import { Module } from '@nestjs/common';
import { ReadinessProbe } from '../../infrastructure/health/readiness-probe';
import { HealthController } from './health.controller';

@Module({
  controllers: [HealthController],
  providers: [ReadinessProbe],
})
export class HealthModule {}
