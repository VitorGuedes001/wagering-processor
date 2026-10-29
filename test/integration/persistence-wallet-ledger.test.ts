/**
 * I-03 (wallet e ledger): ida e volta `domínio → record → domínio`, com dinheiro
 * como string, e o comportamento da Unit of Work (D15, D21, D22, D53, SCHEMA 5).
 */
import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TransientInfrastructureError, type TxRepositories, UniqueViolationError } from '../../src/application/ports';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';
import { StaleWalletVersionError, translateDbError } from '../../src/infrastructure/persistence/db-errors';
import { MikroOrmLedgerRepository } from '../../src/infrastructure/persistence/ledger-repository';
import { LedgerEntryRecord } from '../../src/infrastructure/persistence/records/ledger-entry.record';
import { WalletRecord } from '../../src/infrastructure/persistence/records/wallet.record';
import { MikroOrmUnitOfWork, type RepositoryFactories } from '../../src/infrastructure/persistence/unit-of-work';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/wallet-repository';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertAllWalletsConsistent } from '../support/invariants';
import { getTestInfraConfig } from '../support/preload';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-10-28T12:00:00.000Z');

let db: TestDatabase;
let orm: MikroORM;
let other: SQL;

/** `em` da transação corrente, para gravar por SQL cru as linhas que são de outras tarefas. */
let currentEm: EntityManager | undefined;

/** Repositório que lança em qualquer chamada: os de transação, inbox e outbox são da T21/T22. */
function outOfScope<T extends object>(name: string): () => T {
  const repository = new Proxy({} as T, {
    get: () => {
      throw new Error(`repositório ${name} é da T21/T22, fora da T20`);
    },
  });
  return () => repository;
}

const factories: RepositoryFactories = {
  wallets: (em) => {
    currentEm = em;
    return new MikroOrmWalletRepository(em);
  },
  ledger: (em) => new MikroOrmLedgerRepository(em),
  transactions: outOfScope<TxRepositories['transactions']>('transactions'),
  inbox: outOfScope<TxRepositories['inbox']>('inbox'),
  outbox: outOfScope<TxRepositories['outbox']>('outbox'),
};

function uow(lockTimeoutMs = 2000, on: MikroORM = orm): MikroOrmUnitOfWork {
  return new MikroOrmUnitOfWork(on, { DB_LOCK_TIMEOUT_MS: lockTimeoutMs }, factories);
}

/** `poolMax: 1` força toda transação a reusar a mesma conexão: é como se vê um `SET` vazando. */
function initOrm(poolMax?: number): Promise<MikroORM> {
  const cfg = getTestInfraConfig();
  return MikroORM.init(
    defineConfig({
      host: cfg.dbHost,
      port: cfg.dbPort,
      user: cfg.dbUser,
      password: cfg.dbPassword,
      dbName: db.name,
      entities: [WalletRecord, LedgerEntryRecord],
      metadataProvider: ReflectMetadataProvider,
      debug: false,
      forceUtcTimezone: true,
      ...(poolMax ? { pool: { min: 1, max: poolMax } } : {}),
    }),
  );
}

/**
 * ORM descartável para os testes que derrubam a conexão. O Kysely 0.29.6 só devolve a
 * conexão ao pool depois de um COMMIT ou ROLLBACK bem-sucedido: com o socket morto,
 * ela fica presa e o `close()` espera para sempre. Por isso o `close` não é aguardado
 * (ver "Fora de escopo / dívida" na nota).
 */
async function withDisposableOrm(fn: (on: MikroORM) => Promise<void>): Promise<void> {
  const disposable = await initOrm();
  try {
    await fn(disposable);
  } finally {
    void disposable.close(true);
  }
}

async function backendPid(): Promise<number> {
  const [row] = await currentEm!.execute<{ pid: number }[]>('select pg_backend_pid() as pid');
  return row!.pid;
}

/** A linha de `wager_transaction` que a FK do ledger exige. O repositório de transações é da T21. */
async function insertTransactionRow(
  row: { id: string; walletId: string; playerId: string; kind: 'OPENING' | 'BET'; amount: string; balanceAfter: string },
): Promise<void> {
  if (!currentEm) throw new Error('fora de uma transação');
  if (row.kind === 'OPENING') {
    await currentEm.execute(
      `insert into wager_transaction (id, wallet_id, player_id, kind, status, amount, currency, balance_after,
         created_at, updated_at, processed_at)
       values (?, ?, ?, 'OPENING', 'PROCESSED', ?, 'BRL', ?, now(), now(), now())`,
      [row.id, row.walletId, row.playerId, row.amount, row.balanceAfter],
    );
    return;
  }
  await currentEm.execute(
    `insert into wager_transaction (id, wallet_id, player_id, kind, status, amount, currency, provider_id,
       external_transaction_id, idempotency_key, payload_hash, round_id, game_id, balance_after,
       created_at, updated_at, processed_at)
     values (?, ?, ?, 'BET', 'PROCESSED', ?, 'BRL', 'provider-a', ?, ?, ?, 'round-1', 'game-1', ?, now(), now(), now())`,
    [row.id, row.walletId, row.playerId, row.amount, `ext-${row.id}`, `key-${row.id}`, 'a'.repeat(64), row.balanceAfter],
  );
}

