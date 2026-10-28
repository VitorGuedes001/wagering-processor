import { randomUUID } from 'node:crypto';
import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { assertAllWalletsConsistent } from '../support/invariants';

const VALID_HASH_A = 'a'.repeat(64);
const VALID_HASH_B = 'b'.repeat(64);

interface PgErrorShape {
  errno?: string;
  code?: string;
  constraint?: string;
  message?: string;
}

/**
 * Executa `fn` e verifica que o PostgreSQL rejeita a operação com o `SQLSTATE`
 * esperado (`23514` CHECK, `23505` UNIQUE, `23503` FK, `23000` trigger, `55P03` lock_timeout)
 * e, quando informado, com o nome da constraint ou trigger.
 */
async function expectPgError(
  fn: () => Promise<unknown>,
  expectedSqlState: string,
  expectedConstraintOrTrigger?: string,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }

  if (caught === undefined) {
    throw new Error(
      `Esperava erro PostgreSQL ${expectedSqlState}${
        expectedConstraintOrTrigger ? ` (${expectedConstraintOrTrigger})` : ''
      }, mas a query executou sem erro.`,
    );
  }

  const pgErr = caught as PgErrorShape;
  const actualState = pgErr.errno ?? pgErr.code;
  expect(actualState).toBe(expectedSqlState);

  if (expectedConstraintOrTrigger !== undefined) {
    const constraint = pgErr.constraint ?? '';
    const message = pgErr.message ?? '';
    const matches =
      constraint === expectedConstraintOrTrigger || message.includes(expectedConstraintOrTrigger);
    if (!matches) {
      throw new Error(
        `Esperava constraint/trigger "${expectedConstraintOrTrigger}", mas recebeu constraint="${constraint}" message="${message}"`,
      );
    }
  }
}

/**
 * Executa um bloco dentro de `BEGIN ... COMMIT` na mesma conexão (`max: 1`).
 * Se qualquer statement ou o próprio `COMMIT` (constraint trigger deferred) falhar,
 * garante `ROLLBACK` limpo da sessão antes de relançar o erro.
 */
async function inTx<T>(conn: SQL, work: (conn: SQL) => Promise<T>): Promise<T> {
  await conn.unsafe('BEGIN');
  try {
    const result = await work(conn);
    await conn.unsafe('COMMIT');
    return result;
  } catch (err) {
    try {
      await conn.unsafe('ROLLBACK');
    } catch {
      // Se o erro ocorreu no COMMIT de um trigger deferred, o Postgres já encerrou a transação.
    }
    throw err;
  }
}

async function insertZeroWallet(
  conn: SQL,
  overrides: { id?: string; playerId?: string; currency?: string } = {},
): Promise<{ id: string; playerId: string; currency: string }> {
  const id = overrides.id ?? randomUUID();
  const playerId = overrides.playerId ?? randomUUID();
  const currency = overrides.currency ?? 'BRL';

  await inTx(conn, async (tx) => {
    await tx`
      INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${id}, ${playerId}, ${currency}, 0.00, 1, now(), now())
    `;
  });

  return { id, playerId, currency };
}

async function insertFundedWallet(
  conn: SQL,
  amount = '100.00',
  currency = 'BRL',
): Promise<{
  walletId: string;
  playerId: string;
  currency: string;
  openingTxId: string;
  openingEntryId: string;
}> {
  const walletId = randomUUID();
  const playerId = randomUUID();
  const openingTxId = randomUUID();
  const openingEntryId = randomUUID();

  await inTx(conn, async (tx) => {
    await tx`
      INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${walletId}, ${playerId}, ${currency}, ${amount}, 1, now(), now())
    `;
    await tx`
      INSERT INTO wager_transaction (
        id, wallet_id, player_id, kind, status, amount, currency,
        balance_after, created_at, updated_at, processed_at
      )
      VALUES (
        ${openingTxId}, ${walletId}, ${playerId}, 'OPENING', 'PROCESSED', ${amount}, ${currency},
        ${amount}, now(), now(), now()
      )
    `;
    await tx`
      INSERT INTO wallet_ledger_entry (
        id, wallet_id, transaction_id, wallet_version, direction,
        amount, currency, balance_before, balance_after, created_at
      )
      VALUES (
        ${openingEntryId}, ${walletId}, ${openingTxId}, 1, 'CREDIT',
        ${amount}, ${currency}, 0.00, ${amount}, now()
      )
    `;
  });

  return { walletId, playerId, currency, openingTxId, openingEntryId };
}

