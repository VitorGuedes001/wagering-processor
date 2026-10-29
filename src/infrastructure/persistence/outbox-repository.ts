import type { EntityManager } from '@mikro-orm/postgresql';
import type { OutboxRepository } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { OutboxMessageRecord } from './records/outbox-message.record';

/**
 * Repositório MikroORM de `outbox_message` (SCHEMA 2.5, 4.5; ARQUITETURA 3, 5; D12, D18, D25, D48, D62).
 * Recebe apenas o `EntityManager` da transação corrente via `RepositoryFactories` do `UnitOfWork` (D25).
 * Erros do driver sobem sem tradução local para serem traduzidos na borda do `MikroOrmUnitOfWork` (T20).
 */
export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * Insere um lote de `OutboxMessage` na mesma transação da mudança financeira
   * (SCHEMA 4.2 passo 9; CHALLENGE §6.5, §11; restrição 4).
   */
  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const records = messages.map((msg) => OutboxMessageRecord.fromDomain(msg));
    await this.em.insertMany(OutboxMessageRecord, records);
  }

  /**
   * Reserva até `limit` mensagens pendentes vencidas (`published_at IS NULL` e
   * `next_attempt_at <= now`) empurrando o lease `next_attempt_at` para `now + leaseMs`
   * com `FOR UPDATE SKIP LOCKED` (SCHEMA 4.5, D18, D48, D62).
   * Usa a transação recebida (`this.em`); o worker deve chamá-lo sozinho num `uow.run` curto,
   * publicar no SQS fora da transação (restrição 4) e gravar `markPublished`/`scheduleRetry`
   * em `uow.run` separados. O SQL seleciona por `next_attempt_at ASC` e o lote reservado é
   * devolvido ordenado por `(occurredAt ASC, id ASC)`.
   */
  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    if (limit <= 0) return [];

    const leaseUntil = new Date(now.getTime() + leaseMs);

    const rows = await this.em.execute<Array<Record<string, unknown>>>(
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
      const record = this.em.map(OutboxMessageRecord, row);
      return OutboxMessageRecord.toDomain(record);
    });

    messages.sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id),
    );

    return messages;
  }

  /**
   * Marca um evento do outbox como publicado em `at` (SCHEMA 4.5).
   * Zero linhas afetadas indica bug (id inexistente) e lança erro.
   */
  async markPublished(id: string, at: Date): Promise<void> {
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
  }

  /**
   * Persiste `attempts = attempts + 1` no SQL e o `nextAttemptAt` calculado por
   * `message.scheduleRetry(now)` após falha de publicação, apenas para linhas ainda não
   * publicadas (`published_at IS NULL`, SCHEMA 4.5, D12).
   * Zero linhas afetadas indica linha inexistente ou já publicada e lança erro.
   */
  async scheduleRetry(message: OutboxMessage): Promise<void> {
    const updated = await this.em.execute<Array<{ id: string }>>(
      `UPDATE outbox_message
          SET attempts = attempts + 1,
              next_attempt_at = ?
        WHERE id = ?
          AND published_at IS NULL
       RETURNING id`,
      [message.nextAttemptAt, message.id],
    );

    if (updated.length === 0) {
      throw new Error(`OutboxMessage pendente não encontrada para scheduleRetry: ${message.id}`);
    }
  }

  /**
   * Busca uma `OutboxMessage` pela chave primária `id`, reconstruindo a entidade
   * de domínio via `OutboxMessageRecord.toDomain`.
   */
  async findById(id: string): Promise<OutboxMessage | undefined> {
    const record = await this.em.findOne(
      OutboxMessageRecord,
      { id },
      { refresh: true, disableIdentityMap: true },
    );
    return record ? OutboxMessageRecord.toDomain(record) : undefined;
  }

  /**
   * Calcula o lag de outbox em segundos: `now - min(occurred_at) WHERE published_at IS NULL`
   * (SCHEMA 4.6; ARQUITETURA §9). Devolve 0 se não há eventos pendentes.
   */
  async computeLagSeconds(now: Date): Promise<number> {
    const rows = await this.em.execute<Array<{ min_occurred_at: string | Date | null }>>(
      `SELECT MIN(occurred_at) AS min_occurred_at
         FROM outbox_message
        WHERE published_at IS NULL`,
    );

    const raw = rows[0]?.min_occurred_at;
    if (!raw) {
      return 0;
    }

    const oldest = raw instanceof Date ? raw : new Date(raw);
    const lagMs = now.getTime() - oldest.getTime();
    return lagMs > 0 ? lagMs / 1000 : 0;
  }
}

export { MikroOrmOutboxRepository as SqlOutboxRepository };
