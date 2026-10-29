import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../config';
import { LedgerEntryRecord } from './records/ledger-entry.record';
import { WalletRecord } from './records/wallet.record';

const config = loadConfig();

export default defineConfig({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  dbName: config.DB_NAME,

  // Descoberta explícita: nada de varrer pastas.
  // Com Bun, o scan de .ts via ts-morph costuma ser a primeira coisa a quebrar.
  entities: [WalletRecord, LedgerEntryRecord],
  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],
  migrations: {
    path: './migrations',
    pathTs: './migrations',
    transactional: true,
    disableForeignKeys: false,
    snapshot: false,
  },

  debug: config.MIKRO_ORM_DEBUG,
  forceUtcTimezone: true,
});
