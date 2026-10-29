import { MikroORM } from '@mikro-orm/postgresql';
import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig, loadConfig } from './infrastructure/config';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { MikroOrmInboxRepository } from './infrastructure/persistence/inbox-repository';
import { MikroOrmLedgerRepository } from './infrastructure/persistence/ledger-repository';
import { MikroOrmOutboxRepository } from './infrastructure/persistence/outbox-repository';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/unit-of-work';
import { MikroOrmWagerTransactionRepository } from './infrastructure/persistence/wager-transaction-repository';
import { MikroOrmWalletRepository } from './infrastructure/persistence/wallet-repository';
import { HealthModule } from './interface/health/health.module';
import { HttpModule, UNIT_OF_WORK } from './interface/http/http.module';

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
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
  exports: [APP_CONFIG, UNIT_OF_WORK],
})
class ConfigModule {}

@Module({
  imports: [ConfigModule, PersistenceModule, MessagingModule, HealthModule, HttpModule],
})
export class AppModule {}
