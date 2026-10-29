import { Global, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { MikroORM } from '@mikro-orm/postgresql';
import { APP_CONFIG, type AppConfig } from '../config';
import { MikroOrmInboxRepository } from './inbox-repository';
import { MikroOrmLedgerRepository } from './ledger-repository';
import ormConfig from './mikro-orm.config';
import { MikroOrmOutboxRepository } from './outbox-repository';
import { MikroOrmUnitOfWork } from './unit-of-work';
import { MikroOrmWagerTransactionRepository } from './wager-transaction-repository';
import { MikroOrmWalletRepository } from './wallet-repository';

/** Token da porta `UnitOfWork` (ARQUITETURA §3). */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

@Global()
@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  providers: [
    {
      provide: UNIT_OF_WORK,
      inject: [MikroORM, APP_CONFIG],
      useFactory: (orm: MikroORM, config: AppConfig) =>
        new MikroOrmUnitOfWork(orm, config, {
          wallets: (em) => new MikroOrmWalletRepository(em),
          ledger: (em) => new MikroOrmLedgerRepository(em),
          transactions: (em) => new MikroOrmWagerTransactionRepository(em),
          inbox: (em) => new MikroOrmInboxRepository(em),
          outbox: (em) => new MikroOrmOutboxRepository(em),
        }),
    },
  ],
  exports: [UNIT_OF_WORK],
})
export class PersistenceModule {}
