import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import {
  TransientInfrastructureError,
  UniqueViolationError,
} from '../../src/application/ports';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { payloadHash } from '../../src/domain/payload-hash';
import {
  type BackoffPolicy,
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import type { WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';
import { WagerTransactionRecord } from '../../src/infrastructure/persistence/records/wager-transaction.record';
import {
  MikroOrmWagerTransactionRepository,
  toWagerTransactionDomain,
} from '../../src/infrastructure/persistence/wager-transaction-repository';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertAllWalletsConsistent } from '../support/invariants';
import { getTestInfraConfig } from '../support/preload';

const TEST_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 300_000,
  maxAttempts: 10,
};

const T0 = new Date('2026-10-28T12:00:00.000Z');
const T1 = new Date('2026-10-28T12:00:05.000Z');
const T2 = new Date('2026-10-28T12:00:10.000Z');

function makeTransactionProps(
  overrides: Partial<CreateWagerTransactionProps> & { walletId: string; playerId: string },
): CreateWagerTransactionProps {
  const providerId = overrides.providerId ?? 'pragmatic-play';
  const externalTransactionId = overrides.externalTransactionId ?? `ext-${randomUUID()}`;
  const idempotencyKey = overrides.idempotencyKey ?? `idem-${externalTransactionId}`;
  const roundId = overrides.roundId ?? `round-${randomUUID().slice(0, 8)}`;
  const gameId = overrides.gameId ?? 'sweet-bonanza';
  const kind = overrides.kind ?? WagerTransactionKind.Bet;
  const money = overrides.money ?? Money.from({ amount: '25.00', currency: 'BRL' });
  const referenceExternalTransactionId = overrides.referenceExternalTransactionId;

  const computedHash =
    overrides.payloadHash ??
    payloadHash({
      providerId,
      externalTransactionId,
      playerId: overrides.playerId,
      walletId: overrides.walletId,
      roundId,
      gameId,
      kind,
      money: money.toJSON(),
      referenceExternalTransactionId,
    });

  return {
    id: overrides.id ?? randomUUID(),
    providerId,
    externalTransactionId,
    idempotencyKey,
    payloadHash: computedHash,
    walletId: overrides.walletId,
    playerId: overrides.playerId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId,
    at: overrides.at ?? T0,
  };
}

