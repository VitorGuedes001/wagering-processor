import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ReadinessProbe } from '../../infrastructure/health/readiness-probe';

@Controller('health')
export class HealthController {
  constructor(private readonly probe: ReadinessProbe) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** 503 quando alguma dependência falha: orquestradores leem readiness pelo status, não pelo corpo. */
  @Get('ready')
  async ready() {
    const dependencies = await this.probe.check();
    if (!dependencies.postgres || !dependencies.sqs) {
      throw new ServiceUnavailableException({ status: 'degraded', dependencies });
    }
    return { status: 'ok', dependencies };
  }
}
