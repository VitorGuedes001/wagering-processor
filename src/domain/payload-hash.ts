import type { MoneyProps } from './money';
import { notImplemented } from './not-implemented';
import type { SubmittableKind } from './wager-transaction';

/**
 * Campos de negócio que entram no hash (MODELAGEM 9.1). Ficam de fora: o header,
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
  return notImplemented('T10', value);
}

/** `sha256(canonicalJson(input))` em hex minúsculo, 64 caracteres. */
export function payloadHash(input: PayloadHashInput): string {
  return notImplemented('T10', input);
}
