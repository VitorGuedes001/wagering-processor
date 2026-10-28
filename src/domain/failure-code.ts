/**
 * Motivo de uma transação `REJECTED` ou `FAILED`, gravado nela (MODELAGEM 10.1).
 * Estável e legível por máquina: o provedor decide por ele se reenvia, corrige ou
 * desiste (CHALLENGE §7.2). Erros de requisição sem transação persistida ficam em
 * `RequestErrorCode` (application/contracts.ts, D50).
 */
export enum FailureCode {
  /** `BET` maior que o saldo. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** `ROLLBACK` de `WIN`/`REFUND` que negativaria o saldo. Distinto do anterior (§7.9). */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Moeda da operação diferente da moeda da wallet. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Wallet pertence a outro player. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referência não apareceu até o limite de tentativas (D11). */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência existe, mas está `REJECTED` ou `FAILED`. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Kind da referência não pode ser referenciado por este kind (MODELAGEM 4.2). */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referência de outra wallet, player, moeda ou rodada. */
  ReferenceContextMismatch = 'REFERENCE_CONTEXT_MISMATCH',
  /** Valor da reversão diferente do valor da referência. */
  ReferenceAmountMismatch = 'REFERENCE_AMOUNT_MISMATCH',
  /** Referência já tem uma reversão `PROCESSED` (D1). */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Erro permanente de infraestrutura após o limite de tentativas. Único código de `FAILED`. */
  ProcessingFailed = 'PROCESSING_FAILED',
}
