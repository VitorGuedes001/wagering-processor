import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { type INestApplication, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { RequestErrorCode } from '../../src/application/contracts';
import { TransientInfrastructureError } from '../../src/application/ports';
import { FailureCode } from '../../src/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
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
import { AuthGuard } from '../../src/interface/http/auth.guard';
import { CorrelationIdMiddleware } from '../../src/interface/http/correlation-id.middleware';
import { HttpErrorFilter } from '../../src/interface/http/error-mapping';
import { WageringController } from '../../src/interface/http/wagering.controller';
import { WageringModule } from '../../src/interface/wagering.module';
import { AcceptAllProviderIdentity, PROVIDER_IDENTITY } from '../../src/infrastructure/provider-identity';
import { ApplicationTransactionQueries } from '../../src/application/queries';
import { SubmitWagerTransaction } from '../../src/application/submit-wager-transaction';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertAllWalletsConsistent } from '../support/invariants';
import { getTestInfraConfig } from '../support/preload';

describe('HTTP Endpoints Integration (I-05 a I-11)', () => {
  let db: TestDatabase;
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let app: INestApplication;
  let baseUrl: string;

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

  // Helper de requisições HTTP
  async function apiRequest(
    method: 'GET' | 'POST',
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...(options.headers || {}),
    };

    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    let json: any = undefined;
    const text = await res.text();
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }

    return {
      status: res.status,
      headers: res.headers,
      body: json,
    };
  }

  // ------------------------------------------------------------------ I-05
  describe('I-05: CreateWallet com saldo e sem saldo', () => {
    test('com saldo inicial > 0: OPENING, wallet_version = 1 e dois eventos no outbox', async () => {
      const playerId = randomUUID();
      const res = await apiRequest('POST', '/wallets', {
        body: {
          playerId,
          initialBalance: { amount: '1000.00', currency: 'BRL' },
        },
      });

      expect(res.status).toBe(201);
      expect(res.headers.get('x-correlation-id')).toBeDefined();
      expect(res.body.playerId).toBe(playerId);
      expect(res.body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(res.body.version).toBe(1);

      const walletId = res.body.id;

      // Consulta no banco
      const txRows = await db.sql`select * from wager_transaction where wallet_id = ${walletId}`;
      expect(txRows.length).toBe(1);
      expect((txRows[0] as any).kind).toBe(WagerTransactionKind.Opening);
      expect((txRows[0] as any).status).toBe(WagerTransactionStatus.Processed);
      expect((txRows[0] as any).amount).toBe('1000.00');

      const ledgerRows = await db.sql`select * from wallet_ledger_entry where wallet_id = ${walletId}`;
      expect(ledgerRows.length).toBe(1);
      expect((ledgerRows[0] as any).wallet_version).toBe(1);
      expect((ledgerRows[0] as any).direction).toBe('CREDIT');
      expect((ledgerRows[0] as any).amount).toBe('1000.00');

      const outboxRows = await db.sql`select * from outbox_message where aggregate_id = ${walletId} or (payload->'data'->>'walletId') = ${walletId}`;
      expect(outboxRows.length).toBe(2);
      const eventTypes = outboxRows.map((r: any) => r.event_type);
      expect(eventTypes).toContain('WagerTransactionProcessed');
      expect(eventTypes).toContain('WalletBalanceChanged');

      // GET /wallets/:id
      const getRes = await apiRequest('GET', `/wallets/${walletId}`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.id).toBe(walletId);
      expect(getRes.body.balance).toEqual({ amount: '1000.00', currency: 'BRL' });

      await assertAllWalletsConsistent(db.sql);
    });

    test('sem saldo inicial (0.00): sem OPENING, sem ledger, sem eventos', async () => {
      const playerId = randomUUID();
      const res = await apiRequest('POST', '/wallets', {
        body: {
          playerId,
          initialBalance: { amount: '0.00', currency: 'BRL' },
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(res.body.version).toBe(1);

      const walletId = res.body.id;

      const txRows = await db.sql`select * from wager_transaction where wallet_id = ${walletId}`;
      expect(txRows.length).toBe(0);

      const ledgerRows = await db.sql`select * from wallet_ledger_entry where wallet_id = ${walletId}`;
      expect(ledgerRows.length).toBe(0);

      const outboxRows = await db.sql`select * from outbox_message where aggregate_id = ${walletId}`;
      expect(outboxRows.length).toBe(0);

      await assertAllWalletsConsistent(db.sql);
    });

    test('duplicata para o mesmo playerId + currency retorna 409 WALLET_ALREADY_EXISTS', async () => {
      const playerId = randomUUID();
      const res1 = await apiRequest('POST', '/wallets', {
        body: {
          playerId,
          initialBalance: { amount: '100.00', currency: 'BRL' },
        },
      });
      expect(res1.status).toBe(201);

      const res2 = await apiRequest('POST', '/wallets', {
        body: {
          playerId,
          initialBalance: { amount: '50.00', currency: 'BRL' },
        },
      });
      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe(RequestErrorCode.WalletAlreadyExists);
    });

    test('GET /wallets/:id inexistente retorna 404 WALLET_NOT_FOUND', async () => {
      const res = await apiRequest('GET', `/wallets/${randomUUID()}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe(RequestErrorCode.WalletNotFound);
    });
  });

  // ------------------------------------------------------------------ I-06
  describe('I-06: Cada kind via HTTP (BET, WIN, LOSS, REFUND, ROLLBACK)', () => {
    test('fluxo completo de movimentos financeiros e eventos esperados', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;
      const providerId = 'provider-test';

      // 1. BET 25.00
      const betExtId = `bet-${randomUUID()}`;
      const betRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${betExtId}` },
        body: {
          providerId,
          externalTransactionId: betExtId,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      });
      expect(betRes.status).toBe(200);
      expect(betRes.body.status).toBe('PROCESSED');
      expect(betRes.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
      expect(betRes.body.idempotentReplay).toBe(false);

      // 2. WIN 50.00 com referência à BET
      const winExtId = `win-${randomUUID()}`;
      const winRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${winExtId}` },
        body: {
          providerId,
          externalTransactionId: winExtId,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        },
      });
      expect(winRes.status).toBe(200);
      expect(winRes.body.status).toBe('PROCESSED');
      expect(winRes.body.balance).toEqual({ amount: '1025.00', currency: 'BRL' });

      // 3. LOSS 0.00 referenciando a BET
      const lossExtId = `loss-${randomUUID()}`;
      const lossRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${lossExtId}` },
        body: {
          providerId,
          externalTransactionId: lossExtId,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'LOSS',
          money: { amount: '0.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        },
      });
      expect(lossRes.status).toBe(200);
      expect(lossRes.body.status).toBe('PROCESSED');
      expect(lossRes.body.balance).toEqual({ amount: '1025.00', currency: 'BRL' });

      // 4. REFUND de outra BET
      const bet2ExtId = `bet2-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${bet2ExtId}` },
        body: {
          providerId,
          externalTransactionId: bet2ExtId,
          playerId,
          walletId,
          roundId: 'round-2',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '100.00', currency: 'BRL' },
        },
      });

      const refundExtId = `refund-${randomUUID()}`;
      const refundRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${refundExtId}` },
        body: {
          providerId,
          externalTransactionId: refundExtId,
          playerId,
          walletId,
          roundId: 'round-2',
          gameId: 'game-1',
          kind: 'REFUND',
          money: { amount: '100.00', currency: 'BRL' },
          referenceExternalTransactionId: bet2ExtId,
        },
      });
      expect(refundRes.status).toBe(200);
      expect(refundRes.body.status).toBe('PROCESSED');
      expect(refundRes.body.balance).toEqual({ amount: '1025.00', currency: 'BRL' });

      // 5. ROLLBACK de uma BET
      const bet3ExtId = `bet3-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${bet3ExtId}` },
        body: {
          providerId,
          externalTransactionId: bet3ExtId,
          playerId,
          walletId,
          roundId: 'round-3',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '200.00', currency: 'BRL' },
        },
      });

      const rollbackBetExtId = `rb-bet-${randomUUID()}`;
      const rbBetRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${rollbackBetExtId}` },
        body: {
          providerId,
          externalTransactionId: rollbackBetExtId,
          playerId,
          walletId,
          roundId: 'round-3',
          gameId: 'game-1',
          kind: 'ROLLBACK',
          money: { amount: '200.00', currency: 'BRL' },
          referenceExternalTransactionId: bet3ExtId,
        },
      });
      expect(rbBetRes.status).toBe(200);
      expect(rbBetRes.body.balance).toEqual({ amount: '1025.00', currency: 'BRL' });

      // 6. ROLLBACK de uma WIN
      const bet4ExtId = `bet4-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${bet4ExtId}` },
        body: {
          providerId,
          externalTransactionId: bet4ExtId,
          playerId,
          walletId,
          roundId: 'round-4',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '50.00', currency: 'BRL' },
        },
      });

      const win2ExtId = `win2-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${win2ExtId}` },
        body: {
          providerId,
          externalTransactionId: win2ExtId,
          playerId,
          walletId,
          roundId: 'round-4',
          gameId: 'game-1',
          kind: 'WIN',
          money: { amount: '150.00', currency: 'BRL' },
          referenceExternalTransactionId: bet4ExtId,
        },
      });

      const rbWinExtId = `rb-win-${randomUUID()}`;
      const rbWinRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${rbWinExtId}` },
        body: {
          providerId,
          externalTransactionId: rbWinExtId,
          playerId,
          walletId,
          roundId: 'round-4',
          gameId: 'game-1',
          kind: 'ROLLBACK',
          money: { amount: '150.00', currency: 'BRL' },
          referenceExternalTransactionId: win2ExtId,
        },
      });
      expect(rbWinRes.status).toBe(200);
      expect(rbWinRes.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });

      // 7. ROLLBACK de um REFUND
      const bet5ExtId = `bet5-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${bet5ExtId}` },
        body: {
          providerId,
          externalTransactionId: bet5ExtId,
          playerId,
          walletId,
          roundId: 'round-5',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '30.00', currency: 'BRL' },
        },
      });

      const refund2ExtId = `refund2-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${refund2ExtId}` },
        body: {
          providerId,
          externalTransactionId: refund2ExtId,
          playerId,
          walletId,
          roundId: 'round-5',
          gameId: 'game-1',
          kind: 'REFUND',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: bet5ExtId,
        },
      });

      const rbRefundExtId = `rb-ref-${randomUUID()}`;
      const rbRefRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${rbRefundExtId}` },
        body: {
          providerId,
          externalTransactionId: rbRefundExtId,
          playerId,
          walletId,
          roundId: 'round-5',
          gameId: 'game-1',
          kind: 'ROLLBACK',
          money: { amount: '30.00', currency: 'BRL' },
          referenceExternalTransactionId: refund2ExtId,
        },
      });
      expect(rbRefRes.status).toBe(200);
      expect(rbRefRes.body.balance).toEqual({ amount: '945.00', currency: 'BRL' });

      await assertAllWalletsConsistent(db.sql);
    });
  });

  // ------------------------------------------------------------------ I-07
  describe('I-07: Cada failureCode de MODELAGEM 10.1 com 422', () => {
    test('INSUFFICIENT_FUNDS', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '50.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;

      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${randomUUID()}` },
        body: {
          providerId: 'prov-1',
          externalTransactionId: `tx-${randomUUID()}`,
          playerId,
          walletId,
          roundId: 'r-1',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '100.00', currency: 'BRL' },
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.status).toBe('REJECTED');
      expect(res.body.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(res.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });
    });

    test('REVERSAL_INSUFFICIENT_FUNDS', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '0.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;
      const providerId = 'prov-rev';

      const winExtId = `win-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${winExtId}` },
        body: {
          providerId,
          externalTransactionId: winExtId,
          playerId,
          walletId,
          roundId: 'r-rev',
          gameId: 'g-1',
          kind: 'WIN',
          money: { amount: '100.00', currency: 'BRL' },
        },
      });

      // Gasta quase tudo
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-spend` },
        body: {
          providerId,
          externalTransactionId: `bet-spend-${randomUUID()}`,
          playerId,
          walletId,
          roundId: 'r-rev2',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        },
      });

      // Rollback do WIN de 100 com saldo de apenas 20
      const rbRes = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-rb-win` },
        body: {
          providerId,
          externalTransactionId: `rb-win-${randomUUID()}`,
          playerId,
          walletId,
          roundId: 'r-rev',
          gameId: 'g-1',
          kind: 'ROLLBACK',
          money: { amount: '100.00', currency: 'BRL' },
          referenceExternalTransactionId: winExtId,
        },
      });

      expect(rbRes.status).toBe(422);
      expect(rbRes.body.status).toBe('REJECTED');
      expect(rbRes.body.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    });

    test('CURRENCY_MISMATCH', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });

      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${randomUUID()}` },
        body: {
          providerId: 'prov-1',
          externalTransactionId: `tx-${randomUUID()}`,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-curr',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'USD' },
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe(FailureCode.CurrencyMismatch);
    });

    test('WALLET_PLAYER_MISMATCH', async () => {
      const playerId = randomUUID();
      const otherPlayerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });

      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${randomUUID()}` },
        body: {
          providerId: 'prov-1',
          externalTransactionId: `tx-${randomUUID()}`,
          playerId: otherPlayerId,
          walletId: wRes.body.id,
          roundId: 'r-player',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe(FailureCode.WalletPlayerMismatch);
    });

    test('REFERENCE_NOT_PROCESSED', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } },
      });
      const providerId = 'prov-ref-proc';

      // Cria aposta que é REJECTED
      const rejectedBetExtId = `bet-fail-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${rejectedBetExtId}` },
        body: {
          providerId,
          externalTransactionId: rejectedBetExtId,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-fail',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '100.00', currency: 'BRL' },
        },
      });

      // Tenta refund da aposta rejected
      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-ref-${randomUUID()}` },
        body: {
          providerId,
          externalTransactionId: `ref-${randomUUID()}`,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-fail',
          gameId: 'g-1',
          kind: 'REFUND',
          money: { amount: '100.00', currency: 'BRL' },
          referenceExternalTransactionId: rejectedBetExtId,
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    });

    test('REFERENCE_KIND_NOT_ALLOWED', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });
      const providerId = 'prov-ref-kind';

      // Cria WIN
      const winExtId = `win-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${winExtId}` },
        body: {
          providerId,
          externalTransactionId: winExtId,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-kind',
          gameId: 'g-1',
          kind: 'WIN',
          money: { amount: '50.00', currency: 'BRL' },
        },
      });

      // REFUND de WIN é proibido (só de BET)
      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-ref-win` },
        body: {
          providerId,
          externalTransactionId: `ref-${randomUUID()}`,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-kind',
          gameId: 'g-1',
          kind: 'REFUND',
          money: { amount: '50.00', currency: 'BRL' },
          referenceExternalTransactionId: winExtId,
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe(FailureCode.ReferenceKindNotAllowed);
    });

    test('REFERENCE_CONTEXT_MISMATCH', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });
      const providerId = 'prov-ctx';

      const betExtId = `bet-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${betExtId}` },
        body: {
          providerId,
          externalTransactionId: betExtId,
          playerId,
          walletId: wRes.body.id,
          roundId: 'round-original',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      });

      // REFUND com roundId diferente
      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-ref-ctx` },
        body: {
          providerId,
          externalTransactionId: `ref-${randomUUID()}`,
          playerId,
          walletId: wRes.body.id,
          roundId: 'round-different',
          gameId: 'g-1',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe(FailureCode.ReferenceContextMismatch);
    });

    test('REFERENCE_AMOUNT_MISMATCH', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });
      const providerId = 'prov-amt';

      const betExtId = `bet-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${betExtId}` },
        body: {
          providerId,
          externalTransactionId: betExtId,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-amt',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      });

      // REFUND com valor divergente
      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-ref-amt` },
        body: {
          providerId,
          externalTransactionId: `ref-${randomUUID()}`,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-amt',
          gameId: 'g-1',
          kind: 'REFUND',
          money: { amount: '10.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        },
      });

      expect(res.status).toBe(422);
      expect(res.body.failureCode).toBe(FailureCode.ReferenceAmountMismatch);
    });

    test('REFERENCE_ALREADY_REVERSED', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });
      const providerId = 'prov-already-rev';

      const betExtId = `bet-${randomUUID()}`;
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${betExtId}` },
        body: {
          providerId,
          externalTransactionId: betExtId,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-rev-dup',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      });

      // 1o REFUND: OK
      const ref1ExtId = `ref1-${randomUUID()}`;
      const res1 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${ref1ExtId}` },
        body: {
          providerId,
          externalTransactionId: ref1ExtId,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-rev-dup',
          gameId: 'g-1',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        },
      });
      expect(res1.status).toBe(200);

      // 2o REFUND com novo externalTransactionId: rejeita REFERENCE_ALREADY_REVERSED
      const ref2ExtId = `ref2-${randomUUID()}`;
      const res2 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${ref2ExtId}` },
        body: {
          providerId,
          externalTransactionId: ref2ExtId,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-rev-dup',
          gameId: 'g-1',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: betExtId,
        },
      });
      expect(res2.status).toBe(422);
      expect(res2.body.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    });
  });

  // ------------------------------------------------------------------ I-08
  describe('I-08: Contrato de status HTTP (ARQUITETURA 6.2)', () => {
    test('PENDING_REFERENCE retorna status 202', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });

      // REFUND sem a referência existir ainda
      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${randomUUID()}` },
        body: {
          providerId: 'prov-pending',
          externalTransactionId: `ref-pending-${randomUUID()}`,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-pend',
          gameId: 'g-1',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: 'bet-not-yet-here',
        },
      });

      expect(res.status).toBe(202);
      expect(res.body.status).toBe('PENDING_REFERENCE');
      expect(res.body.balance).toBeUndefined();
    });

    test('Header Idempotency-Key ausente retorna 400 INVALID_PAYLOAD', async () => {
      const res = await apiRequest('POST', '/wagering/transactions', {
        body: {
          providerId: 'prov-1',
          externalTransactionId: 'tx-1',
          playerId: randomUUID(),
          walletId: randomUUID(),
          roundId: 'r-1',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(RequestErrorCode.InvalidPayload);
    });

    test('Rota alternativa /wagers/v1 funciona com o mesmo contrato', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });

      const res = await apiRequest('POST', '/wagers/v1', {
        headers: { 'idempotency-key': `key-${randomUUID()}` },
        body: {
          providerId: 'prov-v1',
          externalTransactionId: `tx-v1-${randomUUID()}`,
          playerId,
          walletId: wRes.body.id,
          roundId: 'r-v1',
          gameId: 'g-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('PROCESSED');
    });

    test('Falha transitória retorna 503 com Retry-After: 1', async () => {
      // Mock pontual do use case para simular falha transitória
      @Module({
        controllers: [WageringController],
        providers: [
          AuthGuard,
          HttpErrorFilter,
          CorrelationIdMiddleware,
          {
            provide: SubmitWagerTransaction,
            useValue: {
              execute: async () => {
                throw new TransientInfrastructureError('Lock timeout simulado');
              },
            },
          },
          { provide: PROVIDER_IDENTITY, useClass: AcceptAllProviderIdentity },
          {
            provide: ApplicationTransactionQueries,
            useValue: {
              findById: async () => undefined,
              findByExternalId: async () => undefined,
            },
          },
        ],
      })
      class TransientModule implements NestModule {
        configure(consumer: MiddlewareConsumer) {
          consumer.apply(CorrelationIdMiddleware).forRoutes('*');
        }
      }

      const customModule = await NestFactory.create(TransientModule, { logger: false });
      await customModule.listen(0);
      const port = (customModule.getHttpServer().address() as any).port;

      const res = await fetch(`http://localhost:${port}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'test-transient',
        },
        body: JSON.stringify({
          providerId: 'prov',
          externalTransactionId: 'ext-transient',
          playerId: randomUUID(),
          walletId: randomUUID(),
          roundId: 'r',
          gameId: 'g',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        }),
      });

      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      const json = (await res.json()) as any;
      expect(json.code).toBe(RequestErrorCode.ServiceUnavailable);

      await customModule.close();
    });
  });

  // ------------------------------------------------------------------ I-09
  describe('I-09: Replay com saldo original para PROCESSED, REJECTED e LOSS', () => {
    test('PROCESSED: replay devolve saldo do momento mesmo após outras movimentações', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;
      const providerId = 'prov-replay-proc';
      const extId = `bet-replay-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      const payload = {
        providerId,
        externalTransactionId: extId,
        playerId,
        walletId,
        roundId: 'round-replay',
        gameId: 'g-1',
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
      };

      // 1ª chamada
      const res1 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': idemKey },
        body: payload,
      });
      expect(res1.status).toBe(200);
      expect(res1.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
      expect(res1.body.idempotentReplay).toBe(false);

      // Movimentação intermediária que altera o saldo da wallet para 875.00
      await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-other-${randomUUID()}` },
        body: {
          ...payload,
          externalTransactionId: `bet-interm-${randomUUID()}`,
          money: { amount: '100.00', currency: 'BRL' },
        },
      });

      // 2ª chamada (replay da 1ª): deve devolver saldo 975.00, NÃO 875.00
      const res2 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': idemKey },
        body: payload,
      });
      expect(res2.status).toBe(200);
      expect(res2.body.transactionId).toBe(res1.body.transactionId);
      expect(res2.body.balance).toEqual({ amount: '975.00', currency: 'BRL' });
      expect(res2.body.idempotentReplay).toBe(true);
      expect(res2.headers.get('x-idempotent-replay')).toBe('true');
    });

    test('REJECTED: replay devolve rejection e saldo daquele momento', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '50.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;
      const providerId = 'prov-replay-rej';
      const extId = `bet-fail-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      const payload = {
        providerId,
        externalTransactionId: extId,
        playerId,
        walletId,
        roundId: 'round-fail',
        gameId: 'g-1',
        kind: 'BET',
        money: { amount: '100.00', currency: 'BRL' },
      };

      // 1ª chamada: 422
      const res1 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': idemKey },
        body: payload,
      });
      expect(res1.status).toBe(422);
      expect(res1.body.status).toBe('REJECTED');
      expect(res1.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });
      expect(res1.body.idempotentReplay).toBe(false);

      // Reenvio idêntico
      const res2 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': idemKey },
        body: payload,
      });
      expect(res2.status).toBe(422);
      expect(res2.body.status).toBe('REJECTED');
      expect(res2.body.transactionId).toBe(res1.body.transactionId);
      expect(res2.body.balance).toEqual({ amount: '50.00', currency: 'BRL' });
      expect(res2.body.idempotentReplay).toBe(true);
    });

    test('LOSS: replay idêntico devolve 200 com idempotentReplay: true', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '100.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;
      const providerId = 'prov-replay-loss';
      const extId = `loss-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      const payload = {
        providerId,
        externalTransactionId: extId,
        playerId,
        walletId,
        roundId: 'round-loss',
        gameId: 'g-1',
        kind: 'LOSS',
        money: { amount: '0.00', currency: 'BRL' },
      };

      const res1 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': idemKey },
        body: payload,
      });
      expect(res1.status).toBe(200);
      expect(res1.body.idempotentReplay).toBe(false);

      const res2 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': idemKey },
        body: payload,
      });
      expect(res2.status).toBe(200);
      expect(res2.body.idempotentReplay).toBe(true);
    });
  });

  // ------------------------------------------------------------------ I-10
  describe('I-10: Conflitos de idempotência e externalId (409)', () => {
    test('mesma idempotency key com payload diferente retorna 409 IDEMPOTENCY_CONFLICT', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '500.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;
      const providerId = 'prov-conflict';
      const sharedKey = `shared-key-${randomUUID()}`;

      // 1ª requisição
      const res1 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': sharedKey },
        body: {
          providerId,
          externalTransactionId: `tx-1-${randomUUID()}`,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      expect(res1.status).toBe(200);

      // 2ª requisição: mesma key, valor diferente
      const res2 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': sharedKey },
        body: {
          providerId,
          externalTransactionId: `tx-2-${randomUUID()}`,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '20.00', currency: 'BRL' },
        },
      });
      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe(RequestErrorCode.IdempotencyConflict);
    });

    test('mesmo externalTransactionId com outra idempotency key retorna 409 EXTERNAL_ID_CONFLICT', async () => {
      const playerId = randomUUID();
      const wRes = await apiRequest('POST', '/wallets', {
        body: { playerId, initialBalance: { amount: '500.00', currency: 'BRL' } },
      });
      const walletId = wRes.body.id;
      const providerId = 'prov-ext-conflict';
      const sharedExtId = `tx-ext-${randomUUID()}`;

      // 1ª requisição
      const res1 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-1-${randomUUID()}` },
        body: {
          providerId,
          externalTransactionId: sharedExtId,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      expect(res1.status).toBe(200);

      // 2ª requisição: mesmo externalId, outra key
      const res2 = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-2-${randomUUID()}` },
        body: {
          providerId,
          externalTransactionId: sharedExtId,
          playerId,
          walletId,
          roundId: 'round-1',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
        },
      });
      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe(RequestErrorCode.ExternalIdConflict);
    });
  });

  // ------------------------------------------------------------------ I-11
  describe('I-11: Restrição 5.1 — amount numérico rejeitado na borda HTTP com 400', () => {
    test('amount: 25 (número) via HTTP retorna 400 INVALID_PAYLOAD', async () => {
      const playerId = randomUUID();
      const walletId = randomUUID();

      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${randomUUID()}` },
        body: {
          providerId: 'prov-num',
          externalTransactionId: `tx-${randomUUID()}`,
          playerId,
          walletId,
          roundId: 'round-num',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: 25, currency: 'BRL' }, // número bruto!
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(RequestErrorCode.InvalidPayload);
    });

    test('amount: "25" (sem casas decimais) via HTTP retorna 400 INVALID_PAYLOAD', async () => {
      const res = await apiRequest('POST', '/wagering/transactions', {
        headers: { 'idempotency-key': `key-${randomUUID()}` },
        body: {
          providerId: 'prov-num',
          externalTransactionId: `tx-${randomUUID()}`,
          playerId: randomUUID(),
          walletId: randomUUID(),
          roundId: 'round-num',
          gameId: 'game-1',
          kind: 'BET',
          money: { amount: '25', currency: 'BRL' },
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(RequestErrorCode.InvalidPayload);
    });

    test('POST /wallets com initialBalance.amount numérico retorna 400 INVALID_PAYLOAD', async () => {
      const res = await apiRequest('POST', '/wallets', {
        body: {
          playerId: randomUUID(),
          initialBalance: { amount: 1000, currency: 'BRL' },
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(RequestErrorCode.InvalidPayload);
    });
  });
});
