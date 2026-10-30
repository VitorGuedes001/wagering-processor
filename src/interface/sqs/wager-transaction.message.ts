import { z } from 'zod';
import type { SubmitOutcome, WagerCommand } from '../../application/contracts';
import { TransientInfrastructureError } from '../../application/ports';
import { CurrencyMismatchError, InvalidMoneyError, InvalidWagerRequestError } from '../../domain/errors';
import type { SubmittableKind } from '../../domain/wager-transaction';
import { idempotencyKeyHeaderSchema, wagerTransactionSchema } from '../http/schemas';

export const WAGER_MESSAGE_TYPE = 'WagerTransactionRequested';

/** Teto do backoff do retry na fila. */
const MAX_RETRY_DELAY_SECONDS = 60;

/**
 * Envelope da fila de entrada. `data` usa o **mesmo** schema do HTTP, mais `idempotencyKey`, que no HTTP vem do header e com as
 * mesmas regras dele.
 */
const envelopeShapeSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.string().min(1),
  occurredAt: z.iso.datetime(),
  data: z.unknown(),
});

export const wagerMessageDataSchema = wagerTransactionSchema.extend({
  idempotencyKey: idempotencyKeyHeaderSchema,
});

export type EnvelopeRejection = 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'UNKNOWN_TYPE' | 'INVALID_PAYLOAD';

export type ParsedEnvelope =
  | { ok: true; messageId: string; command: WagerCommand }
  | { ok: false; reason: EnvelopeRejection; messageId?: string };

/** `JSON.parse` → envelope → `type` → `data`. Nunca lança. */
export function parseEnvelope(body: string): ParsedEnvelope {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'INVALID_JSON' };
  }

  const envelope = envelopeShapeSchema.safeParse(raw);
  if (!envelope.success) return { ok: false, reason: 'INVALID_ENVELOPE' };

  const { messageId, type } = envelope.data;
  if (type !== WAGER_MESSAGE_TYPE) return { ok: false, reason: 'UNKNOWN_TYPE', messageId };

  const data = wagerMessageDataSchema.safeParse(envelope.data.data);
  if (!data.success) return { ok: false, reason: 'INVALID_PAYLOAD', messageId };

  const d = data.data;
  return {
    ok: true,
    messageId,
    command: {
      providerId: d.providerId,
      externalTransactionId: d.externalTransactionId,
      idempotencyKey: d.idempotencyKey,
      playerId: d.playerId,
      walletId: d.walletId,
      roundId: d.roundId,
      gameId: d.gameId,
      kind: d.kind as SubmittableKind,
      money: { amount: d.money.amount, currency: d.money.currency },
      ...(d.referenceExternalTransactionId !== undefined
        ? { referenceExternalTransactionId: d.referenceExternalTransactionId }
        : {}),
      // Na fila, correlation e causation são o messageId.
      correlationId: messageId,
      causationId: messageId,
    },
  };
}

/** O que fazer com a mensagem na fila. */
export type ConsumerAction =
  | { type: 'ACK'; warn?: string }
  | { type: 'RELEASE_PERMANENT'; reason: string }
  | { type: 'RETRY'; delaySeconds: number; reason: 'TRANSIENT' | 'BUG' };

/** `min(2^receiveCount, 60)` segundos. */
export function retryDelaySeconds(receiveCount: number): number {
  return Math.min(2 ** receiveCount, MAX_RETRY_DELAY_SECONDS); // não é caminho de dinheiro
}

/** Ação na fila para cada desfecho-valor do use case. */
export function classifyOutcome(outcome: SubmitOutcome): ConsumerAction {
  switch (outcome.type) {
    case 'RESULT':
    case 'DUPLICATE_MESSAGE':
      return { type: 'ACK' };
    case 'WALLET_NOT_FOUND':
    case 'IDEMPOTENCY_CONFLICT':
    case 'EXTERNAL_ID_CONFLICT':
      return { type: 'ACK', warn: outcome.type };
    case 'MESSAGE_PAYLOAD_MISMATCH':
      // Anomalia do transporte, sem resposta "certa". Vai para a DLQ.
      return { type: 'RELEASE_PERMANENT', reason: outcome.type };
  }
}

/** Exceções que escapam do use case. */
export function classifyError(
  error: unknown,
  receiveCount: number,
): Exclude<ConsumerAction, { type: 'ACK' }> {
  if (
    error instanceof InvalidMoneyError ||
    error instanceof InvalidWagerRequestError ||
    error instanceof CurrencyMismatchError
  ) {
    return { type: 'RELEASE_PERMANENT', reason: 'INVALID_PAYLOAD' };
  }
  const reason = error instanceof TransientInfrastructureError ? 'TRANSIENT' : 'BUG';
  return { type: 'RETRY', delaySeconds: retryDelaySeconds(receiveCount), reason };
}
