import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { loadConfig } from '../config';
import { InboxMessageRecord } from './records/inbox-message.record';
import { LedgerEntryRecord } from './records/ledger-entry.record';
import { OutboxMessageRecord } from './records/outbox-message.record';
import { WagerTransactionRecord } from './records/wager-transaction.record';
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
  entities: [WalletRecord, LedgerEntryRecord, WagerTransactionRecord, InboxMessageRecord, OutboxMessageRecord],
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
