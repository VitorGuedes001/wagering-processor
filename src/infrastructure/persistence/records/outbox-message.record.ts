import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { OutboxMessage } from '../../../domain/outbox-message';

/**
 * Entidade de persistência da tabela `outbox_message`.
 * Separada de `OutboxMessage` para manter o domínio livre de ORM.
 */
@Entity({ tableName: 'outbox_message' })
export class OutboxMessageRecord {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ fieldName: 'aggregate_id', type: 'uuid' })
  aggregateId!: string;

  @Property({ fieldName: 'event_type', type: 'varchar', length: 128 })
  eventType!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ fieldName: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Property({ type: 'integer', default: 0 })
  attempts!: number;

  @Property({ fieldName: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @Property({ fieldName: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt?: Date | null;

  static fromDomain(message: OutboxMessage): OutboxMessageRecord {
    const record = new OutboxMessageRecord();
    record.id = message.id;
    record.aggregateId = message.aggregateId;
    record.eventType = message.eventType;
    record.payload = { ...message.payload };
    record.occurredAt = message.occurredAt;
    record.attempts = message.attempts;
    record.nextAttemptAt = message.nextAttemptAt;
    record.publishedAt = message.publishedAt ?? null;
    return record;
  }

  static toDomain(record: OutboxMessageRecord): OutboxMessage {
    const rawPayload =
      typeof record.payload === 'string'
        ? (JSON.parse(record.payload) as Record<string, unknown>)
        : { ...record.payload };

    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: rawPayload,
      occurredAt: record.occurredAt instanceof Date ? record.occurredAt : new Date(record.occurredAt),
      attempts: record.attempts,
      nextAttemptAt:
        record.nextAttemptAt instanceof Date ? record.nextAttemptAt : new Date(record.nextAttemptAt),
      publishedAt:
        record.publishedAt == null
          ? undefined
          : record.publishedAt instanceof Date
            ? record.publishedAt
            : new Date(record.publishedAt),
    });
  }

  toDomain(): OutboxMessage {
    return OutboxMessageRecord.toDomain(this);
  }
}
