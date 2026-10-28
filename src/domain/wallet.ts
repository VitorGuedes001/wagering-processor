import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError, LedgerArithmeticError } from './errors';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

/** Forma persistida, já com tipos de domínio (D45). */
export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  /** Define a moeda da wallet. Zero não gera `OPENING` nem lançamento. */
  initialBalance: Money;
  /** Id da transação `OPENING`, criada à parte por `WagerTransaction.opening` (D42). */
  openingTransactionId: string;
  openingEntryId: string;
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Presente só quando `initialBalance > 0`. Tem `walletVersion = 1`. */
  openingEntry?: WalletLedgerEntry;
}

/**
 * Aggregate root e unidade de concorrência (§8). Invariantes em MODELAGEM 3:
 * saldo nunca negativo, toda mudança de saldo produz um lançamento, `version`
 * começa em 1 e só sobe quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Cria com `version = 1` já com o saldo inicial (o `OPENING` não incrementa). */
  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('Wallet initial balance cannot be negative');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );

    if (props.initialBalance.isZero()) {
      return { wallet };
    }

    const zeroMoney = Money.zero(props.initialBalance.currency);
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      walletVersion: 1,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: zeroMoney,
      balanceAfter: props.initialBalance,
      at: props.at,
    });

    return { wallet, openingEntry };
  }

  /** Reconstrói do banco sem revalidar (§6.0). */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** A regra de negócio consulta antes de debitar (MODELAGEM 5, verificação 10). */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /**
   * Debita, faz `version++` e devolve o lançamento correspondente. Lança
   * `InsufficientFundsError` (bug: `canDebit` deveria ter barrado),
   * `CurrencyMismatchError`, ou erro se `money` não for positivo.
   */
  debit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new LedgerArithmeticError('Debit money must be positive');
    }
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError('Insufficient funds for debit');
    }

    const before = this._balance;
    const after = before.subtract(money);
    const nextVersion = this._version + 1;

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      walletVersion: nextVersion,
      direction: LedgerDirection.Debit,
      money,
      balanceBefore: before,
      balanceAfter: after,
      at,
    });

    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = at;

    return entry;
  }

  /** Credita, faz `version++` e devolve o lançamento. Mesmas guardas de moeda e valor. */
  credit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new LedgerArithmeticError('Credit money must be positive');
    }

    const before = this._balance;
    const after = before.add(money);
    const nextVersion = this._version + 1;

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      walletVersion: nextVersion,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore: before,
      balanceAfter: after,
      at,
    });

    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = at;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Wallet currency ${this.currency} does not match operation currency ${money.currency}`,
      );
    }
  }
}
