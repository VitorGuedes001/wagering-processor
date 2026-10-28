import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Money } from '../../src/domain/money';
import { canonicalJson, payloadHash, type PayloadHashInput } from '../../src/domain/payload-hash';
import { WagerTransactionKind } from '../../src/domain/wager-transaction';

const bet: PayloadHashInput = {
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: '0190f5a0-0000-7000-8000-000000000001',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: WagerTransactionKind.Bet,
  money: { amount: '25.00', currency: 'BRL' },
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('canonicalJson (MODELAGEM 9.1)', () => {
  test('ordena chaves em todos os níveis, sem espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [{ f: true, e: null }] } })).toBe(
      '{"a":{"c":[{"e":null,"f":true}],"d":"x"},"b":1}',
    );
  });

  test('omite opcionais ausentes, nunca escreve null no lugar', () => {
    expect(canonicalJson({ a: 'x', b: undefined })).toBe('{"a":"x"}');
  });

  test('usa toJSON, como JSON.stringify: Money entra como MoneyProps', () => {
    expect(canonicalJson({ money: Money.from({ amount: '1.50', currency: 'BRL' }) })).toBe(
      '{"money":{"amount":"1.50","currency":"BRL"}}',
    );
  });

  test('escapa strings como JSON', () => {
    expect(canonicalJson({ 'k"': 'a\nb' })).toBe('{"k\\"":"a\\nb"}');
  });

  test('bigint cru lança', () => {
    expect(() => canonicalJson({ cents: 2500n })).toThrow(TypeError);
  });
});

describe('payloadHash (MODELAGEM 9.1)', () => {
  test('é sha256 hex do JSON canônico dos campos de negócio', () => {
    const expected =
      '{"externalTransactionId":"ext-1","gameId":"game-1","kind":"BET",' +
      '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1",' +
      '"providerId":"provider-1","roundId":"round-1",' +
      '"walletId":"0190f5a0-0000-7000-8000-000000000001"}';
    expect(payloadHash(bet)).toBe(sha256(expected));
    expect(payloadHash(bet)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('ordem das chaves é irrelevante', () => {
    const reversed = Object.fromEntries(Object.entries(bet).reverse()) as unknown as PayloadHashInput;
    const money = { currency: 'BRL', amount: '25.00' };
    expect(payloadHash({ ...reversed, money })).toBe(payloadHash(bet));
  });

  test('mesmo comando gera o mesmo hash', () => {
    expect(payloadHash({ ...bet, money: { ...bet.money } })).toBe(payloadHash(bet));
  });

  test('opcional omitido ≠ presente', () => {
    const win: PayloadHashInput = { ...bet, kind: WagerTransactionKind.Win };
    const withReference = { ...win, referenceExternalTransactionId: 'ext-1' };
    expect(payloadHash(withReference)).not.toBe(payloadHash(win));
  });

  test('opcional undefined é o mesmo que ausente', () => {
    expect(payloadHash({ ...bet, referenceExternalTransactionId: undefined })).toBe(payloadHash(bet));
  });

  test('HTTP e SQS geram o mesmo hash: campos fora de 9.1 não entram', () => {
    // Comando HTTP (com idempotencyKey e correlationId) e comando SQS (com o envelope).
    const http = { ...bet, idempotencyKey: 'key-http', correlationId: 'corr-1' };
    const sqs = {
      ...bet,
      idempotencyKey: 'key-sqs',
      messageId: 'msg-1',
      type: 'wager.submitted',
      occurredAt: '2026-10-28T12:00:00.000Z',
      causationId: 'cause-1',
    };
    expect(payloadHash(http)).toBe(payloadHash(bet));
    expect(payloadHash(sqs)).toBe(payloadHash(bet));
  });

  test.each([
    ['providerId', { providerId: 'provider-2' }],
    ['externalTransactionId', { externalTransactionId: 'ext-2' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: '0190f5a0-0000-7000-8000-000000000002' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'game-2' }],
    ['kind', { kind: WagerTransactionKind.Loss }],
    ['money.amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['money.currency', { money: { amount: '25.00', currency: 'USD' } }],
  ])('muda quando %s muda', (_, change) => {
    expect(payloadHash({ ...bet, ...change } as PayloadHashInput)).not.toBe(payloadHash(bet));
  });
});
