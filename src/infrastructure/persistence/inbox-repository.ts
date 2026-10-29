import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  type InboxReceiveResult,
  type InboxRepository,
  TransientInfrastructureError,
} from '../../application/ports';
import { InvalidTransactionStateError } from '../../domain/errors';
import type { InboxMessage } from '../../domain/inbox-message';
import { InboxMessageRecord } from './records/inbox-message.record';

const TRANSIENT_SQLSTATES = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '57014', // query_canceled (statement_timeout)
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

const TRANSIENT_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

function extractErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const record = current as Record<string, unknown>;
    if (typeof record.code === 'string' && record.code.length > 0) {
      return record.code;
    }
    if (typeof record.errno === 'string' && record.errno.length > 0) {
      return record.errno;
    }
    current = record.cause ?? record.previous;
  }
  return undefined;
}

function rethrowPersistenceError(err: unknown): never {
  if (err instanceof TransientInfrastructureError) {
    throw err;
  }
  const code = extractErrorCode(err);
  if (
    code !== undefined &&
    (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NODE_CODES.has(code))
  ) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TransientInfrastructureError(msg, { cause: err });
  }
  throw err;
}

/**
 * Repositório MikroORM de `inbox_message` (SCHEMA 2.4, 4.4; ARQUITETURA 3, 5; D7).
 * Recebe o `EntityManager` da transação corrente do `UnitOfWork` (ou o `EntityManager`
 * raiz quando injetado diretamente).
 */
@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  private scopedEm(): EntityManager {
    const ctx = this.em.getContext(false);
    return ctx.global ? ctx.fork() : ctx;
  }

  /**
   * `INSERT … ON CONFLICT DO NOTHING` (SCHEMA 4.4).
   * Se a chave `(consumer_name, message_id)` já existia, consulta e devolve o
   * `payload_hash` gravado para o use case distinguir duplicata idêntica de
   * divergência de payload (D7).
   */
  async tryReceive(message: InboxMessage): Promise<InboxReceiveResult> {
    try {
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
    } catch (err) {
      return rethrowPersistenceError(err);
    }
  }

  /**
   * Marca a mensagem da inbox como processada na mesma transação SQL do efeito
   * financeiro (SCHEMA 4.4). Exige que `message.markProcessed(at)` já tenha sido
   * invocado na entidade de domínio.
   */
  async markProcessed(message: InboxMessage): Promise<void> {
    if (message.processedAt === undefined) {
      throw new InvalidTransactionStateError(
        `InboxMessage (${message.consumerName}, ${message.messageId}) precisa ter processedAt definido antes de markProcessed no repositório.`,
      );
    }

    try {
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
    } catch (err) {
      rethrowPersistenceError(err);
    }
  }

  /**
   * Busca uma `InboxMessage` pela chave primária composta `(consumerName, messageId)`,
   * reconstruindo a entidade de domínio via `InboxMessageRecord.toDomain`.
   */
  async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    try {
      const record = await this.scopedEm().findOne(
        InboxMessageRecord,
        { consumerName, messageId },
        { refresh: true, disableIdentityMap: true },
      );
      return record ? InboxMessageRecord.toDomain(record) : undefined;
    } catch (err) {
      return rethrowPersistenceError(err);
    }
  }
}

export { MikroOrmInboxRepository as SqlInboxRepository };
