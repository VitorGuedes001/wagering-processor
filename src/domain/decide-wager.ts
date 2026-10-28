import type { FailureCode } from './failure-code';
import { notImplemented } from './not-implemented';
import type { BackoffPolicy, WagerTransaction } from './wager-transaction';
import type { Wallet } from './wallet';
import type { LedgerDirection } from './wallet-ledger-entry';

export type WagerDecision =
  /** `direction` ausente = `LOSS`: processa sem mover saldo. */
  | { type: 'APPLY'; direction: LedgerDirection | undefined }
  | { type: 'REJECT'; code: FailureCode }
  | { type: 'AWAIT_REFERENCE' };

export interface DecideWagerInput {
  transaction: WagerTransaction;
  wallet: Wallet;
  /** Buscada por `(providerId, referenceExternalTransactionId)`. Ausente = ainda não chegou. */
  reference: WagerTransaction | undefined;
  /** A referência já tem `REFUND`/`ROLLBACK` `PROCESSED` (D1). */
  referenceAlreadyReversed: boolean;
  /** Decide entre `AWAIT_REFERENCE` e `REFERENCE_NOT_FOUND` quando a referência falta (D43). */
  backoff: BackoffPolicy;
}

/**
 * Regra de negócio de §7 como função pura (MODELAGEM 5): sem I/O, mesma resposta
 * para a mesma entrada. As verificações rodam numa ordem fixa, e a primeira que
 * falha decide, para o `failureCode` ser determinístico. HTTP, SQS e o worker de
 * referências chamam o mesmo caminho.
 */
export function decideWager(input: DecideWagerInput): WagerDecision {
  return notImplemented('T16', input);
}
