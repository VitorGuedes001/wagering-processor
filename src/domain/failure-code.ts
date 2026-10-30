/**
 * Motivo de uma transação `REJECTED` ou `FAILED`, gravado nela.
 * Estável e legível por máquina: o provedor decide por ele se reenvia, corrige ou
 * desiste. Erros de requisição sem transação persistida ficam em
 * `RequestErrorCode` (application/contracts.ts).
 */
export enum FailureCode {
  /** `BET` maior que o saldo. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** `ROLLBACK` de `WIN`/`REFUND` que negativaria o saldo. Distinto do anterior. */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Wallet pertence a outro player. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referência não apareceu até o limite de tentativas. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência `REJECTED`/`FAILED`, ou ainda pendente quando as tentativas acabaram. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Kind da referência não pode ser referenciado por este kind. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referência de outra wallet, player, moeda ou rodada. */
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Referência já tem uma reversão `PROCESSED`. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Erro permanente de infraestrutura após o limite de tentativas. Único código de `FAILED`. */
  ProcessingFailed = 'PROCESSING_FAILED',
}
