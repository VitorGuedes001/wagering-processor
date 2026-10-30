import { Money } from './money';
import type { Wallet } from './wallet';
import { LedgerDirection, type WalletLedgerEntry } from './wallet-ledger-entry';

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
 * Recalcula o saldo pelo ledger e confere a cadeia. Só sinaliza:
 * divergência nunca é corrigida aqui. `entries` vem em ordem de `walletVersion`.
 *
 * Atenção: wallet aberta com saldo zero não gera `OPENING`, então o
 * primeiro lançamento tem `walletVersion = 2` e `balanceBefore = 0.00`. A verificação
 * confere a cadeia de saldos (partindo de zero e com cada lançamento internamente
 * balanceado), e não a contiguidade de `walletVersion`.
 */
export function reconcile(wallet: Wallet, entries: readonly WalletLedgerEntry[]): ReconciliationResult {
  const zero = Money.zero(wallet.currency);
  let calculatedBalance = zero;
  let expectedBefore = zero;
  let chainIntact = true;

  for (const entry of entries) {
    if (!entry.balanceBefore.equals(expectedBefore) || !entry.isBalanced()) {
      chainIntact = false;
    }
    expectedBefore = entry.balanceAfter;
    calculatedBalance =
      entry.direction === LedgerDirection.Credit
        ? calculatedBalance.add(entry.money)
        : calculatedBalance.subtract(entry.money);
  }

  const storedBalance = wallet.balance;
  const difference = storedBalance.subtract(calculatedBalance);
  const consistent = chainIntact && storedBalance.equals(calculatedBalance);

  return {
    walletId: wallet.id,
    storedBalance,
    calculatedBalance,
    difference,
    consistent,
    chainIntact,
    checkedEntries: entries.length,
  };
}