/** Abre e grava uma wallet como o `CreateWallet` da T30 fará: wallet, `OPENING` e lançamento. */
async function openWallet(initialBalance: string): Promise<Wallet> {
  const openingTransactionId = randomUUID();
  const { wallet, openingEntry } = Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: brl(initialBalance),
    openingTransactionId,
    openingEntryId: randomUUID(),
    at,
  });
  await uow().run(async (tx) => {
    await tx.wallets.insert(wallet);
    if (openingEntry) {
      await insertTransactionRow({
        id: openingTransactionId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'OPENING',
        amount: initialBalance,
        balanceAfter: initialBalance,
      });
      await tx.ledger.insert(openingEntry);
    }
  });
  return wallet;
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('esperava erro');
}

beforeAll(async () => {
  db = await createTestDatabase();
  orm = await initOrm();
  other = await db.connect();
});

afterAll(async () => {
  await orm?.close(true);
  await db?.drop();
});

describe('I-03 wallet: ida e volta', () => {
  test('wallet sem saldo volta igual, sem lançamento', async () => {
    const wallet = await openWallet('0.00');

    const loaded = await uow().run((tx) => tx.wallets.findById(wallet.id));

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(wallet.id);
    expect(loaded!.playerId).toBe(wallet.playerId);
    expect(loaded!.currency).toBe('BRL');
    expect(loaded!.balance.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(loaded!.version).toBe(1);
    expect(loaded!.createdAt.getTime()).toBe(at.getTime());
    expect(loaded!.updatedAt.getTime()).toBe(at.getTime());
    expect(await uow().run((tx) => tx.ledger.all(wallet.id))).toEqual([]);
  });

  test('dinheiro chega do banco como string exata, nunca number (5.1)', async () => {
    const wallet = await openWallet('12345678901234567.89');

    const record = await uow().run(async () => currentEm!.findOneOrFail(WalletRecord, { id: wallet.id }));
    const [entry] = await uow().run(async () => currentEm!.find(LedgerEntryRecord, { walletId: wallet.id }));

    expect(typeof record.balance).toBe('string');
    expect(record.balance).toBe('12345678901234567.89');
    expect(typeof entry!.amount).toBe('string');
    expect(typeof entry!.balanceBefore).toBe('string');
    expect(typeof entry!.balanceAfter).toBe('string');
  });

  test('findById de wallet inexistente devolve undefined', async () => {
    expect(await uow().run((tx) => tx.wallets.findById(randomUUID()))).toBeUndefined();
    expect(await uow().run((tx) => tx.wallets.lockById(randomUUID()))).toBeUndefined();
  });
});

describe('I-03 ledger: ida e volta', () => {
  test('OPENING e débito gravados voltam iguais, com saldo, version e cursor', async () => {
    const opened = await openWallet('100.00');
    const betId = randomUUID();

    const debitEntry = await uow().run(async (tx) => {
      const wallet = (await tx.wallets.lockById(opened.id))!;
      const entry = wallet.debit(brl('30.00'), betId, randomUUID(), at);
      await insertTransactionRow({
        id: betId,
        walletId: wallet.id,
        playerId: wallet.playerId,
        kind: 'BET',
        amount: '30.00',
        balanceAfter: '70.00',
      });
      await tx.ledger.insert(entry);
      await tx.wallets.update(wallet, 1);
      return entry;
    });

    const wallet = (await uow().run((tx) => tx.wallets.findById(opened.id)))!;
    expect(wallet.balance.toJSON()).toEqual({ amount: '70.00', currency: 'BRL' });
    expect(wallet.version).toBe(2);

    const all = await uow().run((tx) => tx.ledger.all(opened.id));
    expect(all.map((e) => e.walletVersion)).toEqual([1, 2]);

    const [opening, debit] = all;
    expect(opening!.direction).toBe(LedgerDirection.Credit);
    expect(opening!.money.toJSON()).toEqual({ amount: '100.00', currency: 'BRL' });
    expect(opening!.balanceBefore.toJSON().amount).toBe('0.00');
    expect(opening!.balanceAfter.toJSON().amount).toBe('100.00');

    expect(debit!.id).toBe(debitEntry.id);
    expect(debit!.walletId).toBe(opened.id);
    expect(debit!.transactionId).toBe(betId);
    expect(debit!.direction).toBe(LedgerDirection.Debit);
    expect(debit!.money.toJSON()).toEqual({ amount: '30.00', currency: 'BRL' });
    expect(debit!.balanceBefore.toJSON().amount).toBe('100.00');
    expect(debit!.balanceAfter.toJSON().amount).toBe('70.00');
    expect(debit!.createdAt.getTime()).toBe(at.getTime());

    const page = await uow().run((tx) => tx.ledger.page(opened.id, 1, 10));
    expect(page.map((e) => e.id)).toEqual([debitEntry.id]);
    expect(await uow().run((tx) => tx.ledger.page(opened.id, 0, 1))).toHaveLength(1);

    await assertAllWalletsConsistent(db);
  });
});

describe('Unit of Work', () => {
  test('lockById trava a linha da wallet até o commit (FOR UPDATE, D15)', async () => {
    const wallet = await openWallet('10.00');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));

    const holder = uow().run(async (tx) => {
      await tx.wallets.lockById(wallet.id);
      locked();
      await released;
    });
    await lockTaken;

    const error = await caught(() => other`select id from wallet where id = ${wallet.id} for update nowait`);
    expect((error as { errno?: string }).errno).toBe('55P03');

    release();
    await holder;
    const [row] = await other`select id from wallet where id = ${wallet.id} for update nowait`;
    expect(row.id).toBe(wallet.id);
  });

  test('esperar o lock além de DB_LOCK_TIMEOUT_MS vira TransientInfrastructureError (D21)', async () => {
    const wallet = await openWallet('10.00');
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));

    const holder = other.begin(async (sql) => {
      await sql`select id from wallet where id = ${wallet.id} for update`;
      locked();
      await released;
    });
    await lockTaken;

    const error = await caught(() => uow(200).run((tx) => tx.wallets.lockById(wallet.id)));
    release();
    await holder;

    expect(error).toBeInstanceOf(TransientInfrastructureError);
    expect(((error as Error).cause as { code?: string }).code).toBe('55P03');
  });

  test('SET LOCAL de D21 vale só dentro da transação', async () => {
    const settings = await uow(1234).run(async () =>
      currentEm!.execute(
        `select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement,
                current_setting('idle_in_transaction_session_timeout') as idle,
                current_setting('transaction_isolation') as isolation`,
      ),
    );
    expect(settings[0]).toEqual({ lock: '1234ms', statement: '5s', idle: '10s', isolation: 'read committed' });
  });

  test('os timeouts não vazam para a conexão depois do commit', async () => {
    const single = await initOrm(1);
    try {
      const firstPid = await uow(1234, single).run(() => backendPid());
      const after = await uow(2000, single).readSnapshot(async () => {
        expect(await backendPid()).toBe(firstPid); // mesma conexão nas duas transações
        return currentEm!.execute(
          `select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement,
                  current_setting('idle_in_transaction_session_timeout') as idle`,
        );
      });
      // readSnapshot aplica statement e idle (D21), mas não lock: '0' prova que o 1234ms do run não ficou
      expect(after[0]).toEqual({ lock: '0', statement: '5s', idle: '10s' });
    } finally {
      await single.close(true);
    }
  });

  test('wallet duplicada vira UniqueViolationError com a constraint (SCHEMA 5)', async () => {
    const wallet = await openWallet('0.00');
    const twin = Wallet.open({
      id: randomUUID(),
      playerId: wallet.playerId,
      initialBalance: brl('0.00'),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      at,
    }).wallet;

    const error = await caught(() => uow().run((tx) => tx.wallets.insert(twin)));

    expect(error).toBeInstanceOf(UniqueViolationError);
    expect((error as UniqueViolationError).constraint).toBe('wallet_player_currency_uq');
  });

  test('update com version errada lança StaleWalletVersionError e não grava', async () => {
    const opened = await openWallet('10.00');

    const error = await caught(() =>
      uow().run(async (tx) => {
        const wallet = (await tx.wallets.lockById(opened.id))!;
        wallet.credit(brl('1.00'), randomUUID(), randomUUID(), at);
        await tx.wallets.update(wallet, 7);
      }),
    );

    expect(error).toBeInstanceOf(StaleWalletVersionError);
    const wallet = (await uow().run((tx) => tx.wallets.findById(opened.id)))!;
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    expect(wallet.version).toBe(1);
  });

  test('saldo alterado sem lançamento falha no COMMIT, sem tradução (D53)', async () => {
    const opened = await openWallet('10.00');

    let updatedInsideWork = false;
    const error = await caught(() =>
      uow().run(async (tx) => {
        const wallet = (await tx.wallets.lockById(opened.id))!;
        wallet.credit(brl('5.00'), randomUUID(), randomUUID(), at); // lançamento descartado de propósito
        await tx.wallets.update(wallet, 1);
        updatedInsideWork = true;
      }),
    );

    expect(updatedInsideWork).toBe(true); // o UPDATE passou: quem recusou foi o COMMIT

    expect(error).not.toBeInstanceOf(UniqueViolationError);
    expect(error).not.toBeInstanceOf(TransientInfrastructureError);
    expect((error as { code?: string }).code).toBe('23000');
    expect((error as { constraint?: string }).constraint).toBe('wallet_ledger_match');

    const wallet = (await uow().run((tx) => tx.wallets.findById(opened.id)))!;
    expect(wallet.balance.toJSON().amount).toBe('10.00');
    await assertAllWalletsConsistent(db);
  });

  test('conexão derrubada no meio da transação vira TransientInfrastructureError', async () => {
    const opened = await openWallet('10.00');

    await withDisposableOrm(async (disposable) => {
      const error = await caught(() =>
        uow(2000, disposable).run(async (tx) => {
          const pid = await backendPid();
          await other`select pg_terminate_backend(${pid})`;
          await tx.wallets.lockById(opened.id);
        }),
      );

      expect(error).toBeInstanceOf(TransientInfrastructureError);
    });
  });

  test('conexão derrubada antes do COMMIT vira TransientInfrastructureError (a tradução cobre o COMMIT)', async () => {
    const opened = await openWallet('10.00');
    let workFinished = false;

    await withDisposableOrm(async (disposable) => {
      const error = await caught(() =>
        uow(2000, disposable).run(async (tx) => {
          await tx.wallets.lockById(opened.id);
          const pid = await backendPid();
          await other`select pg_terminate_backend(${pid})`;
          workFinished = true;
        }),
      );

      expect(workFinished).toBe(true); // nenhuma query do work falhou: o erro veio do COMMIT
      expect(error).toBeInstanceOf(TransientInfrastructureError);
    });
  });

  test('erro dentro do work desfaz tudo', async () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: brl('0.00'),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      at,
    }).wallet;

    await caught(() =>
      uow().run(async (tx) => {
        await tx.wallets.insert(wallet);
        throw new Error('falha do use case');
      }),
    );

    expect(await uow().run((tx) => tx.wallets.findById(wallet.id))).toBeUndefined();
  });

  test('readSnapshot lê em REPEATABLE READ e recusa escrita (D22)', async () => {
    const opened = await openWallet('10.00');

    const isolation = await uow().readSnapshot(async (tx) => {
      await tx.wallets.findById(opened.id);
      return currentEm!.execute(
        `select current_setting('transaction_isolation') as isolation,
                current_setting('transaction_read_only') as read_only`,
      );
    });
    expect(isolation[0]).toEqual({ isolation: 'repeatable read', read_only: 'on' });

    const fresh = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: brl('0.00'),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      at,
    }).wallet;
    const error = await caught(() => uow().readSnapshot((tx) => tx.wallets.insert(fresh)));
    expect((error as { code?: string }).code).toBe('25006');
  });
});

