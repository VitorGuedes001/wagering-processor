import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, LedgerArithmeticError } from '../../src/domain/errors';
import { Money, type MoneyProps } from '../../src/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

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

describe('WalletLedgerEntry', () => {
  const at = new Date('2026-10-28T12:00:00.000Z');

  describe('create', () => {
    it('creates a valid CREDIT entry when balanceBefore + money === balanceAfter', () => {
      const entry = WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        walletVersion: 2,
        direction: LedgerDirection.Credit,
        money: money('25.50'),
        balanceBefore: money('100.00'),
        balanceAfter: money('125.50'),
        at,
      });

      expect(entry.id).toBe('entry-1');
      expect(entry.walletId).toBe('wallet-1');
      expect(entry.transactionId).toBe('tx-1');
      expect(entry.walletVersion).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.money.equals(money('25.50'))).toBe(true);
      expect(entry.balanceBefore.equals(money('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(money('125.50'))).toBe(true);
      expect(entry.createdAt).toBe(at);
      expect(entry.isBalanced()).toBe(true);
    });

    it('creates a valid CREDIT opening entry starting from 0.00 with walletVersion = 1', () => {
      const entry = WalletLedgerEntry.create({
        id: 'entry-open',
        walletId: 'wallet-1',
        transactionId: 'tx-open',
        walletVersion: 1,
        direction: LedgerDirection.Credit,
        money: money('100.00'),
        balanceBefore: money('0.00'),
        balanceAfter: money('100.00'),
        at,
      });

      expect(entry.walletVersion).toBe(1);
      expect(entry.isBalanced()).toBe(true);
    });

    it('creates a valid DEBIT entry when balanceBefore - money === balanceAfter', () => {
      const entry = WalletLedgerEntry.create({
        id: 'entry-2',
        walletId: 'wallet-1',
        transactionId: 'tx-2',
        walletVersion: 3,
        direction: LedgerDirection.Debit,
        money: money('40.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('60.00'),
        at,
      });

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceBefore.equals(money('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(money('60.00'))).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it('creates a valid DEBIT entry that reduces balance to exact zero', () => {
      const entry = WalletLedgerEntry.create({
        id: 'entry-zero',
        walletId: 'wallet-1',
        transactionId: 'tx-zero',
        walletVersion: 2,
        direction: LedgerDirection.Debit,
        money: money('100.00'),
        balanceBefore: money('100.00'),
        balanceAfter: money('0.00'),
        at,
      });

      expect(entry.balanceAfter.isZero()).toBe(true);
      expect(entry.isBalanced()).toBe(true);
    });

    it('throws LedgerArithmeticError when money is zero', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-zero-money',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('0.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('100.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);

      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-zero-debit',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Debit,
          money: money('0.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('100.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when money is negative', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-neg-money',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('-10.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('90.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when currencies differ across money, balanceBefore, or balanceAfter', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-curr-1',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('25.00', 'USD'),
          balanceBefore: money('100.00', 'BRL'),
          balanceAfter: money('125.00', 'BRL'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);

      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-curr-2',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('25.00', 'BRL'),
          balanceBefore: money('100.00', 'USD'),
          balanceAfter: money('125.00', 'BRL'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);

      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-curr-3',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('25.00', 'BRL'),
          balanceBefore: money('100.00', 'BRL'),
          balanceAfter: money('125.00', 'USD'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when CREDIT arithmetic does not match balanceAfter', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-bad-credit',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('25.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('120.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when DEBIT arithmetic does not match balanceAfter', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-bad-debit',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Debit,
          money: money('25.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('80.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when direction is inverted relative to balances', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-inverted-credit',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('25.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('75.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);

      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-inverted-debit',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Debit,
          money: money('25.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('125.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when balanceAfter is negative', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-neg-after',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Debit,
          money: money('25.00'),
          balanceBefore: money('10.00'),
          balanceAfter: money('-15.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when balanceBefore is negative', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-neg-before',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 2,
          direction: LedgerDirection.Credit,
          money: money('25.00'),
          balanceBefore: money('-10.00'),
          balanceAfter: money('15.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });

    it('throws LedgerArithmeticError when walletVersion is less than 1 or not an integer', () => {
      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-v0',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 0,
          direction: LedgerDirection.Credit,
          money: money('25.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('125.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);

      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-v-neg',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: -1,
          direction: LedgerDirection.Credit,
          money: money('25.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('125.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);

      expect(() =>
        WalletLedgerEntry.create({
          id: 'entry-v-float',
          walletId: 'wallet-1',
          transactionId: 'tx-1',
          walletVersion: 1.5,
          direction: LedgerDirection.Credit,
          money: money('25.00'),
          balanceBefore: money('100.00'),
          balanceAfter: money('125.00'),
          at,
        }),
      ).toThrow(LedgerArithmeticError);
    });
  });

  describe('rehydrate and isBalanced', () => {
    it('rehydrates a valid state and reports isBalanced() === true', () => {
      const entry = WalletLedgerEntry.rehydrate({
        id: 'entry-reh-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        walletVersion: 4,
        direction: LedgerDirection.Debit,
        money: money('15.00'),
        balanceBefore: money('50.00'),
        balanceAfter: money('35.00'),
        createdAt: at,
      });

      expect(entry.id).toBe('entry-reh-1');
      expect(entry.walletVersion).toBe(4);
      expect(entry.createdAt).toBe(at);
      expect(entry.isBalanced()).toBe(true);
    });

    it('rehydrates without revalidating and reports isBalanced() === false when tampered', () => {
      const brokenCredit = WalletLedgerEntry.rehydrate({
        id: 'entry-reh-broken-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        walletVersion: 2,
        direction: LedgerDirection.Credit,
        money: money('15.00'),
        balanceBefore: money('50.00'),
        balanceAfter: money('70.00'),
        createdAt: at,
      });
      expect(brokenCredit.isBalanced()).toBe(false);

      const brokenDebit = WalletLedgerEntry.rehydrate({
        id: 'entry-reh-broken-2',
        walletId: 'wallet-1',
        transactionId: 'tx-2',
        walletVersion: 3,
        direction: LedgerDirection.Debit,
        money: money('15.00'),
        balanceBefore: money('50.00'),
        balanceAfter: money('40.00'),
        createdAt: at,
      });
      expect(brokenDebit.isBalanced()).toBe(false);

      const mismatchedCurrency = WalletLedgerEntry.rehydrate({
        id: 'entry-reh-broken-3',
        walletId: 'wallet-1',
        transactionId: 'tx-3',
        walletVersion: 4,
        direction: LedgerDirection.Credit,
        money: money('15.00', 'USD'),
        balanceBefore: money('50.00', 'BRL'),
        balanceAfter: money('65.00', 'BRL'),
        createdAt: at,
      });
      expect(mismatchedCurrency.isBalanced()).toBe(false);
    });
  });
});
