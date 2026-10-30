import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Record de persistência da tabela `wager_transaction`.
 * Separado da entidade de domínio `WagerTransaction`.
 *
 * Campos monetários (`amount`, `balanceAfter`) são mantidos como `string`
 * e convertidos no repositório via `Money.fromPersistence`.
 */
@Entity({ tableName: 'wager_transaction' })
export class WagerTransactionRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @Property({ fieldName: 'player_id', type: 'uuid' })
  playerId!: string;

  @Property({ type: 'varchar', length: 16 })
  kind!: string;

  @Property({ type: 'varchar', length: 24 })
  status!: string;

  @Property({ type: 'numeric', precision: 19, scale: 2 })
  amount!: string;

  @Property({ columnType: 'char(3)', type: 'string', length: 3 })
  currency!: string;

  @Property({ fieldName: 'provider_id', type: 'varchar', length: 128, nullable: true })
  providerId?: string | null;

  @Property({ fieldName: 'external_transaction_id', type: 'varchar', length: 128, nullable: true })
  externalTransactionId?: string | null;

  @Property({ fieldName: 'idempotency_key', type: 'varchar', length: 256, nullable: true })
  idempotencyKey?: string | null;

  @Property({ fieldName: 'payload_hash', columnType: 'char(64)', type: 'string', length: 64, nullable: true })
  payloadHash?: string | null;

  @Property({ fieldName: 'round_id', type: 'varchar', length: 128, nullable: true })
  roundId?: string | null;

  @Property({ fieldName: 'game_id', type: 'varchar', length: 128, nullable: true })
  gameId?: string | null;

  @Property({ fieldName: 'reference_external_transaction_id', type: 'varchar', length: 128, nullable: true })
  referenceExternalTransactionId?: string | null;

  @Property({ fieldName: 'reference_transaction_id', type: 'uuid', nullable: true })
  referenceTransactionId?: string | null;

  @Property({ fieldName: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode?: string | null;

  @Property({ fieldName: 'balance_after', type: 'numeric', precision: 19, scale: 2, nullable: true })
  balanceAfter?: string | null;

  @Property({ fieldName: 'reference_attempts', type: 'integer', default: 0 })
  referenceAttempts!: number;

  @Property({ fieldName: 'next_reference_attempt_at', type: 'timestamptz', nullable: true })
  nextReferenceAttemptAt?: Date | null;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Property({ fieldName: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Property({ fieldName: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;
}
