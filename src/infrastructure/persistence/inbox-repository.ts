import type { EntityManager } from '@mikro-orm/postgresql';
import type { InboxReceiveResult, InboxRepository } from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import { InboxMessageRecord } from './records/inbox-message.record';

/**
 * Erro de infraestrutura lançado quando `InboxRepository.markProcessed` é invocado
 * para uma `InboxMessage` cujo `processedAt` ainda não foi preenchido.
 */
export class InboxMessageNotProcessedError extends Error {
  constructor(consumerName: string, messageId: string) {
    super(
      `InboxMessage (${consumerName}, ${messageId}) precisa ter processedAt definido antes de markProcessed no repositório.`,
    );
    this.name = 'InboxMessageNotProcessedError';
  }
}

/**
 * Repositório MikroORM de `inbox_message`.
 * Recebe apenas o `EntityManager` da transação corrente via `RepositoryFactories` do `UnitOfWork`.
 * Erros do driver sobem sem tradução local para serem traduzidos na borda do `MikroOrmUnitOfWork`.
 */
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `INSERT … ON CONFLICT DO NOTHING`.
   * Se a chave `(consumer_name, message_id)` já existia, consulta e devolve o
   * `payload_hash` gravado para o use case distinguir duplicata idêntica de
   * divergência de payload.
   */
  async tryReceive(message: InboxMessage): Promise<InboxReceiveResult> {
    const inserted = await this.em.execute<Array<{ message_id: string }>>(
      `INSERT INTO inbox_message (consumer_name, message_id, payload_hash, received_at, processed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (consumer_name, message_id) DO NOTHING
       RETURNING message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
    );

    if (inserted.length > 0) {
      return { accepted: true };
    }

    const existing = await this.em.execute<Array<{ payload_hash: string }>>(
      `SELECT payload_hash
         FROM inbox_message
        WHERE consumer_name = ?
          AND message_id = ?`,
      [message.consumerName, message.messageId],
    );

    const row = existing[0];
    if (!row) {
      throw new Error(
        `InboxMessage conflitante não encontrada após ON CONFLICT: (${message.consumerName}, ${message.messageId})`,
      );
    }

    return {
      accepted: false,
      storedPayloadHash: row.payload_hash.trim(),
    };
  }

  /**
   * Marca a mensagem da inbox como processada na mesma transação SQL do efeito
   * financeiro. Exige que `message.markProcessed(at)` já tenha sido
   * invocado na entidade de domínio.
   */
  async markProcessed(message: InboxMessage): Promise<void> {
    if (message.processedAt === undefined) {
      throw new InboxMessageNotProcessedError(message.consumerName, message.messageId);
    }

    const updated = await this.em.execute<Array<{ message_id: string }>>(
      `UPDATE inbox_message
          SET processed_at = ?
        WHERE consumer_name = ?
          AND message_id = ?
       RETURNING message_id`,
      [message.processedAt, message.consumerName, message.messageId],
    );

    if (updated.length === 0) {
      throw new Error(
        `InboxMessage não encontrada para markProcessed: (${message.consumerName}, ${message.messageId})`,
      );
    }
  }

  /**
   * Busca uma `InboxMessage` pela chave primária composta `(consumerName, messageId)`,
   * reconstruindo a entidade de domínio via `InboxMessageRecord.toDomain`.
   */
  async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(
      InboxMessageRecord,
      { consumerName, messageId },
      { refresh: true, disableIdentityMap: true },
    );
    return record ? InboxMessageRecord.toDomain(record) : undefined;
  }
}

export { MikroOrmInboxRepository as SqlInboxRepository };