async function applyProcessedBet(
  conn: SQL,
  params: {
    walletId: string;
    playerId: string;
    currency?: string;
    amount: string;
    balanceBefore: string;
    balanceAfter: string;
    nextVersion: number;
    providerId?: string;
    externalTransactionId?: string;
    idempotencyKey?: string;
    payloadHash?: string;
    roundId?: string;
    gameId?: string;
  },
): Promise<{ txId: string; entryId: string; externalTransactionId: string; idempotencyKey: string }> {
  const txId = randomUUID();
  const entryId = randomUUID();
  const currency = params.currency ?? 'BRL';
  const providerId = params.providerId ?? 'provider-a';
  const externalTransactionId = params.externalTransactionId ?? `ext-${txId.slice(0, 8)}`;
  const idempotencyKey = params.idempotencyKey ?? `${providerId}:${externalTransactionId}`;
  const payloadHash = params.payloadHash ?? VALID_HASH_A;
  const roundId = params.roundId ?? 'round-1';
  const gameId = params.gameId ?? 'fortune-chimp';

  await inTx(conn, async (tx) => {
    await tx`
      INSERT INTO wager_transaction (
        id, wallet_id, player_id, kind, status, amount, currency,
        provider_id, external_transaction_id, idempotency_key, payload_hash,
        round_id, game_id, balance_after, created_at, updated_at, processed_at
      )
      VALUES (
        ${txId}, ${params.walletId}, ${params.playerId}, 'BET', 'PROCESSED', ${params.amount}, ${currency},
        ${providerId}, ${externalTransactionId}, ${idempotencyKey}, ${payloadHash},
        ${roundId}, ${gameId}, ${params.balanceAfter}, now(), now(), now()
      )
    `;
    await tx`
      INSERT INTO wallet_ledger_entry (
        id, wallet_id, transaction_id, wallet_version, direction,
        amount, currency, balance_before, balance_after, created_at
      )
      VALUES (
        ${entryId}, ${params.walletId}, ${txId}, ${params.nextVersion}, 'DEBIT',
        ${params.amount}, ${currency}, ${params.balanceBefore}, ${params.balanceAfter}, now()
      )
    `;
    await tx`
      UPDATE wallet
         SET balance = ${params.balanceAfter},
             version = ${params.nextVersion},
             updated_at = now()
       WHERE id = ${params.walletId}
    `;
  });

  return { txId, entryId, externalTransactionId, idempotencyKey };
}

describe('I-01 — Reversibilidade das migrations (up → down → up)', () => {
  test('I-01: aplica migrations em banco vazio, reverte até zero sem deixar tabelas/funções e reaplica', async () => {
    const emptyDb = await createTestDatabase({ fromTemplate: false });
    try {
      const expectedTables = [
        'inbox_message',
        'outbox_message',
        'wager_transaction',
        'wallet',
        'wallet_ledger_entry',
      ];

      // 1. up
      await emptyDb.migrateUp();
      const afterFirstUp = await emptyDb.sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('wallet', 'wager_transaction', 'wallet_ledger_entry', 'inbox_message', 'outbox_message')
        ORDER BY table_name
      `;
      expect(afterFirstUp.map((r) => r.table_name)).toEqual(expectedTables);

      // 2. down até zero
      await emptyDb.migrateDownToZero();
      const afterDown = await emptyDb.sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('wallet', 'wager_transaction', 'wallet_ledger_entry', 'inbox_message', 'outbox_message')
      `;
      expect([...afterDown]).toEqual([]);

      const leftoverFunctions = await emptyDb.sql<Array<{ proname: string }>>`
        SELECT p.proname
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname LIKE '%_fn'
      `;
      expect([...leftoverFunctions]).toEqual([]);

      // 3. up novamente
      await emptyDb.migrateUp();
      const afterSecondUp = await emptyDb.sql<Array<{ table_name: string }>>`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('wallet', 'wager_transaction', 'wallet_ledger_entry', 'inbox_message', 'outbox_message')
        ORDER BY table_name
      `;
      expect(afterSecondUp.map((r) => r.table_name)).toEqual(expectedTables);
    } finally {
      await emptyDb.drop();
    }
  });
});

