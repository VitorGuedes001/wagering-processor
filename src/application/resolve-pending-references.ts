import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { applyWagerDecision } from './submit-wager-transaction';
import { decideWager } from '../domain/decide-wager';
import type { FailureCode } from '../domain/failure-code';
import {
  type BackoffPolicy,
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

export interface ReferenceWorkerSettings {
  /** Itens por claim. */
  batch: number;
  /** Lease do claim (D18): quanto tempo a linha fica reservada para esta instância. */
  leaseMs: number;
  /** A mesma política da submissão (D11, D43). */
  backoff: BackoffPolicy;
}

export type ResolveOutcome =
  | { type: 'PROCESSED'; transactionId: string; kind: WagerTransactionKind }
  | { type: 'REJECTED'; transactionId: string; kind: WagerTransactionKind; failureCode: FailureCode }
  | { type: 'STILL_PENDING'; transactionId: string; kind: WagerTransactionKind; attempts: number }
  /** Já saiu de `PENDING_REFERENCE`: outro worker resolveu, ou o lease venceu (SCHEMA 4.5). */
  | { type: 'SKIPPED'; transactionId: string };

/**
 * Worker de `PENDING_REFERENCE` (ARQUITETURA 4, SCHEMA 4.5): uma transação
 * curta de claim por lease com `SKIP LOCKED` (D18) e, depois, uma transação por
 * item. Sem métricas nem logger: `application` não importa `infrastructure`
 * (ARQUITETURA 2). Quem instrumenta é o worker, a partir de `ResolveOutcome`.
 */
export class ResolvePendingReferences {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly settings: ReferenceWorkerSettings,
  ) {}

  /** Transação própria, só com o claim. Devolve os ids reservados. */
  claim(): Promise<string[]> {
    return this.uow.run((tx) =>
      tx.transactions.claimDuePendingReferences(
        this.clock.now(),
        this.settings.batch,
        this.settings.leaseMs,
      ),
    );
  }

  /**
   * Uma tentativa de resolver a referência, na ordem de locks de SCHEMA 4.3
   * (wallet → transação pendente). O retry é contado **antes** de `decideWager`
   * (D57), então a tentativa que leva `attempts` a `maxAttempts` já rejeita.
   */
  resolve(transactionId: string): Promise<ResolveOutcome> {
    const { backoff } = this.settings;

    return this.uow.run(async (tx) => {
      // Leitura sem lock só para saber qual wallet travar primeiro.
      const snapshot = await tx.transactions.findById(transactionId);
      if (!snapshot || snapshot.status !== WagerTransactionStatus.PendingReference) {
        return { type: 'SKIPPED', transactionId };
      }

      const wallet = await tx.wallets.lockById(snapshot.walletId);
      if (!wallet) {
        // FK garante a wallet: chegar aqui é bug.
        throw new Error(`Wallet ${snapshot.walletId} da transação ${transactionId} não existe`);
      }

      // Relê sob lock: protege contra dois workers e contra lease vencido (SCHEMA 4.5).
      const pending = await tx.transactions.lockById(transactionId);
      if (!pending || pending.status !== WagerTransactionStatus.PendingReference) {
        return { type: 'SKIPPED', transactionId };
      }

      const now = this.clock.now();
      pending.scheduleReferenceRetry(now, backoff);

      let reference: WagerTransaction | undefined;
      let referenceAlreadyReversed = false;
      if (pending.providerId !== undefined && pending.referenceExternalTransactionId !== undefined) {
        reference = await tx.transactions.findByExternalId(
          pending.providerId,
          pending.referenceExternalTransactionId,
        );
        if (reference) {
          referenceAlreadyReversed = await tx.transactions.hasProcessedReversal(reference.id);
        }
      }

      const decision = decideWager({
        transaction: pending,
        wallet,
        reference,
        referenceAlreadyReversed,
        backoff,
      });

      await applyWagerDecision(tx, this.idGenerator, {
        transaction: pending,
        wallet,
        referenceTransactionId: reference?.id,
        decision,
        now,
        backoff,
        // Decisão pendente 5 (aprovada): sem requisição de origem, a correlação
        // é a própria transação e a causa é a idempotency key (MODELAGEM 8).
        correlationId: pending.id,
        ...(pending.idempotencyKey !== undefined ? { causationId: pending.idempotencyKey } : {}),
        persist: 'update',
      });

      if (decision.type === 'AWAIT_REFERENCE') {
        return {
          type: 'STILL_PENDING',
          transactionId,
          kind: pending.kind,
          attempts: pending.referenceAttempts,
        };
      }
      if (decision.type === 'REJECT') {
        return { type: 'REJECTED', transactionId, kind: pending.kind, failureCode: decision.code };
      }
      return { type: 'PROCESSED', transactionId, kind: pending.kind };
    });
  }
}
