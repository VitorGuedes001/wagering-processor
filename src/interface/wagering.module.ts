import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import { CreateWallet } from '../application/create-wallet';
import type { Clock, IdGenerator, UnitOfWork } from '../application/ports';
import { ApplicationTransactionQueries, ApplicationWalletQueries } from '../application/queries';
import { SubmitWagerTransaction } from '../application/submit-wager-transaction';
import { SystemClock } from '../infrastructure/clock';
import { RandomUuidGenerator } from '../infrastructure/id-generator';
import { ObservabilityModule } from '../infrastructure/observability/observability.module';
import { UNIT_OF_WORK } from '../infrastructure/persistence/persistence.module';
import { AcceptAllProviderIdentity, PROVIDER_IDENTITY } from '../infrastructure/provider-identity';
import { AuthGuard } from './http/auth.guard';
import { CorrelationIdMiddleware } from './http/correlation-id.middleware';
import { HttpErrorFilter } from './http/error-mapping';
import { MetricsController } from './http/metrics.controller';
import { WageringController } from './http/wagering.controller';
import { WalletsController } from './http/wallets.controller';

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
    inject: [UNIT_OF_WORK, SystemClock, RandomUuidGenerator],
    useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) =>
      new SubmitWagerTransaction(uow, clock, ids),
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
 * Controllers e use cases (ARQUITETURA §11). O `UNIT_OF_WORK` vem do
 * `PersistenceModule`; `withUnitOfWork` liga uma instância pronta (testes).
 */
@Module({
  imports: [ObservabilityModule],
  controllers: [WalletsController, WageringController, MetricsController],
  providers: WAGERING_PROVIDERS,
})
export class WageringModule implements NestModule {
  static withUnitOfWork(uow: UnitOfWork): DynamicModule {
    return {
      module: WageringModule,
      providers: [{ provide: UNIT_OF_WORK, useValue: uow }],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
