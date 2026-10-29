import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { type AppProcess, spawnApp } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { aBet, aRefundOf } from '../support/fixtures';
import { createWallet, postTransaction } from '../support/http';
import { assertAllWalletsConsistent } from '../support/invariants';
import { createTestQueues, deleteTestQueues, type TestQueues } from '../support/queues';

/**
 * Worker de `PENDING_REFERENCE` com a aplicação real em processo (TESTES D36, §3.2):
 * backoff e poll reduzidos por env, mesma lógica. Banco e filas do arquivo (D34/D35).
 */
let db: TestDatabase;
let queues: TestQueues;

beforeAll(async () => {
  db = await createTestDatabase();
  queues = await createTestQueues();
});

afterEach(async () => {
  await assertAllWalletsConsistent(db);
});

afterAll(async () => {
  await deleteTestQueues(queues);
  await db.drop();
});

function appEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    DB_NAME: db.name,
    SQS_INPUT_QUEUE: queues.input,
    SQS_DLQ: queues.dlq,
    SQS_EVENTS_QUEUE: queues.events,
    PORT: '0',
    ENABLE_CONSUMER: 'false',
    ENABLE_OUTBOX_WORKER: 'false',
    ENABLE_REFERENCE_WORKER: 'true',
    REFERENCE_POLL_MS: '50',
    REFERENCE_BACKOFF_BASE_MS: '20',
    ...overrides,
  };
}

async function openWallet(app: AppProcess, amount: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = randomUUID();
  const res = await createWallet(app.url, { playerId, initialBalance: { amount, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id, playerId };
}

async function eventCounts(transactionId: string): Promise<Record<string, number>> {
  const rows = await db.sql<Array<{ event_type: string; count: number }>>`
    SELECT event_type, COUNT(*)::int AS count
      FROM outbox_message
     WHERE payload->'data'->>'transactionId' = ${transactionId}
     GROUP BY event_type
  `;
  return Object.fromEntries(rows.map((row) => [row.event_type, row.count]));
}

describe('I-18: REFUND antes da BET é resolvido pelo worker (TESTES §4.2; CHALLENGE §7.1)', () => {
  let app: AppProcess;

  beforeAll(async () => {
    app = await spawnApp(appEnv());
  });

  afterAll(async () => {
    await app?.kill('SIGKILL');
  });

  test('REFUND → 202 PENDING_REFERENCE; a BET chega; o worker deixa o REFUND PROCESSED, com eventos', async () => {
    const { walletId, playerId } = await openWallet(app, '1000.00');
    const bet = aBet({ walletId, playerId, amount: '25.00' });
    const refund = aRefundOf(bet);

    const pending = await postTransaction(app.url, refund);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
    const refundId: string = pending.body.transactionId;

    const betRes = await postTransaction(app.url, bet);
    expect(betRes.status).toBe(200);
    expect(betRes.body.status).toBe('PROCESSED');
    const betId: string = betRes.body.transactionId;

    const resolved = await eventually(
      async () => {
        const [row] = await db.sql<
          Array<{ status: string; reference_transaction_id: string | null; balance_after: string | null }>
        >`
          SELECT status, reference_transaction_id, balance_after::text
            FROM wager_transaction WHERE id = ${refundId}
        `;
        if (row?.status !== 'PROCESSED') throw new Error(`REFUND ainda ${row?.status}`);
        return row;
      },
      { timeoutMs: 15_000 },
    );
    expect(resolved.reference_transaction_id).toBe(betId);
    expect(resolved.balance_after).toBe('1000.00');

    const [wallet] = await db.sql<Array<{ balance: string }>>`
      SELECT balance::text FROM wallet WHERE id = ${walletId}
    `;
    expect(wallet?.balance).toBe('1000.00');

    const [credit] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wallet_ledger_entry
       WHERE transaction_id = ${refundId} AND direction = 'CREDIT'
    `;
    expect(credit?.count).toBe(1);

    expect(await eventCounts(refundId)).toEqual({
      WagerTransactionPendingReference: 1,
      WagerTransactionProcessed: 1,
      WalletBalanceChanged: 1,
    });

    // A consulta HTTP devolve o desfecho final.
    const view = await fetch(`${app.url}/wagering/transactions/${refundId}`);
    expect(view.status).toBe(200);
    const body = (await view.json()) as { status: string };
    expect(body.status).toBe('PROCESSED');
  });
});

describe('I-19: referência que nunca chega vira REFERENCE_NOT_FOUND (TESTES §4.2; CHALLENGE §7.1; D11, D57)', () => {
  const MAX_ATTEMPTS = 3;
  let app: AppProcess;

  beforeAll(async () => {
    app = await spawnApp(appEnv({ REFERENCE_MAX_ATTEMPTS: String(MAX_ATTEMPTS) }));
  });

  afterAll(async () => {
    await app?.kill('SIGKILL');
  });

  test(`depois de ${MAX_ATTEMPTS} tentativas: REJECTED REFERENCE_NOT_FOUND, com evento e saldo intacto`, async () => {
    const { walletId, playerId } = await openWallet(app, '1000.00');
    const neverSentBet = aBet({ walletId, playerId, amount: '25.00' });
    const refund = aRefundOf(neverSentBet);

    const pending = await postTransaction(app.url, refund);
    expect(pending.status).toBe(202);
    const refundId: string = pending.body.transactionId;

    const rejected = await eventually(
      async () => {
        const [row] = await db.sql<
          Array<{
            status: string;
            failure_code: string | null;
            reference_attempts: number;
            next_reference_attempt_at: Date | null;
            balance_after: string | null;
          }>
        >`
          SELECT status, failure_code, reference_attempts, next_reference_attempt_at, balance_after::text
            FROM wager_transaction WHERE id = ${refundId}
        `;
        if (row?.status !== 'REJECTED') throw new Error(`REFUND ainda ${row?.status}`);
        return row;
      },
      { timeoutMs: 15_000 },
    );

    expect(rejected.failure_code).toBe('REFERENCE_NOT_FOUND');
    // D57: exatamente REFERENCE_MAX_ATTEMPTS tentativas do worker, sem um ciclo extra.
    expect(rejected.reference_attempts).toBe(MAX_ATTEMPTS);
    expect(rejected.next_reference_attempt_at).toBeNull();
    expect(rejected.balance_after).toBe('1000.00');

    const [ledger] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wallet_ledger_entry WHERE transaction_id = ${refundId}
    `;
    expect(ledger?.count).toBe(0);

    // Retry não emite evento (MODELAGEM 5): só o PendingReference inicial e o Rejected final.
    expect(await eventCounts(refundId)).toEqual({
      WagerTransactionPendingReference: 1,
      WagerTransactionRejected: 1,
    });

    // Métricas do worker no registry da T33 (ARQUITETURA 9).
    const metrics = await (await fetch(`${app.url}/metrics`)).text();
    expect(metrics).toContain('wagering_retries_total{component="reference_worker"}');
    expect(metrics).toContain('wagering_transactions_total{kind="REFUND",status="REJECTED"}');
  });
});
