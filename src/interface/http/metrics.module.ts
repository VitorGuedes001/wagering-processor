import { Module } from '@nestjs/common';
import { ObservabilityModule } from '../../infrastructure/observability/observability.module';
import { MetricsController } from './controllers/metrics.controller';

@Module({
  imports: [ObservabilityModule],
  controllers: [MetricsController],
})
export class MetricsModule {}
