import { TransientInfrastructureError, UniqueViolationError, type UniqueConstraint } from '../../application/ports';

/**
 * `UPDATE wallet … WHERE version = $esperada` sem linha afetada. Sob o lock da
 * wallet isso não acontece por corrida (SCHEMA 4.1), então é bug e não é transitório.
 */
export class StaleWalletVersionError extends Error {
  constructor(walletId: string, expectedVersion: number) {
    super(`Wallet ${walletId} não está na version ${expectedVersion}`);
    this.name = 'StaleWalletVersionError';
  }
}

const UNIQUE_CONSTRAINTS: ReadonlySet<string> = new Set<UniqueConstraint>([
  'wallet_player_currency_uq',
  'wager_tx_idempotency_uq',
  'wager_tx_external_uq',
  'wager_tx_single_reversal_uq',
  'wager_tx_single_opening_uq',
  'ledger_transaction_uq',
  'ledger_wallet_version_uq',
]);

/**
 * `lock_timeout`, deadlock, `statement_timeout`, sessão derrubada pelo servidor
 * (`57P01`–`57P03`) e `idle_in_transaction_session_timeout` de D21 (`25P03`). SCHEMA 5.
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '40P01', '57014', '57P01', '57P02', '57P03', '25P03']);

/** Falha de socket antes de existir SQLSTATE: o Postgres nem respondeu. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
]);

/**
 * Conexão que caiu no meio da transação. O `pg` rejeita a query seguinte (ou o
 * COMMIT) sem `code`, só com a mensagem, e o conversor do MikroORM para Postgres
 * não emite `ConnectionException`.
 */
const LOST_CONNECTION_MESSAGE = /Connection terminated|not queryable|connection error/i;

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
}

function isTransient(error: Error, code: unknown): boolean {
  if (typeof code === 'string') {
    return TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || NETWORK_CODES.has(code);
  }
  return LOST_CONNECTION_MESSAGE.test(error.message);
}

/** `lock_timeout` e deadlock: a disputa pelo lock da wallet (ARQUITETURA 9). */
const LOCK_CONFLICT_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '40P01']);

/**
 * Diz se a falha transitória veio da disputa pelo lock, para alimentar
 * `wagering_lock_conflicts_total`. Lê o SQLSTATE da causa e não muda a porta
 * congelada (D69).
 */
export function isLockConflict(error: unknown): boolean {
  if (!(error instanceof TransientInfrastructureError)) return false;
  const { code } = (error.cause ?? {}) as PgErrorFields;
  return typeof code === 'string' && LOCK_CONFLICT_SQLSTATES.has(code);
}

/**
 * Traduz o erro do driver para os erros da aplicação (SCHEMA 5). O que não é
 * unicidade conhecida nem transitório volta sem tradução: `23514`, `23503` e
 * `23000` de trigger são bug, e o estado errado não foi gravado.
 */
export function translateDbError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  if (error instanceof UniqueViolationError || error instanceof TransientInfrastructureError) return error;

  const { code, constraint } = error as PgErrorFields;

  if (code === '23505' && typeof constraint === 'string' && UNIQUE_CONSTRAINTS.has(constraint)) {
    return new UniqueViolationError(constraint as UniqueConstraint, { cause: error });
  }

  if (isTransient(error, code)) {
    return new TransientInfrastructureError(error.message, { cause: error });
  }

  return error;
}
