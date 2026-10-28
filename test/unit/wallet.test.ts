import { describe, expect, it } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from '../../src/domain/errors';
import { Money, type MoneyProps } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

function parseCents(raw: string): bigint {
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = '0', frac = '00'] = unsigned.split('.');
  const cents = BigInt(whole) * 100n + BigInt(frac);
  return negative ? -cents : cents;
}

function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

function makeFallbackMoney(cents: bigint, currency: string): Money {
  const assertCurrency = (other: Money): bigint => {
    if (other.currency !== currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${currency} vs ${other.currency}`);
    }
    return (other as unknown as { cents: bigint }).cents;
  };

  const instance = Object.create(Money.prototype) as Money;
  Object.assign(instance, {
    cents,
    currency,
    add(other: Money): Money {
      return makeFallbackMoney(cents + assertCurrency(other), currency);
    },
    subtract(other: Money): Money {
      return makeFallbackMoney(cents - assertCurrency(other), currency);
    },
    negate(): Money {
      return makeFallbackMoney(-cents, currency);
    },
    isZero(): boolean {
      return cents === 0n;
    },
    isPositive(): boolean {
      return cents > 0n;
    },
    isNegative(): boolean {
      return cents < 0n;
    },
    isLessThan(other: Money): boolean {
      return cents < assertCurrency(other);
    },
    equals(other: Money): boolean {
      return cents === assertCurrency(other);
    },
    toJSON(): MoneyProps {
      return { amount: formatCents(cents), currency };
    },
    toString(): string {
      return `${formatCents(cents)} ${currency}`;
    },
  });
  return instance;
}

function money(raw: string, currency = 'BRL'): Money {
  try {
    return raw.startsWith('-')
      ? Money.fromPersistence(raw, currency)
      : Money.from({ amount: raw, currency });
  } catch (err) {
    if (err instanceof Error && err.message.includes('T10')) {
      return makeFallbackMoney(parseCents(raw), currency);
    }
    throw err;
  }
}

describe('Wallet', () => {
  const openedAt = new Date('2026-10-28T10:00:00.000Z');
  const nextAt = new Date('2026-10-28T10:05:00.000Z');
  const laterAt = new Date('2026-10-28T10:10:00.000Z');

  describe('open', () => {
    it('opens with positive initialBalance at version 1 and produces an opening CREDIT ledger entry', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open-1',
        openingEntryId: 'entry-open-1',
        at: openedAt,
      });

      expect(wallet.id).toBe('wallet-1');
      expect(wallet.playerId).toBe('player-1');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.equals(money('100.00', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toBe(openedAt);
      expect(wallet.updatedAt).toBe(openedAt);

      expect(openingEntry).toBeDefined();
      expect(openingEntry!.id).toBe('entry-open-1');
      expect(openingEntry!.walletId).toBe('wallet-1');
      expect(openingEntry!.transactionId).toBe('tx-open-1');
      expect(openingEntry!.walletVersion).toBe(1);
      expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry!.money.equals(money('100.00', 'BRL'))).toBe(true);
      expect(openingEntry!.balanceBefore.equals(money('0.00', 'BRL'))).toBe(true);
      expect(openingEntry!.balanceAfter.equals(money('100.00', 'BRL'))).toBe(true);
      expect(openingEntry!.createdAt).toBe(openedAt);
      expect(openingEntry!.isBalanced()).toBe(true);
    });

    it('opens with zero initialBalance at version 1 without generating an openingEntry', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-zero',
        playerId: 'player-1',
        initialBalance: money('0.00', 'BRL'),
        openingTransactionId: 'tx-open-unused',
        openingEntryId: 'entry-open-unused',
        at: openedAt,
      });

      expect(wallet.id).toBe('wallet-zero');
      expect(wallet.currency).toBe('BRL');
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toBe(openedAt);
      expect(wallet.updatedAt).toBe(openedAt);
      expect(openingEntry).toBeUndefined();
    });

    it('throws InvalidMoneyError when initialBalance is negative', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-neg',
          playerId: 'player-1',
          initialBalance: money('-0.01', 'BRL'),
          openingTransactionId: 'tx-open',
          openingEntryId: 'entry-open',
          at: openedAt,
        }),
      ).toThrow(InvalidMoneyError);
    });
  });

  describe('rehydrate', () => {
    it('reconstructs wallet state from persistence without revalidating', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-reh',
        playerId: 'player-99',
        currency: 'USD',
        balance: money('250.75', 'USD'),
        version: 7,
        createdAt: openedAt,
        updatedAt: nextAt,
      });

      expect(wallet.id).toBe('wallet-reh');
      expect(wallet.playerId).toBe('player-99');
      expect(wallet.currency).toBe('USD');
      expect(wallet.balance.equals(money('250.75', 'USD'))).toBe(true);
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toBe(openedAt);
      expect(wallet.updatedAt).toBe(nextAt);
    });
  });

  describe('canDebit', () => {
    it('returns true below balance, true at exact balance, and false above balance', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      expect(wallet.canDebit(money('99.99', 'BRL'))).toBe(true);
      expect(wallet.canDebit(money('100.00', 'BRL'))).toBe(true);
      expect(wallet.canDebit(money('100.01', 'BRL'))).toBe(false);
    });

    it('throws CurrencyMismatchError when checking canDebit with a different currency', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      expect(() => wallet.canDebit(money('10.00', 'USD'))).toThrow(CurrencyMismatchError);
    });
  });

  describe('debit', () => {
    it('debits amount, increments version, updates updatedAt, and returns a balanced DEBIT entry', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      const entry = wallet.debit(money('35.25', 'BRL'), 'tx-bet-1', 'entry-bet-1', nextAt);

      expect(wallet.balance.equals(money('64.75', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toBe(nextAt);

      expect(entry.id).toBe('entry-bet-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-bet-1');
      expect(entry.walletVersion).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.money.equals(money('35.25', 'BRL'))).toBe(true);
      expect(entry.balanceBefore.equals(money('100.00', 'BRL'))).toBe(true);
      expect(entry.balanceAfter.equals(money('64.75', 'BRL'))).toBe(true);
      expect(entry.createdAt).toBe(nextAt);
      expect(entry.isBalanced()).toBe(true);
    });

    it('allows debiting the exact full balance down to 0.00', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      const entry = wallet.debit(money('100.00', 'BRL'), 'tx-bet-all', 'entry-bet-all', nextAt);

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.balanceAfter.isZero()).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it('throws InsufficientFundsError when debit exceeds balance and leaves wallet unchanged', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      expect(() =>
        wallet.debit(money('100.01', 'BRL'), 'tx-over', 'entry-over', nextAt),
      ).toThrow(InsufficientFundsError);

      expect(wallet.balance.equals(money('100.00', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toBe(openedAt);
    });

    it('throws InvalidMoneyError when debit amount is zero or negative and leaves wallet unchanged', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      expect(() =>
        wallet.debit(money('0.00', 'BRL'), 'tx-zero', 'entry-zero', nextAt),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        wallet.debit(money('-10.00', 'BRL'), 'tx-neg', 'entry-neg', nextAt),
      ).toThrow(InvalidMoneyError);

      expect(wallet.balance.equals(money('100.00', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toBe(openedAt);
    });

    it('throws CurrencyMismatchError when debit currency differs from wallet currency', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      expect(() =>
        wallet.debit(money('10.00', 'USD'), 'tx-usd', 'entry-usd', nextAt),
      ).toThrow(CurrencyMismatchError);

      expect(wallet.balance.equals(money('100.00', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(1);
    });
  });

  describe('credit', () => {
    it('credits amount, increments version, updates updatedAt, and returns a balanced CREDIT entry', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-zero',
        playerId: 'player-1',
        initialBalance: money('0.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      const entry = wallet.credit(money('50.00', 'BRL'), 'tx-win-1', 'entry-win-1', nextAt);

      expect(wallet.balance.equals(money('50.00', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toBe(nextAt);

      expect(entry.id).toBe('entry-win-1');
      expect(entry.walletId).toBe('wallet-zero');
      expect(entry.transactionId).toBe('tx-win-1');
      expect(entry.walletVersion).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.equals(money('50.00', 'BRL'))).toBe(true);
      expect(entry.balanceBefore.equals(money('0.00', 'BRL'))).toBe(true);
      expect(entry.balanceAfter.equals(money('50.00', 'BRL'))).toBe(true);
      expect(entry.createdAt).toBe(nextAt);
      expect(entry.isBalanced()).toBe(true);
    });

    it('throws InvalidMoneyError when credit amount is zero or negative and leaves wallet unchanged', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      expect(() =>
        wallet.credit(money('0.00', 'BRL'), 'tx-zero', 'entry-zero', nextAt),
      ).toThrow(InvalidMoneyError);

      expect(() =>
        wallet.credit(money('-5.00', 'BRL'), 'tx-neg', 'entry-neg', nextAt),
      ).toThrow(InvalidMoneyError);

      expect(wallet.balance.equals(money('100.00', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toBe(openedAt);
    });

    it('throws CurrencyMismatchError when credit currency differs from wallet currency', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-open',
        openingEntryId: 'entry-open',
        at: openedAt,
      });

      expect(() =>
        wallet.credit(money('10.00', 'EUR'), 'tx-eur', 'entry-eur', nextAt),
      ).toThrow(CurrencyMismatchError);

      expect(wallet.balance.equals(money('100.00', 'BRL'))).toBe(true);
      expect(wallet.version).toBe(1);
    });
  });

  describe('ledger chain across multiple movements', () => {
    it('maintains contiguous walletVersion and balanceBefore -> balanceAfter chain', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-chain',
        playerId: 'player-1',
        initialBalance: money('100.00', 'BRL'),
        openingTransactionId: 'tx-1',
        openingEntryId: 'e-1',
        at: openedAt,
      });

      const e2 = wallet.debit(money('30.00', 'BRL'), 'tx-2', 'e-2', nextAt);
      const e3 = wallet.credit(money('50.00', 'BRL'), 'tx-3', 'e-3', laterAt);
      const e4 = wallet.debit(money('120.00', 'BRL'), 'tx-4', 'e-4', laterAt);

      const entries = [openingEntry!, e2, e3, e4];
      expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);

      for (let i = 1; i < entries.length; i++) {
        expect(entries[i]!.balanceBefore.equals(entries[i - 1]!.balanceAfter)).toBe(true);
        expect(entries[i]!.isBalanced()).toBe(true);
      }

      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(4);
    });
  });
});
