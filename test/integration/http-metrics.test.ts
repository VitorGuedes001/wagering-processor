import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/inbox-repository';
import { MikroOrmLedgerRepository } from '../../src/infrastructure/persistence/ledger-repository';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/outbox-repository';
import { InboxMessageRecord } from '../../src/infrastructure/persistence/records/inbox-message.record';
import { LedgerEntryRecord } from '../../src/infrastructure/persistence/records/ledger-entry.record';
import { OutboxMessageRecord } from '../../src/infrastructure/persistence/records/outbox-message.record';
import { WagerTransactionRecord } from '../../src/infrastructure/persistence/records/wager-transaction.record';
import { WalletRecord } from '../../src/infrastructure/persistence/records/wallet.record';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction-repository';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/wallet-repository';
import { WageringModule } from '../../src/interface/wagering.module';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertAllWalletsConsistent } from '../support/invariants';
import { holdWalletLock } from '../support/lock-gate';
import { getTestInfraConfig } from '../support/preload';

/**
 * O caminho HTTP alimenta as métricas de ARQUITETURA 9, como o consumidor
 * SQS já fazia. Cada asserção compara com a leitura anterior, porque o registry
 * é um só para o arquivo.
 */
describe('T52: métricas do caminho HTTP (ARQUITETURA 9)', () => {
  let db: TestDatabase;
  let orm: MikroORM;
  let app: INestApplication;
  let metrics: MetricsRegistry;
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
        entities: [WalletRecord, LedgerEntryRecord, WagerTransactionRecord, InboxMessageRecord, OutboxMessageRecord],
        metadataProvider: ReflectMetadataProvider,
        debug: false,
        forceUtcTimezone: true,
      }),
    );

    // lock_timeout curto: o teste de conflito não precisa esperar os 2 s padrão.
    const uow = new MikroOrmUnitOfWork(orm, { DB_LOCK_TIMEOUT_MS: 300 }, {
      wallets: (em) => new MikroOrmWalletRepository(em),
      ledger: (em) => new MikroOrmLedgerRepository(em),
      transactions: (em) => new MikroOrmWagerTransactionRepository(em),
      inbox: (em) => new MikroOrmInboxRepository(em),
      outbox: (em) => new MikroOrmOutboxRepository(em),
    });

    @Module({ imports: [WageringModule.withUnitOfWork(uow)] })
    class TestAppModule {}

    app = await NestFactory.create(TestAppModule, { logger: false });
    await app.listen(0);
    metrics = app.get(MetricsRegistry);
    const address = app.getHttpServer().address();
    baseUrl = `http://localhost:${typeof address === 'object' && address !== null ? address.port : 3000}`;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (orm) await orm.close();
    if (db) await db.drop();
  });

  /** Valor de uma série no texto Prometheus; 0 se a série ainda não existe. */
  async function value(series: string): Promise<number> {
    const output = await metrics.getMetrics();
    const line = output.split('\n').find((l) => l.startsWith(`${series} `));
    return line ? Number.parseFloat(line.slice(series.length + 1)) : 0;
  }

  async function createWallet(amount: string): Promise<{ walletId: string; playerId: string }> {
    const playerId = randomUUID();
    const res = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: { amount, currency: 'BRL' } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return { walletId: body.id, playerId };
  }

  async function bet(wallet: { walletId: string; playerId: string }, externalId: string, amount: string) {
    return fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `prov-m:${externalId}` },
      body: JSON.stringify({
        providerId: 'prov-m',
        externalTransactionId: externalId,
        playerId: wallet.playerId,
        walletId: wallet.walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: 'BET',
        money: { amount, currency: 'BRL' },
      }),
    });
  }

  test('BET processado conta em transactions_total, na latência entry="http" e na requisição HTTP', async () => {
    const processed = 'wagering_transactions_total{kind="BET",status="PROCESSED"}';
    const latency = 'wagering_processing_duration_seconds_count{entry="http"}';
    const requests = 'wagering_http_requests_total{method="POST",path="/wagering/transactions",status="200"}';
    const before = [await value(processed), await value(latency), await value(requests)];

    const wallet = await createWallet('100.00');
    const res = await bet(wallet, `ok-${randomUUID()}`, '10.00');
    expect(res.status).toBe(200);

    expect(await value(processed)).toBe(before[0]! + 1);
    expect(await value(latency)).toBe(before[1]! + 1);
    expect(await value(requests)).toBe(before[2]! + 1);
    expect(await value('wagering_http_requests_total{method="POST",path="/wallets",status="201"}')).toBeGreaterThan(0);
  });

  test('replay pela Idempotency-Key conta em duplicates_total{source="http"} e não conta de novo a transação', async () => {
    const duplicates = 'wagering_duplicates_total{source="http"}';
    const processed = 'wagering_transactions_total{kind="BET",status="PROCESSED"}';
    const wallet = await createWallet('100.00');
    const externalId = `replay-${randomUUID()}`;
    expect((await bet(wallet, externalId, '10.00')).status).toBe(200);
    const before = [await value(duplicates), await value(processed)];

    const replay = await bet(wallet, externalId, '10.00');
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);

    expect(await value(duplicates)).toBe(before[0]! + 1);
    expect(await value(processed)).toBe(before[1]!);
  });

  test('rejeição conta em transactions_total{status="REJECTED"} e em transactions_rejected_total pelo failureCode', async () => {
    const rejected = 'wagering_transactions_total{kind="BET",status="REJECTED"}';
    const reason = 'wagering_transactions_rejected_total{reason="INSUFFICIENT_FUNDS"}';
    const before = [await value(rejected), await value(reason)];

    const wallet = await createWallet('5.00');
    expect((await bet(wallet, `nofunds-${randomUUID()}`, '10.00')).status).toBe(422);

    expect(await value(rejected)).toBe(before[0]! + 1);
    expect(await value(reason)).toBe(before[1]! + 1);
  });

  test('a requisição é rotulada pela rota casada, e a sem rota vira "unmatched"', async () => {
    const wallet = await createWallet('1.00');
    const byId = 'wagering_http_requests_total{method="GET",path="/wallets/:id",status="200"}';
    const unmatched = 'wagering_http_requests_total{method="GET",path="unmatched",status="404"}';
    const before = [await value(byId), await value(unmatched)];

    expect((await fetch(`${baseUrl}/wallets/${wallet.walletId}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/nao-existe/${randomUUID()}`)).status).toBe(404);

    expect(await value(byId)).toBe(before[0]! + 1);
    expect(await value(unmatched)).toBe(before[1]! + 1);
    const output = await metrics.getMetrics();
    expect(output).not.toContain(wallet.walletId);
  });

  test('C-11: o 503 por lock_timeout conta em lock_conflicts_total; depois de soltar, o reenvio processa', async () => {
    const conflicts = 'wagering_lock_conflicts_total';
    const unavailable = 'wagering_http_requests_total{method="POST",path="/wagering/transactions",status="503"}';
    const before = [await value(conflicts), await value(unavailable)];

    const wallet = await createWallet('100.00');
    const externalId = `locked-${randomUUID()}`;
    const gate = await holdWalletLock(db, wallet.walletId);
    try {
      const res = await bet(wallet, externalId, '10.00');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
    } finally {
      await gate.release();
    }

    expect(await value(conflicts)).toBe(before[0]! + 1);
    expect(await value(unavailable)).toBe(before[1]! + 1);

    expect((await bet(wallet, externalId, '10.00')).status).toBe(200);
    await assertAllWalletsConsistent(db.sql);
  });
});
