/**
 * Portas da aplicação (ARQUITETURA 3). Só existem onde há troca real de
 * implementação (banco, fila) ou onde o teste precisa de controle (relógio, ids).
 * Implementadas em `infrastructure` (T20–T22, T41) e congeladas no M0.
 */
import type { InboxMessage } from '../domain/inbox-message';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WalletLedgerEntry } from '../domain/wallet-ledger-entry';

/**
 * Falha que vale a pena tentar de novo: `lock_timeout`, deadlock, timeout,
 * conexão (SCHEMA 5). Vira 503 no HTTP e retry com backoff na fila.
 */
export class TransientInfrastructureError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientInfrastructureError';
  }
}

// ------------------------------------------------------------------ transação

export interface UnitOfWork {
  /** Abre transação (`READ COMMITTED` + timeouts D21) e entrega os repositórios ligados a ela. Commit ao resolver, rollback ao lançar. */
  run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T>;
  /** Snapshot `REPEATABLE READ READ ONLY`, para a reconciliação (D22). */
  readSnapshot<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T>;
}

export interface TxRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

// ------------------------------------------------------------------ repositórios

export interface WalletRepository {
  /** `SELECT … FOR UPDATE` (D15). */
  lockById(id: string): Promise<Wallet | undefined>;
  findById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  /** `UPDATE … WHERE id = $1 AND version = $expectedVersion`. Zero linhas afetadas é bug e lança. */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface WagerTransactionRepository {
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Existe `REFUND`/`ROLLBACK` `PROCESSED` com esta referência (D1). */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** `SELECT … FOR UPDATE`. O worker relê a pendente depois de travar a wallet (SCHEMA 4.5). */
  lockById(id: string): Promise<WagerTransaction | undefined>;
  /** Reserva por lease com `SKIP LOCKED` as `PENDING_REFERENCE` vencidas (D18). Devolve ids. */
  claimDuePendingReferences(now: Date, limit: number, leaseMs: number): Promise<string[]>;
  insert(transaction: WagerTransaction): Promise<void>;
  update(transaction: WagerTransaction): Promise<void>;
}

export interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  /** Extrato por cursor: `wallet_version > afterVersion`, em ordem crescente. */
  page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  /** Todos os lançamentos da wallet, em ordem de `walletVersion`. Para a reconciliação. */
  all(walletId: string): Promise<WalletLedgerEntry[]>;
}

export type InboxReceiveResult = { accepted: true } | { accepted: false; storedPayloadHash: string };

export interface InboxRepository {
  /** `INSERT … ON CONFLICT DO NOTHING`. Se já existia, devolve o hash gravado (D7). */
  tryReceive(message: InboxMessage): Promise<InboxReceiveResult>;
  markProcessed(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  /** Reserva por lease com `SKIP LOCKED` (D18), em transação curta própria. */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  markPublished(id: string, at: Date): Promise<void>;
  scheduleRetry(message: OutboxMessage): Promise<void>;
}

// ------------------------------------------------------------------ fora do banco

/** Publica no SQS, **fora** de transação (restrição 4). Duplicata é aceita: o consumidor deduplica por `eventId`. */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export interface Clock {
  now(): Date;
}

/** UUIDv7. */
export interface IdGenerator {
  next(): string;
}

/** Quem chamou a API. Sem auth implementada, `providerId` é sempre ausente (D31). */
export interface CallerIdentity {
  providerId: string | undefined;
}

/** Ponto de extensão da auth (§2, D31): lança quando o chamador não pode submeter em nome do provedor. */
export interface ProviderIdentityPort {
  assertMaySubmit(caller: CallerIdentity, providerId: string): void;
}
