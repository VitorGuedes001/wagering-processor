import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Linha de `wallet_ledger_entry`. Sem relações declaradas: as FKs
 * compostas vivem no schema, e o repositório escreve na ordem do use case.
 * Dinheiro é string.
 */
@Entity({ tableName: 'wallet_ledger_entry' })
export class LedgerEntryRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  walletId!: string;

  @Property({ type: 'uuid' })
  transactionId!: string;

  /** `version` da wallet depois deste lançamento. */
  @Property({ type: 'integer' })
  walletVersion!: number;

  @Property({ type: 'string', length: 6 })
  direction!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  amount!: string;

  @Property({ type: 'character', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;
}
