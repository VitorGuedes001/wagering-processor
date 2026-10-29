import { ConnectionException } from '@mikro-orm/core';
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

/** `lock_timeout`, deadlock, `statement_timeout`, servidor derrubando a sessão (SCHEMA 5). */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '40P01', '57014', '57P01']);

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
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

  // Classe 08 é falha de conexão; ConnectionException cobre ECONNREFUSED e afins.
  const transient =
    error instanceof ConnectionException ||
    (typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08')));
  if (transient) {
    return new TransientInfrastructureError(error.message, { cause: error });
  }

  return error;
}
