import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';
import { PublishOutbox } from '../../application/publish-outbox';
import { SystemClock } from '../../infrastructure/clock';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config';
import { FaultInjector, FaultPoint } from '../../infrastructure/fault-injector';
import { AppLogger } from '../../infrastructure/observability/logger';
import { MetricsRegistry } from '../../infrastructure/observability/metrics';
import { OutboxLagProbe } from '../../infrastructure/persistence/outbox-lag-probe';

/**
 * Worker de publicação transacional de outbox (CHALLENGE §6.5, §11; ARQUITETURA §7.3; D18, D20, D32, D62).
 * Agenda e executa o use case `PublishOutbox` preso ao ciclo de vida do Nest (D32, §7.3).
 * Observabilidade: wagering_outbox_lag_seconds, wagering_outbox_published_total, wagering_retries_total.
 */
@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown
{
  private running = false;
  private stopping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private activeTickPromise?: Promise<number>;

  constructor(
    private readonly publishOutbox: PublishOutbox,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsRegistry,
    private readonly lagProbe: OutboxLagProbe,
    @Optional() private readonly logger: AppLogger = new AppLogger(),
    @Optional() private readonly clock: SystemClock = new SystemClock(),
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.ENABLE_OUTBOX_WORKER) {
      await this.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
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
      } catch (error) {
        this.logger.warn(
          { message: 'Erro ao executar ciclo de outbox worker', error },
          'OutboxWorker',
        );
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
   * Executa uma rodada do ciclo de outbox chamando o use case PublishOutbox (D62).
   * Devolve a quantidade de mensagens publicadas com sucesso nesta rodada.
   */
  async tick(now: Date = this.clock.now()): Promise<number> {
    const outcome = await this.publishOutbox.execute({
      batch: this.config.OUTBOX_BATCH,
      leaseMs: this.config.OUTBOX_LEASE_MS,
      now,
      shouldStop: () => this.stopping,
      hooks: {
        afterClaim: (messages) => {
          if (messages.length > 0) {
            FaultInjector.hit(FaultPoint.OutboxAfterClaimBeforePublish);
          }
        },
        afterPublish: () => {
          FaultInjector.hit(FaultPoint.OutboxAfterPublishBeforeMark);
        },
      },
    });

    for (const item of outcome.results) {
      if (item.status === 'published') {
        this.metrics.outboxPublishedTotal?.inc({ eventType: item.message.eventType });
      } else {
        this.metrics.retriesTotal?.inc({ component: 'outbox' });
        this.logger.warn(
          {
            message: 'Falha ao processar mensagem do outbox',
            eventId: item.message.id,
            eventType: item.message.eventType,
            error: item.error,
          },
          'OutboxWorker',
        );
        if (item.scheduleRetryError) {
          this.logger.warn(
            {
              message: 'Falha ao agendar retry de mensagem de outbox no banco',
              eventId: item.message.id,
              error: item.scheduleRetryError,
            },
            'OutboxWorker',
          );
        }
      }
    }

    // Atualiza métrica de lag a cada tick (SCHEMA 4.6, ARQUITETURA §9)
    await this.updateLag(now);

    return outcome.published;
  }

  /**
   * Lag de outbox: `now - min(occurred_at) WHERE published_at IS NULL` (SCHEMA 4.6;
   * ARQUITETURA §9). Lido pelo `OutboxLagProbe`, fora da porta congelada (D74).
   */
  async computeLag(now: Date = this.clock.now()): Promise<number> {
    return this.lagProbe.lagSeconds(now);
  }

  async updateLag(now: Date = this.clock.now()): Promise<void> {
    try {
      const lagSeconds = await this.computeLag(now);
      this.metrics.outboxLagSeconds?.set(lagSeconds);
    } catch (error) {
      this.logger.warn(
        { message: 'Falha ao atualizar métrica de lag de outbox', error },
        'OutboxWorker',
      );
    }
  }
}
