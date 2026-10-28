import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'smoke_balance' })
export class SmokeBalance {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'numeric', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'varchar', length: 3 })
  currency!: string;

  @Property({ fieldName: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
