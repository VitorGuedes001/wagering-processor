import type { Money } from './money';
import { notImplemented } from './not-implemented';

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
    return notImplemented('T11', props);
  }

  /** Reconstrói do banco sem revalidar (§6.0). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return notImplemented('T11', state);
  }

  /** `balanceBefore ± money === balanceAfter`. */
  isBalanced(): boolean {
    return notImplemented('T11');
  }
}
