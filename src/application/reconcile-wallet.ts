import type { UnitOfWork } from './ports';
import { reconcile } from '../domain/reconcile';
import type { ReconciliationView } from './contracts';

/**
 * Reconcilia o saldo da wallet contra o histórico imutável do ledger.
 * Executa sob snapshot isolado REPEATABLE READ READ ONLY, sem travar a wallet.
 */
export class ReconcileWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<ReconciliationView | undefined> {
    return this.uow.readSnapshot(async (tx) => {
      const wallet = await tx.wallets.findById(walletId);
      if (!wallet) return undefined;

      const entries = await tx.ledger.all(walletId);
      const result = reconcile(wallet, entries);

      return {
        walletId: result.walletId,
        storedBalance: result.storedBalance.toJSON(),
        calculatedBalance: result.calculatedBalance.toJSON(),
        difference: result.difference.toJSON(),
        consistent: result.consistent,
        chainIntact: result.chainIntact,
        checkedEntries: result.checkedEntries,
      };
    });
  }
}
