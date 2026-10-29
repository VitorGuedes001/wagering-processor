import 'reflect-metadata';
import { SQSClient } from '@aws-sdk/client-sqs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config';
import { SqsEventPublisher } from './infrastructure/messaging/sqs-event-publisher';
import { MetricsRegistry } from './infrastructure/observability/metrics';
import { UNIT_OF_WORK } from './interface/http/http.module';
import { OutboxWorker } from './interface/workers/outbox.worker';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();

  let outboxWorker: OutboxWorker | undefined;
  if (config.ENABLE_OUTBOX_WORKER) {
    const uow = app.get(UNIT_OF_WORK);
    const sqs = app.get(SQSClient);
    const metrics = app.get(MetricsRegistry);
    const publisher = new SqsEventPublisher(sqs, config);
    outboxWorker = new OutboxWorker(uow, publisher, config, metrics);

    await outboxWorker.start();

    const onShutdown = async () => {
      if (outboxWorker) {
        await outboxWorker.stop();
      }
    };
    process.once('SIGTERM', onShutdown);
    process.once('SIGINT', onShutdown);
  }

  await app.listen(config.PORT);
  const address = app.getHttpServer().address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : config.PORT;
  console.log(JSON.stringify({ msg: 'listening', port: actualPort, runtime: `bun ${Bun.version}` }));
}

void bootstrap();
