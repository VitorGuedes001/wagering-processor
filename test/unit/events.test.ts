import { describe, expect, it } from 'bun:test';
import { InvalidTransactionStateError } from '../../src/domain/errors';
import type { EventContext } from '../../src/domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet, type WalletState } from '../../src/domain/wallet';
import {
  LedgerDirection,
  type LedgerEntryState,
  WalletLedgerEntry,
} from '../../src/domain/wallet-ledger-entry';

/** `Money` real (T10): sem fallback, para um bug do `Money` não passar calado aqui. */
function makeMoney(amount: string, currency = 'BRL'): Money {
  return Money.from({ amount, currency });
}

function makeWallet(overrides: Partial<WalletState> = {}): Wallet {
  const now = new Date('2026-04-19T12:00:00.000Z');
  const state: WalletState = {
    id: 'wallet-1',
    playerId: 'player-1',
    currency: 'BRL',
    balance: makeMoney('100.00', 'BRL'),
    version: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  return Wallet.rehydrate(state);
}

function makeLedgerEntry(overrides: Partial<LedgerEntryState> = {}): WalletLedgerEntry {
  const now = new Date('2026-04-19T12:00:00.000Z');
  const state: LedgerEntryState = {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    walletVersion: 2,
    direction: LedgerDirection.Debit,
    money: makeMoney('25.00', 'BRL'),
    balanceBefore: makeMoney('100.00', 'BRL'),
    balanceAfter: makeMoney('75.00', 'BRL'),
    createdAt: now,
    ...overrides,
  };
  return WalletLedgerEntry.rehydrate(state);
}

function makeTransaction(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  const now = new Date('2026-04-19T12:00:00.000Z');
  const state: WagerTransactionState = {
    id: 'tx-1',
    providerId: 'prov-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'idem-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: makeMoney('25.00', 'BRL'),
    status: WagerTransactionStatus.Processed,
    balanceAfter: makeMoney('75.00', 'BRL'),
    referenceAttempts: 0,
    createdAt: now,
    updatedAt: now,
    processedAt: now,
    ...overrides,
  };
  return WagerTransaction.rehydrate(state);
}

describe('IntegrationEvent & Subclasses (U-03, U-04)', () => {
  const occurredAt = new Date('2026-04-19T12:30:00.000Z');
  const processedAt = new Date('2026-04-19T12:29:59.000Z');

  const baseCtx: EventContext = {
    eventId: 'evt-1',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    occurredAt,
  };

  it('U-03: raw bigint throws in JSON.stringify while all 4 event subclasses serialize cleanly without leaking bigint', () => {
    expect(() => JSON.stringify({ rawCents: 2500n })).toThrow(TypeError);

    const processedEvent = WagerTransactionProcessed.from(
      makeTransaction({ processedAt }),
      baseCtx,
    );
    const rejectedEvent = WagerTransactionRejected.from(
      makeTransaction({
        status: WagerTransactionStatus.Rejected,
        failureCode: FailureCode.InsufficientFunds,
        balanceAfter: makeMoney('10.00', 'BRL'),
        processedAt: undefined,
      }),
      baseCtx,
    );
    const balanceChangedEvent = WalletBalanceChanged.from(
      makeWallet(),
      makeLedgerEntry(),
      baseCtx,
    );
    const pendingRefEvent = WagerTransactionPendingReference.from(
      makeTransaction({
        kind: WagerTransactionKind.Refund,
        status: WagerTransactionStatus.PendingReference,
        referenceExternalTransactionId: 'ext-bet-0',
        balanceAfter: undefined,
        processedAt: undefined,
      }),
      baseCtx,
    );

    for (const ev of [processedEvent, rejectedEvent, balanceChangedEvent, pendingRefEvent]) {
      expect(() => JSON.stringify(ev.toJSON())).not.toThrow();
      const outbox = OutboxMessage.enqueue(ev);
      expect(() => JSON.stringify(outbox.payload)).not.toThrow();
    }
  });

  it('U-04: WagerTransactionProcessed.from builds envelope and MoneyProps for provider transactions and omits causationId when undefined', () => {
    const tx = makeTransaction({
      id: 'tx-refund-1',
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ext-bet-1',
      referenceTransactionId: 'tx-bet-1',
      money: makeMoney('25.00', 'BRL'),
      balanceAfter: makeMoney('100.00', 'BRL'),
      processedAt,
    });

    const eventWithoutCausation = WagerTransactionProcessed.from(tx, {
      eventId: 'evt-proc-1',
      correlationId: 'corr-proc-1',
      occurredAt,
    });

    const json = eventWithoutCausation.toJSON();
    expect(json).toEqual({
      eventId: 'evt-proc-1',
      eventType: 'WagerTransactionProcessed',
      aggregateId: 'tx-refund-1',
      correlationId: 'corr-proc-1',
      occurredAt: '2026-04-19T12:30:00.000Z',
      version: 1,
      data: {
        transactionId: 'tx-refund-1',
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        walletId: 'wallet-1',
        playerId: 'player-1',
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        referenceTransactionId: 'tx-bet-1',
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        processedAt: '2026-04-19T12:29:59.000Z',
      },
    });
    expect('causationId' in json).toBe(false);
    expect(json.data.money).not.toBeInstanceOf(Money);
    expect(json.data.balanceAfter).not.toBeInstanceOf(Money);
  });

  it('U-04: WagerTransactionProcessed.from omits provider fields on OPENING transaction (D42)', () => {
    const openingTx = WagerTransaction.opening({
      id: 'tx-open-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: makeMoney('50.00', 'BRL'),
      at: processedAt,
    });

    const event = WagerTransactionProcessed.from(openingTx, baseCtx);
    const json = event.toJSON();

    expect(json.aggregateId).toBe('tx-open-1');
    expect(json.data).toEqual({
      transactionId: 'tx-open-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      kind: WagerTransactionKind.Opening,
      money: { amount: '50.00', currency: 'BRL' },
      balanceAfter: { amount: '50.00', currency: 'BRL' },
      processedAt: '2026-04-19T12:29:59.000Z',
    });
    expect('providerId' in json.data).toBe(false);
    expect('externalTransactionId' in json.data).toBe(false);
    expect('roundId' in json.data).toBe(false);
    expect('gameId' in json.data).toBe(false);
    expect('referenceTransactionId' in json.data).toBe(false);
  });

  it('WagerTransactionProcessed.from throws InvalidTransactionStateError when transaction is not PROCESSED', () => {
    const pendingTx = makeTransaction({ status: WagerTransactionStatus.Pending });
    expect(() => WagerTransactionProcessed.from(pendingTx, baseCtx)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('WagerTransactionProcessed.from throws when a non-OPENING transaction lacks provider fields (D42)', () => {
    expect(() =>
      WagerTransactionProcessed.from(makeTransaction({ providerId: undefined }), baseCtx),
    ).toThrow(InvalidTransactionStateError);
    expect(() =>
      WagerTransactionProcessed.from(makeTransaction({ externalTransactionId: undefined }), baseCtx),
    ).toThrow(InvalidTransactionStateError);
  });

  it('U-04: WagerTransactionRejected.from serializes failureCode and MoneyProps', () => {
    const rejectedTx = makeTransaction({
      id: 'tx-rej-1',
      status: WagerTransactionStatus.Rejected,
      kind: WagerTransactionKind.Bet,
      money: makeMoney('80.00', 'BRL'),
      failureCode: FailureCode.InsufficientFunds,
      balanceAfter: makeMoney('20.00', 'BRL'),
      processedAt: undefined,
    });

    const event = WagerTransactionRejected.from(rejectedTx, baseCtx);
    const json = event.toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'tx-rej-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-04-19T12:30:00.000Z',
      version: 1,
      data: {
        transactionId: 'tx-rej-1',
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        walletId: 'wallet-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '80.00', currency: 'BRL' },
        failureCode: FailureCode.InsufficientFunds,
        balanceAfter: { amount: '20.00', currency: 'BRL' },
      },
    });
    expect(json.data.money).not.toBeInstanceOf(Money);
    expect(json.data.balanceAfter).not.toBeInstanceOf(Money);
  });

  it('WagerTransactionRejected.from throws InvalidTransactionStateError when transaction is not REJECTED', () => {
    const processedTx = makeTransaction({ status: WagerTransactionStatus.Processed });
    expect(() => WagerTransactionRejected.from(processedTx, baseCtx)).toThrow(
      InvalidTransactionStateError,
    );
  });

  it('U-04: WalletBalanceChanged.from uses wallet.id as aggregateId and serializes MoneyProps', () => {
    const wallet = makeWallet({ id: 'wallet-99' });
    const entry = makeLedgerEntry({
      walletId: 'wallet-99',
      transactionId: 'tx-99',
      walletVersion: 5,
      direction: LedgerDirection.Credit,
      money: makeMoney('40.00', 'BRL'),
      balanceBefore: makeMoney('60.00', 'BRL'),
      balanceAfter: makeMoney('100.00', 'BRL'),
    });

    const event = WalletBalanceChanged.from(wallet, entry, baseCtx);
    const json = event.toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WalletBalanceChanged',
      aggregateId: 'wallet-99',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-04-19T12:30:00.000Z',
      version: 1,
      data: {
        walletId: 'wallet-99',
        transactionId: 'tx-99',
        direction: LedgerDirection.Credit,
        money: { amount: '40.00', currency: 'BRL' },
        balanceBefore: { amount: '60.00', currency: 'BRL' },
        balanceAfter: { amount: '100.00', currency: 'BRL' },
        walletVersion: 5,
      },
    });
    expect(json.data.money).not.toBeInstanceOf(Money);
    expect(json.data.balanceBefore).not.toBeInstanceOf(Money);
    expect(json.data.balanceAfter).not.toBeInstanceOf(Money);
  });

  it('WalletBalanceChanged.from mirrors the entry produced by Wallet.open and Wallet.debit', () => {
    const at = new Date('2026-04-19T12:00:00.000Z');
    const { wallet, openingEntry } = Wallet.open({
      id: 'wallet-7',
      playerId: 'player-7',
      initialBalance: makeMoney('100.00', 'BRL'),
      openingTransactionId: 'tx-open-7',
      openingEntryId: 'entry-open-7',
      at,
    });
    expect(openingEntry).toBeDefined();
    const opened = WalletBalanceChanged.from(wallet, openingEntry as WalletLedgerEntry, baseCtx).toJSON();
    expect(opened.data).toEqual({
      walletId: 'wallet-7',
      transactionId: 'tx-open-7',
      direction: LedgerDirection.Credit,
      money: { amount: '100.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '100.00', currency: 'BRL' },
      walletVersion: 1,
    });

    const entry = wallet.debit(makeMoney('30.00', 'BRL'), 'tx-bet-7', 'entry-bet-7', at);
    const debited = WalletBalanceChanged.from(wallet, entry, baseCtx).toJSON();
    expect(debited.aggregateId).toBe('wallet-7');
    expect(debited.data).toEqual({
      walletId: 'wallet-7',
      transactionId: 'tx-bet-7',
      direction: LedgerDirection.Debit,
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('U-04: WagerTransactionPendingReference.from serializes pending reference payload', () => {
    const pendingRefTx = makeTransaction({
      id: 'tx-pref-1',
      status: WagerTransactionStatus.PendingReference,
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'ext-win-55',
      balanceAfter: undefined,
      processedAt: undefined,
    });

    const event = WagerTransactionPendingReference.from(pendingRefTx, baseCtx);
    const json = event.toJSON();

    expect(json).toEqual({
      eventId: 'evt-1',
      eventType: 'WagerTransactionPendingReference',
      aggregateId: 'tx-pref-1',
      correlationId: 'corr-1',
      causationId: 'cause-1',
      occurredAt: '2026-04-19T12:30:00.000Z',
      version: 1,
      data: {
        transactionId: 'tx-pref-1',
        providerId: 'prov-1',
        externalTransactionId: 'ext-1',
        walletId: 'wallet-1',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'ext-win-55',
      },
    });
  });

  it('WagerTransactionPendingReference.from throws InvalidTransactionStateError when status is not PENDING_REFERENCE', () => {
    const processedTx = makeTransaction({ status: WagerTransactionStatus.Processed });
    expect(() => WagerTransactionPendingReference.from(processedTx, baseCtx)).toThrow(
      InvalidTransactionStateError,
    );
  });
});
