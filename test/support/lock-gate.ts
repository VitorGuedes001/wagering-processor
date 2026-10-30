import type { SQL } from 'bun';
import type { TestDatabase } from './database';
import { eventually } from './eventually';

export interface WalletLockGate {
  readonly walletId: string;
  /**
   * Aguarda até que exatamente `expectedCount` transações estejam bloqueadas
   * disputando o lock desta wallet em `pg_stat_activity`.
   */
  waitForWaiters(expectedCount: number, options?: { timeoutMs?: number }): Promise<number>;
  /** Consulta a contagem instantânea de transações bloqueadas por Lock nesta base. */
  countWaiters(): Promise<number>;
  /** Libera o lock commitando a transação da conexão dedicada. */
  release(): Promise<void>;
  /** Aborta a transação da conexão dedicada. */
  rollback(): Promise<void>;
}

/**
 * Portão de lock para forçar contenção determinística de concorrência.
 * Trava a wallet numa conexão própria com `SELECT ... FOR UPDATE`, permitindo disparar N requisições,
 * esperar que todas apareçam bloqueadas em `pg_stat_activity` e só então soltar.
 */
export async function holdWalletLock(
  db: TestDatabase,
  walletId: string,
): Promise<WalletLockGate> {
  const conn: SQL = await db.connect();
  let released = false;

  await conn.unsafe('BEGIN');
  // Trava a linha da wallet
  await conn.unsafe('SELECT id FROM wallet WHERE id = $1 FOR UPDATE', [walletId]);

  const gate: WalletLockGate = {
    walletId,

    async countWaiters(): Promise<number> {
      const rows = await db.sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = ${db.name}
          AND wait_event_type = 'Lock'
          AND state = 'active'
          AND pid <> pg_backend_pid()
      `;
      return rows[0]?.count ?? 0;
    },

    async waitForWaiters(
      expectedCount: number,
      options: { timeoutMs?: number } = {},
    ): Promise<number> {
      const timeoutMs = options.timeoutMs ?? 10_000;
      return await eventually(
        async () => {
          const current = await gate.countWaiters();
          if (current < expectedCount) {
            throw new Error(
              `Aguardando ${expectedCount} transações bloqueadas no lock da wallet ${walletId}, mas há ${current}`,
            );
          }
          return current;
        },
        { timeoutMs, intervalMs: 25 },
      );
    },

    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await conn.unsafe('COMMIT');
      } finally {
        await conn.close().catch(() => {});
      }
    },

    async rollback(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await conn.unsafe('ROLLBACK');
      } finally {
        await conn.close().catch(() => {});
      }
    },
  };

  return gate;
}
