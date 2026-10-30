import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { type AppProcess, type AppProcessOptions, spawnApp } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { aBet, aLoss, anSqsEnvelope, aWin, type WagerRequestFixture } from '../support/fixtures';
import { createWallet, postTransaction } from '../support/http';
import { assertAllWalletsConsistent } from '../support/invariants';
import {
  createTestQueues,
  deleteTestQueues,
  queueDepth,
  sendEnvelope,
  type TestQueues,
} from '../support/queues';

// Visibilidade curta: a redelivery depois de um crash chega em segundos.
const VISIBILITY_SECONDS = 3;

/**
 * Cenários de falha com processos reais.
 * Cada teste tem banco e filas próprios: um crash não deixa mensagem em voo para o outro.
 */
describe('C-05 e C-08: crash depois do commit e crash com carga (TESTES §4.3)', () => {
  const apps: AppProcess[] = [];

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.kill('SIGKILL')));
  });

  async function start(options: AppProcessOptions): Promise<AppProcess> {
    const app = await spawnApp(options);
    apps.push(app);
    return app;
  }

  async function openWallet(app: AppProcess, amount: string): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const res = await createWallet(app.url, { playerId, initialBalance: { amount, currency: 'BRL' } });
    expect(res.status).toBe(201);
    return { walletId: res.body.id, playerId };
  }

  describe('C-05: instância morre depois do COMMIT e antes do ack (§13.5)', () => {
    let db: TestDatabase;
    let queues: TestQueues;

    beforeAll(async () => {
      db = await createTestDatabase();
      queues = await createTestQueues(undefined, { visibilityTimeoutSeconds: VISIBILITY_SECONDS });
    });

    afterEach(async () => {
      await assertAllWalletsConsistent(db);
    });

    afterAll(async () => {
      await deleteTestQueues(queues);
      await db.drop();
    });

    test(
      'A morre no ponto de falha; B recebe a redelivery, dá ack pela inbox e não debita de novo',
      async () => {
        const base: AppProcessOptions = {
          DB_NAME: db.name,
          SQS_INPUT_QUEUE: queues.input,
          SQS_DLQ: queues.dlq,
          SQS_EVENTS_QUEUE: queues.events,
          ENABLE_OUTBOX_WORKER: 'false',
          ENABLE_REFERENCE_WORKER: 'false',
        };

        // B só serve HTTP enquanto A vive: assim só A pode receber a mensagem.
        const httpOnly = await start({ ...base, ENABLE_CONSUMER: 'false' });
        const { walletId, playerId } = await openWallet(httpOnly, '1000.00');

        const a = await start({
          ...base,
          ENABLE_HTTP: 'false',
          FAULT_POINT: 'consumer.after-commit-before-ack',
        });

        const bet = aBet({ walletId, playerId, amount: '10.00' });
        const envelope = anSqsEnvelope(bet);
        await sendEnvelope(queues, envelope);

        await a.exited;

        // Entre a queda e a redelivery: o commit aconteceu e o ack não.
        expect(await countTransactions(db, bet)).toBe(1);
        expect(await countDebits(db, walletId)).toBe(1);
        expect(await inboxRows(db, envelope.messageId)).toEqual([{ processed: true }]);
        expect(await queueDepth(queues, queues.inputUrl)).toBe(1);

        await start({ ...base, ENABLE_HTTP: 'false' });

        await eventually(
          async () => {
            if ((await queueDepth(queues, queues.inputUrl)) !== 0) throw new Error('mensagem ainda na fila');
          },
          { timeoutMs: 20_000 },
        );

        expect(await queueDepth(queues, queues.dlqUrl)).toBe(0);
        expect(await countTransactions(db, bet)).toBe(1);
        expect(await countDebits(db, walletId)).toBe(1);
        expect(await balanceOf(db, walletId)).toBe('990.00');
        expect(await inboxRows(db, envelope.messageId)).toEqual([{ processed: true }]);
      },
      60_000,
    );
  });

  describe('C-08: SIGKILL em duas de três instâncias no meio da carga (§13.8)', () => {
    const WALLETS = 10;
    const SQS_MESSAGES = 300;
    const HTTP_BETS = 60;

    let db: TestDatabase;
    let queues: TestQueues;

    beforeAll(async () => {
      db = await createTestDatabase();
      queues = await createTestQueues(undefined, { visibilityTimeoutSeconds: VISIBILITY_SECONDS });
    });

    afterEach(async () => {
      await assertAllWalletsConsistent(db);
    });

    afterAll(async () => {
      await deleteTestQueues(queues);
      await db.drop();
    });

    test(
      'depois do crash e de duas instâncias novas, tudo drena e cada wallet reconcilia',
      async () => {
        const options: AppProcessOptions = {
          DB_NAME: db.name,
          SQS_INPUT_QUEUE: queues.input,
          SQS_DLQ: queues.dlq,
          SQS_EVENTS_QUEUE: queues.events,
          OUTBOX_POLL_MS: '50',
          OUTBOX_LEASE_MS: '2000',
          REFERENCE_POLL_MS: '200',
        };

        let live: AppProcess[] = await Promise.all([start(options), start(options), start(options)]);
        let rr = 0;
        const nextUrl = (): string => live[rr++ % live.length]!.url;

        const wallets = await Promise.all(
          Array.from({ length: WALLETS }, () => openWallet(live[0]!, '1000.00')),
        );

        // Carga por SQS: BET, WIN e LOSS alternados, MessageGroupId = walletId.
        const sqsWagers: WagerRequestFixture[] = Array.from({ length: SQS_MESSAGES }, (_, i) => {
          const { walletId, playerId } = wallets[i % WALLETS]!;
          const builders = [aBet, aWin, aLoss] as const;
          const build = builders[i % builders.length]!;
          return build({ walletId, playerId, amount: build === aLoss ? '0.00' : '1.00' });
        });
        const httpBets: WagerRequestFixture[] = Array.from({ length: HTTP_BETS }, (_, i) => {
          const { walletId, playerId } = wallets[i % WALLETS]!;
          return aBet({ walletId, playerId, amount: '1.00' });
        });

        const producing = (async () => {
          for (let i = 0; i < sqsWagers.length; i += 10) {
            await sendBatch(queues, sqsWagers.slice(i, i + 10));
          }
        })();

        // HTTP em paralelo. Erro de conexão (instância morta) é reenviado com a
        // mesma Idempotency-Key a outra instância viva: replay ou um único efeito.
        const posting = Promise.all(
          httpBets.map(async (bet) => {
            for (let attempt = 0; attempt < 20; attempt++) {
              try {
                const res = await postTransaction(nextUrl(), bet, { timeoutMs: 10_000 });
                if (res.status < 500) return res.status;
              } catch {
                // conexão recusada ou cortada pelo SIGKILL
              }
            }
            throw new Error(`BET HTTP ${bet.externalTransactionId} sem resposta`);
          }),
        );

        // No meio: cerca de 1/3 das transações SQS já gravadas.
        await eventually(
          async () => {
            if ((await countAllTransactions(db)) < SQS_MESSAGES / 3) throw new Error('carga ainda no começo');
          },
          { timeoutMs: 30_000, intervalMs: 20 },
        );

        const [survivor, ...victims] = live;
        await Promise.all(victims.map((app) => app.kill('SIGKILL')));
        live = [survivor!];
        // Mensagens em voo nas mortas voltam quando a visibilidade expira; o
        // outbox reservado por elas volta quando o lease vence.
        live = [survivor!, ...(await Promise.all([start(options), start(options)]))];

        await producing;
        const httpStatuses = await posting;
        expect(httpStatuses.every((status) => status === 200 || status === 422)).toBe(true);

        // Drena: fila de entrada, outbox e referências.
        await eventually(
          async () => {
            if ((await queueDepth(queues, queues.inputUrl)) !== 0) throw new Error('fila de entrada não drenou');
            if ((await pendingOutbox(db)) !== 0) throw new Error('outbox não drenou');
            if ((await pendingReferences(db)) !== 0) throw new Error('referência pendente');
          },
          { timeoutMs: 60_000, intervalMs: 200 },
        );

        expect(await queueDepth(queues, queues.dlqUrl)).toBe(0);

        // Toda mensagem enviada tem resultado: uma transação terminal por chave.
        const results = await resultsByKey(db);
        for (const wager of [...sqsWagers, ...httpBets]) {
          const statuses = results.get(`${wager.providerId}|${wager.idempotencyKey}`) ?? [];
          expect(statuses.length).toBe(1);
          expect(['PROCESSED', 'REJECTED']).toContain(statuses[0]!);
        }
        expect(await countFailed(db)).toBe(0);

        // Reconciliação por uma das instâncias novas.
        const reconciler = live[1]!;
        for (const { walletId } of wallets) {
          const res = await fetch(`${reconciler.url}/wallets/${walletId}/reconciliation`, { method: 'POST' });
          expect(res.status).toBe(200);
          const body = (await res.json()) as { consistent: boolean };
          expect(body.consistent).toBe(true);
        }
      },
      180_000,
    );
  });
});

