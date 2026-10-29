import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { SubmitOutcome } from '../../application/contracts';
import { RecordProcessingFailure } from '../../application/record-processing-failure';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { APP_CONFIG, type AppConfig } from '../../infrastructure/config';
import { FaultInjector, FaultPoint } from '../../infrastructure/fault-injector';
import type { InputMessage } from '../../infrastructure/messaging/sqs-input-queue';
import { SqsInputQueue } from '../../infrastructure/messaging/sqs-input-queue';
import { AppLogger } from '../../infrastructure/observability/logger';
import { MetricsRegistry } from '../../infrastructure/observability/metrics';
import { runWithRequestContext } from '../../infrastructure/observability/request-context';
import {
  type ConsumerAction,
  classifyError,
  classifyOutcome,
  type ParsedEnvelope,
  parseEnvelope,
} from './wager-transaction.message';

const LOG_CONTEXT = 'WagerTransactionConsumer';
const RETRY_COMPONENT = 'sqs-consumer';
/** Pausa do laço quando o próprio `ReceiveMessage` falha (SQS fora). */
const RECEIVE_ERROR_PAUSE_MS = 1_000;

/**
 * Consumidor de `wager-transactions.fifo` (CHALLENGE §10, ARQUITETURA 7.2).
 *
 * - chama o **mesmo** use case do HTTP, com a inbox na mesma transação (D24);
 * - faz ack só depois do commit; nunca envia à DLQ: a mensagem chega lá pelo
 *   redrive, depois de `maxReceiveCount` entregas sem ack;
 * - nenhum estado de correção em memória (restrição 8): o que fica aqui é só o
 *   controle do laço e das mensagens em andamento.
 */
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly abort = new AbortController();
  /** Cadeias por `MessageGroupId` do lote atual. */
  private readonly chains = new Set<Promise<void>>();
  /** Mensagens recebidas e ainda não concluídas (iniciadas ou na fila da cadeia). */
  private outstanding = 0;

  constructor(
    private readonly queue: SqsInputQueue,
    @Inject(SubmitWagerTransaction) private readonly submit: Pick<SubmitWagerTransaction, 'execute'>,
    @Inject(RecordProcessingFailure) private readonly recordFailure: Pick<RecordProcessingFailure, 'execute'>,
    private readonly metrics: MetricsRegistry,
    private readonly logger: AppLogger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.ENABLE_CONSUMER) return;
    this.running = true;
    // Lê a política de redrive cedo; falha aqui não impede o consumo (DP-2).
    this.queue.maxReceiveCount().then(
      (max) => {
        if (max === undefined) {
          this.logger.warn('fila de entrada sem RedrivePolicy: FAILED na última entrega desligado', LOG_CONTEXT);
        }
      },
      (error: unknown) => this.logger.warn('não foi possível ler a RedrivePolicy', { error }, LOG_CONTEXT),
    );
    this.loop = this.run();
    this.logger.log(
      { message: 'consumidor SQS iniciado', queue: this.queue.name, concurrency: this.config.SQS_CONSUMER_CONCURRENCY },
      LOG_CONTEXT,
    );
  }

  /**
   * `SIGTERM` (ARQUITETURA 7.3, passos 1–3): para de receber, espera as
   * mensagens em andamento até `SHUTDOWN_GRACE_MS` e devolve à fila as que
   * ainda não começaram. Roda antes de o MikroORM e o SQS fecharem.
   */
  async beforeApplicationShutdown(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    await this.loop;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.config.SHUTDOWN_GRACE_MS);
    });
    const drained = await Promise.race([Promise.all([...this.chains]).then(() => 'drained' as const), graceOver]);
    clearTimeout(timer);
    this.logger.log({ message: 'consumidor SQS parado', drain: drained, outstanding: this.outstanding }, LOG_CONTEXT);
  }

  private async run(): Promise<void> {
    while (this.running) {
      const capacity = this.config.SQS_CONSUMER_CONCURRENCY - this.outstanding;
      if (capacity <= 0) {
        await Promise.race(this.chains);
        continue;
      }

      let messages: InputMessage[];
      try {
        messages = await this.queue.receive(capacity, this.abort.signal);
      } catch (error) {
        if (!this.running) break;
        this.metrics.retriesTotal.inc({ component: `${RETRY_COMPONENT}-receive` });
        this.logger.warn('ReceiveMessage falhou', { error }, LOG_CONTEXT);
        await this.pause(RECEIVE_ERROR_PAUSE_MS);
        continue;
      }

      this.dispatch(messages);
    }
  }

  /**
   * Mesmo `MessageGroupId` em sequência, grupos diferentes em paralelo: mantém a
   * ordem do FIFO como otimização (ARQUITETURA 7.2). A correção vem do banco.
   */
  private dispatch(messages: InputMessage[]): void {
    const groups = new Map<string, InputMessage[]>();
    for (const message of messages) {
      const key = message.groupId ?? `#${message.sqsMessageId}`;
      const group = groups.get(key);
      if (group) group.push(message);
      else groups.set(key, [message]);
    }

    for (const group of groups.values()) {
      this.outstanding += group.length;
      const chain = (async () => {
        for (const message of group) {
          try {
            if (this.running) await this.handle(message);
            else await this.safely('releaseNow', () => this.queue.releaseNow(message)); // 7.3 passo 3
          } finally {
            this.outstanding -= 1;
          }
        }
      })();
      this.chains.add(chain);
      void chain.finally(() => this.chains.delete(chain));
    }
  }

  /** Processa uma mensagem e aplica a ação na fila. Nunca lança. */
  async handle(message: InputMessage): Promise<ConsumerAction> {
    const startedAt = performance.now();
    this.metrics.sqsMessagesReceivedTotal.inc({ queue: this.queue.name });

    const parsed = parseEnvelope(message.body);
    const context = parsed.ok
      ? {
          correlationId: parsed.messageId,
          messageId: parsed.messageId,
          walletId: parsed.command.walletId,
          providerId: parsed.command.providerId,
          kind: parsed.command.kind,
        }
      : { messageId: parsed.messageId ?? message.sqsMessageId };

    return runWithRequestContext(context, async () => {
      const action = await this.decide(parsed, message);
      await this.apply(action, parsed, message);
      this.metrics.processingDurationSeconds.observe({ entry: 'sqs' }, (performance.now() - startedAt) / 1000);
      return action;
    });
  }

  private async decide(parsed: ParsedEnvelope, message: InputMessage): Promise<ConsumerAction> {
    if (!parsed.ok) {
      this.logger.warn({ message: 'mensagem inválida', reason: parsed.reason, receiveCount: message.receiveCount }, LOG_CONTEXT);
      return { type: 'RELEASE_PERMANENT', reason: parsed.reason };
    }

    try {
      const outcome = await this.submit.execute(parsed.command, {
        consumerName: this.config.CONSUMER_NAME,
        messageId: parsed.messageId,
      });
      this.countOutcome(outcome, parsed.command.kind);
      const action = classifyOutcome(outcome);
      if (action.type === 'ACK' && action.warn) {
        this.logger.warn({ message: 'mensagem sem efeito', outcome: action.warn }, LOG_CONTEXT);
      }
      if (action.type === 'RELEASE_PERMANENT') {
        // D7: mesmo messageId com payload diferente.
        this.logger.error({ message: 'messageId repetido com payload diferente', outcome: outcome.type }, LOG_CONTEXT);
      }
      return action;
    } catch (error) {
      const action = classifyError(error, message.receiveCount);
      if (action.type === 'RELEASE_PERMANENT') {
        this.logger.warn({ message: 'mensagem inválida', reason: action.reason, error }, LOG_CONTEXT);
      } else if (action.reason === 'TRANSIENT') {
        this.logger.warn({ message: 'falha transitória, nova tentativa', receiveCount: message.receiveCount, error }, LOG_CONTEXT);
      } else {
        this.logger.error({ message: 'erro inesperado no processamento', receiveCount: message.receiveCount, error }, LOG_CONTEXT);
      }
      return action;
    }
  }

  private async apply(action: ConsumerAction, parsed: ParsedEnvelope, message: InputMessage): Promise<void> {
    if (action.type === 'ACK') {
      // TESTES 3.4: depois do COMMIT, antes do DeleteMessage (C-05).
      FaultInjector.hit(FaultPoint.ConsumerAfterCommitBeforeAck);
      await this.safely('DeleteMessage', () => this.queue.ack(message));
      return;
    }

    const last = await this.isLastDelivery(message);
    if (last) {
      this.metrics.dlqTotal.inc();
      this.metrics.sqsMessagesDlqTotal.inc({ queue: this.queue.name, reason: action.reason });
      this.logger.error({ message: 'última entrega: a mensagem segue para a DLQ', receiveCount: message.receiveCount }, LOG_CONTEXT);
    }

    if (action.type === 'RELEASE_PERMANENT') {
      await this.safely('ChangeMessageVisibility', () => this.queue.releaseNow(message));
      return;
    }

    this.metrics.retriesTotal.inc({ component: RETRY_COMPONENT });
    if (last && parsed.ok) await this.recordFailed(parsed);
    await this.safely('ChangeMessageVisibility', () => this.queue.delay(message, action.delaySeconds));
  }

  /** DP-3: `FAILED` só na última entrega, com comando válido e falha transitória ou bug. */
  private async recordFailed(parsed: Extract<ParsedEnvelope, { ok: true }>): Promise<void> {
    try {
      const result = await this.recordFailure.execute(parsed.command);
      this.logger.warn({ message: 'falha persistente na última entrega', failed: result }, LOG_CONTEXT);
    } catch (error) {
      this.logger.error({ message: 'não foi possível gravar FAILED', error }, LOG_CONTEXT);
    }
  }

  private async isLastDelivery(message: InputMessage): Promise<boolean> {
    try {
      const max = await this.queue.maxReceiveCount();
      return max !== undefined && message.receiveCount >= max;
    } catch {
      return false;
    }
  }

  private countOutcome(outcome: SubmitOutcome, kind: string): void {
    if (outcome.type === 'DUPLICATE_MESSAGE') {
      this.metrics.duplicatesTotal.inc({ source: 'inbox' });
      return;
    }
    if (outcome.type !== 'RESULT') return;
    if (outcome.idempotentReplay) {
      this.metrics.duplicatesTotal.inc({ source: 'inbox' });
      return;
    }
    this.metrics.transactionsTotal.inc({ kind, status: outcome.view.status });
    if (outcome.view.status === WagerTransactionStatus.Rejected && outcome.view.failureCode) {
      this.metrics.transactionsRejectedTotal.inc({ reason: outcome.view.failureCode });
    }
  }

  /** Falha ao falar com a fila não perde a mensagem: ela volta quando a visibilidade expira. */
  private async safely(operation: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      this.logger.warn({ message: `${operation} falhou`, error }, LOG_CONTEXT);
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.abort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
