import { randomUUID } from 'node:crypto';
import { SQL } from 'bun';
import {
  buildPostgresUrl,
  checkInfrastructure,
  createMigratorOrm,
  ensureTemplateDatabase,
  hasMigrationFiles,
  MIGRATIONS_DIR,
  TEMPLATE_DB_NAME,
} from './preload';

export interface CreateTestDatabaseOptions {
  /** Se `true` (padrão), clona de `wagering_template_<hash>` (D34, D60). Se `false` (I-01), cria banco vazio. */
  fromTemplate?: boolean;
}

export interface TestDatabase {
  readonly name: string;
  readonly sql: SQL;
  /** Abre uma conexão independente para `name` (ex.: testar locks concorrentes), fechada no `drop()`. */
  connect(): Promise<SQL>;
  /** Roda `orm.migrator.up()` contra este banco. */
  migrateUp(): Promise<void>;
  /** Roda `orm.migrator.down({ to: 0 })` contra este banco. */
  migrateDownToZero(): Promise<void>;
  /** Limpa dados das tabelas existentes usando `session_replication_role = replica` (SCHEMA §3). */
  reset(): Promise<void>;
  /** Fecha conexões e executa `DROP DATABASE IF EXISTS ... WITH (FORCE)`. */
  drop(): Promise<void>;
}

const APP_TABLES = [
  'wallet_ledger_entry',
  'wager_transaction',
  'wallet',
  'inbox_message',
  'outbox_message',
] as const;

let createDbMutex: Promise<void> = Promise.resolve();

async function withCreateDbLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = createDbMutex;
  let release!: () => void;
  createDbMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Cria um banco PostgreSQL isolado para um arquivo de teste (TESTES D34, D60, §3.1).
 * Nunca usa o banco `wagering`.
 */
export async function createTestDatabase(
  options: CreateTestDatabaseOptions = {},
): Promise<TestDatabase> {
  const fromTemplate = options.fromTemplate ?? true;
  const dbName = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

  if (fromTemplate) {
    await ensureTemplateDatabase();
  } else {
    await checkInfrastructure();
  }

  await withCreateDbLock(async () => {
    const adminSql = new SQL({ url: buildPostgresUrl('postgres'), max: 1 });
    try {
      if (fromTemplate) {
        await adminSql.unsafe(`
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = '${TEMPLATE_DB_NAME}' AND pid <> pg_backend_pid()
        `);
        await adminSql.unsafe(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB_NAME}`);
      } else {
        await adminSql.unsafe(`CREATE DATABASE ${dbName}`);
      }
    } finally {
      await adminSql.close();
    }
  });

  const sql = new SQL({ url: buildPostgresUrl(dbName), max: 1 });
  const extraConnections: SQL[] = [];
  let dropped = false;

  const db: TestDatabase = {
    name: dbName,
    sql,

    async connect(): Promise<SQL> {
      const conn = new SQL({ url: buildPostgresUrl(dbName), max: 1 });
      extraConnections.push(conn);
      return conn;
    },

    async migrateUp(): Promise<void> {
      if (!hasMigrationFiles()) {
        throw new Error(`Nenhuma migration encontrada em ${MIGRATIONS_DIR}.`);
      }
      const orm = await createMigratorOrm(dbName);
      try {
        await orm.migrator.up();
      } finally {
        await orm.close(true);
      }
    },

    async migrateDownToZero(): Promise<void> {
      if (!hasMigrationFiles()) {
        throw new Error(`Nenhuma migration encontrada em ${MIGRATIONS_DIR}.`);
      }
      const orm = await createMigratorOrm(dbName);
      try {
        await orm.migrator.down({ to: 0 });
      } finally {
        await orm.close(true);
      }
    },

    async reset(): Promise<void> {
      const rows = await sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('wallet_ledger_entry', 'wager_transaction', 'wallet', 'inbox_message', 'outbox_message')
      `;
      const existing = APP_TABLES.filter((t) => rows.some((r) => r.table_name === t));
      if (existing.length === 0) return;

      await sql.unsafe('SET session_replication_role = replica');
      try {
        await sql.unsafe(`TRUNCATE TABLE ${existing.join(', ')} CASCADE`);
      } finally {
        await sql.unsafe('SET session_replication_role = DEFAULT');
      }
    },

    async drop(): Promise<void> {
      if (dropped) return;
      dropped = true;

      for (const conn of extraConnections.splice(0)) {
        try {
          await conn.close();
        } catch {
          // ignora erro ao fechar conexão extra
        }
      }
      try {
        await sql.close();
      } catch {
        // ignora erro ao fechar conexão principal
      }

      const adminSql = new SQL({ url: buildPostgresUrl('postgres'), max: 1 });
      try {
        await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await adminSql.close();
      }
    },
  };

  return db;
}

export async function dropTestDatabase(dbOrName: TestDatabase | string): Promise<void> {
  if (typeof dbOrName !== 'string') {
    await dbOrName.drop();
    return;
  }
  if (
    dbOrName === 'wagering' ||
    dbOrName === 'postgres' ||
    dbOrName === TEMPLATE_DB_NAME ||
    dbOrName.startsWith('wagering_template')
  ) {
    throw new Error(`Proibido remover banco compartilhado: ${dbOrName}`);
  }
  const adminSql = new SQL({ url: buildPostgresUrl('postgres'), max: 1 });
  try {
    await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbOrName} WITH (FORCE)`);
  } finally {
    await adminSql.close();
  }
}
