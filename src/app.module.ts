import { Controller, Get, HttpCode, Injectable, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import ormConfig from './mikro-orm.config';

@Injectable()
export class ReadinessProbe {
  private readonly sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  constructor(private readonly em: EntityManager) { }

  async check(): Promise<{ postgres: boolean; sqs: boolean }> {
    const [postgres, sqs] = await Promise.all([
      this.em
        .getConnection()
        .execute('select 1')
        .then(() => true)
        .catch(() => false),
      this.sqs
        .send(new ListQueuesCommand({}))
        .then(() => true)
        .catch(() => false),
    ]);
    return { postgres, sqs };
  }
}

@Controller('health')
export class HealthController {
  constructor(private readonly probe: ReadinessProbe) { }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(200)
  async ready() {
    const deps = await this.probe.check();
    const ready = deps.postgres && deps.sqs;
    return { status: ready ? 'ok' : 'degraded', dependencies: deps };
  }
}

@Module({
  imports: [MikroOrmModule.forRoot(ormConfig)],
  controllers: [HealthController],
  providers: [ReadinessProbe],
})
export class AppModule { }
