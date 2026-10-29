import { Global, Module } from '@nestjs/common';
import { AppLogger } from './logger';
import { MetricsRegistry } from './metrics';

@Global()
@Module({
  providers: [
    AppLogger,
    {
      provide: MetricsRegistry,
      useClass: MetricsRegistry,
    },
  ],
  exports: [AppLogger, MetricsRegistry],
})
export class ObservabilityModule {}
