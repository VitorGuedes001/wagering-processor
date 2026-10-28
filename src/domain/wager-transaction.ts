import { InvalidTransactionStateError, InvalidWagerRequestError } from './errors';
import type { FailureCode } from './failure-code';
import type { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

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
    // Ordem fixa: kind, referência, valor. O tipo já exclui `OPENING`, mas o kind vem de fora.
    if (!SUBMITTABLE_KINDS.has(props.kind)) {
      throw new InvalidWagerRequestError(`kind não aceito de fora: ${String(props.kind)}`);
    }
    const reference = props.referenceExternalTransactionId;
    if (props.kind === WagerTransactionKind.Bet && reference !== undefined) {
      throw new InvalidWagerRequestError('BET não aceita referência');
    }
    if (REFERENCE_REQUIRED_KINDS.has(props.kind) && reference === undefined) {
      throw new InvalidWagerRequestError(`${props.kind} exige referência`);
    }
    if (reference !== undefined && reference === props.externalTransactionId) {
      throw new InvalidWagerRequestError('a referência aponta para a própria transação');
    }
    // `LOSS` aceita zero (D3); os demais exigem > 0. `Money.from` já barrou negativo.
    const amountOk =
      props.kind === WagerTransactionKind.Loss ? !props.money.isNegative() : props.money.isPositive();
    if (!amountOk) {
      throw new InvalidWagerRequestError(`valor fora da regra de ${props.kind}: ${props.money.toString()}`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      props.at,
      WagerTransactionStatus.Pending,
      props.at,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /** `OPENING` da wallet: nasce `PROCESSED`, com `balanceAfter = money` e sem campos de provedor (D42). */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    // MODELAGEM 4.2: `OPENING > 0`. Saldo inicial zero não gera abertura (MODELAGEM 3).
    if (!props.money.isPositive()) {
      throw new InvalidWagerRequestError(`valor fora da regra de OPENING: ${props.money.toString()}`);
    }
    return new WagerTransaction(
      props.id,
      undefined,
      undefined,
      undefined,
      undefined,
      props.walletId,
      props.playerId,
      undefined,
      undefined,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Processed,
      props.at,
      undefined,
      undefined,
      props.at,
      props.money,
      0,
      undefined,
    );
  }

  /** Reconstrói do banco sem revalidar transições (§6.0). */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.updatedAt,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
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
    this.assertStatus('markProcessed', OPEN_STATUSES);
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._balanceAfter = balanceAfter;
    this._processedAt = at;
    this.close(at);
  }

  reject(code: FailureCode, balanceAfter: Money, at: Date): void {
    this.assertStatus('reject', OPEN_STATUSES);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this.close(at);
  }

  /** Sem snapshot: a transação financeira não aconteceu. */
  fail(code: FailureCode, at: Date): void {
    this.assertStatus('fail', OPEN_STATUSES);
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this.close(at);
  }

  /** Só a partir de `PENDING`. `attempts = 0` e agenda a primeira tentativa. */
  markPendingReference(now: Date, policy: BackoffPolicy): void {
    this.assertStatus('markPendingReference', [WagerTransactionStatus.Pending]);
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = nextAttemptAt(now, 0, policy);
    this._updatedAt = now;
  }

  /** Só em `PENDING_REFERENCE`. `attempts++` e reagenda com backoff. Não muda status. */
  scheduleReferenceRetry(now: Date, policy: BackoffPolicy): void {
    this.assertStatus('scheduleReferenceRetry', [WagerTransactionStatus.PendingReference]);
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt(now, this._referenceAttempts, policy);
    this._updatedAt = now;
  }

  // ---- consultas de domínio

  referenceAttemptsExhausted(policy: BackoffPolicy): boolean {
    return this._referenceAttempts >= policy.maxAttempts;
  }

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** `false` para `LOSS`: a aposta já foi debitada no `BET`. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** `true` para `REFUND` e `ROLLBACK`. */
  requiresReference(): boolean {
    return REFERENCE_REQUIRED_KINDS.has(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash !== undefined && this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento. `ROLLBACK` usa o oposto da direção da referência,
   * por isso a recebe. Lança para `LOSS`, que não tem direção.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError('LOSS não move saldo: não tem direção no ledger');
      case WagerTransactionKind.Rollback: {
        // `decideWager` rejeita referência de outro kind antes (REFERENCE_KIND_NOT_ALLOWED).
        if (reference === undefined || !ROLLBACKABLE_KINDS.has(reference.kind)) {
          throw new InvalidTransactionStateError(
            `ROLLBACK sem referência reversível: ${reference?.kind ?? 'ausente'}`,
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  /** Origem fora da lista: terminal ou não permitida (MODELAGEM 4.3). É bug, nunca `failureCode`. */
  private assertStatus(method: string, allowed: readonly WagerTransactionStatus[]): void {
    if (!allowed.includes(this._status)) {
      throw new InvalidTransactionStateError(`${method} não é permitido a partir de ${this._status} (${this.id})`);
    }
  }

  /** Desfecho terminal: não há mais tentativa de referência a agendar. */
  private close(at: Date): void {
    this._nextReferenceAttemptAt = undefined;
    this._updatedAt = at;
  }
}

const SUBMITTABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

const REFERENCE_REQUIRED_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/** Kinds que um `ROLLBACK` pode referenciar (MODELAGEM 4.2). */
const ROLLBACKABLE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

const OPEN_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Pending,
  WagerTransactionStatus.PendingReference,
];

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * `now + min(baseMs × 2^attempts, maxMs)` (D11). Não é caminho de dinheiro, então
 * `number` vale. `2 ** attempts` vira `Infinity` em expoente alto e o `min` devolve `maxMs`.
 */
function nextAttemptAt(now: Date, attempts: number, policy: BackoffPolicy): Date {
  const delayMs = Math.min(policy.baseMs * 2 ** attempts, policy.maxMs);
  return new Date(now.getTime() + delayMs);
}
