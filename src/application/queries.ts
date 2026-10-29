import type { LedgerEntryView, LedgerPageView, TransactionView, WalletView } from './contracts';
import type { UnitOfWork } from './ports';

export interface WalletQueriesPort {
  findById(id: string): Promise<WalletView | undefined>;
  getLedger(walletId: string, afterVersion: number, limit: number): Promise<LedgerPageView | undefined>;
}

export interface TransactionQueriesPort {
  findById(id: string): Promise<TransactionView | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined>;
}

/**
 * Leituras simples de wallet (ARQUITETURA §2.1, queries.ts).
 */
export class ApplicationWalletQueries implements WalletQueriesPort {
  constructor(private readonly uow: UnitOfWork) {}

  async findById(id: string): Promise<WalletView | undefined> {
    return this.uow.run(async (tx) => {
      const wallet = await tx.wallets.findById(id);
      if (!wallet) return undefined;
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }

  async getLedger(walletId: string, afterVersion: number, limit: number): Promise<LedgerPageView | undefined> {
    return this.uow.readSnapshot(async (tx) => {
      const wallet = await tx.wallets.findById(walletId);
      if (!wallet) return undefined;

      const entries = await tx.ledger.page(walletId, afterVersion, limit);
      const items: LedgerEntryView[] = entries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
        createdAt: entry.createdAt.toISOString(),
      }));

      const lastItem = items[items.length - 1];
      const nextCursor = items.length === limit && lastItem ? lastItem.walletVersion : null;

      return {
        items,
        nextCursor,
      };
    });
  }
}

/**
 * Leituras simples de transações por id interno ou (providerId, externalTransactionId).
 */
export class ApplicationTransactionQueries implements TransactionQueriesPort {
  constructor(private readonly uow: UnitOfWork) {}

  async findById(id: string): Promise<TransactionView | undefined> {
    return this.uow.run(async (tx) => {
      const t = await tx.transactions.findById(id);
      if (!t) return undefined;
      return {
        transactionId: t.id,
        status: t.status,
        balance: t.balanceAfter?.toJSON(),
        failureCode: t.failureCode,
      };
    });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<TransactionView | undefined> {
    return this.uow.run(async (tx) => {
      const t = await tx.transactions.findByExternalId(providerId, externalTransactionId);
      if (!t) return undefined;
      return {
        transactionId: t.id,
        status: t.status,
        balance: t.balanceAfter?.toJSON(),
        failureCode: t.failureCode,
      };
    });
  }
}
