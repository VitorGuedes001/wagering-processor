import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';

export const WORKTREE_ROOT = resolve(import.meta.dir, '../..');
export const WORKTREE_HASH = createHash('sha256').update(WORKTREE_ROOT).digest('hex').slice(0, 8);
/** Nome do banco template, isolado por checkout. */
export const TEMPLATE_DB_NAME = `wagering_template_${WORKTREE_HASH}`;
export const MIGRATIONS_DIR = resolve(WORKTREE_ROOT, 'migrations');

export interface TestInfraConfig {
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  sqsEndpoint: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
}

export function getTestInfraConfig(): TestInfraConfig {
  return {
    dbHost: process.env.DB_HOST ?? 'localhost',
    dbPort: parseInt(process.env.DB_PORT ?? '5434', 10),
    dbUser: process.env.DB_USER ?? 'wagering',
    dbPassword: process.env.DB_PASSWORD ?? 'wagering',
    sqsEndpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    awsRegion: process.env.AWS_REGION ?? 'us-east-1',
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  };
}

export function buildPostgresUrl(dbName: string, cfg: TestInfraConfig = getTestInfraConfig()): string {
  const user = encodeURIComponent(cfg.dbUser);
  const pass = encodeURIComponent(cfg.dbPassword);
  return `postgres://${user}:${pass}@${cfg.dbHost}:${cfg.dbPort}/${dbName}`;
}

export function hasMigrationFiles(dir = MIGRATIONS_DIR): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => /^Migration.*\.(ts|js)$/.test(name));
}

export async function createMigratorOrm(dbName: string): Promise<MikroORM> {
  const cfg = getTestInfraConfig();
  return MikroORM.init(
    defineConfig({
      host: cfg.dbHost,
      port: cfg.dbPort,
      user: cfg.dbUser,
      password: cfg.dbPassword,
      dbName,
      entities: [],
      metadataProvider: ReflectMetadataProvider,
      discovery: { warnWhenNoEntities: false },
      extensions: [Migrator],
      migrations: {
        path: MIGRATIONS_DIR,
        pathTs: MIGRATIONS_DIR,
        transactional: true,
        disableForeignKeys: false,
        snapshot: false,
      },
      debug: false,
      forceUtcTimezone: true,
    }),
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) ao conectar em ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

let infraCheckedPromise: Promise<void> | undefined;

/**
 * Verifica se PostgreSQL e LocalStack SQS respondem.
 * Se não responderem, falha imediatamente com a instrução `bun run infra:up`.
 */
export async function checkInfrastructure(): Promise<void> {
  if (infraCheckedPromise) return infraCheckedPromise;

  infraCheckedPromise = (async () => {
    const cfg = getTestInfraConfig();
    const errors: string[] = [];

    // 1. PostgreSQL
    const adminSql = new SQL({ url: buildPostgresUrl('postgres', cfg), max: 1 });
    try {
      await withTimeout(adminSql`SELECT 1`, 3_000, `PostgreSQL (${cfg.dbHost}:${cfg.dbPort})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`PostgreSQL (${cfg.dbHost}:${cfg.dbPort}): ${msg}`);
    } finally {
      try {
        await adminSql.close();
      } catch {
        // ignora erro de close quando conexão falhou
      }
    }

    // 2. LocalStack SQS
    const sqs = new SQSClient({
      region: cfg.awsRegion,
      endpoint: cfg.sqsEndpoint,
      credentials: {
        accessKeyId: cfg.awsAccessKeyId,
        secretAccessKey: cfg.awsSecretAccessKey,
      },
    });
    try {
      await withTimeout(sqs.send(new ListQueuesCommand({})), 3_000, `SQS (${cfg.sqsEndpoint})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`LocalStack SQS (${cfg.sqsEndpoint}): ${msg}`);
    } finally {
      sqs.destroy();
    }

    if (errors.length > 0) {
      infraCheckedPromise = undefined;
      throw new Error(
        `Infraestrutura indisponível. Suba os containers com: bun run infra:up\nDetalhes:\n  - ${errors.join('\n  - ')}`,
      );
    }
  })();

  return infraCheckedPromise;
}

let templatePromise: Promise<void> | undefined;

/**
 * Cria/atualiza o banco `wagering_template_<hash>` do checkout atual uma vez por processo
 * Aplica as migrations e fecha todas as conexões no template
 * para permitir `CREATE DATABASE ... TEMPLATE wagering_template_<hash>`.
 */
export async function ensureTemplateDatabase(): Promise<void> {
  if (templatePromise) return templatePromise;

  templatePromise = (async () => {
    await checkInfrastructure();

    const adminSql = new SQL({ url: buildPostgresUrl('postgres'), max: 1 });
    try {
      await adminSql.unsafe(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${TEMPLATE_DB_NAME}' AND pid <> pg_backend_pid()
      `);
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEMPLATE_DB_NAME} WITH (FORCE)`);
      await adminSql.unsafe(`CREATE DATABASE ${TEMPLATE_DB_NAME}`);

      if (hasMigrationFiles()) {
        const orm = await createMigratorOrm(TEMPLATE_DB_NAME);
        try {
          await orm.migrator.up();
        } finally {
          await orm.close(true);
        }
      }

      // Garante zero sessões ativas no template antes do CREATE DATABASE ... TEMPLATE
      await adminSql.unsafe(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${TEMPLATE_DB_NAME}' AND pid <> pg_backend_pid()
      `);
    } catch (err) {
      templatePromise = undefined;
      throw err;
    } finally {
      await adminSql.close();
    }
  })();

  return templatePromise;
}