describe('I-03 (transação): WagerTransactionRecord e MikroOrmWagerTransactionRepository', () => {
  let db: TestDatabase;
  let orm: MikroORM;

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
        entities: [WagerTransactionRecord],
        metadataProvider: ReflectMetadataProvider,
        discovery: { warnWhenNoEntities: false },
        debug: false,
        forceUtcTimezone: true,
      }),
    );
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    if (db) {
      await db.drop();
    }
  });

  /**
   * Insere uma wallet com saldo zero (sem precisar de OPENING/ledger) para servir
   * de FK válida para `wager_transaction`, mantendo `assertAllWalletsConsistent` verde.
   */
  async function insertEmptyWallet(currency = 'BRL'): Promise<Wallet> {
    const { wallet } = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.zero(currency),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      at: T0,
    });
    await db.sql`
      INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (
        ${wallet.id}::uuid,
        ${wallet.playerId}::uuid,
        ${wallet.currency},
        ${wallet.balance.toJSON().amount}::numeric(19,2),
        ${wallet.version},
        ${wallet.createdAt.toISOString()}::timestamptz,
        ${wallet.updatedAt.toISOString()}::timestamptz
      )
    `;
    return wallet;
  }

  /**
   * Persiste na conexão SQL a atualização de saldo da wallet e seu lançamento no ledger,
   * para acompanhar transações `PROCESSED` que movem saldo e satisfazer os triggers
   * deferred (`wallet_ledger_match`, `ledger_wallet_match`) e `assertAllWalletsConsistent` (D40).
   */
  async function persistWalletAndEntry(wallet: Wallet, entry: WalletLedgerEntry): Promise<void> {
    await db.sql.begin(async (tx) => {
      await tx`
        UPDATE wallet
           SET balance = ${wallet.balance.toJSON().amount}::numeric(19,2),
               version = ${wallet.version},
               updated_at = ${wallet.updatedAt.toISOString()}::timestamptz
         WHERE id = ${wallet.id}::uuid
      `;
      await tx`
        INSERT INTO wallet_ledger_entry (
          id, wallet_id, transaction_id, wallet_version, direction,
          amount, currency, balance_before, balance_after, created_at
        ) VALUES (
          ${entry.id}::uuid,
          ${entry.walletId}::uuid,
          ${entry.transactionId}::uuid,
          ${entry.walletVersion},
          ${entry.direction},
          ${entry.money.toJSON().amount}::numeric(19,2),
          ${entry.money.currency},
          ${entry.balanceBefore.toJSON().amount}::numeric(19,2),
          ${entry.balanceAfter.toJSON().amount}::numeric(19,2),
          ${entry.createdAt.toISOString()}::timestamptz
        )
      `;
    });
  }

  /**
   * Abre uma wallet com saldo inicial positivo: persiste `wallet` + `OPENING` via
   * `MikroOrmWagerTransactionRepository` + `wallet_ledger_entry` na mesma transação.
   */
  async function openFundedWallet(
    repo: MikroOrmWagerTransactionRepository,
    em: ReturnType<typeof orm.em.fork>,
    initialAmount = '100.00',
    currency = 'BRL',
  ): Promise<{ wallet: Wallet; openingTx: WagerTransaction }> {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const openingTxId = randomUUID();
    const openingEntryId = randomUUID();
    const initialMoney = Money.from({ amount: initialAmount, currency });

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId,
      initialBalance: initialMoney,
      openingTransactionId: openingTxId,
      openingEntryId,
      at: T0,
    });
    const openingTx = WagerTransaction.opening({
      id: openingTxId,
      walletId,
      playerId,
      money: initialMoney,
      at: T0,
    });

    await em.transactional(async (txEm) => {
      const txRepo = new MikroOrmWagerTransactionRepository(txEm);
      await txEm.execute(
        `INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          wallet.id,
          wallet.playerId,
          wallet.currency,
          wallet.balance.toJSON().amount,
          wallet.version,
          wallet.createdAt,
          wallet.updatedAt,
        ],
      );
      await txRepo.insert(openingTx);
      await txEm.execute(
        `INSERT INTO wallet_ledger_entry (
           id, wallet_id, transaction_id, wallet_version, direction,
           amount, currency, balance_before, balance_after, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          openingEntry!.id,
          openingEntry!.walletId,
          openingEntry!.transactionId,
          openingEntry!.walletVersion,
          openingEntry!.direction,
          openingEntry!.money.toJSON().amount,
          openingEntry!.money.currency,
          openingEntry!.balanceBefore.toJSON().amount,
          openingEntry!.balanceAfter.toJSON().amount,
          openingEntry!.createdAt,
        ],
      );
    });

    void repo;
    return { wallet, openingTx };
  }

  test('ida e volta de OPENING (PROCESSED) sem campos de provedor e com numeric lido como string', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);

    const { wallet, openingTx } = await openFundedWallet(repo, em, '250.75', 'BRL');

    const rawRecord = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: openingTx.id },
      { disableIdentityMap: true },
    );
    expect(typeof rawRecord.amount).toBe('string');
    expect(rawRecord.amount).toBe('250.75');
    expect(typeof rawRecord.balanceAfter).toBe('string');
    expect(rawRecord.balanceAfter).toBe('250.75');
    expect(rawRecord.providerId).toBeNull();
    expect(rawRecord.externalTransactionId).toBeNull();
    expect(rawRecord.idempotencyKey).toBeNull();
    expect(rawRecord.payloadHash).toBeNull();
    expect(rawRecord.roundId).toBeNull();
    expect(rawRecord.gameId).toBeNull();

    const loaded = await repo.findById(openingTx.id);
    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(openingTx.id);
    expect(loaded!.walletId).toBe(wallet.id);
    expect(loaded!.playerId).toBe(wallet.playerId);
    expect(loaded!.kind).toBe(WagerTransactionKind.Opening);
    expect(loaded!.status).toBe(WagerTransactionStatus.Processed);
    expect(loaded!.money.equals(Money.from({ amount: '250.75', currency: 'BRL' }))).toBe(true);
    expect(loaded!.balanceAfter?.equals(Money.from({ amount: '250.75', currency: 'BRL' }))).toBe(
      true,
    );
    expect(loaded!.providerId).toBeUndefined();
    expect(loaded!.externalTransactionId).toBeUndefined();
    expect(loaded!.idempotencyKey).toBeUndefined();
    expect(loaded!.payloadHash).toBeUndefined();
    expect(loaded!.roundId).toBeUndefined();
    expect(loaded!.gameId).toBeUndefined();
    expect(loaded!.failureCode).toBeUndefined();
    expect(loaded!.referenceExternalTransactionId).toBeUndefined();
    expect(loaded!.referenceTransactionId).toBeUndefined();
    expect(loaded!.referenceAttempts).toBe(0);
    expect(loaded!.nextReferenceAttemptAt).toBeUndefined();
    expect(loaded!.createdAt.toISOString()).toBe(T0.toISOString());
    expect(loaded!.updatedAt.toISOString()).toBe(T0.toISOString());
    expect(loaded!.processedAt?.toISOString()).toBe(T0.toISOString());
  });

  test('ida e volta de BET, WIN, LOSS (0.00 e > 0), REFUND e ROLLBACK PROCESSED, preservando extremos de numeric(19,2) como string', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);
    const { wallet } = await openFundedWallet(repo, em, '100.00', 'BRL');

    // 1. BET 25.00 -> saldo 75.00
    const betProps = makeTransactionProps({
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount: '25.00', currency: 'BRL' }),
      at: T0,
    });
    const betTx = WagerTransaction.create(betProps);
    const betEntry = wallet.debit(betTx.money, betTx.id, randomUUID(), T1);
    betTx.markProcessed(undefined, wallet.balance, T1);
    await repo.insert(betTx);
    await persistWalletAndEntry(wallet, betEntry);

    // Verifica record cru e buscas por id, idempotencyKey e externalTransactionId
    const betRecord = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: betTx.id },
      { disableIdentityMap: true },
    );
    expect(typeof betRecord.amount).toBe('string');
    expect(betRecord.amount).toBe('25.00');
    expect(typeof betRecord.balanceAfter).toBe('string');
    expect(betRecord.balanceAfter).toBe('75.00');

    const byId = await repo.findById(betTx.id);
    const byKey = await repo.findByIdempotencyKey(betProps.providerId, betProps.idempotencyKey);
    const byExt = await repo.findByExternalId(
      betProps.providerId,
      betProps.externalTransactionId,
    );

    for (const found of [byId, byKey, byExt]) {
      expect(found).toBeDefined();
      expect(found!.id).toBe(betTx.id);
      expect(found!.providerId).toBe(betProps.providerId);
      expect(found!.externalTransactionId).toBe(betProps.externalTransactionId);
      expect(found!.idempotencyKey).toBe(betProps.idempotencyKey);
      expect(found!.payloadHash).toBe(betProps.payloadHash);
      expect(found!.walletId).toBe(wallet.id);
      expect(found!.playerId).toBe(wallet.playerId);
      expect(found!.roundId).toBe(betProps.roundId);
      expect(found!.gameId).toBe(betProps.gameId);
      expect(found!.kind).toBe(WagerTransactionKind.Bet);
      expect(found!.status).toBe(WagerTransactionStatus.Processed);
      expect(found!.money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(found!.balanceAfter?.toJSON()).toEqual({ amount: '75.00', currency: 'BRL' });
      expect(found!.processedAt?.toISOString()).toBe(T1.toISOString());
    }

    // 2. WIN com referência para a BET e valor alto 99999999999999899.99 -> saldo 99999999999999974.99
    const hugeWinMoney = Money.from({ amount: '99999999999999899.99', currency: 'BRL' });
    const winTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: betProps.roundId,
        kind: WagerTransactionKind.Win,
        money: hugeWinMoney,
        referenceExternalTransactionId: betProps.externalTransactionId,
        at: T1,
      }),
    );
    const winEntry = wallet.credit(winTx.money, winTx.id, randomUUID(), T2);
    winTx.markProcessed(betTx.id, wallet.balance, T2);
    await repo.insert(winTx);
    await persistWalletAndEntry(wallet, winEntry);

    const winRecord = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: winTx.id },
      { disableIdentityMap: true },
    );
    expect(typeof winRecord.amount).toBe('string');
    expect(winRecord.amount).toBe('99999999999999899.99');
    expect(typeof winRecord.balanceAfter).toBe('string');
    expect(winRecord.balanceAfter).toBe('99999999999999974.99');

    const loadedWin = await repo.findById(winTx.id);
    expect(loadedWin?.money.toJSON()).toEqual({
      amount: '99999999999999899.99',
      currency: 'BRL',
    });
    expect(loadedWin?.balanceAfter?.toJSON()).toEqual({
      amount: '99999999999999974.99',
      currency: 'BRL',
    });
    expect(loadedWin?.referenceExternalTransactionId).toBe(betProps.externalTransactionId);
    expect(loadedWin?.referenceTransactionId).toBe(betTx.id);

    // 3. LOSS com amount 0.00 (D3: não move saldo nem gera lançamento)
    const lossZeroTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: betProps.roundId,
        kind: WagerTransactionKind.Loss,
        money: Money.from({ amount: '0.00', currency: 'BRL' }),
        referenceExternalTransactionId: betProps.externalTransactionId,
        at: T1,
      }),
    );
    lossZeroTx.markProcessed(betTx.id, wallet.balance, T2);
    await repo.insert(lossZeroTx);

    const lossRecord = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: lossZeroTx.id },
      { disableIdentityMap: true },
    );
    expect(typeof lossRecord.amount).toBe('string');
    expect(lossRecord.amount).toBe('0.00');
    expect(typeof lossRecord.balanceAfter).toBe('string');
    expect(lossRecord.balanceAfter).toBe('99999999999999974.99');

    const loadedLoss = await repo.findById(lossZeroTx.id);
    expect(loadedLoss?.kind).toBe(WagerTransactionKind.Loss);
    expect(loadedLoss?.money.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(loadedLoss?.balanceAfter?.toJSON()).toEqual({
      amount: '99999999999999974.99',
      currency: 'BRL',
    });

    // 3b. LOSS com amount > 0 (0.01, D3: o provedor pode mandar o stake ou valor positivo; não move saldo)
    const lossPositiveTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: betProps.roundId,
        kind: WagerTransactionKind.Loss,
        money: Money.from({ amount: '0.01', currency: 'BRL' }),
        at: T1,
      }),
    );
    lossPositiveTx.markProcessed(undefined, wallet.balance, T2);
    await repo.insert(lossPositiveTx);

    const loadedLossPositive = await repo.findById(lossPositiveTx.id);
    expect(loadedLossPositive?.kind).toBe(WagerTransactionKind.Loss);
    expect(loadedLossPositive?.money.toJSON()).toEqual({ amount: '0.01', currency: 'BRL' });
    expect(loadedLossPositive?.balanceAfter?.toJSON()).toEqual({
      amount: '99999999999999974.99',
      currency: 'BRL',
    });

    // 4. REFUND da BET (25.00) -> saldo 99999999999999999.99 (limite exato de 17 dígitos inteiros)
    const refundTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: betProps.roundId,
        kind: WagerTransactionKind.Refund,
        money: betTx.money,
        referenceExternalTransactionId: betProps.externalTransactionId,
        at: T1,
      }),
    );
    const refundEntry = wallet.credit(refundTx.money, refundTx.id, randomUUID(), T2);
    refundTx.markProcessed(betTx.id, wallet.balance, T2);
    await repo.insert(refundTx);
    await persistWalletAndEntry(wallet, refundEntry);

    const loadedRefund = await repo.findById(refundTx.id);
    expect(loadedRefund?.kind).toBe(WagerTransactionKind.Refund);
    expect(loadedRefund?.referenceTransactionId).toBe(betTx.id);
    expect(loadedRefund?.balanceAfter?.toJSON()).toEqual({
      amount: '99999999999999999.99',
      currency: 'BRL',
    });

    // 5. ROLLBACK do WIN (99999999999999899.99) -> saldo 100.00
    const rollbackTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: betProps.roundId,
        kind: WagerTransactionKind.Rollback,
        money: winTx.money,
        referenceExternalTransactionId: winTx.externalTransactionId,
        at: T1,
      }),
    );
    const rollbackEntry = wallet.debit(rollbackTx.money, rollbackTx.id, randomUUID(), T2);
    rollbackTx.markProcessed(winTx.id, wallet.balance, T2);
    await repo.insert(rollbackTx);
    await persistWalletAndEntry(wallet, rollbackEntry);

    const loadedRollback = await repo.findById(rollbackTx.id);
    expect(loadedRollback?.kind).toBe(WagerTransactionKind.Rollback);
    expect(loadedRollback?.referenceTransactionId).toBe(winTx.id);
    expect(loadedRollback?.balanceAfter?.toJSON()).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  });

  test('ida e volta de REJECTED, FAILED e PENDING_REFERENCE', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);
    const wallet = await insertEmptyWallet('BRL');

    // 1. REJECTED (INSUFFICIENT_FUNDS) com balanceAfter = 0.00
    const rejectedTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '50.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    rejectedTx.reject(FailureCode.InsufficientFunds, wallet.balance, T1);
    await repo.insert(rejectedTx);

    const rejectedRecord = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: rejectedTx.id },
      { disableIdentityMap: true },
    );
    expect(typeof rejectedRecord.amount).toBe('string');
    expect(rejectedRecord.amount).toBe('50.00');
    expect(typeof rejectedRecord.balanceAfter).toBe('string');
    expect(rejectedRecord.balanceAfter).toBe('0.00');
    expect(rejectedRecord.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejectedRecord.processedAt).toBeNull();

    const loadedRejected = await repo.findById(rejectedTx.id);
    expect(loadedRejected?.status).toBe(WagerTransactionStatus.Rejected);
    expect(loadedRejected?.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(loadedRejected?.balanceAfter?.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(loadedRejected?.processedAt).toBeUndefined();

    // 2. FAILED (PROCESSING_FAILED) sem balanceAfter
    const failedTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    failedTx.fail(FailureCode.ProcessingFailed, T1);
    await repo.insert(failedTx);

    const failedRecord = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: failedTx.id },
      { disableIdentityMap: true },
    );
    expect(failedRecord.balanceAfter).toBeNull();
    expect(failedRecord.failureCode).toBe(FailureCode.ProcessingFailed);

    const loadedFailed = await repo.findById(failedTx.id);
    expect(loadedFailed?.status).toBe(WagerTransactionStatus.Failed);
    expect(loadedFailed?.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(loadedFailed?.balanceAfter).toBeUndefined();
    expect(loadedFailed?.processedAt).toBeUndefined();

    // 3. PENDING_REFERENCE com nextReferenceAttemptAt e referenceAttempts = 0
    const pendingRefTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '15.00', currency: 'BRL' }),
        referenceExternalTransactionId: 'missing-bet-ext',
        at: T0,
      }),
    );
    pendingRefTx.markPendingReference(T0, TEST_BACKOFF);
    await repo.insert(pendingRefTx);

    const loadedPending = await repo.findById(pendingRefTx.id);
    expect(loadedPending?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(loadedPending?.referenceAttempts).toBe(0);
    expect(loadedPending?.nextReferenceAttemptAt?.toISOString()).toBe(
      new Date(T0.getTime() + 1_000).toISOString(),
    );
    expect(loadedPending?.balanceAfter).toBeUndefined();
    expect(loadedPending?.failureCode).toBeUndefined();
    expect(loadedPending?.processedAt).toBeUndefined();

    // Conferência direta do helper toWagerTransactionDomain
    const pendingRecord = await em.findOneOrFail(
      WagerTransactionRecord,
      { id: pendingRefTx.id },
      { disableIdentityMap: true },
    );
    const rehydratedDirect = toWagerTransactionDomain(pendingRecord);
    expect(rehydratedDirect.id).toBe(pendingRefTx.id);
    expect(rehydratedDirect.money.equals(pendingRefTx.money)).toBe(true);
  });

  test('findById, findByIdempotencyKey e findByExternalId retornam undefined quando não encontrado ou de outro provider', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);
    const wallet = await insertEmptyWallet('BRL');

    const tx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'provider-a',
        externalTransactionId: 'ext-1',
        idempotencyKey: 'key-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    tx.reject(FailureCode.InsufficientFunds, wallet.balance, T0);
    await repo.insert(tx);

    expect(await repo.findById(randomUUID())).toBeUndefined();
    expect(await repo.findByIdempotencyKey('provider-a', 'key-inexistente')).toBeUndefined();
    expect(await repo.findByIdempotencyKey('provider-b', 'key-1')).toBeUndefined();
    expect(await repo.findByExternalId('provider-a', 'ext-inexistente')).toBeUndefined();
    expect(await repo.findByExternalId('provider-b', 'ext-1')).toBeUndefined();
  });

  test('hasProcessedReversal distingue reversões PROCESSED de REJECTED/FAILED e de WIN/LOSS (D1)', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);
    const { wallet } = await openFundedWallet(repo, em, '100.00', 'BRL');

    // Cria duas BETs PROCESSED
    const bet1 = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        externalTransactionId: 'bet-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    const entry1 = wallet.debit(bet1.money, bet1.id, randomUUID(), T0);
    bet1.markProcessed(undefined, wallet.balance, T0);
    await repo.insert(bet1);
    await persistWalletAndEntry(wallet, entry1);

    const bet2 = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        externalTransactionId: 'bet-2',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '30.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    const entry2 = wallet.debit(bet2.money, bet2.id, randomUUID(), T0);
    bet2.markProcessed(undefined, wallet.balance, T0);
    await repo.insert(bet2);
    await persistWalletAndEntry(wallet, entry2);

    expect(await repo.hasProcessedReversal(bet1.id)).toBe(false);
    expect(await repo.hasProcessedReversal(bet2.id)).toBe(false);

    // LOSS PROCESSED referenciando bet1 NÃO é reversão
    const lossOnBet1 = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: bet1.roundId,
        kind: WagerTransactionKind.Loss,
        money: Money.from({ amount: '0.00', currency: 'BRL' }),
        referenceExternalTransactionId: bet1.externalTransactionId,
        at: T1,
      }),
    );
    lossOnBet1.markProcessed(bet1.id, wallet.balance, T1);
    await repo.insert(lossOnBet1);
    expect(await repo.hasProcessedReversal(bet1.id)).toBe(false);

    // REFUND REJECTED referenciando bet1 NÃO ocupa a vaga (D1)
    const rejectedRefund = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: bet1.roundId,
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '99.00', currency: 'BRL' }),
        referenceExternalTransactionId: bet1.externalTransactionId,
        at: T1,
      }),
    );
    rejectedRefund.reject(FailureCode.ReferenceAmountMismatch, wallet.balance, T1);
    await repo.insert(rejectedRefund);
    expect(await repo.hasProcessedReversal(bet1.id)).toBe(false);

    // REFUND PROCESSED referenciando bet1 -> true
    const processedRefund = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: bet1.roundId,
        kind: WagerTransactionKind.Refund,
        money: bet1.money,
        referenceExternalTransactionId: bet1.externalTransactionId,
        at: T1,
      }),
    );
    const refundEntry = wallet.credit(processedRefund.money, processedRefund.id, randomUUID(), T1);
    processedRefund.markProcessed(bet1.id, wallet.balance, T1);
    await repo.insert(processedRefund);
    await persistWalletAndEntry(wallet, refundEntry);

    expect(await repo.hasProcessedReversal(bet1.id)).toBe(true);
    expect(await repo.hasProcessedReversal(bet2.id)).toBe(false);

    // ROLLBACK PROCESSED referenciando bet2 -> true
    const processedRollback = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: bet2.roundId,
        kind: WagerTransactionKind.Rollback,
        money: bet2.money,
        referenceExternalTransactionId: bet2.externalTransactionId,
        at: T1,
      }),
    );
    const rollbackEntry = wallet.credit(
      processedRollback.money,
      processedRollback.id,
      randomUUID(),
      T1,
    );
    processedRollback.markProcessed(bet2.id, wallet.balance, T1);
    await repo.insert(processedRollback);
    await persistWalletAndEntry(wallet, rollbackEntry);

    expect(await repo.hasProcessedReversal(bet2.id)).toBe(true);
  });

  test('update persiste scheduleReferenceRetry e transições de PENDING_REFERENCE para PROCESSED, REJECTED e FAILED', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);
    const { wallet } = await openFundedWallet(repo, em, '100.00', 'BRL');

    // BET referenciada chega
    const bet = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        externalTransactionId: 'bet-ref',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '15.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    const betEntry = wallet.debit(bet.money, bet.id, randomUUID(), T0);
    bet.markProcessed(undefined, wallet.balance, T0);
    await repo.insert(bet);
    await persistWalletAndEntry(wallet, betEntry);

    // 1. PENDING_REFERENCE -> scheduleReferenceRetry -> PROCESSED
    const pendingToProcess = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: bet.roundId,
        kind: WagerTransactionKind.Refund,
        money: bet.money,
        referenceExternalTransactionId: bet.externalTransactionId,
        at: T0,
      }),
    );
    pendingToProcess.markPendingReference(T0, TEST_BACKOFF);
    await repo.insert(pendingToProcess);

    pendingToProcess.scheduleReferenceRetry(T1, TEST_BACKOFF);
    await repo.update(pendingToProcess);

    const afterRetry = await repo.findById(pendingToProcess.id);
    expect(afterRetry?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(afterRetry?.referenceAttempts).toBe(1);
    expect(afterRetry?.nextReferenceAttemptAt?.toISOString()).toBe(
      new Date(T1.getTime() + 2_000).toISOString(),
    );
    expect(afterRetry?.updatedAt.toISOString()).toBe(T1.toISOString());

    const refundEntry = wallet.credit(
      pendingToProcess.money,
      pendingToProcess.id,
      randomUUID(),
      T2,
    );
    pendingToProcess.markProcessed(bet.id, wallet.balance, T2);
    await repo.update(pendingToProcess);
    await persistWalletAndEntry(wallet, refundEntry);

    const afterProcessed = await repo.findById(pendingToProcess.id);
    expect(afterProcessed?.status).toBe(WagerTransactionStatus.Processed);
    expect(afterProcessed?.referenceTransactionId).toBe(bet.id);
    expect(afterProcessed?.balanceAfter?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(afterProcessed?.processedAt?.toISOString()).toBe(T2.toISOString());
    expect(afterProcessed?.nextReferenceAttemptAt).toBeUndefined();

    // 2. PENDING_REFERENCE -> REJECTED
    const pendingToReject = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '15.00', currency: 'BRL' }),
        referenceExternalTransactionId: 'missing-ext',
        at: T0,
      }),
    );
    pendingToReject.markPendingReference(T0, TEST_BACKOFF);
    await repo.insert(pendingToReject);

    pendingToReject.reject(FailureCode.ReferenceNotFound, wallet.balance, T2);
    await repo.update(pendingToReject);

    const afterRejected = await repo.findById(pendingToReject.id);
    expect(afterRejected?.status).toBe(WagerTransactionStatus.Rejected);
    expect(afterRejected?.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(afterRejected?.balanceAfter?.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(afterRejected?.nextReferenceAttemptAt).toBeUndefined();

    // 3. PENDING_REFERENCE -> FAILED
    const pendingToFail = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Rollback,
        money: Money.from({ amount: '15.00', currency: 'BRL' }),
        referenceExternalTransactionId: 'missing-ext-2',
        at: T0,
      }),
    );
    pendingToFail.markPendingReference(T0, TEST_BACKOFF);
    await repo.insert(pendingToFail);

    pendingToFail.fail(FailureCode.ProcessingFailed, T2);
    await repo.update(pendingToFail);

    const afterFailed = await repo.findById(pendingToFail.id);
    expect(afterFailed?.status).toBe(WagerTransactionStatus.Failed);
    expect(afterFailed?.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(afterFailed?.balanceAfter).toBeUndefined();
    expect(afterFailed?.nextReferenceAttemptAt).toBeUndefined();

    // 4. update de transação inexistente lança erro
    const ghost = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '5.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    ghost.reject(FailureCode.InsufficientFunds, wallet.balance, T1);
    await expect(repo.update(ghost)).rejects.toThrow(/não encontrada para update/);

    // 5. tentar regravar por update uma transação já terminal no banco é barrado por wager_tx_guard (SCHEMA §5: bug, não UniqueViolationError nem TransientInfrastructureError)
    const staleCopy = WagerTransaction.rehydrate({
      id: pendingToReject.id,
      providerId: pendingToReject.providerId,
      externalTransactionId: pendingToReject.externalTransactionId,
      idempotencyKey: pendingToReject.idempotencyKey,
      payloadHash: pendingToReject.payloadHash,
      walletId: pendingToReject.walletId,
      playerId: pendingToReject.playerId,
      roundId: pendingToReject.roundId,
      gameId: pendingToReject.gameId,
      kind: pendingToReject.kind,
      money: pendingToReject.money,
      referenceExternalTransactionId: pendingToReject.referenceExternalTransactionId,
      status: WagerTransactionStatus.Failed,
      failureCode: FailureCode.ProcessingFailed,
      referenceAttempts: 1,
      createdAt: T0,
      updatedAt: T2,
    });
    try {
      await repo.update(staleCopy);
      throw new Error('Deveria ter falhado por wager_tx_guard');
    } catch (err) {
      expect(err).not.toBeInstanceOf(UniqueViolationError);
      expect(err).not.toBeInstanceOf(TransientInfrastructureError);
    }
  });

  test('lockById adquire SELECT ... FOR UPDATE na linha, relê estado fresco sem bloquear outra linha e traduz lock_timeout (55P03) para TransientInfrastructureError', async () => {
    const em1 = orm.em.fork();
    const em2 = orm.em.fork();
    const wallet = await insertEmptyWallet('BRL');

    const repo1 = new MikroOrmWagerTransactionRepository(em1);
    const repo2 = new MikroOrmWagerTransactionRepository(em2);

    const pendingTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        referenceExternalTransactionId: 'ext-bet-1',
        at: T0,
      }),
    );
    pendingTx.markPendingReference(T0, TEST_BACKOFF);
    await repo1.insert(pendingTx);

    const otherTx = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
        referenceExternalTransactionId: 'ext-bet-2',
        at: T0,
      }),
    );
    otherTx.markPendingReference(T0, TEST_BACKOFF);
    await repo1.insert(otherTx);

    // Popula em1 antes de em2 atualizar a linha no banco
    const beforeUpdate = await repo1.findById(pendingTx.id);
    expect(beforeUpdate?.referenceAttempts).toBe(0);

    pendingTx.scheduleReferenceRetry(T1, TEST_BACKOFF);
    await repo2.update(pendingTx);

    await em1.transactional(async (txEm1) => {
      const txRepo1 = new MikroOrmWagerTransactionRepository(txEm1);
      expect(await txRepo1.lockById(randomUUID())).toBeUndefined();

      const locked = await txRepo1.lockById(pendingTx.id);
      expect(locked).toBeDefined();
      expect(locked!.id).toBe(pendingTx.id);
      expect(locked!.referenceAttempts).toBe(1);

      // Outra linha não fica bloqueada pelo lock de pendingTx
      const lockedOther = await em2.transactional(async (txEm2) => {
        await txEm2.execute(`SET LOCAL lock_timeout = '100ms'`);
        const txRepo2 = new MikroOrmWagerTransactionRepository(txEm2);
        return txRepo2.lockById(otherTx.id);
      });
      expect(lockedOther?.id).toBe(otherTx.id);

      // Segunda transação com lock_timeout curto falha ao tentar lockById na mesma linha
      await expect(
        em2.transactional(async (txEm2) => {
          await txEm2.execute(`SET LOCAL lock_timeout = '100ms'`);
          const txRepo2 = new MikroOrmWagerTransactionRepository(txEm2);
          await txRepo2.lockById(pendingTx.id);
        }),
      ).rejects.toBeInstanceOf(TransientInfrastructureError);
    });
  });

  test('claimDuePendingReferences reserva vencidas em ordem, aplica lease, respeita limit e pula linhas travadas (SKIP LOCKED)', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);
    const wallet = await insertEmptyWallet('BRL');

    const baseTime = new Date('2026-10-28T12:00:00.000Z');
    const createPendingAt = async (offsetMs: number, label: string): Promise<WagerTransaction> => {
      const createdAt = new Date(baseTime.getTime() + offsetMs);
      const tx = WagerTransaction.create(
        makeTransactionProps({
          walletId: wallet.id,
          playerId: wallet.playerId,
          externalTransactionId: `ext-${label}`,
          idempotencyKey: `idem-${label}`,
          kind: WagerTransactionKind.Refund,
          money: Money.from({ amount: '10.00', currency: 'BRL' }),
          referenceExternalTransactionId: `ref-${label}`,
          at: createdAt,
        }),
      );
      // Com baseMs = 1000, nextReferenceAttemptAt = createdAt + 1000ms
      tx.markPendingReference(createdAt, TEST_BACKOFF);
      await repo.insert(tx);
      return tx;
    };

    // due1: next = baseTime + 1s; due2: next = baseTime + 2s; due3: next = baseTime + 3s; future: next = baseTime + 60s
    const due1 = await createPendingAt(0, 'due1');
    const due2 = await createPendingAt(1_000, 'due2');
    const due3 = await createPendingAt(2_000, 'due3');
    const future = await createPendingAt(59_000, 'future');

    // Transação terminal não entra no claim
    const rejected = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        externalTransactionId: 'ext-rejected',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '10.00', currency: 'BRL' }),
        at: baseTime,
      }),
    );
    rejected.reject(FailureCode.InsufficientFunds, wallet.balance, baseTime);
    await repo.insert(rejected);

    const now = new Date(baseTime.getTime() + 5_000); // due1, due2 e due3 estão vencidas; future não
    expect(await repo.claimDuePendingReferences(now, 0, 30_000)).toEqual([]);

    // 1. Conexão concorrente trava due1 com FOR UPDATE; o claim deve pular due1 (SKIP LOCKED) e pegar due2 e due3
    const lockConn = await db.connect();
    await lockConn.begin(async (sqlTx) => {
      await sqlTx`SELECT id FROM wager_transaction WHERE id = ${due1.id}::uuid FOR UPDATE`;

      const claimedWhileLocked = await repo.claimDuePendingReferences(now, 2, 30_000);
      expect(claimedWhileLocked).toEqual([due2.id, due3.id]);
    });

    // 2. Com due1 destravada e due2/due3 sob lease (+30s), novo claim em `now` pega apenas due1
    const claimedAfterRelease = await repo.claimDuePendingReferences(now, 10, 30_000);
    expect(claimedAfterRelease).toEqual([due1.id]);

    // 3. Novo claim imediato em `now` retorna vazio (todas as vencidas estão sob lease)
    expect(await repo.claimDuePendingReferences(now, 10, 30_000)).toEqual([]);

    // 4. Confere que o lease empurrou nextReferenceAttemptAt para now + 30_000ms sem alterar status nem referenceAttempts
    const reloadedDue2 = await repo.findById(due2.id);
    expect(reloadedDue2?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(reloadedDue2?.referenceAttempts).toBe(0);
    expect(reloadedDue2?.nextReferenceAttemptAt?.toISOString()).toBe(
      new Date(now.getTime() + 30_000).toISOString(),
    );

    // 5. Após o lease expirar (now + 30s), due1, due2 e due3 voltam a ser elegíveis (mas future em +60s ainda não)
    const afterLeaseExpired = new Date(now.getTime() + 30_000);
    const reClaimed = await repo.claimDuePendingReferences(afterLeaseExpired, 2, 30_000);
    expect(reClaimed).toHaveLength(2);
    expect(reClaimed.includes(future.id)).toBe(false);
  });

  test('insert traduz violações 23505 dos índices únicos de wager_transaction em UniqueViolationError', async () => {
    const em = orm.em.fork();
    const repo = new MikroOrmWagerTransactionRepository(em);
    const { wallet } = await openFundedWallet(repo, em, '100.00', 'BRL');

    // 1. wager_tx_single_opening_uq: segunda OPENING na mesma wallet
    const duplicateOpening = WagerTransaction.opening({
      id: randomUUID(),
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: Money.from({ amount: '10.00', currency: 'BRL' }),
      at: T0,
    });
    await expect(repo.insert(duplicateOpening)).rejects.toEqual(
      expect.objectContaining({
        name: 'UniqueViolationError',
        constraint: 'wager_tx_single_opening_uq',
      }),
    );

    // Transação base para testar idempotency, external e single_reversal
    const bet = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'pragmatic-play',
        externalTransactionId: 'ext-unique-1',
        idempotencyKey: 'idem-unique-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    const betEntry = wallet.debit(bet.money, bet.id, randomUUID(), T0);
    bet.markProcessed(undefined, wallet.balance, T0);
    await repo.insert(bet);
    await persistWalletAndEntry(wallet, betEntry);

    // 2. wager_tx_idempotency_uq: mesmo (providerId, idempotencyKey)
    const dupIdempotency = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'pragmatic-play',
        externalTransactionId: 'ext-unique-2',
        idempotencyKey: 'idem-unique-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    dupIdempotency.reject(FailureCode.InsufficientFunds, wallet.balance, T0);
    try {
      await repo.insert(dupIdempotency);
      throw new Error('Deveria ter lançado UniqueViolationError');
    } catch (err) {
      expect(err).toBeInstanceOf(UniqueViolationError);
      expect((err as UniqueViolationError).constraint).toBe('wager_tx_idempotency_uq');
    }

    // 3. wager_tx_external_uq: mesmo (providerId, externalTransactionId) com outra idempotencyKey
    const dupExternal = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'pragmatic-play',
        externalTransactionId: 'ext-unique-1',
        idempotencyKey: 'idem-unique-3',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '20.00', currency: 'BRL' }),
        at: T0,
      }),
    );
    dupExternal.reject(FailureCode.InsufficientFunds, wallet.balance, T0);
    try {
      await repo.insert(dupExternal);
      throw new Error('Deveria ter lançado UniqueViolationError');
    } catch (err) {
      expect(err).toBeInstanceOf(UniqueViolationError);
      expect((err as UniqueViolationError).constraint).toBe('wager_tx_external_uq');
    }

    // 4. wager_tx_single_reversal_uq: segunda reversão PROCESSED para a mesma referência
    const refund1 = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'pragmatic-play',
        roundId: bet.roundId,
        kind: WagerTransactionKind.Refund,
        money: bet.money,
        referenceExternalTransactionId: bet.externalTransactionId,
        at: T1,
      }),
    );
    const refund1Entry = wallet.credit(refund1.money, refund1.id, randomUUID(), T1);
    refund1.markProcessed(bet.id, wallet.balance, T1);
    await repo.insert(refund1);
    await persistWalletAndEntry(wallet, refund1Entry);

    const rollbackDup = WagerTransaction.create(
      makeTransactionProps({
        walletId: wallet.id,
        playerId: wallet.playerId,
        providerId: 'pragmatic-play',
        roundId: bet.roundId,
        kind: WagerTransactionKind.Rollback,
        money: bet.money,
        referenceExternalTransactionId: bet.externalTransactionId,
        at: T2,
      }),
    );
    rollbackDup.markProcessed(bet.id, wallet.balance, T2);
    try {
      await repo.insert(rollbackDup);
      throw new Error('Deveria ter lançado UniqueViolationError');
    } catch (err) {
      expect(err).toBeInstanceOf(UniqueViolationError);
      expect((err as UniqueViolationError).constraint).toBe('wager_tx_single_reversal_uq');
    }
  });
});
