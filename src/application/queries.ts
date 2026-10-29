import type { TransactionView, WalletView } from './contracts';
import type { UnitOfWork } from './ports';

export interface WalletQueriesPort {
  findById(id: string): Promise<WalletView | undefined>;
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
