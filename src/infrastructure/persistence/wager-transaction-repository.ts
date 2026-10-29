import { LockMode, type EntityManager, type RequiredEntityData } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import {
  TransientInfrastructureError,
  type UniqueConstraint,
  UniqueViolationError,
  type WagerTransactionRepository,
} from '../../application/ports';
import type { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { WagerTransactionRecord } from './records/wager-transaction.record';

const UNIQUE_CONSTRAINTS: ReadonlySet<UniqueConstraint> = new Set<UniqueConstraint>([
  'wallet_player_currency_uq',
  'wager_tx_idempotency_uq',
  'wager_tx_external_uq',
  'wager_tx_single_reversal_uq',
  'wager_tx_single_opening_uq',
  'ledger_transaction_uq',
  'ledger_wallet_version_uq',
]);

const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '40P01', // deadlock_detected
  '57014', // query_canceled (statement_timeout)
  '53300', // too_many_connections
]);

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

function isUniqueConstraint(value: unknown): value is UniqueConstraint {
  return typeof value === 'string' && UNIQUE_CONSTRAINTS.has(value as UniqueConstraint);
}

/**
 * Extrai SQLSTATE e constraint do erro lançado pelo driver (`pg` / `Bun.SQL`) ou
 * encapsulado pelo `PostgreSqlExceptionConverter` do MikroORM, e traduz segundo
 * SCHEMA §5 para os tipos de `src/application/ports.ts`.
 */
function translatePersistenceError(error: unknown): unknown {
  if (error instanceof UniqueViolationError || error instanceof TransientInfrastructureError) {
    return error;
  }

  const candidates: Array<Record<string, unknown>> = [];
  let current: unknown = error;
  while (current !== null && typeof current === 'object' && candidates.length < 5) {
    const rec = current as Record<string, unknown>;
    candidates.push(rec);
    current = rec.cause ?? rec.previous;
  }

  let sqlState: string | undefined;
  let constraint: string | undefined;
  let netCode: string | undefined;

  for (const candidate of candidates) {
    if (sqlState === undefined) {
      const code = candidate.code ?? candidate.errno ?? candidate.sqlState;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
        sqlState = code;
      } else if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) {
        netCode = code;
      }
    }
    if (constraint === undefined && typeof candidate.constraint === 'string') {
      constraint = candidate.constraint;
    }
  }

  if (sqlState === '23505' && isUniqueConstraint(constraint)) {
    return new UniqueViolationError(constraint, { cause: error });
  }

  if (
    (sqlState !== undefined &&
      (TRANSIENT_SQLSTATES.has(sqlState) ||
        sqlState.startsWith('08') ||
        sqlState.startsWith('57P'))) ||
    netCode !== undefined
  ) {
    const message = error instanceof Error ? error.message : String(error);
    return new TransientInfrastructureError(message, { cause: error });
  }

  return error;
}

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
 */
@Injectable()
export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdempotencyKey(
    providerId: string,
    idempotencyKey: string,
  ): Promise<WagerTransaction | undefined> {
    try {
      const record = await this.em.findOne(
        WagerTransactionRecord,
        { providerId, idempotencyKey },
        { disableIdentityMap: true },
      );
      return record ? toWagerTransactionDomain(record) : undefined;
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    try {
      const record = await this.em.findOne(
        WagerTransactionRecord,
        { providerId, externalTransactionId },
        { disableIdentityMap: true },
      );
      return record ? toWagerTransactionDomain(record) : undefined;
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    try {
      const record = await this.em.findOne(
        WagerTransactionRecord,
        { id },
        { disableIdentityMap: true },
      );
      return record ? toWagerTransactionDomain(record) : undefined;
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  /**
   * Verifica se já existe reversão (`REFUND` ou `ROLLBACK`) `PROCESSED` apontando
   * para `referenceTransactionId` (MODELAGEM D1, índice `wager_tx_single_reversal_uq`).
   */
  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    try {
      const count = await this.em.count(WagerTransactionRecord, {
        referenceTransactionId,
        kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
        status: WagerTransactionStatus.Processed,
      });
      return count > 0;
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  /**
   * `SELECT … FOR UPDATE` (SCHEMA §4.5, §7).
   * Usado pelo worker de `PENDING_REFERENCE` após travar a wallet.
   */
  async lockById(id: string): Promise<WagerTransaction | undefined> {
    try {
      const record = await this.em.findOne(
        WagerTransactionRecord,
        { id },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true, disableIdentityMap: true },
      );
      return record ? toWagerTransactionDomain(record) : undefined;
    } catch (error) {
      throw translatePersistenceError(error);
    }
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
    try {
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
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    try {
      await this.em.insert(WagerTransactionRecord, toWagerTransactionRecordData(transaction));
    } catch (error) {
      throw translatePersistenceError(error);
    }
  }

  /**
   * Atualiza apenas as colunas mutáveis permitidas pelo trigger `wager_tx_guard`
   * (SCHEMA §3, MODELAGEM §4.3). Lança erro se a linha não existir.
   */
  async update(transaction: WagerTransaction): Promise<void> {
    let affectedRows: number;
    try {
      affectedRows = await this.em.nativeUpdate(
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
    } catch (error) {
      throw translatePersistenceError(error);
    }

    if (affectedRows === 0) {
      throw new Error(`WagerTransaction não encontrada para update: ${transaction.id}`);
    }
  }
}
