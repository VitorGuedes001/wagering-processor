import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { type AppProcess, spawnApp } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { aBet, anSqsEnvelope, aWalletRequest } from '../support/fixtures';
import { createWallet, getWallet, postTransaction } from '../support/http';
import { assertAllWalletsConsistent } from '../support/invariants';
import { holdWalletLock } from '../support/lock-gate';
import {
  createTestQueues,
  deleteTestQueues,
  peekBodies,
  queueDepth,
  sendEnvelope,
  type TestQueues,
} from '../support/queues';

const CONSUMER_NAME = 'wager-transactions-consumer';
/** Redrive de 5 recebimentos e backoff de 2 s na 1ª falha transitória: margem folgada. */
const QUEUE_TIMEOUT = { timeoutMs: 30_000, intervalMs: 100 };

describe('Consumidor SQS (I-12 a I-15; CHALLENGE §10, ARQUITETURA 7.2)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let app: AppProcess;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();
    app = await spawnApp({
      DB_NAME: db.name,
      SQS_INPUT_QUEUE: queues.input,
      SQS_DLQ: queues.dlq,
      SQS_EVENTS_QUEUE: queues.events,
      // I-15: o lock_timeout curto transforma o portão de lock em falha transitória (D66).
      DB_LOCK_TIMEOUT_MS: '300',
      ENABLE_OUTBOX_WORKER: 'false',
      ENABLE_REFERENCE_WORKER: 'false',
    });
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db);
  });

  afterAll(async () => {
    await app?.stop();
    if (queues) await deleteTestQueues(queues);
    await db?.drop();
  });

  async function newWallet(amount = '100.00'): Promise<{ walletId: string; playerId: string }> {
    const request = aWalletRequest({ amount });
    const res = await createWallet(app.url, request);
    expect(res.status).toBe(201);
    return { walletId: res.body.id, playerId: request.playerId };
  }

  async function balanceOf(walletId: string): Promise<string> {
    const res = await getWallet(app.url, walletId);
    return res.body.balance.amount;
  }

  async function inboxRow(messageId: string) {
    const rows = await db.sql<Array<{ payload_hash: string; processed_at: Date | null }>>`
      SELECT payload_hash, processed_at FROM inbox_message
      WHERE consumer_name = ${CONSUMER_NAME} AND message_id = ${messageId}`;
    return rows;
  }

  async function ledgerCount(walletId: string): Promise<number> {
    const [row] = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM wallet_ledger_entry WHERE wallet_id = ${walletId}`;
    return row!.n;
  }

  async function inputQueueDrained(): Promise<void> {
    expect(await queueDepth(queues, queues.inputUrl)).toBe(0);
  }

  async function inDlq(messageId: string): Promise<boolean> {
    const bodies = await peekBodies(queues, queues.dlqUrl);
    return bodies.some((body) => body.includes(`"messageId":"${messageId}"`));
  }

  async function dlqContains(messageId: string): Promise<void> {
    expect(await inDlq(messageId)).toBe(true);
  }

  function logLines(pattern: string, messageId: string): number {
    return app
      .logs()
      .split('\n')
      .filter((line) => line.includes(pattern) && line.includes(`"messageId":"${messageId}"`)).length;
  }

  async function metric(line: string): Promise<string | undefined> {
    const text = await (await fetch(`${app.url}/metrics`)).text();
    return text.split('\n').find((l) => l.startsWith(line));
  }

  // ------------------------------------------------------------------ I-12
  test('I-12: mesma operação via HTTP e depois via SQS → a segunda é replay, sem segundo débito', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const bet = aBet({ walletId, playerId, amount: '25.00' });

    const http = await postTransaction(app.url, bet, { idempotencyKey: bet.idempotencyKey });
    expect(http.status).toBe(200);
    expect(http.body.status).toBe('PROCESSED');

    const envelope = anSqsEnvelope(bet);
    await sendEnvelope(queues, envelope);

    await eventually(async () => {
      const [row] = await inboxRow(envelope.messageId);
      expect(row?.processed_at).not.toBeNull(); // D65: replay também marca a inbox
      await inputQueueDrained();
    }, QUEUE_TIMEOUT);

    const [tx] = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM wager_transaction
      WHERE provider_id = ${bet.providerId} AND idempotency_key = ${bet.idempotencyKey}`;
    expect(tx!.n).toBe(1);
    expect(await ledgerCount(walletId)).toBe(2); // OPENING + BET
    expect(await balanceOf(walletId)).toBe('75.00');
    expect(await inDlq(envelope.messageId)).toBe(false);
  });

  // ------------------------------------------------------------------ I-13
  test('I-13: a mesma mensagem enviada 3× (messageId igual) → 1 efeito, 3 acks', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const envelope = anSqsEnvelope(aBet({ walletId, playerId, amount: '10.00' }));

    // MessageDeduplicationId distinto em cada envio: sem isso o FIFO descartaria as cópias.
    for (let i = 0; i < 3; i++) await sendEnvelope(queues, envelope);

    await eventually(async () => {
      await inputQueueDrained(); // as três receberam ack (nenhuma ficou nem foi para a DLQ)
      expect(logLines('mensagem inválida', envelope.messageId)).toBe(0);
    }, QUEUE_TIMEOUT);

    const rows = await inboxRow(envelope.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.processed_at).not.toBeNull();
    expect(await ledgerCount(walletId)).toBe(2);
    expect(await balanceOf(walletId)).toBe('90.00');
    expect(await inDlq(envelope.messageId)).toBe(false);
    expect(await metric('wagering_duplicates_total{source="inbox"}')).toBeDefined();
  });

  // ------------------------------------------------------------------ I-14
  test('I-14: mesmo messageId com payload diferente → DLQ, sem segundo efeito (D7)', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const first = anSqsEnvelope(aBet({ walletId, playerId, amount: '30.00' }));
    await sendEnvelope(queues, first);

    await eventually(async () => {
      const [row] = await inboxRow(first.messageId);
      expect(row?.processed_at).not.toBeNull();
    }, QUEUE_TIMEOUT);

    const tampered = anSqsEnvelope(aBet({ walletId, playerId, amount: '40.00' }), {
      messageId: first.messageId,
    });
    await sendEnvelope(queues, tampered);

    await eventually(async () => {
      await dlqContains(first.messageId);
      await inputQueueDrained();
    }, QUEUE_TIMEOUT);

    const rows = await inboxRow(first.messageId);
    expect(rows).toHaveLength(1);
    expect(await ledgerCount(walletId)).toBe(2);
    expect(await balanceOf(walletId)).toBe('70.00');
    expect(logLines('messageId repetido com payload diferente', first.messageId)).toBeGreaterThanOrEqual(1);
  });

  // ------------------------------------------------------------------ I-15
  test('I-15 (a): mensagem inválida chega à DLQ após 5 recebimentos', async () => {
    const envelope = anSqsEnvelope(aBet(), { type: 'SomethingElseRequested' });
    await sendEnvelope(queues, envelope, { groupId: randomUUID() });

    await eventually(async () => {
      await dlqContains(envelope.messageId);
      await inputQueueDrained();
    }, QUEUE_TIMEOUT);

    // Cada recebimento loga uma vez; o redrive moveu depois do 5º (maxReceiveCount = 5).
    expect(logLines('mensagem inválida', envelope.messageId)).toBe(5);
    expect(logLines('última entrega', envelope.messageId)).toBe(1);
    expect(await inboxRow(envelope.messageId)).toHaveLength(0);
  });

  test('I-15 (b): falha transitória (lock_timeout) → retry com backoff e sucesso depois de liberar', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const envelope = anSqsEnvelope(aBet({ walletId, playerId, amount: '15.00' }));

    // D66: no lugar de `docker pause`, o portão
    // segura a wallet e o lock_timeout de 300 ms vira TransientInfrastructureError.
    const gate = await holdWalletLock(db, walletId);
    try {
      await sendEnvelope(queues, envelope);
      await eventually(() => {
        expect(logLines('falha transitória', envelope.messageId)).toBeGreaterThanOrEqual(1);
      }, QUEUE_TIMEOUT);
      // A transação financeira deu rollback inteira, inbox inclusive (SCHEMA 2.4).
      expect(await inboxRow(envelope.messageId)).toHaveLength(0);
    } finally {
      await gate.release();
    }

    await eventually(async () => {
      const [row] = await inboxRow(envelope.messageId);
      expect(row?.processed_at).not.toBeNull();
      await inputQueueDrained();
    }, QUEUE_TIMEOUT);

    expect(await balanceOf(walletId)).toBe('85.00');
    expect(await ledgerCount(walletId)).toBe(2);
    expect(await inDlq(envelope.messageId)).toBe(false);
    expect(await metric('wagering_retries_total{component="sqs-consumer"}')).toBeDefined();
  });

  // ------------------------------------------------------------------ I-11 (metade SQS)
  test('I-11 via SQS: amount numérico (25) → DLQ, sem efeito (restrição 5.1)', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const envelope = anSqsEnvelope(aBet({ walletId, playerId }));
    const body = JSON.stringify({
      ...envelope,
      data: { ...envelope.data, money: { amount: 25, currency: 'BRL' } },
    });
    await sendEnvelope(queues, body, { groupId: walletId });

    await eventually(async () => {
      await dlqContains(envelope.messageId);
      await inputQueueDrained();
    }, QUEUE_TIMEOUT);

    expect(await balanceOf(walletId)).toBe('100.00');
    expect(await ledgerCount(walletId)).toBe(1);
  });
});
