import type { Money } from './money';
import { notImplemented } from './not-implemented';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

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
    return notImplemented('T11', props);
  }

  /** Reconstrói do banco sem revalidar (§6.0). */
  static rehydrate(state: WalletState): Wallet {
    return notImplemented('T11', state);
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
    return notImplemented('T11', money);
  }

  /**
   * Debita, faz `version++` e devolve o lançamento correspondente. Lança
   * `InsufficientFundsError` (bug: `canDebit` deveria ter barrado),
   * `CurrencyMismatchError`, ou erro se `money` não for positivo.
   */
  debit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    return notImplemented('T11', money, transactionId, entryId, at);
  }

  /** Credita, faz `version++` e devolve o lançamento. Mesmas guardas de moeda e valor. */
  credit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry {
    return notImplemented('T11', money, transactionId, entryId, at);
  }
}
