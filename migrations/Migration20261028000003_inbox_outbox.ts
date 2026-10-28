import { Migration } from '@mikro-orm/migrations';

/**
 * `inbox_message` e `outbox_message` (SCHEMA 2.4 e 2.5). O inbox deduplica a fila
 * pela PK; o outbox é a fila de publicação com lease em `next_attempt_at` (D18).
 */
export class Migration20261028000003_inbox_outbox extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_message (
        consumer_name varchar(128) NOT NULL,
        message_id    varchar(256) NOT NULL,
        payload_hash  char(64)     NOT NULL,
        received_at   timestamptz  NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )
    `);

    this.addSql(`
      CREATE TABLE outbox_message (
        id               uuid         PRIMARY KEY,
        aggregate_id     uuid         NOT NULL,
        event_type       varchar(128) NOT NULL,
        payload          jsonb        NOT NULL,
        occurred_at      timestamptz  NOT NULL,
        attempts         integer      NOT NULL DEFAULT 0,
        next_attempt_at  timestamptz  NOT NULL,
        published_at     timestamptz,

        CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0)
      )
    `);

    this.addSql(`CREATE INDEX outbox_due_ix ON outbox_message (next_attempt_at) WHERE published_at IS NULL`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE outbox_message`);
    this.addSql(`DROP TABLE inbox_message`);
  }
}
