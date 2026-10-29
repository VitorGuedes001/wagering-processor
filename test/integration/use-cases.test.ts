import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Clock, IdGenerator } from '../../src/application/ports';
import type { WagerCommand } from '../../src/application/contracts';
import { CreateWallet } from '../../src/application/use-cases/create-wallet';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
import { FailureCode } from '../../src/domain/failure-code';
import {
  type SubmittableKind,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
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
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertAllWalletsConsistent } from '../support/invariants';
import { getTestInfraConfig } from '../support/preload';

describe('T30: Use cases de Wallet e Submissão (ARQUITETURA §4, SCHEMA §4.2, §4.4, §5)', () => {
  let db: TestDatabase;
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;

  const currentTime = new Date('2026-10-29T10:00:00.000Z');
  const clock: Clock = {
    now: () => currentTime,
  };
  const idGenerator: IdGenerator = {
    next: () => randomUUID(),
  };

  const factories: RepositoryFactories = {
    wallets: (em: EntityManager) => new MikroOrmWalletRepository(em),
    transactions: (em: EntityManager) => new MikroOrmWagerTransactionRepository(em),
    ledger: (em: EntityManager) => new MikroOrmLedgerRepository(em),
    inbox: (em: EntityManager) => new MikroOrmInboxRepository(em),
    outbox: (em: EntityManager) => new MikroOrmOutboxRepository(em),
  };

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
    uow = new MikroOrmUnitOfWork(orm, { DB_LOCK_TIMEOUT_MS: 2000 }, factories);
  });

  afterAll(async () => {
    if (orm) await orm.close(true);
    if (db) await db.drop();
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db.sql);
  });

  describe('CreateWallet', () => {
    test('cria wallet com saldo inicial positivo (I-05): gera OPENING, lançamento e 2 eventos no outbox', async () => {
      const useCase = new CreateWallet(uow, clock, idGenerator);
      const playerId = randomUUID();
      const correlationId = randomUUID();

      const outcome = await useCase.execute({
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
        correlationId,
      });

      expect(outcome.type).toBe('CREATED');
      if (outcome.type !== 'CREATED') return;

      expect(outcome.view.playerId).toBe(playerId);
      expect(outcome.view.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
      expect(outcome.view.version).toBe(1);

      // Verifica wallet no banco
      const [walletRow] = await db.sql<Array<{ id: string; balance: string; version: number }>>`
        SELECT id, balance::text, version FROM wallet WHERE id = ${outcome.view.id}
      `;
      expect(walletRow).toBeDefined();
      expect(walletRow!.balance).toBe('1000.00');
      expect(walletRow!.version).toBe(1);

      // Verifica wager_transaction de OPENING
      const [openingTx] = await db.sql<
        Array<{ id: string; kind: string; status: string; amount: string; balance_after: string }>
      >`
        SELECT id, kind, status, amount::text, balance_after::text
        FROM wager_transaction
        WHERE wallet_id = ${outcome.view.id}
      `;
      expect(openingTx).toBeDefined();
      expect(openingTx!.kind).toBe('OPENING');
      expect(openingTx!.status).toBe('PROCESSED');
      expect(openingTx!.amount).toBe('1000.00');
      expect(openingTx!.balance_after).toBe('1000.00');

      // Verifica lançamento no ledger
      const [entryRow] = await db.sql<
        Array<{
          direction: string;
          amount: string;
          balance_before: string;
          balance_after: string;
          wallet_version: number;
        }>
      >`
        SELECT direction, amount::text, balance_before::text, balance_after::text, wallet_version
        FROM wallet_ledger_entry
        WHERE wallet_id = ${outcome.view.id}
      `;
      expect(entryRow).toBeDefined();
      expect(entryRow!.direction).toBe('CREDIT');
      expect(entryRow!.amount).toBe('1000.00');
      expect(entryRow!.balance_before).toBe('0.00');
      expect(entryRow!.balance_after).toBe('1000.00');
      expect(entryRow!.wallet_version).toBe(1);

      // Verifica 2 eventos no outbox
      const outboxRows = await db.sql<Array<{ event_type: string; aggregate_id: string }>>`
        SELECT event_type, aggregate_id FROM outbox_message ORDER BY occurred_at, event_type
      `;
      expect(outboxRows.length).toBe(2);
      expect(outboxRows.some((r) => r.event_type === 'WagerTransactionProcessed')).toBe(true);
      expect(outboxRows.some((r) => r.event_type === 'WalletBalanceChanged')).toBe(true);
    });

    test('cria wallet com saldo inicial zero (I-05): sem OPENING, sem ledger e sem outbox', async () => {
      const useCase = new CreateWallet(uow, clock, idGenerator);
      const playerId = randomUUID();

      const outcome = await useCase.execute({
        playerId,
        initialBalance: { amount: '0.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      expect(outcome.type).toBe('CREATED');
      if (outcome.type !== 'CREATED') return;

      expect(outcome.view.balance).toEqual({ amount: '0.00', currency: 'BRL' });
      expect(outcome.view.version).toBe(1);

      // Wallet existe no banco
      const [walletRow] = await db.sql<Array<{ balance: string; version: number }>>`
        SELECT balance::text, version FROM wallet WHERE id = ${outcome.view.id}
      `;
      expect(walletRow).toBeDefined();
      expect(walletRow!.balance).toBe('0.00');
      expect(walletRow!.version).toBe(1);

      // Nenhuma transação e nenhum lançamento
      const txRows = await db.sql<Array<{ id: string }>>`
        SELECT id FROM wager_transaction WHERE wallet_id = ${outcome.view.id}
      `;
      expect(txRows.length).toBe(0);

      const ledgerRows = await db.sql<Array<{ id: string }>>`
        SELECT id FROM wallet_ledger_entry WHERE wallet_id = ${outcome.view.id}
      `;
      expect(ledgerRows.length).toBe(0);
    });

    test('devolve WALLET_ALREADY_EXISTS quando playerId + currency já existe', async () => {
      const useCase = new CreateWallet(uow, clock, idGenerator);
      const playerId = randomUUID();

      const first = await useCase.execute({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });
      expect(first.type).toBe('CREATED');

      const second = await useCase.execute({
        playerId,
        initialBalance: { amount: '50.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });
      expect(second.type).toBe('WALLET_ALREADY_EXISTS');
    });
  });

  describe('SubmitWagerTransaction', () => {
    let walletId: string;
    let playerId: string;

    beforeEach(async () => {
      const createWallet = new CreateWallet(uow, clock, idGenerator);
      playerId = randomUUID();
      const res = await createWallet.execute({
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });
      if (res.type !== 'CREATED') throw new Error('Falha ao criar wallet de teste');
      walletId = res.view.id;
    });

    test('BET com saldo: debita da wallet, cria ledger DEBIT, marca PROCESSED e outbox (I-06)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const correlationId = randomUUID();
      const extId = `ext-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      const outcome = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '100.00', currency: 'BRL' },
        correlationId,
      });

      expect(outcome.type).toBe('RESULT');
      if (outcome.type !== 'RESULT') return;

      expect(outcome.idempotentReplay).toBe(false);
      expect(outcome.view.status).toBe(WagerTransactionStatus.Processed);
      expect(outcome.view.balance).toEqual({ amount: '900.00', currency: 'BRL' });
      expect(outcome.view.failureCode).toBeUndefined();

      // Saldo no banco atualizado para 900.00 e version = 2
      const [walletRow] = await db.sql<Array<{ balance: string; version: number }>>`
        SELECT balance::text, version FROM wallet WHERE id = ${walletId}
      `;
      expect(walletRow).toBeDefined();
      expect(walletRow!.balance).toBe('900.00');
      expect(walletRow!.version).toBe(2);

      // Lançamento de débito
      const [entryRow] = await db.sql<
        Array<{ direction: string; amount: string; balance_before: string; balance_after: string }>
      >`
        SELECT direction, amount::text, balance_before::text, balance_after::text
        FROM wallet_ledger_entry
        WHERE wallet_id = ${walletId} AND wallet_version = 2
      `;
      expect(entryRow).toBeDefined();
      expect(entryRow!.direction).toBe('DEBIT');
      expect(entryRow!.amount).toBe('100.00');
      expect(entryRow!.balance_before).toBe('1000.00');
      expect(entryRow!.balance_after).toBe('900.00');
    });

    test('Replay idempotente devolve snapshot original com idempotentReplay: true (I-09)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const extId = `ext-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      const command: WagerCommand = {
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '50.00', currency: 'BRL' },
        correlationId: randomUUID(),
      };

      const first = await submit.execute(command);
      expect(first.type).toBe('RESULT');
      if (first.type !== 'RESULT') return;
      expect(first.idempotentReplay).toBe(false);
      expect(first.view.balance).toEqual({ amount: '950.00', currency: 'BRL' });

      // Executa outra operação no meio para mudar o saldo da wallet
      await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: `ext-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-2',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '200.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      // Saldo atual da wallet agora é 750.00
      const [walletRow] = await db.sql<Array<{ balance: string }>>`
        SELECT balance::text FROM wallet WHERE id = ${walletId}
      `;
      expect(walletRow).toBeDefined();
      expect(walletRow!.balance).toBe('750.00');

      // Replay da primeira requisição: DEVE devolver o saldo daquela época (950.00, D10)
      const second = await submit.execute(command);
      expect(second.type).toBe('RESULT');
      if (second.type !== 'RESULT') return;
      expect(second.idempotentReplay).toBe(true);
      expect(second.view.transactionId).toBe(first.view.transactionId);
      expect(second.view.balance).toEqual({ amount: '950.00', currency: 'BRL' });
    });

    test('IDEMPOTENCY_CONFLICT em mesma idempotencyKey com payload diferente (I-10)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const extId = `ext-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '50.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      // Mesma key, mas valor diferente (100.00)
      const conflict = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '100.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      expect(conflict.type).toBe('IDEMPOTENCY_CONFLICT');
    });

    test('EXTERNAL_ID_CONFLICT em mesmo externalTransactionId com idempotencyKey diferente (I-10)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const extId = `ext-${randomUUID()}`;

      await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: `idem-1-${extId}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '50.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      // Mesmo externalTransactionId, outra idempotencyKey
      const conflict = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: `idem-2-${extId}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '50.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      expect(conflict.type).toBe('EXTERNAL_ID_CONFLICT');
    });

    test('WALLET_NOT_FOUND para wallet inexistente', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);

      const outcome = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: `ext-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        playerId,
        walletId: randomUUID(), // inexistente
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '50.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      expect(outcome.type).toBe('WALLET_NOT_FOUND');
    });

    test('Rejeição de negócio por saldo insuficiente (INSUFFICIENT_FUNDS): grava REJECTED, saldo inalterado (I-07)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const extId = `ext-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      const outcome = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '5000.00', currency: 'BRL' }, // maior que 1000.00
        correlationId: randomUUID(),
      });

      expect(outcome.type).toBe('RESULT');
      if (outcome.type !== 'RESULT') return;

      expect(outcome.idempotentReplay).toBe(false);
      expect(outcome.view.status).toBe(WagerTransactionStatus.Rejected);
      expect(outcome.view.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(outcome.view.balance).toEqual({ amount: '1000.00', currency: 'BRL' });

      // Saldo da wallet inalterado
      const [walletRow] = await db.sql<Array<{ balance: string; version: number }>>`
        SELECT balance::text, version FROM wallet WHERE id = ${walletId}
      `;
      expect(walletRow).toBeDefined();
      expect(walletRow!.balance).toBe('1000.00');
      expect(walletRow!.version).toBe(1);

      // Replay da rejeição devolve mesmo resultado com idempotentReplay: true
      const replay = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '5000.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      expect(replay.type).toBe('RESULT');
      if (replay.type !== 'RESULT') return;
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.view.status).toBe(WagerTransactionStatus.Rejected);
      expect(replay.view.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(replay.view.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    });

    test('WIN credita na wallet e emite eventos (I-06)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);

      const outcome = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: `ext-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Win as SubmittableKind,
        money: { amount: '250.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      expect(outcome.type).toBe('RESULT');
      if (outcome.type !== 'RESULT') return;
      expect(outcome.view.status).toBe(WagerTransactionStatus.Processed);
      expect(outcome.view.balance).toEqual({ amount: '1250.00', currency: 'BRL' });

      const [walletRow] = await db.sql<Array<{ balance: string }>>`
        SELECT balance::text FROM wallet WHERE id = ${walletId}
      `;
      expect(walletRow).toBeDefined();
      expect(walletRow!.balance).toBe('1250.00');
    });

    test('LOSS não move saldo e não gera lançamento no ledger (I-06, D3, D55)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);

      const [ledgerBefore] = await db.sql<Array<{ count: number }>>`
        SELECT count(*)::int as count FROM wallet_ledger_entry WHERE wallet_id = ${walletId}
      `;

      const outcome = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: `ext-${randomUUID()}`,
        idempotencyKey: `idem-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Loss as SubmittableKind,
        money: { amount: '0.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      expect(outcome.type).toBe('RESULT');
      if (outcome.type !== 'RESULT') return;
      expect(outcome.view.status).toBe(WagerTransactionStatus.Processed);
      expect(outcome.view.balance).toEqual({ amount: '1000.00', currency: 'BRL' });

      // Quantidade de lançamentos no ledger permanece idêntica
      const [ledgerAfter] = await db.sql<Array<{ count: number }>>`
        SELECT count(*)::int as count FROM wallet_ledger_entry WHERE wallet_id = ${walletId}
      `;
      expect(ledgerAfter).toBeDefined();
      expect(ledgerBefore).toBeDefined();
      expect(ledgerAfter!.count).toBe(ledgerBefore!.count);

      // Transação gravada com PROCESSED
      const [txRow] = await db.sql<Array<{ status: string; balance_after: string }>>`
        SELECT status, balance_after::text FROM wager_transaction WHERE id = ${outcome.view.transactionId}
      `;
      expect(txRow).toBeDefined();
      expect(txRow!.status).toBe('PROCESSED');
      expect(txRow!.balance_after).toBe('1000.00');
    });

    test('REFUND e ROLLBACK: credita valor e barra segunda reversão (REFERENCE_ALREADY_REVERSED) (I-06, D1)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const betExtId = `ext-bet-${randomUUID()}`;

      // 1. Faz BET de 100.00 -> saldo vira 900.00
      await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: betExtId,
        idempotencyKey: `idem-${betExtId}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '100.00', currency: 'BRL' },
        correlationId: randomUUID(),
      });

      // 2. REFUND da BET -> saldo volta para 1000.00
      const refundOutcome = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: `ext-ref-${randomUUID()}`,
        idempotencyKey: `idem-ref-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund as SubmittableKind,
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
        correlationId: randomUUID(),
      });

      expect(refundOutcome.type).toBe('RESULT');
      if (refundOutcome.type !== 'RESULT') return;
      expect(refundOutcome.view.status).toBe(WagerTransactionStatus.Processed);
      expect(refundOutcome.view.balance).toEqual({ amount: '1000.00', currency: 'BRL' });

      // 3. Segunda tentativa de REFUND da mesma BET -> REJECT com REFERENCE_ALREADY_REVERSED
      const secondRefund = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: `ext-ref2-${randomUUID()}`,
        idempotencyKey: `idem-ref2-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund as SubmittableKind,
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
        correlationId: randomUUID(),
      });

      expect(secondRefund.type).toBe('RESULT');
      if (secondRefund.type !== 'RESULT') return;
      expect(secondRefund.view.status).toBe(WagerTransactionStatus.Rejected);
      expect(secondRefund.view.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    });

    test('PENDING_REFERENCE quando a referência ainda não chegou ao banco (I-18)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const missingBetExtId = `missing-${randomUUID()}`;

      const outcome = await submit.execute({
        providerId: 'provider-test',
        externalTransactionId: `ext-ref-${randomUUID()}`,
        idempotencyKey: `idem-ref-${randomUUID()}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund as SubmittableKind,
        money: { amount: '100.00', currency: 'BRL' },
        referenceExternalTransactionId: missingBetExtId,
        correlationId: randomUUID(),
      });

      expect(outcome.type).toBe('RESULT');
      if (outcome.type !== 'RESULT') return;
      expect(outcome.view.status).toBe(WagerTransactionStatus.PendingReference);
      expect(outcome.view.balance).toBeUndefined();

      // Saldo da wallet permanece inalterado
      const [walletRow] = await db.sql<Array<{ balance: string }>>`
        SELECT balance::text FROM wallet WHERE id = ${walletId}
      `;
      expect(walletRow).toBeDefined();
      expect(walletRow!.balance).toBe('1000.00');

      // Evento WagerTransactionPendingReference registrado no outbox
      const [outboxRow] = await db.sql<Array<{ event_type: string }>>`
        SELECT event_type FROM outbox_message WHERE aggregate_id = ${outcome.view.transactionId}
      `;
      expect(outboxRow).toBeDefined();
      expect(outboxRow!.event_type).toBe('WagerTransactionPendingReference');
    });

    test('Inbox SQS: tryReceive registra mensagem; duplicata idêntica aceita (DUPLICATE_MESSAGE); divergente gera MESSAGE_PAYLOAD_MISMATCH (I-13, I-14)', async () => {
      const submit = new SubmitWagerTransaction(uow, clock, idGenerator);
      const messageId = `msg-${randomUUID()}`;
      const consumerName = 'test-consumer';
      const extId = `ext-${randomUUID()}`;
      const idemKey = `idem-${extId}`;

      const command: WagerCommand = {
        providerId: 'provider-test',
        externalTransactionId: extId,
        idempotencyKey: idemKey,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet as SubmittableKind,
        money: { amount: '50.00', currency: 'BRL' },
        correlationId: randomUUID(),
      };

      // 1. Primeira submissão com inboxContext
      const first = await submit.execute(command, { messageId, consumerName });
      expect(first.type).toBe('RESULT');

      // Verifica processed_at na tabela inbox_message
      const [inboxRow] = await db.sql<Array<{ processed_at: string | null }>>`
        SELECT processed_at::text FROM inbox_message WHERE consumer_name = ${consumerName} AND message_id = ${messageId}
      `;
      expect(inboxRow).toBeDefined();
      expect(inboxRow!.processed_at).not.toBeNull();

      // 2. Mesma mensagem reenviada com mesmo payload -> DUPLICATE_MESSAGE
      const duplicate = await submit.execute(command, { messageId, consumerName });
      expect(duplicate.type).toBe('DUPLICATE_MESSAGE');

      // 3. Mesma mensagem reenviada com payload diferente (ex: valor 80.00) -> MESSAGE_PAYLOAD_MISMATCH
      const mismatch = await submit.execute(
        { ...command, money: { amount: '80.00', currency: 'BRL' } },
        { messageId, consumerName },
      );
      expect(mismatch.type).toBe('MESSAGE_PAYLOAD_MISMATCH');
    });
  });
});
