import { describe, expect, it } from 'bun:test';
import {
  type EventContext,
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../src/domain/events/integration-event';
import { InboxMessage } from '../../src/domain/inbox-message';
import {
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_MAX_MS,
  OutboxMessage,
} from '../../src/domain/outbox-message';

class DummyIntegrationEvent extends IntegrationEvent<{ ok: boolean }> {
  readonly eventType = 'DummyIntegrationEvent';
  readonly version = 1;

  constructor(props: IntegrationEventProps<{ ok: boolean }>) {
    super(props);
  }

  static create(ctx: EventContext, aggregateId = 'agg-1'): DummyIntegrationEvent {
    return new DummyIntegrationEvent({
      eventId: ctx.eventId,
      aggregateId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: { ok: true },
    });
  }
}

describe('InboxMessage', () => {
  it('receives a message as unprocessed and marks it processed with timestamp', () => {
    const receivedAt = new Date('2026-04-19T12:00:00.000Z');
    const processedAt = new Date('2026-04-19T12:00:01.250Z');

    const msg = InboxMessage.receive({
      messageId: 'msg-001',
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'sha256-abc',
      at: receivedAt,
    });

    expect(msg.messageId).toBe('msg-001');
    expect(msg.consumerName).toBe('wager-transactions-consumer');
    expect(msg.payloadHash).toBe('sha256-abc');
    expect(msg.receivedAt).toEqual(receivedAt);
    expect(msg.processedAt).toBeUndefined();
    expect(msg.isProcessed()).toBe(false);

    msg.markProcessed(processedAt);

    expect(msg.processedAt).toEqual(processedAt);
    expect(msg.isProcessed()).toBe(true);
  });

  it('rehydrates both unprocessed and processed state from persistence', () => {
    const receivedAt = new Date('2026-04-19T12:00:00.000Z');
    const processedAt = new Date('2026-04-19T12:00:05.000Z');

    const pending = InboxMessage.rehydrate({
      messageId: 'msg-pending',
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'hash-1',
      receivedAt,
    });
    expect(pending.isProcessed()).toBe(false);
    expect(pending.processedAt).toBeUndefined();

    const done = InboxMessage.rehydrate({
      messageId: 'msg-done',
      consumerName: 'wager-transactions-consumer',
      payloadHash: 'hash-2',
      receivedAt,
      processedAt,
    });
    expect(done.isProcessed()).toBe(true);
    expect(done.processedAt).toEqual(processedAt);
  });
});

describe('OutboxMessage', () => {
  const occurredAt = new Date('2026-04-19T15:00:00.000Z');
  const ctx: EventContext = {
    eventId: 'evt-100',
    correlationId: 'corr-100',
    causationId: 'cause-100',
    occurredAt,
  };

  it('enqueues an integration event with attempts = 0 and nextAttemptAt = occurredAt', () => {
    const event = DummyIntegrationEvent.create(ctx, 'wallet-42');
    const outbox = OutboxMessage.enqueue(event);

    expect(outbox.id).toBe('evt-100');
    expect(outbox.aggregateId).toBe('wallet-42');
    expect(outbox.eventType).toBe('DummyIntegrationEvent');
    expect(outbox.occurredAt).toEqual(occurredAt);
    expect(outbox.attempts).toBe(0);
    expect(outbox.nextAttemptAt).toEqual(occurredAt);
    expect(outbox.publishedAt).toBeUndefined();
    expect(outbox.isPending()).toBe(true);
    expect(outbox.payload).toEqual({
      eventId: 'evt-100',
      eventType: 'DummyIntegrationEvent',
      aggregateId: 'wallet-42',
      correlationId: 'corr-100',
      causationId: 'cause-100',
      occurredAt: '2026-04-19T15:00:00.000Z',
      version: 1,
      data: { ok: true },
    });
  });

  it('evaluates isDue and markPublished transitions accurately', () => {
    const event = DummyIntegrationEvent.create(ctx);
    const outbox = OutboxMessage.enqueue(event);

    const before = new Date(occurredAt.getTime() - 1);
    const exact = new Date(occurredAt.getTime());
    const after = new Date(occurredAt.getTime() + 500);
    const publishedAt = new Date(occurredAt.getTime() + 1_000);

    expect(outbox.isDue(before)).toBe(false);
    expect(outbox.isDue(exact)).toBe(true);
    expect(outbox.isDue(after)).toBe(true);

    outbox.markPublished(publishedAt);

    expect(outbox.isPending()).toBe(false);
    expect(outbox.publishedAt).toEqual(publishedAt);
    expect(outbox.isDue(after)).toBe(false);
    expect(outbox.isDue(publishedAt)).toBe(false);
  });

  it('rehydrates state from persistence', () => {
    const nextAttemptAt = new Date('2026-04-19T15:00:04.000Z');
    const publishedAt = new Date('2026-04-19T15:00:05.000Z');

    const msg = OutboxMessage.rehydrate({
      id: 'evt-200',
      aggregateId: 'tx-200',
      eventType: 'WagerTransactionProcessed',
      payload: { eventId: 'evt-200' },
      occurredAt,
      attempts: 2,
      nextAttemptAt,
      publishedAt,
    });

    expect(msg.id).toBe('evt-200');
    expect(msg.aggregateId).toBe('tx-200');
    expect(msg.eventType).toBe('WagerTransactionProcessed');
    expect(msg.attempts).toBe(2);
    expect(msg.nextAttemptAt).toEqual(nextAttemptAt);
    expect(msg.publishedAt).toEqual(publishedAt);
    expect(msg.isPending()).toBe(false);
  });

  it('U-05: scheduleRetry follows min(2^n, 60) seconds with fixed clock and no attempt cap (D12)', () => {
    const event = DummyIntegrationEvent.create(ctx);
    const outbox = OutboxMessage.enqueue(event);
    const fixedNow = new Date('2026-04-19T16:00:00.000Z');

    expect(OUTBOX_BACKOFF_BASE_MS).toBe(1_000);
    expect(OUTBOX_BACKOFF_MAX_MS).toBe(60_000);

    const expectedDelaysSeconds = [2, 4, 8, 16, 32, 60, 60, 60, 60, 60];

    for (let i = 0; i < expectedDelaysSeconds.length; i++) {
      const expectedAttempts = i + 1;
      const expectedDelayMs = (expectedDelaysSeconds[i] ?? 60) * 1_000;

      outbox.scheduleRetry(fixedNow);

      expect(outbox.attempts).toBe(expectedAttempts);
      expect(outbox.nextAttemptAt.getTime() - fixedNow.getTime()).toBe(expectedDelayMs);
    }
  });
});
