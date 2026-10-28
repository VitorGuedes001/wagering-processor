import type { Money } from './money';
import { notImplemented } from './not-implemented';
import type { Wallet } from './wallet';
import type { WalletLedgerEntry } from './wallet-ledger-entry';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  /** `stored − calculated`. Pode ser negativa. */
  difference: Money;
  /** Saldo bate **e** a cadeia está íntegra. */
  consistent: boolean;
  /** Cada `balanceBefore` é o `balanceAfter` anterior, e o primeiro parte de zero. */
  chainIntact: boolean;
  checkedEntries: number;
}

/**
 * Recalcula o saldo pelo ledger e confere a cadeia (MODELAGEM 11). Só sinaliza:
 * divergência nunca é corrigida aqui. `entries` vem em ordem de `walletVersion`.
 */
export function reconcile(wallet: Wallet, entries: readonly WalletLedgerEntry[]): ReconciliationResult {
  return notImplemented('T16', wallet, entries);
}
