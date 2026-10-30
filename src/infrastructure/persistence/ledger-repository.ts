import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerRepository } from '../../application/ports';
import { Money } from '../../domain/money';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerEntryRecord } from './records/ledger-entry.record';

/** Append-only: não existe `update` nem `delete`, e o schema também recusa. */
export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntryRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      walletVersion: entry.walletVersion,
      direction: entry.direction,
      amount: entry.money.toJSON().amount,
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      createdAt: entry.createdAt,
    });
  }

  /** Cursor por `wallet_version`, estável porque o ledger é imutável. */
  async page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit, disableIdentityMap: true },
    );
    return records.map(toDomain);
  }

  async all(walletId: string): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      { walletId },
      { orderBy: { walletVersion: 'asc' }, disableIdentityMap: true },
    );
    return records.map(toDomain);
  }
}

function toDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    walletVersion: record.walletVersion,
    direction: record.direction as LedgerDirection,
    money: Money.fromPersistence(record.amount, record.currency),
    balanceBefore: Money.fromPersistence(record.balanceBefore, record.currency),
    balanceAfter: Money.fromPersistence(record.balanceAfter, record.currency),
    createdAt: record.createdAt,
  });
}
