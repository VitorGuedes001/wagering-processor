import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/errors';
import { Money, type MoneyProps } from '../../src/domain/money';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money.from (MODELAGEM 2.1)', () => {
  test.each([
    ['vazio', ''],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['notação científica', '1e3'],
    ['sinal +', '+5.00'],
    ['zero à esquerda', '05.00'],
    ['sem casas', '5'],
    ['uma casa', '5.0'],
    ['três casas', '5.000'],
    ['negativo', '-5.00'],
    ['espaço em volta', ' 5.00 '],
    ['quebra de linha no fim', '5.00\n'],
    ['vírgula decimal', '5,00'],
    ['só ponto', '.50'],
    ['dígito não ASCII', '٥.00'],
  ])('rejeita %s (%p)', (_, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('U-01: amount numérico lança InvalidMoneyError', () => {
    const props = { amount: 25, currency: 'BRL' } as unknown as MoneyProps;
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });

  test.each([null, undefined, {}, { currency: 'BRL' }])('rejeita props sem amount string (%p)', (props) => {
    expect(() => Money.from(props as unknown as MoneyProps)).toThrow(InvalidMoneyError);
  });

  test('aceita 0.00', () => {
    const zero = brl('0.00');
    expect(zero.isZero()).toBe(true);
    expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  test('aceita 17 dígitos inteiros e rejeita 18', () => {
    expect(brl('99999999999999999.99').toJSON().amount).toBe('99999999999999999.99');
    expect(() => brl('100000000000000000.00')).toThrow(InvalidMoneyError);
  });

  test.each(['', 'brl', 'BR', 'BRLL', 'R$1', 'B1L'])('rejeita currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('rejeita currency não string', () => {
    const props = { amount: '1.00', currency: 986 } as unknown as MoneyProps;
    expect(() => Money.from(props)).toThrow(InvalidMoneyError);
  });
});

describe('U-02: ida e volta string → bigint → string', () => {
  test.each(['0.00', '0.01', '99999999999999999.99'])('%s', (amount) => {
    expect(brl(amount).toJSON()).toEqual({ amount, currency: 'BRL' });
    expect(Money.fromPersistence(amount, 'BRL').toJSON()).toEqual({ amount, currency: 'BRL' });
  });
});

describe('Money.fromPersistence', () => {
  test('aceita negativo', () => {
    const money = Money.fromPersistence('-12.30', 'BRL');
    expect(money.isNegative()).toBe(true);
    expect(money.toJSON()).toEqual({ amount: '-12.30', currency: 'BRL' });
  });

  test.each(['', '1e3', '5', '5.000', '+5.00', '05.00', '--1.00', '-', 'NaN'])('rejeita %p', (amount) => {
    expect(() => Money.fromPersistence(amount, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('rejeita mais de 17 dígitos inteiros, também negativo', () => {
    expect(() => Money.fromPersistence('-100000000000000000.00', 'BRL')).toThrow(InvalidMoneyError);
  });

  test('rejeita currency inválida', () => {
    expect(() => Money.fromPersistence('1.00', 'brl')).toThrow(InvalidMoneyError);
  });
});

describe('aritmética', () => {
  test('add e subtract são exatos em centavos', () => {
    expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    expect(brl('10.00').subtract(brl('0.01')).toJSON().amount).toBe('9.99');
    expect(brl('99999999999999999.98').add(brl('0.01')).toJSON().amount).toBe('99999999999999999.99');
  });

  test('subtract pode dar negativo', () => {
    const difference = brl('1.00').subtract(brl('1.50'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.toJSON()).toEqual({ amount: '-0.50', currency: 'BRL' });
  });

  test('negate', () => {
    expect(brl('2.05').negate().toJSON().amount).toBe('-2.05');
    expect(brl('2.05').negate().negate().equals(brl('2.05'))).toBe(true);
    expect(brl('0.00').negate().toJSON().amount).toBe('0.00');
  });

  test('é imutável: operações devolvem instâncias novas', () => {
    const a = brl('1.00');
    const b = a.add(brl('2.00'));
    expect(b).not.toBe(a);
    expect(a.toJSON().amount).toBe('1.00');
  });

  test('predicados', () => {
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.99').isLessThan(brl('1.00'))).toBe(true);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1.00'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
  });

  test('zero valida currency', () => {
    expect(() => Money.zero('xx')).toThrow(InvalidMoneyError);
  });
});

describe('moeda divergente', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test.each([
    ['add', () => brl('1.00').add(usd)],
    ['subtract', () => brl('1.00').subtract(usd)],
    ['isLessThan', () => brl('1.00').isLessThan(usd)],
    ['equals', () => brl('1.00').equals(usd)],
  ])('%s lança CurrencyMismatchError', (_, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });
});

describe('serialização', () => {
  test('toJSON de negativo tem sinal e 2 casas', () => {
    expect(Money.fromPersistence('-0.05', 'BRL').toJSON()).toEqual({ amount: '-0.05', currency: 'BRL' });
    expect(Money.fromPersistence('-1234.50', 'BRL').toJSON()).toEqual({ amount: '-1234.50', currency: 'BRL' });
  });

  test('JSON.stringify usa toJSON e nunca expõe bigint', () => {
    expect(JSON.stringify({ balance: brl('25.00') })).toBe('{"balance":{"amount":"25.00","currency":"BRL"}}');
  });

  test('toString', () => {
    expect(brl('25.00').toString()).toBe('25.00 BRL');
    expect(Money.fromPersistence('-3.07', 'BRL').toString()).toBe('-3.07 BRL');
  });
});
