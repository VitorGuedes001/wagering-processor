import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { type AppCluster, spawnCluster } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import {
  aBet,
  anSqsEnvelope,
  aRefundOf,
  aRollbackOf,
  aWin,
  type WagerRequestFixture,
} from '../support/fixtures';
import { createWallet, postTransaction } from '../support/http';
import { assertAllWalletsConsistent } from '../support/invariants';
import { holdWalletLock } from '../support/lock-gate';
import { createTestQueues, deleteTestQueues, type TestQueues } from '../support/queues';

describe('C-07 e C-07b: worker de PENDING_REFERENCE em 3 instâncias (TESTES §4.3; CHALLENGE §13.7)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let cluster: AppCluster;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();
    cluster = await spawnCluster(3, {
      DB_NAME: db.name,
      SQS_INPUT_QUEUE: queues.input,
      SQS_DLQ: queues.dlq,
      SQS_EVENTS_QUEUE: queues.events,
      PORT: '0',
      DB_LOCK_TIMEOUT_MS: '10000', // portão de lock
      ENABLE_OUTBOX_WORKER: 'false',
      REFERENCE_POLL_MS: '50',
      REFERENCE_BACKOFF_BASE_MS: '20',
      // Um item por claim: cada instância pega um item diferente e elas disputam a wallet.
      REFERENCE_BATCH: '1',
    });
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db);
  });

  afterAll(async () => {
    if (cluster) await cluster.killAll('SIGKILL');
    await deleteTestQueues(queues);
    await db.drop();
  });

  async function openWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const res = await createWallet(cluster, { playerId, initialBalance: { amount, currency: 'BRL' } });
    expect(res.status).toBe(201);
    return { walletId: res.body.id, playerId };
  }

  async function statusByExternalId(wager: WagerRequestFixture): Promise<
    { id: string; status: string; failure_code: string | null } | undefined
  > {
    const [row] = await db.sql<Array<{ id: string; status: string; failure_code: string | null }>>`
      SELECT id, status, failure_code FROM wager_transaction
       WHERE provider_id = ${wager.providerId} AND external_transaction_id = ${wager.externalTransactionId}
    `;
    return row;
  }

  async function waitStatus(wager: WagerRequestFixture, status: string): Promise<void> {
    await eventually(
      async () => {
        const row = await statusByExternalId(wager);
        if (row?.status !== status) throw new Error(`${wager.kind} ainda ${row?.status}, esperado ${status}`);
      },
      { timeoutMs: 20_000 },
    );
  }

  async function balanceOf(walletId: string): Promise<string | undefined> {
    const [row] = await db.sql<Array<{ balance: string }>>`
      SELECT balance::text FROM wallet WHERE id = ${walletId}
    `;
    return row?.balance;
  }

  async function sendBySqs(wager: WagerRequestFixture): Promise<void> {
    const envelope = anSqsEnvelope(wager);
    await queues.sqs.send(
      new SendMessageCommand({
        QueueUrl: queues.inputUrl,
        MessageBody: JSON.stringify(envelope),
        MessageGroupId: wager.walletId, // walletId como grupo
        MessageDeduplicationId: envelope.messageId,
      }),
    );
  }

  // Envelope da fila de entrada, consumido pelo WagerTransactionConsumer.
  test(
    'C-07: ROLLBACK de WIN e REFUND de BET chegam por SQS antes das referências; ambos PROCESSED',
    async () => {
      const { walletId, playerId } = await openWallet('1000.00');
      const bet = aBet({ walletId, playerId, amount: '100.00' });
      const win = aWin({ walletId, playerId, amount: '50.00' });
      const refund = aRefundOf(bet);
      const rollback = aRollbackOf(win);

      await sendBySqs(refund);
      await sendBySqs(rollback);
      await waitStatus(refund, 'PENDING_REFERENCE');
      await waitStatus(rollback, 'PENDING_REFERENCE');

      await sendBySqs(bet);
      await sendBySqs(win);

      await waitStatus(refund, 'PROCESSED');
      await waitStatus(rollback, 'PROCESSED');

      // BET -100, WIN +50, REFUND +100, ROLLBACK -50.
      expect(await balanceOf(walletId)).toBe('1000.00');

      for (const reversal of [refund, rollback]) {
        const row = await statusByExternalId(reversal);
        const [pendingEvents] = await db.sql<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count FROM outbox_message
           WHERE event_type = 'WagerTransactionPendingReference' AND aggregate_id = ${row!.id}
        `;
        expect(pendingEvents?.count).toBe(1);
      }
    },
  );

  test('C-07b (a): REFUND e ROLLBACK da mesma BET já processada, em paralelo com portão', async () => {
    const { walletId, playerId } = await openWallet('1000.00');
    const bet = aBet({ walletId, playerId, amount: '100.00' });
    expect((await postTransaction(cluster, bet)).status).toBe(200);

    const refund = aRefundOf(bet);
    const rollback = aRollbackOf(bet);

    const gate = await holdWalletLock(db, walletId);
    const sending = Promise.all([postTransaction(cluster, refund), postTransaction(cluster, rollback)]);
    await gate.waitForWaiters(2);
    await gate.release();
    const responses = await sending;

    const statuses = responses.map((r) => r.body.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    const rejected = responses.find((r) => r.body.status === 'REJECTED')!;
    expect(rejected.status).toBe(422);
    expect(rejected.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(walletId)).toBe('1000.00');
  });

  test('C-07b (b): REFUND e ROLLBACK pendentes da mesma BET, resolvidos pelos workers em disputa', async () => {
    const { walletId, playerId } = await openWallet('1000.00');
    const bet = aBet({ walletId, playerId, amount: '100.00' });
    const refund = aRefundOf(bet);
    const rollback = aRollbackOf(bet);

    expect((await postTransaction(cluster, refund)).status).toBe(202);
    expect((await postTransaction(cluster, rollback)).status).toBe(202);

    // Portão na wallet: a BET e os workers das instâncias ficam presos no mesmo lock.
    const gate = await holdWalletLock(db, walletId);
    const betSending = postTransaction(cluster, bet);
    await gate.waitForWaiters(2);
    await gate.release();
    expect((await betSending).status).toBe(200);

    await eventually(
      async () => {
        const rows = await Promise.all([statusByExternalId(refund), statusByExternalId(rollback)]);
        if (rows.some((row) => row?.status === 'PENDING_REFERENCE')) throw new Error('reversão ainda pendente');
      },
      { timeoutMs: 20_000 },
    );

    const rows = await Promise.all([statusByExternalId(refund), statusByExternalId(rollback)]);
    expect(rows.map((row) => row!.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(rows.find((row) => row!.status === 'REJECTED')!.failure_code).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await balanceOf(walletId)).toBe('1000.00');

    const [reversals] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wallet_ledger_entry
       WHERE wallet_id = ${walletId} AND direction = 'CREDIT'
    `;
    // OPENING + uma única reversão.
    expect(reversals?.count).toBe(2);
  });
});
