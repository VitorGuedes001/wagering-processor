import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { type AppCluster, spawnCluster } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { aBet } from '../support/fixtures';
import { createWallet, postTransaction } from '../support/http';
import { assertAllWalletsConsistent } from '../support/invariants';
import { holdWalletLock } from '../support/lock-gate';
import { createTestQueues, deleteTestQueues, type TestQueues } from '../support/queues';

describe('C-01 a C-03: Concorrência Real e Disputa de Lock (TESTES §4.3; CHALLENGE §5, §13)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let cluster: AppCluster;
  let routesAvailable = false;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues('conc');

    // Sobe o cluster de 3 instâncias com DB_LOCK_TIMEOUT_MS maior (10s) para o portão de lock
    cluster = await spawnCluster(3, {
      DB_NAME: db.name,
      SQS_INPUT_QUEUE: queues.input,
      SQS_DLQ: queues.dlq,
      SQS_EVENTS_QUEUE: queues.events,
      PORT: '0',
      DB_LOCK_TIMEOUT_MS: '10000',
      OUTBOX_POLL_MS: '50',
    });

    // Sonda de disponibilidade das rotas de negócio
    const probeRes = await fetch(`${cluster.urls[0]}/wagering/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    routesAvailable = probeRes.status !== 404;
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db);
  });

  afterAll(async () => {
    if (cluster) {
      await cluster.killAll('SIGTERM');
    }
    await deleteTestQueues(queues);
    await db.drop();
  });

  test('Sonda de rotas: cluster pronto em /health/ready e relato do estado das rotas HTTP', async () => {
    for (const app of cluster.apps) {
      const readyRes = await fetch(`${app.url}/health/ready`);
      expect(readyRes.status).toBe(200);
    }

    if (!routesAvailable) {
      // Sem as rotas de negócio, o teste falha pelo motivo certo em vez de passar vazio
      const res = await fetch(`${cluster.urls[0]}/wagering/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    }
  });

  /**
   * C-01: Wallet 1000.00. A mesma BET 10.00 50× em paralelo, distribuída em 3 instâncias.
   * Uma rodada com portão, outra sem.
   * Verificação: exatamente 1 transação, 1 DEBIT, saldo 990.00.
   * 50 respostas com o mesmo transactionId, 49 com idempotentReplay: true.
   */
  test(
    'C-01: mesma BET 10.00 enviada 50x em paralelo em 3 instâncias (sem portão e com portão)',
    async () => {
      for (const useGate of [false, true]) {
        // 1. Criar wallet com 1000.00
        const playerId = randomUUID();
        const createRes = await createWallet(cluster, {
          playerId,
          initialBalance: { amount: '1000.00', currency: 'BRL' },
        });
        expect(createRes.status).toBe(201);
        const walletId = createRes.body.id;

        // 2. Mesma requisição de BET 10.00
        const betPayload = aBet({
          walletId,
          playerId,
          amount: '10.00',
        });

        let gate;
        if (useGate) {
          gate = await holdWalletLock(db, walletId);
        }

        // 3. Dispara 50 requisições simultâneas em round-robin entre as 3 instâncias
        const sendPromises = Array.from({ length: 50 }, () =>
          postTransaction(cluster, betPayload, {
            idempotencyKey: betPayload.idempotencyKey,
          }),
        );

        if (useGate && gate) {
          // Aguarda contenção no lock da wallet
          await eventually(async () => {
            const waiters = await gate.countWaiters();
            if (waiters === 0) throw new Error('Aguardando disputa de lock no portão');
          });
          await gate.release();
        }

        const responses = await Promise.all(sendPromises);

        // 4. Verificação das 50 respostas
        expect(responses.length).toBe(50);
        const firstTxId = responses[0]!.body.transactionId;
        expect(firstTxId).toBeDefined();

        let replays = 0;
        for (const resp of responses) {
          expect(resp.status).toBe(200);
          expect(resp.body.transactionId).toBe(firstTxId);
          expect(resp.body.status).toBe('PROCESSED');
          if (resp.body.idempotentReplay === true) {
            replays++;
          }
        }
        expect(replays).toBe(49);

        // 5. Verificação no banco: exatamente 1 transação, 1 DEBIT, saldo 990.00
        const [walletRows] = await db.sql<Array<{ balance: string }>>`
          SELECT balance::text FROM wallet WHERE id = ${walletId}
        `;
        expect(walletRows?.balance).toBe('990.00');

        const [txCount] = await db.sql<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count FROM wager_transaction WHERE wallet_id = ${walletId} AND kind = 'BET'
        `;
        expect(txCount?.count).toBe(1);

        const [debitCount] = await db.sql<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count FROM wallet_ledger_entry WHERE wallet_id = ${walletId} AND direction = 'DEBIT'
        `;
        expect(debitCount?.count).toBe(1);
      }
    },
  );

  /**
   * C-02: Wallet 100.00, duas BET 80.00 (ids diferentes) com portão.
   * Verificação: exatamente 1 PROCESSED, 1 REJECTED INSUFFICIENT_FUNDS, saldo 20.00, 1 DEBIT.
   * Reenviar as duas → replays, nada muda.
   */
  test(
    'C-02: duas BETs de 80.00 com saldo 100.00 e portão de lock',
    async () => {
      const playerId = randomUUID();
      const createRes = await createWallet(cluster, {
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      });
      expect(createRes.status).toBe(201);
      const walletId = createRes.body.id;

      const bet1 = aBet({ walletId, playerId, amount: '80.00' });
      const bet2 = aBet({ walletId, playerId, amount: '80.00' });

      const gate = await holdWalletLock(db, walletId);

      const pending1 = postTransaction(cluster, bet1);
      const pending2 = postTransaction(cluster, bet2);

      await gate.waitForWaiters(2);
      await gate.release();

      const [res1, res2] = await Promise.all([pending1, pending2]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 422]);

      const rejected = res1.status === 422 ? res1 : res2;
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');

      // Saldo deve ser 20.00 e exatamente 1 DEBIT
      const [walletRows] = await db.sql<Array<{ balance: string }>>`
        SELECT balance::text FROM wallet WHERE id = ${walletId}
      `;
      expect(walletRows?.balance).toBe('20.00');

      const [debits] = await db.sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM wallet_ledger_entry WHERE wallet_id = ${walletId} AND direction = 'DEBIT'
      `;
      expect(debits?.count).toBe(1);

      // Reenvio das duas: ambas são replays
      const replay1 = await postTransaction(cluster, bet1);
      const replay2 = await postTransaction(cluster, bet2);

      expect(replay1.status).toBe(res1.status);
      expect(replay1.body.idempotentReplay).toBe(true);

      expect(replay2.status).toBe(res2.status);
      expect(replay2.body.idempotentReplay).toBe(true);

      const [walletAfterReplay] = await db.sql<Array<{ balance: string }>>`
        SELECT balance::text FROM wallet WHERE id = ${walletId}
      `;
      expect(walletAfterReplay?.balance).toBe('20.00');
    },
  );

  /**
   * C-02b: Wallet 1000.00, 100 BETs de 15.00 com portão.
   * Verificação: exatamente 66 PROCESSED e 34 REJECTED, saldo final 10.00.
   */
  test(
    'C-02b: 100 BETs de 15.00 com saldo 1000.00 e portão de lock (66 PROCESSED, 34 REJECTED)',
    async () => {
      const playerId = randomUUID();
      const createRes = await createWallet(cluster, {
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      });
      expect(createRes.status).toBe(201);
      const walletId = createRes.body.id;

      const bets = Array.from({ length: 100 }, () =>
        aBet({ walletId, playerId, amount: '15.00' }),
      );

      const gate = await holdWalletLock(db, walletId);

      const sendPromises = bets.map((b) => postTransaction(cluster, b));

      // Espera contenção no portão
      await eventually(async () => {
        const waiters = await gate.countWaiters();
        if (waiters < 5) throw new Error(`Aguardando mais bloqueios no portão (${waiters})`);
      });

      await gate.release();

      const responses = await Promise.all(sendPromises);

      const processed = responses.filter((r) => r.status === 200);
      const rejected = responses.filter((r) => r.status === 422);

      expect(processed.length).toBe(66);
      expect(rejected.length).toBe(34);

      for (const r of rejected) {
        expect(r.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      }

      // Saldo final: 1000 - 66 * 15 = 1000 - 990 = 10.00
      const [walletRows] = await db.sql<Array<{ balance: string }>>`
        SELECT balance::text FROM wallet WHERE id = ${walletId}
      `;
      expect(walletRows?.balance).toBe('10.00');

      const [debitCount] = await db.sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM wallet_ledger_entry WHERE wallet_id = ${walletId} AND direction = 'DEBIT'
      `;
      expect(debitCount?.count).toBe(66);
    },
  );

  /**
   * C-03: 20 wallets, 20 BETs em cada, em paralelo. Portão em UMA wallet só.
   * Verificação: as outras 19 terminam enquanto a travada espera: o lock não é global.
   */
  test(
    'C-03: 20 wallets em paralelo, portão em uma só: prova ausência de lock global',
    async () => {
      // 1. Cria 20 wallets com saldo 500.00 cada
      const wallets: Array<{ walletId: string; playerId: string }> = [];
      for (let i = 0; i < 20; i++) {
        const playerId = randomUUID();
        const createRes = await createWallet(cluster, {
          playerId,
          initialBalance: { amount: '500.00', currency: 'BRL' },
        });
        expect(createRes.status).toBe(201);
        wallets.push({ walletId: createRes.body.id, playerId });
      }

      const lockedWallet = wallets[0]!;
      const otherWallets = wallets.slice(1);

      // 2. Trava APENAS a primeira wallet
      const gate = await holdWalletLock(db, lockedWallet.walletId);

      // Dispara 20 BETs para a wallet travada
      const lockedBets = Array.from({ length: 20 }, () =>
        aBet({ walletId: lockedWallet.walletId, playerId: lockedWallet.playerId, amount: '10.00' }),
      );
      const lockedPromises = lockedBets.map((b) => postTransaction(cluster, b));

      // Dispara 20 BETs para cada uma das outras 19 wallets (total 380 reqs)
      const otherPromises: Promise<any>[] = [];
      for (const w of otherWallets) {
        for (let j = 0; j < 20; j++) {
          otherPromises.push(
            postTransaction(
              cluster,
              aBet({ walletId: w.walletId, playerId: w.playerId, amount: '10.00' }),
            ),
          );
        }
      }

      // As outras 19 wallets DEVEM completar todas as suas requisições enquanto o portão está travado
      const otherResponses = await Promise.all(otherPromises);
      expect(otherResponses.length).toBe(380);
      for (const r of otherResponses) {
        expect(r.status).toBe(200);
      }

      // Confirma que a wallet travada ainda tem transações bloqueadas
      const waiters = await gate.countWaiters();
      expect(waiters).toBeGreaterThanOrEqual(1);

      // Libera a wallet travada
      await gate.release();

      // Agora a primeira wallet deve completar
      const lockedResponses = await Promise.all(lockedPromises);
      expect(lockedResponses.length).toBe(20);
      for (const r of lockedResponses) {
        expect(r.status).toBe(200);
      }

      // Verificação de saldo de todas as 20 wallets: 500 - 20 * 10 = 300.00
      for (const w of wallets) {
        const [row] = await db.sql<Array<{ balance: string }>>`
          SELECT balance::text FROM wallet WHERE id = ${w.walletId}
        `;
        expect(row?.balance).toBe('300.00');
      }
    },
  );
});
