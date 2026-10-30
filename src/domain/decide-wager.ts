import { FailureCode } from './failure-code';
import {
  type BackoffPolicy,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import type { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';

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
  /** A referência já tem `REFUND`/`ROLLBACK` `PROCESSED`. */
  referenceAlreadyReversed: boolean;
  /** Decide entre `AWAIT_REFERENCE` e `REFERENCE_NOT_FOUND` quando a referência falta. */
  backoff: BackoffPolicy;
}

/**
 * Regras de negócio como função pura: sem I/O, mesma resposta
 * para a mesma entrada. As verificações rodam numa ordem fixa, e a primeira que
 * falha decide, para o `failureCode` ser determinístico. HTTP, SQS e o worker de
 * referências chamam o mesmo caminho.
 *
 * `WALLET_NOT_FOUND` fica fora daqui: é verificado antes pelo use case.
 *
 * Contrato de tentativas com o worker de `PENDING_REFERENCE`:
 * - Na submissão inicial (`PENDING`, `referenceAttempts = 0`), a falta de referência
 *   ou referência ainda pendente devolve `AWAIT_REFERENCE`, e o use case chama
 *   `markPendingReference`.
 * - No worker de referências, cada tentativa chama `transaction.scheduleReferenceRetry(now, backoff)`
 *   **antes** de `decideWager`. Assim, na tentativa que leva `referenceAttempts` a
 *   `maxAttempts` (ex.: 10ª tentativa com o padrão de 10), `referenceAttemptsExhausted(backoff)` já
 *   devolve `true`, e `decideWager` rejeita imediatamente com `REFERENCE_NOT_FOUND`
 *   (passo 3, quando ausente) ou `REFERENCE_NOT_PROCESSED` (passo 4 → 5, quando ainda
 *   em `PENDING`/`PENDING_REFERENCE`), sem esperar um ciclo extra.
 */
export function decideWager(input: DecideWagerInput): WagerDecision {
  const { transaction, wallet, reference, referenceAlreadyReversed, backoff } = input;

  // 1. Wallet pertence ao playerId
  if (wallet.playerId !== transaction.playerId) {
    return { type: 'REJECT', code: FailureCode.WalletPlayerMismatch };
  }

  // 2. Moeda da operação = moeda da wallet
  if (transaction.money.currency !== wallet.currency) {
    return { type: 'REJECT', code: FailureCode.CurrencyMismatch };
  }

  // Passos 3–9: aplicáveis quando a transação informa (ou exige) referência
  const hasReference =
    transaction.referenceExternalTransactionId !== undefined || transaction.requiresReference();

  if (hasReference) {
    const attemptsExhausted = transaction.referenceAttemptsExhausted(backoff);

    // 3. Referência informada existe
    if (reference === undefined) {
      return attemptsExhausted
        ? { type: 'REJECT', code: FailureCode.ReferenceNotFound }
        : { type: 'AWAIT_REFERENCE' };
    }

    // 4. Referência está PENDING ou PENDING_REFERENCE (só aguarda enquanto não esgotou)
    if (
      (reference.status === WagerTransactionStatus.Pending ||
        reference.status === WagerTransactionStatus.PendingReference) &&
      !attemptsExhausted
    ) {
      return { type: 'AWAIT_REFERENCE' };
    }

    // 5. Referência está PROCESSED (inclui REJECTED, FAILED e pendente após esgotamento)
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { type: 'REJECT', code: FailureCode.ReferenceNotProcessed };
    }

    // 6. Kind da referência é permitido
    if (!isAllowedReferenceKind(transaction.kind, reference.kind)) {
      return { type: 'REJECT', code: FailureCode.ReferenceKindNotAllowed };
    }

    // 7. Mesma wallet, player, moeda e rodada
    if (
      reference.walletId !== transaction.walletId ||
      reference.playerId !== transaction.playerId ||
      reference.money.currency !== transaction.money.currency ||
      reference.roundId !== transaction.roundId
    ) {
      return { type: 'REJECT', code: FailureCode.ReferenceContextMismatch };
    }

    if (transaction.requiresReference()) {
      // 8. Valor igual (só REFUND/ROLLBACK)
      if (!transaction.money.equals(reference.money)) {
        return { type: 'REJECT', code: FailureCode.ReferenceAmountMismatch };
      }

      // 9. Referência ainda não revertida (só REFUND/ROLLBACK, uma reversão por referência)
      if (referenceAlreadyReversed) {
        return { type: 'REJECT', code: FailureCode.ReferenceAlreadyReversed };
      }
    }
  }

  // LOSS não move saldo e não chama ledgerDirectionFor
  if (!transaction.affectsBalance()) {
    return { type: 'APPLY', direction: undefined };
  }

  const direction = transaction.ledgerDirectionFor(reference);

  // 10. Saldo cobre o débito (BET vs. ROLLBACK de WIN/REFUND)
  if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
    const code =
      transaction.kind === WagerTransactionKind.Bet
        ? FailureCode.InsufficientFunds
        : FailureCode.ReversalInsufficientFunds;
    return { type: 'REJECT', code };
  }

  return { type: 'APPLY', direction };
}

const ROLLBACK_ALLOWED_REFERENCE_KINDS: ReadonlySet<WagerTransactionKind> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

function isAllowedReferenceKind(
  transactionKind: WagerTransactionKind,
  referenceKind: WagerTransactionKind,
): boolean {
  switch (transactionKind) {
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Loss:
    case WagerTransactionKind.Refund:
      return referenceKind === WagerTransactionKind.Bet;
    case WagerTransactionKind.Rollback:
      return ROLLBACK_ALLOWED_REFERENCE_KINDS.has(referenceKind);
    case WagerTransactionKind.Bet:
    case WagerTransactionKind.Opening:
      return false;
  }
}
