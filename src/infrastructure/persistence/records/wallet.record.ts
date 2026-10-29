import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

/**
 * Linha de `wallet` (SCHEMA 2.1). Entidade de persistência, separada do domínio
 * (SCHEMA 7): o repositório converte para `Wallet` com `Money.fromPersistence`.
 * `balance` é string porque `numeric(19,2)` chega exato do driver (restrição 5.1).
 */
@Entity({ tableName: 'wallet' })
export class WalletRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'uuid' })
  playerId!: string;

  @Property({ type: 'character', length: 3 })
  currency!: string;

  @Property({ type: 'decimal', precision: 19, scale: 2 })
  balance!: string;

  /** Sem `version: true` (SCHEMA 7): a checagem é explícita no `UPDATE`. */
  @Property({ type: 'integer' })
  version!: number;

  @Property({ type: 'timestamptz' })
  createdAt!: Date;

  @Property({ type: 'timestamptz' })
  updatedAt!: Date;
}
