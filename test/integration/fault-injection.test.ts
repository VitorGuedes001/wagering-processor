import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertAllWalletsConsistent } from '../support/invariants';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const WORKER_SCRIPT = resolve(import.meta.dir, '../support/uow-fault-worker.ts');

describe('I-04: Injeção de Falhas e Atomicidade de Transação (TESTES §3.4, §4.2; D38)', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db);
  });

  afterAll(async () => {
    await db.drop();
  });

  test('I-04: FAULT_POINT=uow.before-commit em processo: nada de wallet, transação, ledger, inbox ou outbox persiste', async () => {
    const walletId = randomUUID();
    const txId = randomUUID();
    const ledgerId = randomUUID();
    const messageId = `msg-${randomUUID()}`;
    const eventId = randomUUID();

    const proc = Bun.spawn(['bun', WORKER_SCRIPT], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DB_NAME: db.name,
        FAULT_POINT: 'uow.before-commit',
        TARGET_WALLET_ID: walletId,
        TARGET_TX_ID: txId,
        TARGET_LEDGER_ID: ledgerId,
        TARGET_MESSAGE_ID: messageId,
        TARGET_EVENT_ID: eventId,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    // O processo deve ter sido abortado com sinal/erro devido ao SIGKILL
    expect(exitCode).not.toBe(0);

    // Verifica que NENHUMA das 5 tabelas gravou qualquer registro (atomicidade total da UoW)
    const [wallets] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wallet WHERE id = ${walletId}
    `;
    expect(wallets?.count).toBe(0);

    const [transactions] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wager_transaction WHERE id = ${txId}
    `;
    expect(transactions?.count).toBe(0);

    const [ledgerEntries] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wallet_ledger_entry WHERE id = ${ledgerId}
    `;
    expect(ledgerEntries?.count).toBe(0);

    const [inboxMessages] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM inbox_message WHERE message_id = ${messageId}
    `;
    expect(inboxMessages?.count).toBe(0);

    const [outboxMessages] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM outbox_message WHERE id = ${eventId}
    `;
    expect(outboxMessages?.count).toBe(0);
  });

  test('Controle positivo: sem FAULT_POINT, a transação da UoW persiste atomicamente todas as entidades', async () => {
    const walletId = randomUUID();
    const txId = randomUUID();
    const ledgerId = randomUUID();
    const messageId = `msg-${randomUUID()}`;
    const eventId = randomUUID();

    const proc = Bun.spawn(['bun', WORKER_SCRIPT], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DB_NAME: db.name,
        FAULT_POINT: undefined,
        TARGET_WALLET_ID: walletId,
        TARGET_TX_ID: txId,
        TARGET_LEDGER_ID: ledgerId,
        TARGET_MESSAGE_ID: messageId,
        TARGET_EVENT_ID: eventId,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const errText = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      console.error('Positive control worker failed:', errText);
    }
    expect(exitCode).toBe(0);

    const [wallets] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wallet WHERE id = ${walletId}
    `;
    expect(wallets?.count).toBe(1);

    const [transactions] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wager_transaction WHERE id = ${txId}
    `;
    expect(transactions?.count).toBe(1);

    const [ledgerEntries] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM wallet_ledger_entry WHERE id = ${ledgerId}
    `;
    expect(ledgerEntries?.count).toBe(1);

    const [inboxMessages] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM inbox_message WHERE message_id = ${messageId}
    `;
    expect(inboxMessages?.count).toBe(1);

    const [outboxMessages] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM outbox_message WHERE id = ${eventId}
    `;
    expect(outboxMessages?.count).toBe(1);
  });
});
