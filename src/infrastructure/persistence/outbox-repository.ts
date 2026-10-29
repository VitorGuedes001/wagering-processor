import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { type OutboxRepository, TransientInfrastructureError } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageRecord } from './records/outbox-message.record';

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
 * Repositório MikroORM de `outbox_message` (SCHEMA 2.5, 4.5; ARQUITETURA 3, 5; D12, D18, D48).
 * Recebe o `EntityManager` da transação corrente do `UnitOfWork` (em `enqueue`) ou o
 * `EntityManager` raiz para as operações em transação curta própria do worker (`claimDue`,
 * `markPublished`, `scheduleRetry`).
 */
@Injectable()
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  private scopedEm(): EntityManager {
    const ctx = this.em.getContext(false);
    return ctx.global ? ctx.fork() : ctx;
  }

  /**
   * Insere um lote de `OutboxMessage` na mesma transação da mudança financeira
   * (SCHEMA 4.2 passo 9; CHALLENGE §6.5, §11; restrição 4).
   */
  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;

    try {
      const records = messages.map((msg) => OutboxMessageRecord.fromDomain(msg));
      await this.scopedEm().insertMany(OutboxMessageRecord, records);
    } catch (err) {
      rethrowPersistenceError(err);
    }
  }

  /**
   * Reserva até `limit` mensagens pendentes vencidas (`published_at IS NULL` e
   * `next_attempt_at <= now`) empurrando o lease `next_attempt_at` para `now + leaseMs`
   * com `FOR UPDATE SKIP LOCKED` (SCHEMA 4.5, D18, D48).
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    if (limit <= 0) return [];

    const leaseUntil = new Date(now.getTime() + leaseMs);
    const em = this.scopedEm();

    try {
      const rows = await em.execute<Array<Record<string, unknown>>>(
        `UPDATE outbox_message
            SET next_attempt_at = ?
          WHERE id IN (
            SELECT id
              FROM outbox_message
             WHERE published_at IS NULL
               AND next_attempt_at <= ?
             ORDER BY next_attempt_at ASC, occurred_at ASC, id ASC
             LIMIT ?
             FOR UPDATE SKIP LOCKED
          )
         RETURNING id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at`,
        [leaseUntil, now, limit],
      );

      const messages = rows.map((row) => {
        const record = em.map(OutboxMessageRecord, row);
        return OutboxMessageRecord.toDomain(record);
      });

      messages.sort(
        (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id),
      );

      return messages;
    } catch (err) {
      return rethrowPersistenceError(err);
    }
  }

  /**
   * Marca um evento do outbox como publicado em `at` (SCHEMA 4.5).
   * Zero linhas afetadas indica bug (id inexistente) e lança erro.
   */
  async markPublished(id: string, at: Date): Promise<void> {
    try {
      const updated = await this.em.execute<Array<{ id: string }>>(
        `UPDATE outbox_message
            SET published_at = ?
          WHERE id = ?
         RETURNING id`,
        [at, id],
      );

      if (updated.length === 0) {
        throw new Error(`OutboxMessage não encontrada para markPublished: ${id}`);
      }
    } catch (err) {
      rethrowPersistenceError(err);
    }
  }

  /**
   * Persiste `attempts` e `nextAttemptAt` calculados por `message.scheduleRetry(now)`
   * após falha de publicação (SCHEMA 4.5, D12).
   * Zero linhas afetadas indica bug (id inexistente) e lança erro.
   */
  async scheduleRetry(message: OutboxMessage): Promise<void> {
    try {
      const updated = await this.em.execute<Array<{ id: string }>>(
        `UPDATE outbox_message
            SET attempts = ?,
                next_attempt_at = ?
          WHERE id = ?
         RETURNING id`,
        [message.attempts, message.nextAttemptAt, message.id],
      );

      if (updated.length === 0) {
        throw new Error(`OutboxMessage não encontrada para scheduleRetry: ${message.id}`);
      }
    } catch (err) {
      rethrowPersistenceError(err);
    }
  }

  /**
   * Busca uma `OutboxMessage` pela chave primária `id`, reconstruindo a entidade
   * de domínio via `OutboxMessageRecord.toDomain`.
   */
  async findById(id: string): Promise<OutboxMessage | undefined> {
    try {
      const record = await this.scopedEm().findOne(
        OutboxMessageRecord,
        { id },
        { refresh: true, disableIdentityMap: true },
      );
      return record ? OutboxMessageRecord.toDomain(record) : undefined;
    } catch (err) {
      return rethrowPersistenceError(err);
    }
  }
}

export { MikroOrmOutboxRepository as SqlOutboxRepository };
