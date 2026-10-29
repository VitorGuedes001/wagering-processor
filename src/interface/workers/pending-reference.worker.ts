import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import {
  ResolvePendingReferences,
  type ResolveOutcome,
} from '../../application/resolve-pending-references';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config';
import { AppLogger } from '../../infrastructure/observability/logger';
import { MetricsRegistry } from '../../infrastructure/observability/metrics';
import { runWithRequestContext } from '../../infrastructure/observability/request-context';

const COMPONENT = 'reference_worker';

/**
 * Laço do worker de `PENDING_REFERENCE` (D32): `setTimeout` preso ao ciclo de
 * vida do Nest, ligado por `ENABLE_REFERENCE_WORKER` (D28). Nenhum estado de
 * correção fica aqui (restrição 8): a reserva é o lease no banco, e um item
 * que falha volta sozinho quando o lease vence (D18).
 */
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private current: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly useCase: ResolvePendingReferences,
    private readonly metrics: MetricsRegistry,
    private readonly logger: AppLogger,
    /** Ausente quando o módulo é montado sem `ConfigModule` (testes HTTP): o worker fica desligado. */
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config?.ENABLE_REFERENCE_WORKER) return;
    this.schedule(0);
  }

  /** Para de agendar e espera o ciclo atual (ARQUITETURA 7.3, passo 4). */
  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.current;
  }

  /** Um ciclo: claim e, depois, cada item na sua transação. Público para teste. */
  async tick(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.useCase.claim();
    } catch (error) {
      this.metrics.retriesTotal.inc({ component: COMPONENT });
      this.logger.error({ message: 'reference worker: claim falhou' }, error);
      return;
    }

    for (const id of ids) {
      // Desligando: termina o item atual e solta o resto, que volta pelo lease.
      if (this.stopped) break;
      await runWithRequestContext({ transactionId: id }, () => this.resolveOne(id));
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.current = this.tick().finally(() => {
        this.current = undefined;
        this.schedule(this.config?.REFERENCE_POLL_MS ?? 1000);
      });
    }, delayMs);
  }

  private async resolveOne(id: string): Promise<void> {
    const startedAt = performance.now();
    try {
      const outcome = await this.useCase.resolve(id);
      this.record(outcome);
    } catch (error) {
      // Transitório ou bug: o item continua reservado e volta depois do lease.
      this.metrics.retriesTotal.inc({ component: COMPONENT });
      this.logger.error({ message: 'reference worker: item falhou', transactionId: id }, error);
    } finally {
      this.metrics.processingDurationSeconds.observe(
        { entry: COMPONENT },
        (performance.now() - startedAt) / 1000,
      );
    }
  }

  private record(outcome: ResolveOutcome): void {
    switch (outcome.type) {
      case 'PROCESSED':
        this.metrics.transactionsTotal.inc({ kind: outcome.kind, status: 'PROCESSED' });
        this.logger.log({
          message: 'reference worker: referência resolvida',
          transactionId: outcome.transactionId,
          kind: outcome.kind,
          status: 'PROCESSED',
        });
        return;
      case 'REJECTED':
        this.metrics.transactionsTotal.inc({ kind: outcome.kind, status: 'REJECTED' });
        this.metrics.transactionsRejectedTotal.inc({ reason: outcome.failureCode });
        this.logger.log({
          message: 'reference worker: transação rejeitada',
          transactionId: outcome.transactionId,
          kind: outcome.kind,
          status: 'REJECTED',
          failureCode: outcome.failureCode,
        });
        return;
      case 'STILL_PENDING':
        this.metrics.retriesTotal.inc({ component: COMPONENT });
        return;
      case 'SKIPPED':
        return;
    }
  }
}
