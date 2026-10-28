import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './infrastructure/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  console.log(JSON.stringify({ msg: 'listening', port: config.PORT, runtime: `bun ${Bun.version}` }));
}

void bootstrap();
