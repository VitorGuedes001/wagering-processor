import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { CreateWallet } from '../application/create-wallet';
import type { Clock, EventPublisher, IdGenerator, UnitOfWork } from '../application/ports';
import { PublishOutbox } from '../application/publish-outbox';
import { ApplicationTransactionQueries, ApplicationWalletQueries } from '../application/queries';
import { RecordProcessingFailure } from '../application/record-processing-failure';
import { ReconcileWallet } from '../application/reconcile-wallet';
import { ResolvePendingReferences } from '../application/resolve-pending-references';
import {
  DEFAULT_REFERENCE_BACKOFF,
  SubmitWagerTransaction,
} from '../application/submit-wager-transaction';
import { SystemClock } from '../infrastructure/clock';
import { APP_CONFIG, type AppConfig, loadConfig, referenceBackoffFrom } from '../infrastructure/config';
import { RandomUuidGenerator } from '../infrastructure/id-generator';
import { EVENT_PUBLISHER } from '../infrastructure/messaging/sqs-event-publisher';
import { SqsInputQueue } from '../infrastructure/messaging/sqs-input-queue';
import { ObservabilityModule } from '../infrastructure/observability/observability.module';
import { UNIT_OF_WORK } from '../infrastructure/persistence/persistence.module';
import { AcceptAllProviderIdentity, PROVIDER_IDENTITY } from '../infrastructure/provider-identity';
import { AuthGuard } from './http/auth.guard';
import { CorrelationIdMiddleware } from './http/correlation-id.middleware';
import { HttpErrorFilter } from './http/error-mapping';
import { MetricsController } from './http/metrics.controller';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';
import { WagerTransactionConsumer } from './sqs/wager-transaction.consumer';
import { OutboxLagProbe } from '../infrastructure/persistence/outbox-lag-probe';
import { OutboxWorker } from './workers/outbox.worker';
import { PendingReferenceWorker } from './workers/pending-reference.worker';

/** Sem `APP_CONFIG` (módulo montado sozinho em teste), vale o default de D11. */
const OPTIONAL_CONFIG = { token: APP_CONFIG, optional: true };

const WAGERING_PROVIDERS: Provider[] = [
  AuthGuard,
  HttpErrorFilter,
  CorrelationIdMiddleware,
  SystemClock,
  RandomUuidGenerator,
  { provide: PROVIDER_IDENTITY, useClass: AcceptAllProviderIdentity },
  {
    provide: CreateWallet,
    inject: [UNIT_OF_WORK, SystemClock, RandomUuidGenerator],
    useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWallet(uow, clock, ids),
  },
  {
    provide: SubmitWagerTransaction,
    inject: [UNIT_OF_WORK, SystemClock, RandomUuidGenerator, OPTIONAL_CONFIG],
    useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config?: AppConfig) =>
      new SubmitWagerTransaction(
        uow,
        clock,
        ids,
        config ? referenceBackoffFrom(config) : DEFAULT_REFERENCE_BACKOFF,
      ),
  },
  {
    provide: RecordProcessingFailure,
    inject: [UNIT_OF_WORK, SystemClock, RandomUuidGenerator],
    useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
      new RecordProcessingFailure(uow, clock, ids),
  },
  {
    provide: PublishOutbox,
    inject: [UNIT_OF_WORK, EVENT_PUBLISHER, SystemClock],
    useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock) =>
      new PublishOutbox(uow, publisher, clock),
  },
  // Só consome se ENABLE_CONSUMER (D28); depende do SqsInputQueue do MessagingModule.
  WagerTransactionConsumer,
  // Só roda se ENABLE_OUTBOX_WORKER (D28); preso ao ciclo de vida do Nest (D32, §7.3).
  OutboxWorker,
  {
    provide: ResolvePendingReferences,
    inject: [UNIT_OF_WORK, SystemClock, RandomUuidGenerator, OPTIONAL_CONFIG],
    useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, config?: AppConfig) =>
      new ResolvePendingReferences(uow, clock, ids, {
        batch: config?.REFERENCE_BATCH ?? 50,
        leaseMs: config?.REFERENCE_LEASE_MS ?? 30_000,
        backoff: config ? referenceBackoffFrom(config) : DEFAULT_REFERENCE_BACKOFF,
      }),
  },
  // Só roda se ENABLE_REFERENCE_WORKER (D28).
  PendingReferenceWorker,
  {
    provide: ReconcileWallet,
    inject: [UNIT_OF_WORK],
    useFactory: (uow: UnitOfWork) => new ReconcileWallet(uow),
  },
  {
    provide: ApplicationWalletQueries,
    inject: [UNIT_OF_WORK],
    useFactory: (uow: UnitOfWork) => new ApplicationWalletQueries(uow),
  },
  {
    provide: ApplicationTransactionQueries,
    inject: [UNIT_OF_WORK],
    useFactory: (uow: UnitOfWork) => new ApplicationTransactionQueries(uow),
  },
];

/**
 * Controllers, use cases, consumidor SQS e workers (ARQUITETURA §11).
 * O `UNIT_OF_WORK` vem do `PersistenceModule`; `withUnitOfWork` liga uma instância
 * pronta (testes).
 */
@Module({
  imports: [ObservabilityModule],
  controllers: [WalletsController, WageringController, MetricsController],
  providers: WAGERING_PROVIDERS,
})
export class WageringModule implements NestModule {
  /**
   * Só HTTP, com uma UoW pronta (testes em processo). Sem fila nem workers: o
   * consumidor e os workers recebem flags false (D28), e nenhum adaptador SQS.
   * A config não lê `process.env`, então nunca aponta para as filas padrão (TESTES D35).
   */
  static withUnitOfWork(uow: UnitOfWork): DynamicModule {
    return {
      module: WageringModule,
      providers: [
        { provide: UNIT_OF_WORK, useValue: uow },
        {
          provide: APP_CONFIG,
          useValue: loadConfig({
            ENABLE_CONSUMER: 'false',
            ENABLE_REFERENCE_WORKER: 'false',
            ENABLE_OUTBOX_WORKER: 'false',
          }),
        },
        { provide: SqsInputQueue, useValue: null },
        { provide: EVENT_PUBLISHER, useValue: { publish: async () => {} } },
        // Sem MikroORM aqui; o worker de outbox está desligado e nunca lê o lag.
        { provide: OutboxLagProbe, useValue: { lagSeconds: async () => 0 } },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
