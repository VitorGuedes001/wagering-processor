import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RequestErrorCode } from '../../src/application/contracts';
import { AppLogger } from '../../src/infrastructure/observability/logger';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/inbox-repository';
import { MikroOrmLedgerRepository } from '../../src/infrastructure/persistence/ledger-repository';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/outbox-repository';
import { InboxMessageRecord } from '../../src/infrastructure/persistence/records/inbox-message.record';
import { LedgerEntryRecord } from '../../src/infrastructure/persistence/records/ledger-entry.record';
import { OutboxMessageRecord } from '../../src/infrastructure/persistence/records/outbox-message.record';
import { WagerTransactionRecord } from '../../src/infrastructure/persistence/records/wager-transaction.record';
import { WalletRecord } from '../../src/infrastructure/persistence/records/wallet.record';
import {
  MikroOrmUnitOfWork,
  type RepositoryFactories,
} from '../../src/infrastructure/persistence/unit-of-work';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction-repository';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/wallet-repository';
import { WageringModule } from '../../src/interface/wagering.module';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { getTestInfraConfig } from '../support/preload';

function encodeCursor(version: number): string {
  return Buffer.from(JSON.stringify({ v: version })).toString('base64url');
}

describe('T43 — Extrato e reconciliação (I-21 e teste complementar de extrato)', () => {
  let db: TestDatabase;
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let app: INestApplication;
  let baseUrl: string;
  let testMetrics: MetricsRegistry;
  const capturedLogs: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase();
    const cfg = getTestInfraConfig();

    orm = await MikroORM.init(
      defineConfig({
        host: cfg.dbHost,
        port: cfg.dbPort,
        user: cfg.dbUser,
        password: cfg.dbPassword,
        dbName: db.name,
        entities: [
          WalletRecord,
          LedgerEntryRecord,
          WagerTransactionRecord,
          InboxMessageRecord,
          OutboxMessageRecord,
        ],
        metadataProvider: ReflectMetadataProvider,
        debug: false,
        forceUtcTimezone: true,
      }),
    );

    const factories: RepositoryFactories = {
      wallets: (em) => new MikroOrmWalletRepository(em),
      ledger: (em) => new MikroOrmLedgerRepository(em),
      transactions: (em) => new MikroOrmWagerTransactionRepository(em),
      inbox: (em) => new MikroOrmInboxRepository(em),
      outbox: (em) => new MikroOrmOutboxRepository(em),
    };

    uow = new MikroOrmUnitOfWork(orm, { DB_LOCK_TIMEOUT_MS: 2000 }, factories);

    @Module({
      imports: [WageringModule.withUnitOfWork(uow)],
    })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false });
    testMetrics = app.get(MetricsRegistry);
    const appLogger = app.get(AppLogger);
    appLogger.setWriter((line) => capturedLogs.push(line));

    await app.listen(0);

    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 3000;
    baseUrl = `http://localhost:${port}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (orm) await orm.close();
    if (db) await db.drop();
  });

  async function apiRequest(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const responseText = await res.text();
    let parsedBody: any;
    try {
      parsedBody = JSON.parse(responseText);
    } catch {
      parsedBody = responseText;
    }
    return {
      status: res.status,
      headers: res.headers,
      body: parsedBody,
    };
  }

  async function createWallet(playerId: string, initialBalance: string, currency = 'BRL') {
    return apiRequest('POST', '/wallets', {
      playerId,
      initialBalance: { amount: initialBalance, currency },
    });
  }

  async function submitWager(params: {
    walletId: string;
    playerId: string;
    kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
    amount: string;
    currency?: string;
    referenceExternalTransactionId?: string;
  }) {
    const extId = randomUUID();
    return apiRequest('POST', '/wagering/transactions', {
      providerId: 'test-provider',
      externalTransactionId: extId,
      playerId: params.playerId,
      walletId: params.walletId,
      roundId: randomUUID(),
      gameId: 'test-game',
      kind: params.kind,
      money: { amount: params.amount, currency: params.currency ?? 'BRL' },
      referenceExternalTransactionId: params.referenceExternalTransactionId,
    }, {
      'Idempotency-Key': `idemp-${extId}`,
    });
  }

  describe('Extrato com paginação por cursor estável (teste complementar)', () => {
    test('validação de parâmetros de query rejeita limit inválido com 400 INVALID_PAYLOAD', async () => {
      const walletId = randomUUID();

      const r1 = await apiRequest('GET', `/wallets/${walletId}/ledger?limit=0`);
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe(RequestErrorCode.InvalidPayload);

      const r2 = await apiRequest('GET', `/wallets/${walletId}/ledger?limit=201`);
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe(RequestErrorCode.InvalidPayload);

      const r3 = await apiRequest('GET', `/wallets/${walletId}/ledger?limit=notanumber`);
      expect(r3.status).toBe(400);
      expect(r3.body.code).toBe(RequestErrorCode.InvalidPayload);
    });

    test('cursor inválido (base64 quebrado, JSON inválido, v ausente ou não inteiro) devolve 400 INVALID_PAYLOAD', async () => {
      const walletId = randomUUID();

      // 1. Base64 quebrado / caracteres inválidos
      const r1 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=invalid!@#$%`);
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe(RequestErrorCode.InvalidPayload);

      // 2. Base64 válido de texto não-JSON
      const notJson = Buffer.from('hello-world').toString('base64url');
      const r2 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${notJson}`);
      expect(r2.status).toBe(400);
      expect(r2.body.code).toBe(RequestErrorCode.InvalidPayload);

      // 3. JSON válido mas sem a propriedade `v`
      const noV = Buffer.from(JSON.stringify({ other: 123 })).toString('base64url');
      const r3 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${noV}`);
      expect(r3.status).toBe(400);
      expect(r3.body.code).toBe(RequestErrorCode.InvalidPayload);

      // 4. `v` presente mas não inteiro (número de ponto flutuante)
      const floatV = Buffer.from(JSON.stringify({ v: 1.5 })).toString('base64url');
      const r4 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${floatV}`);
      expect(r4.status).toBe(400);
      expect(r4.body.code).toBe(RequestErrorCode.InvalidPayload);

      // 5. `v` presente mas string
      const strV = Buffer.from(JSON.stringify({ v: '2' })).toString('base64url');
      const r5 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${strV}`);
      expect(r5.status).toBe(400);
      expect(r5.body.code).toBe(RequestErrorCode.InvalidPayload);

      // 6. `v` negativo
      const negV = Buffer.from(JSON.stringify({ v: -1 })).toString('base64url');
      const r6 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${negV}`);
      expect(r6.status).toBe(400);
      expect(r6.body.code).toBe(RequestErrorCode.InvalidPayload);

      // 7. JSON que é um array ou primitivo
      const arr = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64url');
      const r7 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${arr}`);
      expect(r7.status).toBe(400);
      expect(r7.body.code).toBe(RequestErrorCode.InvalidPayload);

      // 8. `v` acima do limite de `integer` do Postgres (wallet_version)
      const hugeV = Buffer.from(JSON.stringify({ v: 2_147_483_648 })).toString('base64url');
      const r8 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${hugeV}`);
      expect(r8.status).toBe(400);
      expect(r8.body.code).toBe(RequestErrorCode.InvalidPayload);
    });

    test('retorna 404 WALLET_NOT_FOUND para wallet inexistente', async () => {
      const res = await apiRequest('GET', `/wallets/${randomUUID()}/ledger`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(RequestErrorCode.WalletNotFound);
    });

    test('wallet criada com saldo zero retorna lista vazia e nextCursor null', async () => {
      const playerId = randomUUID();
      const created = await createWallet(playerId, '0.00');
      expect(created.status).toBe(201);
      const walletId = created.body.id;

      const res = await apiRequest('GET', `/wallets/${walletId}/ledger`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    test('paginação estável por cursor opaco após inserções subsequentes entre páginas', async () => {
      const playerId = randomUUID();
      const created = await createWallet(playerId, '100.00');
      expect(created.status).toBe(201);
      const walletId = created.body.id;

      // Executa 4 transações para totalizar 5 lançamentos (versões 1 a 5)
      const tx1 = await submitWager({ walletId, playerId, kind: 'BET', amount: '10.00' });
      expect(tx1.status).toBe(200);

      const tx2 = await submitWager({ walletId, playerId, kind: 'BET', amount: '15.00' });
      expect(tx2.status).toBe(200);

      const tx3 = await submitWager({ walletId, playerId, kind: 'WIN', amount: '25.00' });
      expect(tx3.status).toBe(200);

      const tx4 = await submitWager({ walletId, playerId, kind: 'BET', amount: '20.00' });
      expect(tx4.status).toBe(200);

      // 1. Busca primeira página (versões 1 e 2)
      const page1 = await apiRequest('GET', `/wallets/${walletId}/ledger?limit=2`);
      expect(page1.status).toBe(200);
      expect(page1.body.items).toHaveLength(2);
      expect(page1.body.items[0].walletVersion).toBe(1);
      expect(page1.body.items[0].direction).toBe('CREDIT');
      expect(page1.body.items[0].money).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(page1.body.items[0].balanceBefore).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(page1.body.items[0].balanceAfter).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(page1.body.items[0].createdAt).toBeDefined();

      expect(page1.body.items[1].walletVersion).toBe(2);
      expect(page1.body.items[1].direction).toBe('DEBIT');
      expect(page1.body.items[1].money).toEqual({ amount: '10.00', currency: 'BRL' });
      expect(page1.body.items[1].balanceBefore).toEqual({ amount: '100.00', currency: 'BRL' });
      expect(page1.body.items[1].balanceAfter).toEqual({ amount: '90.00', currency: 'BRL' });
      expect(page1.body.nextCursor).toBe(encodeCursor(2));

      // Inserções adicionais acontecem entre as páginas
      const nextTx1 = await submitWager({ walletId, playerId, kind: 'WIN', amount: '50.00' });
      expect(nextTx1.status).toBe(200); // gera versão 6

      const nextTx2 = await submitWager({ walletId, playerId, kind: 'BET', amount: '30.00' });
      expect(nextTx2.status).toBe(200); // gera versão 7

      // 2. Busca segunda página com cursor da página 1
      const page2 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${page1.body.nextCursor}&limit=2`);
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(2);
      expect(page2.body.items[0].walletVersion).toBe(3);
      expect(page2.body.items[0].direction).toBe('DEBIT');
      expect(page2.body.items[0].money).toEqual({ amount: '15.00', currency: 'BRL' });

      expect(page2.body.items[1].walletVersion).toBe(4);
      expect(page2.body.items[1].direction).toBe('CREDIT');
      expect(page2.body.items[1].money).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(page2.body.nextCursor).toBe(encodeCursor(4));

      // 3. Busca terceira página usando o cursor da página 2
      const page3 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${page2.body.nextCursor}&limit=2`);
      expect(page3.status).toBe(200);
      expect(page3.body.items).toHaveLength(2);
      expect(page3.body.items[0].walletVersion).toBe(5);
      expect(page3.body.items[1].walletVersion).toBe(6);
      expect(page3.body.nextCursor).toBe(encodeCursor(6));

      // 4. Busca quarta página (versão 7 restante)
      const page4 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${page3.body.nextCursor}&limit=2`);
      expect(page4.status).toBe(200);
      expect(page4.body.items).toHaveLength(1);
      expect(page4.body.items[0].walletVersion).toBe(7);
      expect(page4.body.nextCursor).toBeNull(); // menos itens que o limit -> nextCursor é null

      // 5. Busca além do fim com cursor da versão 7
      const page5 = await apiRequest('GET', `/wallets/${walletId}/ledger?cursor=${encodeCursor(7)}&limit=2`);
      expect(page5.status).toBe(200);
      expect(page5.body.items).toHaveLength(0);
      expect(page5.body.nextCursor).toBeNull();
    });
  });

  describe('I-21: Reconciliação consistente e inconsistente (§9)', () => {
    test('retorna 404 WALLET_NOT_FOUND para wallet inexistente', async () => {
      const res = await apiRequest('POST', `/wallets/${randomUUID()}/reconciliation`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(RequestErrorCode.WalletNotFound);
    });

    test('cenário normal: reconciliação consistente', async () => {
      const playerId = randomUUID();
      const created = await createWallet(playerId, '500.00');
      expect(created.status).toBe(201);
      const walletId = created.body.id;

      await submitWager({ walletId, playerId, kind: 'BET', amount: '100.00' });
      await submitWager({ walletId, playerId, kind: 'WIN', amount: '50.00' });

      capturedLogs.length = 0;
      const initialMetrics = await testMetrics.getMetrics();
      const initialMismatch = /wagering_reconciliation_mismatch_total\s+(\d+)/.exec(initialMetrics)?.[1] ?? '0';

      const res = await apiRequest('POST', `/wallets/${walletId}/reconciliation`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        walletId,
        storedBalance: { amount: '450.00', currency: 'BRL' },
        calculatedBalance: { amount: '450.00', currency: 'BRL' },
        difference: { amount: '0.00', currency: 'BRL' },
        consistent: true,
        checkedEntries: 3,
      });

      // Métrica não é incrementada em reconciliação consistente
      const afterMetrics = await testMetrics.getMetrics();
      const afterMismatch = /wagering_reconciliation_mismatch_total\s+(\d+)/.exec(afterMetrics)?.[1] ?? '0';
      expect(afterMismatch).toBe(initialMismatch);

      // Nenhum log warn foi emitido
      const warnLogs = capturedLogs.filter((line) => line.includes('"warn"'));
      expect(warnLogs).toHaveLength(0);
    });

    test('cenário inconsistente: saldo adulterado por SQL cru (triggers desligados) reporta consistent false sem correção', async () => {
      const playerId = randomUUID();
      const created = await createWallet(playerId, '500.00');
      expect(created.status).toBe(201);
      const walletId = created.body.id;

      await submitWager({ walletId, playerId, kind: 'BET', amount: '100.00' });
      // Saldo legítimo atual = 400.00 BRL (2 entradas no ledger: OPENING 500, BET 100)

      // Adulterar o saldo via SQL cru desligando triggers com session_replication_role = replica
      await orm.em.fork().execute(
        `SET session_replication_role = replica;
         UPDATE wallet SET balance = balance + 200.00 WHERE id = ?;
         SET session_replication_role = DEFAULT;`,
        [walletId],
      );

      // Verifica que o saldo adulterado no banco está em 600.00 BRL
      const tamperedWallet = await orm.em.fork().findOne(WalletRecord, { id: walletId });
      expect(tamperedWallet?.balance).toBe('600.00');

      capturedLogs.length = 0;
      const initialMetrics = await testMetrics.getMetrics();
      const initialMismatchMatch = /wagering_reconciliation_mismatch_total\s+(\d+)/.exec(initialMetrics);
      const initialMismatchCount = initialMismatchMatch ? parseInt(initialMismatchMatch[1]!, 10) : 0;

      // Chama a reconciliação
      const res = await apiRequest('POST', `/wallets/${walletId}/reconciliation`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        walletId,
        storedBalance: { amount: '600.00', currency: 'BRL' },
        calculatedBalance: { amount: '400.00', currency: 'BRL' },
        difference: { amount: '200.00', currency: 'BRL' },
        consistent: false,
        checkedEntries: 2,
      });

      // 1. Métrica wagering_reconciliation_mismatch_total incrementada
      const afterMetrics = await testMetrics.getMetrics();
      const afterMismatchMatch = /wagering_reconciliation_mismatch_total\s+(\d+)/.exec(afterMetrics);
      const afterMismatchCount = afterMismatchMatch ? parseInt(afterMismatchMatch[1]!, 10) : 0;
      expect(afterMismatchCount).toBe(initialMismatchCount + 1);

      // 2. Log warn estruturado emitido
      const mismatchLogs = capturedLogs.filter((line) => line.includes('Reconciliation mismatch detected'));
      expect(mismatchLogs.length).toBeGreaterThan(0);
      const logEntry = JSON.parse(mismatchLogs[0]!);
      expect(logEntry.level).toBe('warn');
      expect(logEntry.walletId).toBe(walletId);
      expect(logEntry.consistent).toBe(false);

      // 3. Regra de ouro da observabilidade: proibido expor quantia monetária em log (I-23 / restrição 5.1)
      expect(mismatchLogs[0]).not.toMatch(/"amount"\s*:\s*"[^"]*"/);
      expect(mismatchLogs[0]).not.toMatch(/"storedBalance"/);
      expect(mismatchLogs[0]).not.toMatch(/"calculatedBalance"/);

      // 4. Invariante inviolável (§9): divergências NÃO são corrigidas silenciosamente
      const walletAfter = await orm.em.fork().findOne(WalletRecord, { id: walletId });
      expect(walletAfter?.balance).toBe('600.00');

      const httpCheck = await apiRequest('GET', `/wallets/${walletId}`);
      expect(httpCheck.status).toBe(200);
      expect(httpCheck.body.balance).toEqual({ amount: '600.00', currency: 'BRL' });
    });
  });
});
