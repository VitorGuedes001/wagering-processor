import type { LedgerEntryView, LedgerPageView, TransactionView, WalletView } from './contracts';
import type { UnitOfWork } from './ports';

/** `ledger_entries.wallet_version` é `integer` no Postgres (SCHEMA 3). */
const MAX_WALLET_VERSION = 2_147_483_647;
const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/** Fonte única da regra do cursor: o schema HTTP valida chamando esta função. */
export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    if (!BASE64URL_REGEX.test(cursor)) throw new Error('Invalid cursor format');
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      !Array.isArray(decoded) &&
      typeof decoded.v === 'number' &&
      Number.isInteger(decoded.v) &&
      decoded.v >= 0 &&
      decoded.v <= MAX_WALLET_VERSION
    ) {
      return decoded.v;
    }
  } catch {
    // fall through
  }
  throw new Error('Invalid cursor format');
}

export function encodeCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion }), 'utf8').toString('base64url');
}

export interface WalletQueriesPort {
  findById(id: string): Promise<WalletView | undefined>;
  getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView | undefined>;
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

  async getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView | undefined> {
    const afterVersion = decodeCursor(cursor);
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
      const nextCursor = items.length === limit && lastItem ? encodeCursor(lastItem.walletVersion) : null;

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
