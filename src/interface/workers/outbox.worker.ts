import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import type { Clock, EventPublisher, UnitOfWork } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config';
import { FaultInjector, FaultPoint } from '../../infrastructure/fault-injector';
import { EVENT_PUBLISHER } from '../../infrastructure/messaging/sqs-event-publisher';
import { MetricsRegistry } from '../../infrastructure/observability/metrics';
import { UNIT_OF_WORK } from '../http/http.module';

const defaultClock: Clock = {
  now: () => new Date(),
};

/**
 * Worker de publicação transacional de outbox (CHALLENGE §6.5, §11; ARQUITETURA §7.3; D18, D20, D32, D62).
 * Executa em três passos separados conforme D62:
 * 1. Claim por lease com SKIP LOCKED em uow.run curto;
 * 2. Publicação no SQS fora de transação (restrição 4);
 * 3. markPublished ou scheduleRetry de cada mensagem no seu próprio uow.run.
 * Observabilidade: wagering_outbox_lag_seconds, wagering_outbox_published_total, wagering_retries_total.
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private running = false;
  private stopping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activeTickPromise?: Promise<number>;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsRegistry,
    @Optional() @Inject('CLOCK') private readonly clock: Clock = defaultClock,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.ENABLE_OUTBOX_WORKER) {
      await this.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    if (!this.running && !this.stopping) return;
    this.stopping = true;

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (this.activeTickPromise !== undefined) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, this.config.SHUTDOWN_GRACE_MS);
      });

      try {
        await Promise.race([this.activeTickPromise, timeoutPromise]);
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
      }
    }

    this.running = false;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopping || !this.running) return;

    this.timer = setTimeout(async () => {
      try {
        const processedCount = await this.executeTick();
        const nextDelay =
          processedCount >= this.config.OUTBOX_BATCH ? 0 : this.config.OUTBOX_POLL_MS;
        this.scheduleNext(nextDelay);
      } catch {
        this.scheduleNext(this.config.OUTBOX_POLL_MS);
      }
    }, delayMs);
  }

  private async executeTick(): Promise<number> {
    const promise = this.tick();
    this.activeTickPromise = promise;
    try {
      return await promise;
    } finally {
      this.activeTickPromise = undefined;
    }
  }

  /**
   * Executa uma rodada do ciclo de outbox (D62).
   * Devolve a quantidade de mensagens publicadas com sucesso nesta rodada.
   */
  async tick(now: Date = this.clock.now()): Promise<number> {
    // 1. Claim curto na UoW com FOR UPDATE SKIP LOCKED e lease (D18, D62)
    const messages = await this.uow.run(async (tx) => {
      return await tx.outbox.claimDue(now, this.config.OUTBOX_BATCH, this.config.OUTBOX_LEASE_MS);
    });

    if (messages.length > 0) {
      FaultInjector.hit(FaultPoint.OutboxAfterClaimBeforePublish);
    }

    // 2. Publicação SQS fora de transação e marcação atômica por item (restrição 4, D62)
    let publishedCount = 0;
    for (const message of messages) {
      if (this.stopping) {
        break;
      }

      await this.processMessage(message);
      if (message.publishedAt !== undefined) {
        publishedCount++;
      }
    }

    // 3. Atualiza métrica de lag a cada tick (SCHEMA 4.6, ARQUITETURA §9)
    await this.updateLag(now);

    return publishedCount;
  }

  private async processMessage(message: OutboxMessage): Promise<void> {
    try {
      // Publica fora de transação
      await this.publisher.publish(message);

      FaultInjector.hit(FaultPoint.OutboxAfterPublishBeforeMark);

      // Marca publicado em uow.run curto próprio (D62)
      const publishedAt = this.clock.now();
      await this.uow.run(async (tx) => {
        await tx.outbox.markPublished(message.id, publishedAt);
      });

      message.markPublished(publishedAt);
      this.metrics.outboxPublishedTotal?.inc({ eventType: message.eventType });
    } catch {
      // Falha na publicação ou marcação: incrementa retry e agenda próximo lease com backoff (D12)
      this.metrics.retriesTotal?.inc({ component: 'outbox' });

      const retryNow = this.clock.now();
      message.scheduleRetry(retryNow);

      try {
        await this.uow.run(async (tx) => {
          await tx.outbox.scheduleRetry(message);
        });
      } catch {
        // Se a persistência do retry falhar, o lease atual expirará e o evento voltará
      }
    }
  }

  async computeLag(now: Date = this.clock.now()): Promise<number> {
    return await this.uow.run(async (tx) => {
      const repo = tx.outbox as unknown as { computeLagSeconds?: (now: Date) => Promise<number> };
      if (typeof repo.computeLagSeconds === 'function') {
        return await repo.computeLagSeconds(now);
      }
      return 0;
    });
  }

  async updateLag(now: Date = this.clock.now()): Promise<void> {
    try {
      const lagSeconds = await this.computeLag(now);
      this.metrics.outboxLagSeconds?.set(lagSeconds);
    } catch {
      // Ignora erro pontual de coleta de métrica
    }
  }
}
