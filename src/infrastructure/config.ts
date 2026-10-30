import { z } from 'zod';
import type { BackoffPolicy } from '../domain/wager-transaction';

const flag = z
  .enum(['true', 'false'])
  .default('true')
  .transform((value) => value === 'true');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),

  DB_HOST: z.string().min(1).default('localhost'),
  DB_PORT: positiveInt(5434),
  DB_USER: z.string().min(1).default('wagering'),
  DB_PASSWORD: z.string().min(1).default('wagering'),
  DB_NAME: z.string().min(1).default('wagering'),
  DB_LOCK_TIMEOUT_MS: positiveInt(2000),
  MIKRO_ORM_DEBUG: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string().min(1).default('test'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).default('test'),
  SQS_ENDPOINT: z.url().default('http://localhost:4566'),
  SQS_INPUT_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().min(1).default('wagering-events.fifo'),
  SQS_CONSUMER_CONCURRENCY: positiveInt(5),
  CONSUMER_NAME: z.string().min(1).default('wager-transactions-consumer'),

  ENABLE_HTTP: flag,
  ENABLE_CONSUMER: flag,
  ENABLE_OUTBOX_WORKER: flag,
  ENABLE_REFERENCE_WORKER: flag,

  OUTBOX_POLL_MS: positiveInt(500),
  OUTBOX_BATCH: positiveInt(50),
  OUTBOX_LEASE_MS: positiveInt(30_000),
  REFERENCE_POLL_MS: positiveInt(1000),
  REFERENCE_MAX_ATTEMPTS: positiveInt(10),
  REFERENCE_BACKOFF_BASE_MS: positiveInt(1000),
  REFERENCE_BACKOFF_MAX_MS: positiveInt(300_000),
  REFERENCE_BATCH: positiveInt(50),
  REFERENCE_LEASE_MS: positiveInt(30_000),
  SHUTDOWN_GRACE_MS: positiveInt(20_000),

  FAULT_POINT: z.string().min(1).optional(),
});

export type AppConfig = z.infer<typeof schema>;

export const APP_CONFIG = Symbol('APP_CONFIG');

/** Política única de `PENDING_REFERENCE` para a submissão e o worker. */
export function referenceBackoffFrom(config: AppConfig): BackoffPolicy {
  return {
    baseMs: config.REFERENCE_BACKOFF_BASE_MS,
    maxMs: config.REFERENCE_BACKOFF_MAX_MS,
    maxAttempts: config.REFERENCE_MAX_ATTEMPTS,
  };
}

/** Lê e valida o ambiente uma vez. Valor inválido derruba o processo na largada. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Configuração inválida:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