async function sendBatch(queues: TestQueues, wagers: WagerRequestFixture[]): Promise<void> {
  if (wagers.length === 0) return;
  await queues.sqs.send(
    new SendMessageBatchCommand({
      QueueUrl: queues.inputUrl,
      Entries: wagers.map((wager, i) => {
        const envelope = anSqsEnvelope(wager);
        return {
          Id: String(i),
          MessageBody: JSON.stringify(envelope),
          MessageGroupId: wager.walletId,
          MessageDeduplicationId: envelope.messageId,
        };
      }),
    }),
  );
}

async function countTransactions(db: TestDatabase, wager: WagerRequestFixture): Promise<number> {
  const [row] = await db.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM wager_transaction
     WHERE provider_id = ${wager.providerId} AND idempotency_key = ${wager.idempotencyKey}
  `;
  return row?.count ?? 0;
}

async function countAllTransactions(db: TestDatabase): Promise<number> {
  const [row] = await db.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM wager_transaction WHERE kind <> 'OPENING'
  `;
  return row?.count ?? 0;
}

async function countDebits(db: TestDatabase, walletId: string): Promise<number> {
  const [row] = await db.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM wallet_ledger_entry
     WHERE wallet_id = ${walletId} AND direction = 'DEBIT'
  `;
  return row?.count ?? 0;
}

async function balanceOf(db: TestDatabase, walletId: string): Promise<string | undefined> {
  const [row] = await db.sql<Array<{ balance: string }>>`
    SELECT balance::text FROM wallet WHERE id = ${walletId}
  `;
  return row?.balance;
}

async function inboxRows(db: TestDatabase, messageId: string): Promise<Array<{ processed: boolean }>> {
  return db.sql<Array<{ processed: boolean }>>`
    SELECT processed_at IS NOT NULL AS processed FROM inbox_message WHERE message_id = ${messageId}
  `;
}

async function pendingOutbox(db: TestDatabase): Promise<number> {
  const [row] = await db.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM outbox_message WHERE published_at IS NULL
  `;
  return row?.count ?? 0;
}

async function pendingReferences(db: TestDatabase): Promise<number> {
  const [row] = await db.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM wager_transaction WHERE status IN ('PENDING', 'PENDING_REFERENCE')
  `;
  return row?.count ?? 0;
}

async function countFailed(db: TestDatabase): Promise<number> {
  const [row] = await db.sql<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count FROM wager_transaction WHERE status = 'FAILED'
  `;
  return row?.count ?? 0;
}

async function resultsByKey(db: TestDatabase): Promise<Map<string, string[]>> {
  const rows = await db.sql<Array<{ key: string; status: string }>>`
    SELECT provider_id || '|' || idempotency_key AS key, status FROM wager_transaction
     WHERE idempotency_key IS NOT NULL
  `;
  const byKey = new Map<string, string[]>();
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row.status]);
  return byKey;
}
