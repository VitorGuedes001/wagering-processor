import { notImplemented } from './not-implemented';

/** Contrato de dinheiro nas bordas (CHALLENGE §6.1): `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  /** String decimal com exatamente 2 casas. Nunca `number` (restrição 5.1). */
  amount: string;
  /** ISO-4217, três letras maiúsculas. */
  currency: string;
}

/**
 * Valor monetário imutável: toda operação devolve uma instância nova.
 *
 * Internamente, centavos em `bigint` (D8). Nunca arredonda: mais de 2 casas é
 * rejeitado (D9). Operação entre moedas diferentes lança `CurrencyMismatchError`.
 * Regras de entrada em MODELAGEM 2.1.
 */
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /**
   * Contrato de entrada (HTTP, SQS). Rejeita negativo, `NaN`, `Infinity`,
   * notação científica, vazio e escala diferente de 2. Lança `InvalidMoneyError`.
   */
  static from(props: MoneyProps): Money {
    return notImplemented('T10', props);
  }

  /** Leitura do banco (`numeric` como string). Aceita negativo: o schema já validou o que pode ser. */
  static fromPersistence(amount: string, currency: string): Money {
    return notImplemented('T10', amount, currency);
  }

  static zero(currency: string): Money {
    return notImplemented('T10', currency);
  }

  add(other: Money): Money {
    return notImplemented('T10', other);
  }

  /** Pode dar negativo: a `difference` da reconciliação é negativa quando falta dinheiro. */
  subtract(other: Money): Money {
    return notImplemented('T10', other);
  }

  negate(): Money {
    return notImplemented('T10');
  }

  isZero(): boolean {
    return notImplemented('T10');
  }

  isPositive(): boolean {
    return notImplemented('T10');
  }

  isNegative(): boolean {
    return notImplemented('T10');
  }

  isLessThan(other: Money): boolean {
    return notImplemented('T10', other);
  }

  equals(other: Money): boolean {
    return notImplemented('T10', other);
  }

  /** Sempre 2 casas, com `-` quando negativo. */
  toJSON(): MoneyProps {
    return notImplemented('T10');
  }

  /** Ex.: `"25.00 BRL"`. */
  toString(): string {
    return notImplemented('T10', this.cents);
  }
}
