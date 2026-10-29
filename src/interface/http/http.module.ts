import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
  type Provider,
} from '@nestjs/common';
import type { UnitOfWork } from '../../application/ports';
import {
  ApplicationTransactionQueries,
  ApplicationWalletQueries,
} from '../../application/queries';
import { AuthGuard } from './auth.guard';
import { CorrelationIdMiddleware } from './correlation-id.middleware';
import { HttpErrorFilter } from './error-mapping';
import {
  CREATE_WALLET_USE_CASE,
  DefaultCreateWalletHandler,
  DefaultSubmitWagerHandler,
  SUBMIT_WAGER_USE_CASE,
} from './use-case-handlers';
import { WageringController, TRANSACTION_QUERIES } from './wagering.controller';
import { WalletsController, WALLET_QUERIES } from './wallets.controller';

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export const HTTP_PROVIDERS: Provider[] = [
  AuthGuard,
  HttpErrorFilter,
  CorrelationIdMiddleware,
  {
    provide: CREATE_WALLET_USE_CASE,
    useFactory: (uow?: UnitOfWork) => (uow ? new DefaultCreateWalletHandler(uow) : undefined),
    inject: [{ token: UNIT_OF_WORK, optional: true }],
  },
  {
    provide: SUBMIT_WAGER_USE_CASE,
    useFactory: (uow?: UnitOfWork) => (uow ? new DefaultSubmitWagerHandler(uow) : undefined),
    inject: [{ token: UNIT_OF_WORK, optional: true }],
  },
  {
    provide: WALLET_QUERIES,
    useFactory: (uow?: UnitOfWork) => (uow ? new ApplicationWalletQueries(uow) : undefined),
    inject: [{ token: UNIT_OF_WORK, optional: true }],
  },
  {
    provide: TRANSACTION_QUERIES,
    useFactory: (uow?: UnitOfWork) => (uow ? new ApplicationTransactionQueries(uow) : undefined),
    inject: [{ token: UNIT_OF_WORK, optional: true }],
  },
];

@Module({
  controllers: [WalletsController, WageringController],
  providers: [...HTTP_PROVIDERS],
  exports: [
    ...HTTP_PROVIDERS,
    CREATE_WALLET_USE_CASE,
    SUBMIT_WAGER_USE_CASE,
    WALLET_QUERIES,
    TRANSACTION_QUERIES,
  ],
})
export class HttpModule implements NestModule {
  static forRoot(uow?: UnitOfWork): DynamicModule {
    const providers: Provider[] = [
      AuthGuard,
      HttpErrorFilter,
      CorrelationIdMiddleware,
      {
        provide: CREATE_WALLET_USE_CASE,
        useFactory: () => (uow ? new DefaultCreateWalletHandler(uow) : undefined),
      },
      {
        provide: SUBMIT_WAGER_USE_CASE,
        useFactory: () => (uow ? new DefaultSubmitWagerHandler(uow) : undefined),
      },
      {
        provide: WALLET_QUERIES,
        useFactory: () => (uow ? new ApplicationWalletQueries(uow) : undefined),
      },
      {
        provide: TRANSACTION_QUERIES,
        useFactory: () => (uow ? new ApplicationTransactionQueries(uow) : undefined),
      },
    ];

    return {
      module: HttpModule,
      controllers: [WalletsController, WageringController],
      providers,
      exports: providers,
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
