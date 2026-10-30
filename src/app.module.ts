import { Module } from '@nestjs/common';
import { ConfigModule } from './infrastructure/config.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { HealthModule } from './interface/health/health.module';
import { WageringModule } from './interface/wagering.module';

/** Composição dos módulos da aplicação. */
@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    MessagingModule,
    ObservabilityModule,
    HealthModule,
    WageringModule,
  ],
})
export class AppModule {}
