import { Migration } from '@mikro-orm/migrations';

export class Migration20261028000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table "smoke_balance" (
        "id" uuid not null,
        "amount" numeric(20,2) not null,
        "currency" varchar(3) not null,
        "created_at" timestamptz not null,
        constraint "smoke_balance_pkey" primary key ("id"),
        constraint "smoke_balance_amount_non_negative" check ("amount" >= 0)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "smoke_balance";`);
  }
}
