/**
 * Entrada e saída dos use cases. Separado de `ports.ts`: o HTTP e o
 * consumidor SQS programam contra estes tipos, não contra os use cases.
 * Nenhum tipo aqui carrega `Money`: só `MoneyProps`.
 */
import type { FailureCode } from '../domain/failure-code';
import type { MoneyProps } from '../domain/money';
import type { SubmittableKind, WagerTransactionStatus } from '../domain/wager-transaction';

/**
 * Erros de requisição sem transação persistida. Viram
 * status HTTP e `code` no corpo de erro.
 */
export enum RequestErrorCode {
  /** Forma inválida, `Money` inválido, regra de `create`, header ausente. 400. */
  InvalidPayload = 'INVALID_PAYLOAD',
  /** Mesma idempotency key, payload diferente. 409. */
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  /** Mesmo id externo com outra key. 409. */
  ExternalIdConflict = 'EXTERNAL_ID_CONFLICT',
  /** 404. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** 404. */
  TransactionNotFound = 'TRANSACTION_NOT_FOUND',
  /** `POST /wallets` duplicado para `playerId` + `currency`. 409. */
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  /** Falha transitória: lock, banco ou fila indisponível. 503. */
  ServiceUnavailable = 'SERVICE_UNAVAILABLE',
  /** Bug. 500. */
  InternalError = 'INTERNAL_ERROR',
}

// ------------------------------------------------------------------ wallet

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

/** Formato de `POST /wallets` e `GET /wallets/:id`. */
export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export type CreateWalletOutcome =
  | { type: 'CREATED'; view: WalletView }
  | { type: 'WALLET_ALREADY_EXISTS' };

// ------------------------------------------------------------------ submissão

/** Mesmo comando para HTTP e SQS. `money` chega cru e é validado por `Money.from`. */
export interface WagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  causationId?: string;
}

/** Presente só quando a entrada é SQS: a inbox entra na mesma transação. */
export interface InboxContext {
  consumerName: string;
  messageId: string;
}

/** Montada da transação persistida. Por isso o replay devolve o saldo daquele momento. */
export interface TransactionView {
  transactionId: string;
  status: WagerTransactionStatus;
  /** Snapshot. Ausente em `PENDING_REFERENCE` e `FAILED`. */
  balance: MoneyProps | undefined;
  failureCode?: FailureCode;
}

/**
 * Desfechos esperados como valores. Exceção fica para payload inválido
 * (antes da transação), `TransientInfrastructureError` e bug.
 */
export type SubmitOutcome =
  /** `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`, novo ou replay. */
  | { type: 'RESULT'; view: TransactionView; idempotentReplay: boolean }
  | { type: 'IDEMPOTENCY_CONFLICT' }
  | { type: 'EXTERNAL_ID_CONFLICT' }
  | { type: 'WALLET_NOT_FOUND' }
  /** Inbox: mesmo `messageId`, mesmo hash. Ack. */
  | { type: 'DUPLICATE_MESSAGE' }
  /** Inbox: mesmo `messageId`, hash diferente. DLQ. */
  | { type: 'MESSAGE_PAYLOAD_MISMATCH' };


// ------------------------------------------------------------------ extrato e reconciliação

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  chainIntact: boolean;
  checkedEntries: number;
}
