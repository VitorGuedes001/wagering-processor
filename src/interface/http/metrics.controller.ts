import { Controller, Get, Header } from '@nestjs/common';
import { MetricsRegistry } from '../../infrastructure/observability/metrics';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsRegistry: MetricsRegistry) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    return this.metricsRegistry.getMetrics();
  }
}
