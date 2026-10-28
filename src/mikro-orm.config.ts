import { defineConfig } from '@mikro-orm/postgresql';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { SmokeBalance } from './entities/smoke-balance.entity';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5434),
  user: process.env.DB_USER ?? 'wagering',
  password: process.env.DB_PASSWORD ?? 'wagering',
  dbName: process.env.DB_NAME ?? 'wagering',

  // Descoberta explícita: nada de varrer pastas.
  // Com Bun, o scan de .ts via ts-morph costuma ser a primeira coisa a quebrar.
  entities: [SmokeBalance],
  metadataProvider: ReflectMetadataProvider,

  extensions: [Migrator],
  migrations: {
    path: './migrations',
    pathTs: './migrations',
    transactional: true,
    disableForeignKeys: false,
    snapshot: false,
  },

  debug: process.env.MIKRO_ORM_DEBUG === 'true',
  forceUtcTimezone: true,
});
