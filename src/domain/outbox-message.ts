import type { IntegrationEvent } from './events/integration-event';
import { notImplemented } from './not-implemented';

/** Backoff de publicação: `min(2^attempts × base, teto)`, sem limite de tentativas (D12). */
export const OUTBOX_BACKOFF_BASE_MS = 1_000;
export const OUTBOX_BACKOFF_MAX_MS = 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  /** Também é o lease do worker (D18). `NOT NULL` no schema. */
  nextAttemptAt: Date;
  publishedAt?: Date;
}

/**
 * Evento esperando publicação (CHALLENGE §6.5, §11). Entra na mesma transação
 * da mudança financeira. Um worker publica depois do commit.
 */
export class OutboxMessage {
  private constructor(
    /** = `eventId`: o consumidor deduplica por ele. */
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date,
    private _publishedAt?: Date,
  ) {}

  /**
   * Copia `eventId`, `eventType`, `aggregateId` e `occurredAt` do evento, grava
   * `payload = event.toJSON()` e agenda para `occurredAt`.
   */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return notImplemented('T13', event);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return notImplemented('T13', state);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return notImplemented('T13');
  }

  isDue(now: Date): boolean {
    return notImplemented('T13', now);
  }

  markPublished(at: Date): void {
    notImplemented('T13', at);
  }

  /** `attempts++` e `nextAttemptAt = now + min(2^attempts × base, teto)`. O relógio é injetado, sem jitter. */
  scheduleRetry(now: Date): void {
    notImplemented('T13', now);
  }
}
