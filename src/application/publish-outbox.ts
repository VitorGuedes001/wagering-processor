import type { Clock, EventPublisher, UnitOfWork } from './ports';
import type { OutboxMessage } from '../domain/outbox-message';

export interface PublishOutboxHooks {
  afterClaim?: (messages: OutboxMessage[]) => void;
  afterPublish?: (message: OutboxMessage) => void;
  onPublishError?: (message: OutboxMessage, error: unknown) => void;
  onScheduleRetryError?: (message: OutboxMessage, error: unknown) => void;
}

export interface PublishOutboxOptions {
  batch?: number;
  leaseMs?: number;
  now?: Date;
  shouldStop?: () => boolean;
  hooks?: PublishOutboxHooks;
}

export interface PublishOutboxItemResult {
  message: OutboxMessage;
  status: 'published' | 'failed';
  error?: unknown;
  scheduleRetryError?: unknown;
}

export interface PublishOutboxOutcome {
  claimed: number;
  published: number;
  failed: number;
  results: PublishOutboxItemResult[];
}

/**
 * Use case PublishOutbox.
 * Executa o ciclo de outbox em três passos separados:
 * 1. Claim por lease com SKIP LOCKED em uow.run curto;
 * 2. Publicação no SQS fora de transação;
 * 3. markPublished ou scheduleRetry de cada mensagem no seu próprio uow.run curto.
 */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
  ) {}

  async execute(options?: PublishOutboxOptions): Promise<PublishOutboxOutcome> {
    const now = options?.now ?? this.clock.now();
    const batch = options?.batch ?? 50;
    const leaseMs = options?.leaseMs ?? 30_000;
    const hooks = options?.hooks;

    // 1. Claim curto na UoW com FOR UPDATE SKIP LOCKED e lease
    const messages = await this.uow.run(async (tx) => {
      return await tx.outbox.claimDue(now, batch, leaseMs);
    });

    if (messages.length > 0) {
      hooks?.afterClaim?.(messages);
    }

    // 2. Publicação SQS fora de transação e marcação atômica por item
    const results: PublishOutboxItemResult[] = [];
    let published = 0;
    let failed = 0;

    for (const message of messages) {
      if (options?.shouldStop?.()) {
        break;
      }

      try {
        await this.publisher.publish(message);

        hooks?.afterPublish?.(message);

        const publishedAt = this.clock.now();
        await this.uow.run(async (tx) => {
          await tx.outbox.markPublished(message.id, publishedAt);
        });

        message.markPublished(publishedAt);
        published++;
        results.push({ message, status: 'published' });
      } catch (error) {
        failed++;
        hooks?.onPublishError?.(message, error);

        const retryNow = this.clock.now();
        message.scheduleRetry(retryNow);

        let scheduleRetryError: unknown;
        try {
          await this.uow.run(async (tx) => {
            await tx.outbox.scheduleRetry(message);
          });
        } catch (schedErr) {
          scheduleRetryError = schedErr;
          hooks?.onScheduleRetryError?.(message, schedErr);
        }

        results.push({
          message,
          status: 'failed',
          error,
          scheduleRetryError,
        });
      }
    }

    return {
      claimed: messages.length,
      published,
      failed,
      results,
    };
  }
}
