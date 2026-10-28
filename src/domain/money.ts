import { CurrencyMismatchError, InvalidMoneyError } from './errors';

/** Contrato de dinheiro nas bordas (CHALLENGE §6.1): `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  /** String decimal com exatamente 2 casas. Nunca `number` (restrição 5.1). */
  amount: string;
  /** ISO-4217, três letras maiúsculas. */
  currency: string;
}

/** Entrada: sem sinal, sem zero à esquerda, exatamente 2 casas (MODELAGEM 2.1). */
const INPUT_AMOUNT = /^(0|[1-9]\d*)\.(\d{2})$/;
/** Banco: como a entrada, mas com `-` opcional (`difference` da reconciliação). */
const PERSISTED_AMOUNT = /^(-?)(0|[1-9]\d*)\.(\d{2})$/;
const CURRENCY = /^[A-Z]{3}$/;
/** `numeric(19,2)`: 17 dígitos inteiros. */
const MAX_INTEGER_DIGITS = 17;

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
    // `props` vem de JSON não confiável: o tipo estático não garante nada aqui (U-01).
    const { amount, currency } = (props ?? {}) as { amount?: unknown; currency?: unknown };
    if (typeof amount !== 'string') throw new InvalidMoneyError('amount precisa ser string decimal');
    const match = INPUT_AMOUNT.exec(amount);
    if (!match) throw new InvalidMoneyError(`amount inválido: ${JSON.stringify(amount)}`);
    const [, integer = '', fraction = ''] = match;
    return new Money(toCents(integer, fraction), checkCurrency(currency));
  }

  /** Leitura do banco (`numeric` como string). Aceita negativo: o schema já validou o que pode ser. */
  static fromPersistence(amount: string, currency: string): Money {
    const match = typeof amount === 'string' ? PERSISTED_AMOUNT.exec(amount) : null;
    if (!match) throw new InvalidMoneyError(`amount persistido inválido: ${JSON.stringify(amount)}`);
    const [, sign, integer = '', fraction = ''] = match;
    const cents = toCents(integer, fraction);
    return new Money(sign === '-' ? -cents : cents, checkCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(0n, checkCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  /** Pode dar negativo: a `difference` da reconciliação é negativa quando falta dinheiro. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents === other.cents;
  }

  /** Sempre 2 casas, com `-` quando negativo. */
  toJSON(): MoneyProps {
    return { amount: formatCents(this.cents), currency: this.currency };
  }

  /** Ex.: `"25.00 BRL"`. */
  toString(): string {
    return `${formatCents(this.cents)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(`moedas diferentes: ${this.currency} e ${other.currency}`);
    }
  }
}

/** Parse só textual (ARQUITETURA 8): as partes já passaram pela regex. */
function toCents(integer: string, fraction: string): bigint {
  if (integer.length > MAX_INTEGER_DIGITS) {
    throw new InvalidMoneyError(`amount excede ${MAX_INTEGER_DIGITS} dígitos inteiros`);
  }
  return BigInt(integer) * 100n + BigInt(fraction);
}

/** Formatação só textual (ARQUITETURA 8): `/ 100n`, `% 100n` e `padStart`. */
function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${absolute / 100n}.${fraction}`;
}

function checkCurrency(currency: unknown): string {
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) {
    throw new InvalidMoneyError(`currency inválida: ${JSON.stringify(currency)}`);
  }
  return currency;
}
