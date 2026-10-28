import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(JSON.stringify({ msg: 'listening', port, runtime: `bun ${Bun.version}` }));
}

void bootstrap();
