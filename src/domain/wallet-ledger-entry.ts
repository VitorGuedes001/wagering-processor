import { LedgerArithmeticError } from './errors';
import type { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  /** `version` da wallet **depois** deste lançamento (D16). */
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  at: Date;
}

/** Forma persistida, já com tipos de domínio (D45). */
export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  walletVersion: number;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/**
 * Lançamento do ledger. Imutável por estrutura: sem campos mutáveis e sem
 * métodos de transição (CHALLENGE §6.4). Só `Wallet.open`, `debit` e `credit`
 * chamam `create`, então o lançamento nasce junto com a mudança de saldo.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /**
   * Lança `LedgerArithmeticError` se `money` não for positivo, se as moedas
   * diferirem, se `balanceBefore ± money !== balanceAfter` ou se `balanceAfter`
   * for negativo (MODELAGEM 6).
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new LedgerArithmeticError('Ledger entry money must be positive');
    }
    if (
      props.money.currency !== props.balanceBefore.currency ||
      props.money.currency !== props.balanceAfter.currency
    ) {
      throw new LedgerArithmeticError('Ledger entry currencies must match');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new LedgerArithmeticError('Ledger entry balances cannot be negative');
    }
    if (props.walletVersion < 1 || props.walletVersion % 1 !== 0) {
      throw new LedgerArithmeticError('Ledger entry walletVersion must be an integer >= 1');
    }

    const expectedAfter =
      props.direction === LedgerDirection.Credit
        ? props.balanceBefore.add(props.money)
        : props.balanceBefore.subtract(props.money);
    if (!expectedAfter.equals(props.balanceAfter)) {
      throw new LedgerArithmeticError('Ledger entry arithmetic does not balance');
    }

    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.walletVersion,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.at,
    );
  }

  /** Reconstrói do banco sem revalidar (§6.0). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** `balanceBefore ± money === balanceAfter`. */
  isBalanced(): boolean {
    if (
      this.money.currency !== this.balanceBefore.currency ||
      this.money.currency !== this.balanceAfter.currency
    ) {
      return false;
    }
    const expectedAfter =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expectedAfter.equals(this.balanceAfter);
  }
}