describe('I-02 — Schema, constraints, triggers e locks por SQL cru (SCHEMA §2, §3, §9)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(async () => {
    await db.reset();
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db);
  });

  describe('Caminho feliz e triggers deferred', () => {
    test('wallet nova com saldo 0.00 e version = 1 comita sem lançamento no ledger', async () => {
      const wallet = await insertZeroWallet(db.sql);
      const rows = await db.sql<Array<{ balance: string; version: number }>>`
        SELECT balance::text AS balance, version FROM wallet WHERE id = ${wallet.id}
      `;
      expect([...rows]).toEqual([{ balance: '0.00', version: 1 }]);
    });

    test('wallet com saldo inicial > 0 + OPENING + lançamento comita e aceita ambas as ordens de UPDATE/INSERT no commit', async () => {
      const funded = await insertFundedWallet(db.sql, '100.00', 'BRL');

      // Operação 1: insere lançamento ANTES de atualizar a wallet (prova ledger_wallet_match deferred)
      await applyProcessedBet(db.sql, {
        walletId: funded.walletId,
        playerId: funded.playerId,
        amount: '25.00',
        balanceBefore: '100.00',
        balanceAfter: '75.00',
        nextVersion: 2,
      });

      // Operação 2: atualiza a wallet ANTES de inserir o lançamento (prova wallet_ledger_match deferred)
      const winTxId = randomUUID();
      const winEntryId = randomUUID();
      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, balance_after, created_at, updated_at, processed_at
          )
          VALUES (
            ${winTxId}, ${funded.walletId}, ${funded.playerId}, 'WIN', 'PROCESSED', 50.00, 'BRL',
            'provider-a', 'ext-win-1', 'provider-a:ext-win-1', ${VALID_HASH_B},
            'round-1', 'fortune-chimp', 125.00, now(), now(), now()
          )
        `;
        await tx`
          UPDATE wallet
             SET balance = 125.00,
                 version = 3,
                 updated_at = now()
           WHERE id = ${funded.walletId}
        `;
        await tx`
          INSERT INTO wallet_ledger_entry (
            id, wallet_id, transaction_id, wallet_version, direction,
            amount, currency, balance_before, balance_after, created_at
          )
          VALUES (
            ${winEntryId}, ${funded.walletId}, ${winTxId}, 3, 'CREDIT',
            50.00, 'BRL', 75.00, 125.00, now()
          )
        `;
      });

      const rows = await db.sql<Array<{ balance: string; version: number }>>`
        SELECT balance::text AS balance, version FROM wallet WHERE id = ${funded.walletId}
      `;
      expect([...rows]).toEqual([{ balance: '125.00', version: 3 }]);

      // Se o saldo for adulterado desligando triggers (replica), assertAllWalletsConsistent detecta
      await inTx(db.sql, async (tx) => {
        await tx.unsafe('SET LOCAL session_replication_role = replica');
        await tx`UPDATE wallet SET balance = 999.00 WHERE id = ${funded.walletId}`;
      });
      await expect(assertAllWalletsConsistent(db)).rejects.toThrow(/Violação de invariantes/);

      // Restaura saldo íntegro para o afterEach
      await inTx(db.sql, async (tx) => {
        await tx.unsafe('SET LOCAL session_replication_role = replica');
        await tx`UPDATE wallet SET balance = 125.00 WHERE id = ${funded.walletId}`;
      });
    });
  });

  describe('Violações de wallet (SCHEMA 2.1, 3, 9)', () => {
    test('CHECKs de wallet: saldo negativo, version <= 0 e formato de moeda inválido (23514)', async () => {
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
              VALUES (${randomUUID()}, ${randomUUID()}, 'BRL', -0.01, 1, now(), now())
            `;
          }),
        '23514',
        'wallet_balance_non_negative_ck',
      );

      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
              VALUES (${randomUUID()}, ${randomUUID()}, 'BRL', 0.00, 0, now(), now())
            `;
          }),
        '23514',
        'wallet_version_positive_ck',
      );

      for (const badCurrency of ['brl', 'BR', '123']) {
        await expectPgError(
          () =>
            inTx(db.sql, async (tx) => {
              await tx`
                INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
                VALUES (${randomUUID()}, ${randomUUID()}, ${badCurrency}, 0.00, 1, now(), now())
              `;
            }),
          '23514',
          'wallet_currency_format_ck',
        );
      }
    });

    test('wallet_player_currency_uq: impede duas wallets para o mesmo player_id + currency (23505)', async () => {
      const playerId = randomUUID();
      await insertZeroWallet(db.sql, { playerId, currency: 'BRL' });

      await expectPgError(
        () => insertZeroWallet(db.sql, { playerId, currency: 'BRL' }),
        '23505',
        'wallet_player_currency_uq',
      );
    });

    test('trigger wallet_version_rule: exige version = OLD.version + 1 quando e somente quando balance muda, e bloqueia mutação de identidade (23000)', async () => {
      const wallet = await insertZeroWallet(db.sql);

      // 1. Subir version sem mudar balance
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`UPDATE wallet SET version = 2 WHERE id = ${wallet.id}`;
          }),
        '23000',
        'wallet_version_rule',
      );

      // 2. Mudar balance mantendo version igual
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`UPDATE wallet SET balance = 50.00, version = 1 WHERE id = ${wallet.id}`;
          }),
        '23000',
        'wallet_version_rule',
      );

      // 3. Mudar balance pulando version (OLD.version + 2)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`UPDATE wallet SET balance = 50.00, version = 3 WHERE id = ${wallet.id}`;
          }),
        '23000',
        'wallet_version_rule',
      );

      // 4. Tentar alterar currency ou player_id
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`UPDATE wallet SET currency = 'USD' WHERE id = ${wallet.id}`;
          }),
        '23000',
        'wallet_version_rule',
      );

      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`UPDATE wallet SET player_id = ${randomUUID()} WHERE id = ${wallet.id}`;
          }),
        '23000',
        'wallet_version_rule',
      );
    });

    test('trigger deferred wallet_ledger_match: rejeita no COMMIT mudança de saldo sem lançamento correspondente (23000)', async () => {
      // 1. Criar wallet com saldo inicial > 0 sem lançamento no ledger falha no COMMIT
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
              VALUES (${randomUUID()}, ${randomUUID()}, 'BRL', 100.00, 1, now(), now())
            `;
          }),
        '23000',
        'wallet_ledger_match',
      );

      // 2. Atualizar saldo e version = version + 1 sem inserir lançamento falha no COMMIT
      const funded = await insertFundedWallet(db.sql, '100.00', 'BRL');
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              UPDATE wallet
                 SET balance = 80.00,
                     version = 2,
                     updated_at = now()
               WHERE id = ${funded.walletId}
            `;
          }),
        '23000',
        'wallet_ledger_match',
      );
    });

    test('trigger wallet_no_delete: bloqueia DELETE em wallet (23000)', async () => {
      const wallet = await insertZeroWallet(db.sql);
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`DELETE FROM wallet WHERE id = ${wallet.id}`;
          }),
        '23000',
        'wallet_no_delete',
      );
    });
  });

  describe('Violações de wager_transaction (SCHEMA 2.2, 3, 9)', () => {
    test('CHECKs de kind, status, amount (D3: só LOSS aceita 0.00) e OPENING', async () => {
      const wallet = await insertZeroWallet(db.sql);

      // wager_tx_kind_ck
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BONUS', 'PROCESSED', 10.00, 'BRL',
                'prov', 'ext-1', 'prov:ext-1', ${VALID_HASH_A},
                'r-1', 'g-1', 0.00, now(), now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_kind_ck',
      );

      // wager_tx_status_ck (balance_after e processed_at omitidos para isolar wager_tx_status_ck)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'ABORTED', 0.00, 'BRL',
                'prov', 'ext-2', 'prov:ext-2', ${VALID_HASH_A},
                'r-1', 'g-1', now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_status_ck',
      );

      // wager_tx_amount_ck: BET com 0.00 falha, LOSS com 0.00 passa
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 0.00, 'BRL',
                'prov', 'ext-3', 'prov:ext-3', ${VALID_HASH_A},
                'r-1', 'g-1', 'INSUFFICIENT_FUNDS', 0.00, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_amount_ck',
      );

      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, balance_after, created_at, updated_at, processed_at
          )
          VALUES (
            ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
            'prov', 'ext-loss-0', 'prov:ext-loss-0', ${VALID_HASH_A},
            'r-1', 'g-1', 0.00, now(), now(), now()
          )
        `;
      });

      // wager_tx_provider_fields_ck: OPENING com provider_id falha; BET sem provider_id falha
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'OPENING', 'PROCESSED', 10.00, 'BRL',
                'prov', 10.00, now(), now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_provider_fields_ck',
      );

      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                NULL, 'ext-4', 'prov:ext-4', ${VALID_HASH_A},
                'r-1', 'g-1', 'INSUFFICIENT_FUNDS', 0.00, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_provider_fields_ck',
      );

      // wager_tx_opening_processed_ck: OPENING não-PROCESSED falha
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'OPENING', 'REJECTED', 10.00, 'BRL',
                'INSUFFICIENT_FUNDS', 0.00, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_opening_processed_ck',
      );
    });

    test('CHECKs de referência, failure_code, balance_after, processed_at, agendamento e payload_hash (23514)', async () => {
      const wallet = await insertZeroWallet(db.sql);

      // wager_tx_reference_required_ck (REFUND sem reference_external_transaction_id)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, next_reference_attempt_at, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'REFUND', 'PENDING_REFERENCE', 10.00, 'BRL',
                'prov', 'ext-ref-req', 'prov:ext-ref-req', ${VALID_HASH_A},
                'r-1', 'g-1', now(), now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_reference_required_ck',
      );

      // wager_tx_reference_forbidden_ck (BET com reference_external_transaction_id)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, reference_external_transaction_id,
                failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'prov', 'ext-ref-forb', 'prov:ext-ref-forb', ${VALID_HASH_A},
                'r-1', 'g-1', 'some-ref',
                'INSUFFICIENT_FUNDS', 0.00, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_reference_forbidden_ck',
      );

      // Cria uma transação base (LOSS PROCESSED) para usar o id em testes de FK de referência
      const baseTxId = randomUUID();
      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, balance_after, created_at, updated_at, processed_at
          )
          VALUES (
            ${baseTxId}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
            'prov', 'ext-base', 'prov:ext-base', ${VALID_HASH_A},
            'r-1', 'g-1', 0.00, now(), now(), now()
          )
        `;
      });

      // wager_tx_reference_pair_ck (reference_transaction_id sem reference_external_transaction_id)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, reference_external_transaction_id, reference_transaction_id,
                balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
                'prov', 'ext-pair', 'prov:ext-pair', ${VALID_HASH_A},
                'r-1', 'g-1', NULL, ${baseTxId},
                0.00, now(), now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_reference_pair_ck',
      );

      // wager_tx_reference_not_self_ck (reference_transaction_id = id)
      const selfId = randomUUID();
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, reference_external_transaction_id, reference_transaction_id,
                balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${selfId}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
                'prov', 'ext-self', 'prov:ext-self', ${VALID_HASH_A},
                'r-1', 'g-1', 'ext-self', ${selfId},
                0.00, now(), now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_reference_not_self_ck',
      );

      // wager_tx_reference_resolved_ck (PROCESSED com reference_external_transaction_id mas sem reference_transaction_id)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, reference_external_transaction_id, reference_transaction_id,
                balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
                'prov', 'ext-unres', 'prov:ext-unres', ${VALID_HASH_A},
                'r-1', 'g-1', 'ext-base', NULL,
                0.00, now(), now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_reference_resolved_ck',
      );

      // wager_tx_failure_code_ck (REJECTED sem failure_code)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'prov', 'ext-fc', 'prov:ext-fc', ${VALID_HASH_A},
                'r-1', 'g-1', NULL, 0.00, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_failure_code_ck',
      );

      // wager_tx_balance_after_ck (REJECTED sem balance_after)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'prov', 'ext-ba', 'prov:ext-ba', ${VALID_HASH_A},
                'r-1', 'g-1', 'INSUFFICIENT_FUNDS', NULL, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_balance_after_ck',
      );

      // wager_tx_balance_after_non_negative_ck (balance_after < 0)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'prov', 'ext-baneg', 'prov:ext-baneg', ${VALID_HASH_A},
                'r-1', 'g-1', 'INSUFFICIENT_FUNDS', -0.01, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_balance_after_non_negative_ck',
      );

      // wager_tx_processed_at_ck (PROCESSED sem processed_at)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
                'prov', 'ext-pa', 'prov:ext-pa', ${VALID_HASH_A},
                'r-1', 'g-1', 0.00, now(), now(), NULL
              )
            `;
          }),
        '23514',
        'wager_tx_processed_at_ck',
      );

      // wager_tx_reference_schedule_ck (PENDING_REFERENCE sem next_reference_attempt_at)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, reference_external_transaction_id,
                next_reference_attempt_at, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'REFUND', 'PENDING_REFERENCE', 10.00, 'BRL',
                'prov', 'ext-sched', 'prov:ext-sched', ${VALID_HASH_A},
                'r-1', 'g-1', 'missing-bet',
                NULL, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_reference_schedule_ck',
      );

      // wager_tx_reference_attempts_ck (reference_attempts < 0)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, reference_attempts,
                failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'prov', 'ext-att', 'prov:ext-att', ${VALID_HASH_A},
                'r-1', 'g-1', -1,
                'INSUFFICIENT_FUNDS', 0.00, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_reference_attempts_ck',
      );

      // wager_tx_payload_hash_format_ck (hash fora de ^[0-9a-f]{64}$)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${wallet.id}, ${wallet.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'prov', 'ext-hash', 'prov:ext-hash', 'NOT_A_VALID_SHA256_HEX',
                'r-1', 'g-1', 'INSUFFICIENT_FUNDS', 0.00, now(), now()
              )
            `;
          }),
        '23514',
        'wager_tx_payload_hash_format_ck',
      );
    });

    test('índices únicos de wager_transaction: idempotency_key, external_transaction_id, single_reversal e single_opening (23505)', async () => {
      const funded = await insertFundedWallet(db.sql, '100.00', 'BRL');
      const bet = await applyProcessedBet(db.sql, {
        walletId: funded.walletId,
        playerId: funded.playerId,
        amount: '25.00',
        balanceBefore: '100.00',
        balanceAfter: '75.00',
        nextVersion: 2,
        providerId: 'provider-a',
        externalTransactionId: 'bet-100',
        idempotencyKey: 'provider-a:bet-100',
      });

      // 1. wager_tx_idempotency_uq
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${funded.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'provider-a', 'bet-other-ext', ${bet.idempotencyKey}, ${VALID_HASH_A},
                'round-1', 'fortune-chimp', 'INSUFFICIENT_FUNDS', 75.00, now(), now()
              )
            `;
          }),
        '23505',
        'wager_tx_idempotency_uq',
      );

      // 2. wager_tx_external_uq
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, failure_code, balance_after, created_at, updated_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${funded.playerId}, 'BET', 'REJECTED', 10.00, 'BRL',
                'provider-a', ${bet.externalTransactionId}, 'provider-a:other-key', ${VALID_HASH_A},
                'round-1', 'fortune-chimp', 'INSUFFICIENT_FUNDS', 75.00, now(), now()
              )
            `;
          }),
        '23505',
        'wager_tx_external_uq',
      );

      // 3. wager_tx_single_reversal_uq: reversão REJECTED não ocupa a vaga, mas a 2ª PROCESSED falha
      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, reference_external_transaction_id, reference_transaction_id,
            failure_code, balance_after, created_at, updated_at
          )
          VALUES (
            ${randomUUID()}, ${funded.walletId}, ${funded.playerId}, 'REFUND', 'REJECTED', 10.00, 'BRL',
            'provider-a', 'refund-rej-1', 'provider-a:refund-rej-1', ${VALID_HASH_A},
            'round-1', 'fortune-chimp', ${bet.externalTransactionId}, ${bet.txId},
            'REFERENCE_AMOUNT_MISMATCH', 75.00, now(), now()
          )
        `;
      });

      // 1ª reversão PROCESSED passa
      const refundTxId = randomUUID();
      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, reference_external_transaction_id, reference_transaction_id,
            balance_after, created_at, updated_at, processed_at
          )
          VALUES (
            ${refundTxId}, ${funded.walletId}, ${funded.playerId}, 'REFUND', 'PROCESSED', 25.00, 'BRL',
            'provider-a', 'refund-ok-1', 'provider-a:refund-ok-1', ${VALID_HASH_A},
            'round-1', 'fortune-chimp', ${bet.externalTransactionId}, ${bet.txId},
            100.00, now(), now(), now()
          )
        `;
        await tx`
          INSERT INTO wallet_ledger_entry (
            id, wallet_id, transaction_id, wallet_version, direction,
            amount, currency, balance_before, balance_after, created_at
          )
          VALUES (
            ${randomUUID()}, ${funded.walletId}, ${refundTxId}, 3, 'CREDIT',
            25.00, 'BRL', 75.00, 100.00, now()
          )
        `;
        await tx`
          UPDATE wallet SET balance = 100.00, version = 3, updated_at = now()
          WHERE id = ${funded.walletId}
        `;
      });

      // 2ª reversão PROCESSED da mesma referência (mesmo que ROLLBACK) falha com 23505
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, reference_external_transaction_id, reference_transaction_id,
                balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${funded.playerId}, 'ROLLBACK', 'PROCESSED', 25.00, 'BRL',
                'provider-a', 'rollback-dup-1', 'provider-a:rollback-dup-1', ${VALID_HASH_B},
                'round-1', 'fortune-chimp', ${bet.externalTransactionId}, ${bet.txId},
                125.00, now(), now(), now()
              )
            `;
          }),
        '23505',
        'wager_tx_single_reversal_uq',
      );

      // 4. wager_tx_single_opening_uq: segunda OPENING na mesma wallet falha com 23505
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${funded.playerId}, 'OPENING', 'PROCESSED', 50.00, 'BRL',
                150.00, now(), now(), now()
              )
            `;
          }),
        '23505',
        'wager_tx_single_opening_uq',
      );
    });

    test('trigger wager_tx_guard: protege status terminal, transição inválida de PENDING_REFERENCE, colunas imutáveis e DELETE (23000)', async () => {
      const wallet = await insertZeroWallet(db.sql);
      const lossTxId = randomUUID();
      const pendingRefTxId = randomUUID();

      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, balance_after, created_at, updated_at, processed_at
          )
          VALUES (
            ${lossTxId}, ${wallet.id}, ${wallet.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
            'prov', 'ext-term', 'prov:ext-term', ${VALID_HASH_A},
            'r-1', 'g-1', 0.00, now(), now(), now()
          )
        `;
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, reference_external_transaction_id,
            next_reference_attempt_at, created_at, updated_at
          )
          VALUES (
            ${pendingRefTxId}, ${wallet.id}, ${wallet.playerId}, 'REFUND', 'PENDING_REFERENCE', 10.00, 'BRL',
            'prov', 'ext-pend', 'prov:ext-pend', ${VALID_HASH_B},
            'r-1', 'g-1', 'ext-missing',
            now(), now(), now()
          )
        `;
      });

      // 1. Alterar transação em status terminal (PROCESSED)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              UPDATE wager_transaction
                 SET status = 'REJECTED',
                     failure_code = 'INSUFFICIENT_FUNDS',
                     processed_at = NULL
               WHERE id = ${lossTxId}
            `;
          }),
        '23000',
        'wager_tx_guard',
      );

      // 2. Voltar PENDING_REFERENCE para PENDING
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              UPDATE wager_transaction
                 SET status = 'PENDING',
                     next_reference_attempt_at = NULL
               WHERE id = ${pendingRefTxId}
            `;
          }),
        '23000',
        'wager_tx_guard',
      );

      // 3. Alterar coluna imutável (amount) em transação ainda não-terminal (PENDING_REFERENCE)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              UPDATE wager_transaction
                 SET amount = 20.00
               WHERE id = ${pendingRefTxId}
            `;
          }),
        '23000',
        'wager_tx_guard',
      );

      // 4. DELETE em wager_transaction
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`DELETE FROM wager_transaction WHERE id = ${pendingRefTxId}`;
          }),
        '23000',
        'wager_tx_guard',
      );
    });
  });

  describe('Violações de wallet_ledger_entry (SCHEMA 2.3, 3, 9)', () => {
    test('CHECKs de direction, amount > 0, saldos não-negativos, aritmética e wallet_version >= 1 (23514)', async () => {
      const funded = await insertFundedWallet(db.sql, '100.00', 'BRL');

      // Transação LOSS PROCESSED auxiliar apenas para ter um transaction_id válido nos testes de CHECK
      // (a inserção no ledger vai falhar antes do commit).
      const auxTxId = randomUUID();
      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO wager_transaction (
            id, wallet_id, player_id, kind, status, amount, currency,
            provider_id, external_transaction_id, idempotency_key, payload_hash,
            round_id, game_id, balance_after, created_at, updated_at, processed_at
          )
          VALUES (
            ${auxTxId}, ${funded.walletId}, ${funded.playerId}, 'LOSS', 'PROCESSED', 0.00, 'BRL',
            'prov', 'ext-aux', 'prov:ext-aux', ${VALID_HASH_A},
            'r-1', 'g-1', 100.00, now(), now(), now()
          )
        `;
      });

      // ledger_direction_ck
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${auxTxId}, 2, 'HOLD',
                10.00, 'BRL', 100.00, 90.00, now()
              )
            `;
          }),
        '23514',
        'ledger_direction_ck',
      );

      // ledger_amount_positive_ck
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${auxTxId}, 2, 'DEBIT',
                0.00, 'BRL', 100.00, 100.00, now()
              )
            `;
          }),
        '23514',
        'ledger_amount_positive_ck',
      );

      // ledger_balances_non_negative_ck
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${auxTxId}, 2, 'DEBIT',
                110.00, 'BRL', 100.00, -10.00, now()
              )
            `;
          }),
        '23514',
        'ledger_balances_non_negative_ck',
      );

      // ledger_arithmetic_ck (100.00 - 10.00 != 95.00)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${auxTxId}, 2, 'DEBIT',
                10.00, 'BRL', 100.00, 95.00, now()
              )
            `;
          }),
        '23514',
        'ledger_arithmetic_ck',
      );

      // ledger_wallet_version_positive_ck (testado com replica role para avaliar o CHECK direto)
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx.unsafe('SET LOCAL session_replication_role = replica');
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${auxTxId}, 0, 'DEBIT',
                10.00, 'BRL', 100.00, 90.00, now()
              )
            `;
          }),
        '23514',
        'ledger_wallet_version_positive_ck',
      );
    });

    test('FKs compostas (ledger_wallet_fk e ledger_transaction_fk) e unicidades (ledger_transaction_uq e ledger_wallet_version_uq)', async () => {
      const brlWallet = await insertFundedWallet(db.sql, '100.00', 'BRL');
      const usdWallet = await insertFundedWallet(db.sql, '100.00', 'USD');

      // 1. ledger_wallet_fk: moeda diferente da wallet
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            const txId = randomUUID();
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${txId}, ${brlWallet.walletId}, ${brlWallet.playerId}, 'BET', 'PROCESSED', 10.00, 'USD',
                'prov', 'ext-fk-w', 'prov:ext-fk-w', ${VALID_HASH_A},
                'r-1', 'g-1', 90.00, now(), now(), now()
              )
            `;
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${brlWallet.walletId}, ${txId}, 2, 'DEBIT',
                10.00, 'USD', 100.00, 90.00, now()
              )
            `;
          }),
        '23503',
        'ledger_wallet_fk',
      );

      // 2. ledger_transaction_fk: lançamento na usdWallet apontando para uma nova transação da brlWallet
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            const txId = randomUUID();
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${txId}, ${brlWallet.walletId}, ${brlWallet.playerId}, 'WIN', 'PROCESSED', 10.00, 'BRL',
                'prov', 'ext-fk-tx', 'prov:ext-fk-tx', ${VALID_HASH_A},
                'r-1', 'g-1', 110.00, now(), now(), now()
              )
            `;
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${usdWallet.walletId}, ${txId}, 2, 'CREDIT',
                10.00, 'USD', 100.00, 110.00, now()
              )
            `;
          }),
        '23503',
        'ledger_transaction_fk',
      );

      // 3. ledger_transaction_uq: dois lançamentos para a mesma transaction_id
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${brlWallet.walletId}, ${brlWallet.openingTxId}, 2, 'CREDIT',
                10.00, 'BRL', 100.00, 110.00, now()
              )
            `;
          }),
        '23505',
        'ledger_transaction_uq',
      );

      // 4. ledger_wallet_version_uq: mesmo (wallet_id, wallet_version) com triggers em replica
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            const txId = randomUUID();
            await tx.unsafe('SET LOCAL session_replication_role = replica');
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${brlWallet.walletId}, ${txId}, 1, 'CREDIT',
                100.00, 'BRL', 0.00, 100.00, now()
              )
            `;
          }),
        '23505',
        'ledger_wallet_version_uq',
      );
    });

    test('triggers ledger_chain, ledger_wallet_match, ledger_immutable e ledger_no_truncate (23000)', async () => {
      const zeroWallet = await insertZeroWallet(db.sql);

      // 1. ledger_chain: primeiro lançamento com balance_before <> 0
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            const txId = randomUUID();
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${txId}, ${zeroWallet.id}, ${zeroWallet.playerId}, 'WIN', 'PROCESSED', 50.00, 'BRL',
                'prov', 'ext-ch-1', 'prov:ext-ch-1', ${VALID_HASH_A},
                'r-1', 'g-1', 100.00, now(), now(), now()
              )
            `;
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${zeroWallet.id}, ${txId}, 2, 'CREDIT',
                50.00, 'BRL', 50.00, 100.00, now()
              )
            `;
          }),
        '23000',
        'ledger_chain',
      );

      const funded = await insertFundedWallet(db.sql, '100.00', 'BRL');

      // 2. ledger_chain: lançamento seguinte com balance_before <> último balance_after
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            const txId = randomUUID();
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${txId}, ${funded.walletId}, ${funded.playerId}, 'BET', 'PROCESSED', 20.00, 'BRL',
                'prov', 'ext-ch-2', 'prov:ext-ch-2', ${VALID_HASH_A},
                'r-1', 'g-1', 60.00, now(), now(), now()
              )
            `;
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${txId}, 2, 'DEBIT',
                20.00, 'BRL', 80.00, 60.00, now()
              )
            `;
          }),
        '23000',
        'ledger_chain',
      );

      // 3. ledger_chain: wallet_version <= último wallet_version
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            const txId = randomUUID();
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${txId}, ${funded.walletId}, ${funded.playerId}, 'BET', 'PROCESSED', 20.00, 'BRL',
                'prov', 'ext-ch-3', 'prov:ext-ch-3', ${VALID_HASH_A},
                'r-1', 'g-1', 80.00, now(), now(), now()
              )
            `;
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${txId}, 1, 'DEBIT',
                20.00, 'BRL', 100.00, 80.00, now()
              )
            `;
          }),
        '23000',
        'ledger_chain',
      );

      // 4. ledger_wallet_match: inserir lançamento sem atualizar a wallet falha no COMMIT
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            const txId = randomUUID();
            await tx`
              INSERT INTO wager_transaction (
                id, wallet_id, player_id, kind, status, amount, currency,
                provider_id, external_transaction_id, idempotency_key, payload_hash,
                round_id, game_id, balance_after, created_at, updated_at, processed_at
              )
              VALUES (
                ${txId}, ${funded.walletId}, ${funded.playerId}, 'BET', 'PROCESSED', 20.00, 'BRL',
                'prov', 'ext-lwm', 'prov:ext-lwm', ${VALID_HASH_A},
                'r-1', 'g-1', 80.00, now(), now(), now()
              )
            `;
            await tx`
              INSERT INTO wallet_ledger_entry (
                id, wallet_id, transaction_id, wallet_version, direction,
                amount, currency, balance_before, balance_after, created_at
              )
              VALUES (
                ${randomUUID()}, ${funded.walletId}, ${txId}, 2, 'DEBIT',
                20.00, 'BRL', 100.00, 80.00, now()
              )
            `;
          }),
        '23000',
        'ledger_wallet_match',
      );

      // 5. ledger_immutable: UPDATE e DELETE em wallet_ledger_entry
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              UPDATE wallet_ledger_entry
                 SET amount = 99.00
               WHERE id = ${funded.openingEntryId}
            `;
          }),
        '23000',
        'ledger_immutable',
      );

      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`DELETE FROM wallet_ledger_entry WHERE id = ${funded.openingEntryId}`;
          }),
        '23000',
        'ledger_immutable',
      );

      // 6. ledger_no_truncate: TRUNCATE wallet_ledger_entry
      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx.unsafe('TRUNCATE TABLE wallet_ledger_entry CASCADE');
          }),
        '23000',
        'ledger_no_truncate',
      );
    });
  });

  describe('inbox_message, outbox_message e Locks por wallet (SCHEMA 2.4, 2.5, 4.1, 9)', () => {
    test('inbox_message PK duplicada (23505) e outbox_attempts_ck (23514)', async () => {
      await inTx(db.sql, async (tx) => {
        await tx`
          INSERT INTO inbox_message (consumer_name, message_id, payload_hash, received_at)
          VALUES ('wager-transactions-consumer', 'msg-001', ${VALID_HASH_A}, now())
        `;
      });

      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO inbox_message (consumer_name, message_id, payload_hash, received_at)
              VALUES ('wager-transactions-consumer', 'msg-001', ${VALID_HASH_B}, now())
            `;
          }),
        '23505',
      );

      await expectPgError(
        () =>
          inTx(db.sql, async (tx) => {
            await tx`
              INSERT INTO outbox_message (
                id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at
              )
              VALUES (
                ${randomUUID()}, ${randomUUID()}, 'WalletBalanceChanged', '{}'::jsonb, now(), -1, now()
              )
            `;
          }),
        '23514',
        'outbox_attempts_ck',
      );
    });

    test('locks: 2 conexões na mesma wallet bloqueiam, em wallets diferentes não bloqueiam, e lock_timeout estoura com 55P03', async () => {
      const walletA = await insertZeroWallet(db.sql);
      const walletB = await insertZeroWallet(db.sql);

      const conn1 = await db.connect();
      const conn2 = await db.connect();

      await conn1.unsafe('BEGIN');
      try {
        await conn1`SELECT id FROM wallet WHERE id = ${walletA.id} FOR UPDATE`;

        // 1. Wallets diferentes: conn2 trava walletB imediatamente sem bloquear
        await conn2.unsafe('BEGIN');
        const bLocked = await conn2<Array<{ id: string }>>`
          SELECT id FROM wallet WHERE id = ${walletB.id} FOR UPDATE
        `;
        expect(bLocked).toHaveLength(1);
        await conn2.unsafe('COMMIT');

        // 2. Mesma wallet: conn2 fica esperando em Lock até conn1 soltar
        await conn2.unsafe('BEGIN');
        let conn2Resolved = false;
        const lockWaitPromise = conn2`
          SELECT id FROM wallet WHERE id = ${walletA.id} FOR UPDATE
        `.then((res) => {
          conn2Resolved = true;
          return res;
        });

        await eventually(async () => {
          const waiters = await db.sql<Array<{ cnt: number }>>`
            SELECT COUNT(*)::int AS cnt
            FROM pg_stat_activity
            WHERE datname = ${db.name}
              AND wait_event_type = 'Lock'
          `;
          expect(waiters[0]?.cnt).toBe(1);
        });
        expect(conn2Resolved).toBe(false);

        // Solta na conn1 -> conn2 adquire o lock e conclui
        await conn1.unsafe('COMMIT');
        await lockWaitPromise;
        expect(conn2Resolved).toBe(true);
        await conn2.unsafe('COMMIT');

        // 3. lock_timeout (D21): conn1 segura walletA, conn2 com lock_timeout curto falha com 55P03
        await conn1.unsafe('BEGIN');
        await conn1`SELECT id FROM wallet WHERE id = ${walletA.id} FOR UPDATE`;

        await expectPgError(
          () =>
            inTx(conn2, async (tx) => {
              await tx.unsafe("SET LOCAL lock_timeout = '200ms'");
              await tx`SELECT id FROM wallet WHERE id = ${walletA.id} FOR UPDATE`;
            }),
          '55P03',
        );
      } finally {
        try {
          await conn1.unsafe('ROLLBACK');
        } catch {
          // ignora se já comitou
        }
        try {
          await conn2.unsafe('ROLLBACK');
        } catch {
          // ignora se já comitou
        }
      }
    });
  });
});
