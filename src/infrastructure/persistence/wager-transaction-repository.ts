import { LockMode, type EntityManager, type RequiredEntityData } from '@mikro-orm/postgresql';
import type { WagerTransactionRepository } from '../../application/ports';
import type { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { WagerTransactionRecord } from './records/wager-transaction.record';

/**
 * Converte `WagerTransactionRecord` lido do banco em `WagerTransaction` de domínio
 * (SCHEMA §2, §7; MODELAGEM D45). Dinheiro chega como `string` e passa por
 * `Money.fromPersistence`.
 */
export function toWagerTransactionDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId ?? undefined,
    externalTransactionId: record.externalTransactionId ?? undefined,
    idempotencyKey: record.idempotencyKey ?? undefined,
    payloadHash: record.payloadHash ?? undefined,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId ?? undefined,
    gameId: record.gameId ?? undefined,
    kind: record.kind as WagerTransactionKind,
    money: Money.fromPersistence(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode ?? undefined) as FailureCode | undefined,
    balanceAfter:
      record.balanceAfter !== null && record.balanceAfter !== undefined
        ? Money.fromPersistence(record.balanceAfter, record.currency)
        : undefined,
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: record.nextReferenceAttemptAt ?? undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

/**
 * Converte `WagerTransaction` de domínio nos dados persistidos de `WagerTransactionRecord`.
 * Valores monetários saem sempre como `string` (`Money.toJSON().amount`), nunca `number` (5.1).
 */
export function toWagerTransactionRecordData(
  transaction: WagerTransaction,
): RequiredEntityData<WagerTransactionRecord> {
  return {
    id: transaction.id,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    kind: transaction.kind,
    status: transaction.status,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    providerId: transaction.providerId ?? null,
    externalTransactionId: transaction.externalTransactionId ?? null,
    idempotencyKey: transaction.idempotencyKey ?? null,
    payloadHash: transaction.payloadHash ?? null,
    roundId: transaction.roundId ?? null,
    gameId: transaction.gameId ?? null,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    balanceAfter: transaction.balanceAfter ? transaction.balanceAfter.toJSON().amount : null,
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    processedAt: transaction.processedAt ?? null,
  };
}

/**
 * Implementação MikroORM/PostgreSQL de `WagerTransactionRepository` (ARQUITETURA §3, SCHEMA §2.2, §4.5, §7).
 * Recebe apenas o `EntityManager` da transação corrente via `RepositoryFactories` do `UnitOfWork` (D25).
 * Erros do driver sobem sem tradução local para serem traduzidos na borda do `MikroOrmUnitOfWork`.
 */
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, idempotencyKey },
      { disableIdentityMap: true },
    );
    return record ? toWagerTransactionDomain(record) : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { providerId, externalTransactionId },
      { disableIdentityMap: true },
    );
    return record ? toWagerTransactionDomain(record) : undefined;
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { disableIdentityMap: true },
    );
    return record ? toWagerTransactionDomain(record) : undefined;
  }

  /**
   * Verifica se já existe reversão (`REFUND` ou `ROLLBACK`) `PROCESSED` apontando
   * para `referenceTransactionId` (MODELAGEM D1, índice `wager_tx_single_reversal_uq`).
   */
  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  /**
   * `SELECT … FOR UPDATE` (SCHEMA §4.5, §7).
   * Usado pelo worker de `PENDING_REFERENCE` após travar a wallet.
   */
  async lockById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true, disableIdentityMap: true },
    );
    return record ? toWagerTransactionDomain(record) : undefined;
  }

  /**
   * Reserva por lease (`next_reference_attempt_at = now + leaseMs`) até `limit`
   * transações em `PENDING_REFERENCE` vencidas (`next_reference_attempt_at <= now`),
   * usando `FOR UPDATE SKIP LOCKED` (SCHEMA D18, §4.5, §7).
   */
  async claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]> {
    if (limit <= 0) {
      return [];
    }
    const leaseUntil = new Date(now.getTime() + leaseMs);
    const rows = await this.em.execute<Array<{ id: string }>>(
      `
      WITH due AS (
        SELECT id, next_reference_attempt_at
          FROM wager_transaction
         WHERE status = ?
           AND next_reference_attempt_at <= ?
         ORDER BY next_reference_attempt_at ASC, id ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED
      ),
      claimed AS (
        UPDATE wager_transaction AS wt
           SET next_reference_attempt_at = ?
          FROM due
         WHERE wt.id = due.id
        RETURNING wt.id, due.next_reference_attempt_at
      )
      SELECT id
        FROM claimed
       ORDER BY next_reference_attempt_at ASC, id ASC
      `,
      [WagerTransactionStatus.PendingReference, now, limit, leaseUntil],
    );
    return rows.map((row) => row.id);
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionRecord, toWagerTransactionRecordData(transaction));
  }

  /**
   * Atualiza apenas as colunas mutáveis permitidas pelo trigger `wager_tx_guard`
   * (SCHEMA §3, MODELAGEM §4.3). Lança erro se a linha não existir.
   */
  async update(transaction: WagerTransaction): Promise<void> {
    const affectedRows = await this.em.nativeUpdate(
      WagerTransactionRecord,
      { id: transaction.id },
      {
        status: transaction.status,
        referenceTransactionId: transaction.referenceTransactionId ?? null,
        failureCode: transaction.failureCode ?? null,
        balanceAfter: transaction.balanceAfter ? transaction.balanceAfter.toJSON().amount : null,
        referenceAttempts: transaction.referenceAttempts,
        nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
        updatedAt: transaction.updatedAt,
        processedAt: transaction.processedAt ?? null,
      },
    );

    if (affectedRows === 0) {
      throw new Error(`WagerTransaction não encontrada para update: ${transaction.id}`);
    }
  }
}
