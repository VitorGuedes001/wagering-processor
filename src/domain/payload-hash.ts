import { createHash } from 'node:crypto';
import type { MoneyProps } from './money';
import type { SubmittableKind } from './wager-transaction';

/**
 * Campos de negócio que entram no hash. Ficam de fora: o header,
 * `idempotencyKey`, `messageId`, `type` e `occurredAt` do envelope SQS. Assim
 * HTTP e SQS geram o mesmo hash para a mesma operação.
 */
export interface PayloadHashInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/** JSON com chaves ordenadas em todos os níveis, sem espaços, com opcionais ausentes omitidos (nunca `null`). */
export function canonicalJson(value: unknown): string {
  if (value !== null && typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    // Mesma semântica de `JSON.stringify`: um `Money` entra como `MoneyProps`.
    return canonicalJson((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(',')}}`;
  }
  // `bigint` lança aqui, como em `JSON.stringify`: dinheiro cru não vaza para o hash.
  const primitive = JSON.stringify(value);
  if (primitive === undefined) throw new TypeError(`valor sem representação JSON: ${typeof value}`);
  return primitive;
}

/** `sha256(canonicalJson(input))` em hex minúsculo, 64 caracteres. */
export function payloadHash(input: PayloadHashInput): string {
  // Copia só os campos de 9.1: o chamador costuma passar o `WagerCommand` inteiro,
  // com `idempotencyKey` e `correlationId`, que não podem mudar o hash.
  const fields: PayloadHashInput = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(fields), 'utf8').digest('hex');
}
