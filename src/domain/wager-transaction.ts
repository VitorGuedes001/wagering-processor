import type { FailureCode } from './failure-code';
import type { Money } from './money';
import { notImplemented } from './not-implemented';
import type { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca submetido por API ou fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Kinds que HTTP e SQS aceitam. */
export type SubmittableKind = Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. Não é gravada: a decisão acontece antes do INSERT (SCHEMA 2.2). */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada (§7.1). Não terminal. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada. Terminal. */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio. Terminal, com `failureCode`. */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura. Terminal, auditável. */
  Failed = 'FAILED',
}

/** Tentativas e backoff da resolução de referência (D11). Valores vindos de env (D43). */
export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: Money;
  /** Obrigatória em `REFUND`/`ROLLBACK`, opcional em `WIN`/`LOSS`, proibida em `BET` (MODELAGEM 4.2). */
  referenceExternalTransactionId?: string;
  at: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

/**
 * Forma persistida, já com tipos de domínio (D45). Os campos de provedor são
 * ausentes só no `OPENING` (SCHEMA 2.2, `wager_tx_provider_fields_ck`).
 */
export interface WagerTransactionState {
  id: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  payloadHash?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balanceAfter?: Money;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  processedAt?: Date;
}

/**
 * Uma operação de provedor (ou a abertura interna da wallet). Transições em
 * MODELAGEM 4.3: `PROCESSED`, `REJECTED` e `FAILED` são terminais, e tentar
 * transicioná-las lança `InvalidTransactionStateError` (bug, não negócio).
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    /** Ausente só no `OPENING`. */
    public readonly providerId: string | undefined,
    public readonly externalTransactionId: string | undefined,
    public readonly idempotencyKey: string | undefined,
    public readonly payloadHash: string | undefined,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string | undefined,
    public readonly gameId: string | undefined,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** Id no provedor, não o id interno. */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _updatedAt: Date,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    /** Snapshot do saldo no desfecho, para o replay (D10). */
    private _balanceAfter: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /**
   * Nasce em `PENDING`. Valida a forma por kind (MODELAGEM 4.2) e lança
   * `InvalidWagerRequestError`: referência faltando ou proibida, referência
   * para a própria `externalTransactionId`, valor fora da regra do kind.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    return notImplemented('T12', props);
  }

  /** `OPENING` da wallet: nasce `PROCESSED`, com `balanceAfter = money` e sem campos de provedor (D42). */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    return notImplemented('T12', props);
  }

  /** Reconstrói do banco sem revalidar transições (§6.0). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return notImplemented('T12', state);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições (D46). Origem permitida: PENDING ou PENDING_REFERENCE, salvo indicação.

  markProcessed(referenceTransactionId: string | undefined, balanceAfter: Money, at: Date): void {
    notImplemented('T12', referenceTransactionId, balanceAfter, at);
  }

  reject(code: FailureCode, balanceAfter: Money, at: Date): void {
    notImplemented('T12', code, balanceAfter, at);
  }

  /** Sem snapshot: a transação financeira não aconteceu. */
  fail(code: FailureCode, at: Date): void {
    notImplemented('T12', code, at);
  }

  /** Só a partir de `PENDING`. `attempts = 0` e agenda a primeira tentativa. */
  markPendingReference(now: Date, policy: BackoffPolicy): void {
    notImplemented('T12', now, policy);
  }

  /** Só em `PENDING_REFERENCE`. `attempts++` e reagenda com backoff. Não muda status. */
  scheduleReferenceRetry(now: Date, policy: BackoffPolicy): void {
    notImplemented('T12', now, policy);
  }

  // ---- consultas de domínio

  referenceAttemptsExhausted(policy: BackoffPolicy): boolean {
    return notImplemented('T12', policy);
  }

  isTerminal(): boolean {
    return notImplemented('T12');
  }

  /** `false` para `LOSS`: a aposta já foi debitada no `BET`. */
  affectsBalance(): boolean {
    return notImplemented('T12');
  }

  /** `true` para `REFUND` e `ROLLBACK`. */
  requiresReference(): boolean {
    return notImplemented('T12');
  }

  matchesPayload(payloadHash: string): boolean {
    return notImplemented('T12', payloadHash);
  }

  /**
   * Direção do lançamento. `ROLLBACK` usa o oposto da direção da referência,
   * por isso a recebe. Lança para `LOSS`, que não tem direção.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    return notImplemented('T12', reference);
  }
}
