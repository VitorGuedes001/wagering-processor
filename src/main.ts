import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  const address = app.getHttpServer().address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : config.PORT;
  console.log(JSON.stringify({ msg: 'listening', port: actualPort, runtime: `bun ${Bun.version}` }));
}

void bootstrap();
