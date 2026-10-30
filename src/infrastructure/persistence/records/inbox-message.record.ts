import { PrimaryKeyProp } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { InboxMessage } from '../../../domain/inbox-message';

/**
 * Entidade de persistência da tabela `inbox_message`.
 * Separada de `InboxMessage` para manter o domínio livre de ORM.
 */
@Entity({ tableName: 'inbox_message' })
export class InboxMessageRecord {
  [PrimaryKeyProp]?: ['consumerName', 'messageId'];

  @PrimaryKey({ fieldName: 'consumer_name', type: 'varchar', length: 128 })
  consumerName!: string;

  @PrimaryKey({ fieldName: 'message_id', type: 'varchar', length: 256 })
  messageId!: string;

  @Property({ fieldName: 'payload_hash', columnType: 'char(64)', type: 'string', length: 64 })
  payloadHash!: string;

  @Property({ fieldName: 'received_at', type: 'timestamptz' })
  receivedAt!: Date;

  @Property({ fieldName: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt?: Date | null;

  static fromDomain(message: InboxMessage): InboxMessageRecord {
    const record = new InboxMessageRecord();
    record.consumerName = message.consumerName;
    record.messageId = message.messageId;
    record.payloadHash = message.payloadHash;
    record.receivedAt = message.receivedAt;
    record.processedAt = message.processedAt ?? null;
    return record;
  }

  static toDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash.trim(),
      receivedAt: record.receivedAt instanceof Date ? record.receivedAt : new Date(record.receivedAt),
      processedAt:
        record.processedAt == null
          ? undefined
          : record.processedAt instanceof Date
            ? record.processedAt
            : new Date(record.processedAt),
    });
  }

  toDomain(): InboxMessage {
    return InboxMessageRecord.toDomain(this);
  }
}
