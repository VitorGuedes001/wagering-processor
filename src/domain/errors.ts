/**
 * Exceções de domínio (MODELAGEM 10.4). Nenhuma vira `failureCode`: rejeição de
 * negócio é desfecho persistido, não exceção (D26).
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

/** Entrada monetária inválida: formato, escala, sinal ou moeda (MODELAGEM 2.1). */
export class InvalidMoneyError extends DomainError {}

/** Operação entre `Money` de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {}

/** Forma inválida de uma transação submetida (MODELAGEM 4.2): `OPENING` de fora, referência faltando ou proibida, valor fora da regra do kind. */
export class InvalidWagerRequestError extends DomainError {}

/** Transição a partir de estado terminal, ou não permitida (MODELAGEM 4.3). Bug. */
export class InvalidTransactionStateError extends DomainError {}

/** Débito além do saldo chegou à `Wallet`. A regra consulta `canDebit` antes, então é bug. */
export class InsufficientFundsError extends DomainError {}

/** Lançamento cuja aritmética não fecha (MODELAGEM 6). Bug. */
export class LedgerArithmeticError extends DomainError {}
