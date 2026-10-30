/**
 * Exceções de domínio. Nenhuma vira `failureCode`: rejeição de
 * negócio é desfecho persistido, não exceção.
 *
 * - `InvalidMoneyError`, `CurrencyMismatchError` e `InvalidWagerRequestError`
 *   viram `INVALID_PAYLOAD` quando ocorrem na borda.
 * - As demais indicam bug: viram 500 com log de erro.
 */
export abstract class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada monetária inválida: formato, escala, sinal ou moeda. */
export class InvalidMoneyError extends DomainError {}

/** Operação entre `Money` de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {}

/** Forma inválida de uma transação submetida: `OPENING` de fora, referência faltando ou proibida, valor fora da regra do kind. */
export class InvalidWagerRequestError extends DomainError {}

/** Transição a partir de estado terminal, ou não permitida. Bug. */
export class InvalidTransactionStateError extends DomainError {}

/** Débito além do saldo chegou à `Wallet`. A regra consulta `canDebit` antes, então é bug. */
export class InsufficientFundsError extends DomainError {}

/** Lançamento cuja aritmética não fecha. Bug. */
export class LedgerArithmeticError extends DomainError {}