describe('translateDbError (SCHEMA 5)', () => {
  const pgError = (fields: { code?: string; constraint?: string; message?: string }) =>
    Object.assign(new Error(fields.message ?? 'erro do driver'), fields);

  test.each(['55P03', '40P01', '57014', '57P01', '57P02', '57P03', '25P03', '08006', '08001'])(
    'SQLSTATE %s é transitório',
    (code) => {
      expect(translateDbError(pgError({ code }))).toBeInstanceOf(TransientInfrastructureError);
    },
  );

  test.each(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'])(
    'falha de socket %s é transitória',
    (code) => {
      expect(translateDbError(pgError({ code }))).toBeInstanceOf(TransientInfrastructureError);
    },
  );

  test.each(['Connection terminated unexpectedly', 'Client has encountered a connection error and is not queryable'])(
    'conexão perdida sem code ("%s") é transitória',
    (message) => {
      expect(translateDbError(pgError({ message }))).toBeInstanceOf(TransientInfrastructureError);
    },
  );

  test.each(['23514', '23503', '23000', '25006'])('SQLSTATE %s passa sem tradução (bug)', (code) => {
    const original = pgError({ code });
    expect(translateDbError(original)).toBe(original);
  });

  test('23505 de constraint fora da lista passa sem tradução', () => {
    const original = pgError({ code: '23505', constraint: 'outra_uq' });
    expect(translateDbError(original)).toBe(original);
  });
});
