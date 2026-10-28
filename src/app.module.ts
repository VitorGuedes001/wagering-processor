import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './infrastructure/config';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { HealthModule } from './interface/health/health.module';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
  exports: [APP_CONFIG],
})
class ConfigModule {}

@Module({
  imports: [ConfigModule, PersistenceModule, MessagingModule, HealthModule],
})
export class AppModule {}
