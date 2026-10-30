import type { SQL } from 'bun';
import type { TestDatabase } from './database';

function getSql(dbOrSql: TestDatabase | SQL): SQL {
  return 'sql' in dbOrSql ? dbOrSql.sql : dbOrSql;
}

/**
 * Invariante final de todos os testes de integração e concorrência.
 * Roda em SQL puro, independente do código da aplicação:
 *   1. para cada wallet, `balance = Σ(CREDIT) - Σ(DEBIT)` do ledger;
 *   2. a cadeia `balance_before = lag(balance_after)` (ou 0 no primeiro lançamento) não tem buraco
 *      e `wallet_version` é estritamente crescente (sem exigir contiguidade 1..N, pois wallet aberta
 *      com saldo zero tem `version = 1` sem lançamento e recebe o 1º lançamento em `wallet_version = 2`);
 *   3. o último `wallet_version` do ledger é igual a `wallet.version`, salvo wallet nova com saldo zero;
 *   4. nenhuma transação `REFUND`/`ROLLBACK` `PROCESSED` duplicada por referência;
 *   5. toda transação `PROCESSED` que move saldo (`kind <> 'LOSS'`) tem exatamente 1 lançamento,
 *      e nenhuma outra tem.
 */
export async function assertAllWalletsConsistent(dbOrSql: TestDatabase | SQL): Promise<void> {
  const sql = getSql(dbOrSql);
  const violations: string[] = [];

  // 1. wallet.balance = Σ(CREDIT) - Σ(DEBIT)
  const balanceMismatches = await sql<
    Array<{ wallet_id: string; stored_balance: string; ledger_balance: string }>
  >`
    SELECT
      w.id::text AS wallet_id,
      w.balance::text AS stored_balance,
      COALESCE(
        SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),
        0.00
      )::numeric(19,2)::text AS ledger_balance
    FROM wallet w
    LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
    GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(
      SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END),
      0.00
    )
  `;
  if (balanceMismatches.length > 0) {
    violations.push(
      `[1] Divergência entre wallet.balance e Σ(ledger): ${JSON.stringify(balanceMismatches)}`,
    );
  }

  // 2. Cadeia sem buraco: balance_before = lag(balance_after, 0) e wallet_version estritamente crescente
  const chainGaps = await sql<
    Array<{
      wallet_id: string;
      entry_id: string;
      wallet_version: number;
      prev_version: number | null;
      balance_before: string;
      expected_before: string;
      balance_after: string;
    }>
  >`
    WITH ordered AS (
      SELECT
        id::text AS entry_id,
        wallet_id::text AS wallet_id,
        wallet_version,
        LAG(wallet_version) OVER (
          PARTITION BY wallet_id
          ORDER BY created_at ASC, wallet_version ASC, id ASC
        )::int AS prev_version,
        balance_before,
        COALESCE(
          LAG(balance_after) OVER (
            PARTITION BY wallet_id
            ORDER BY wallet_version ASC, created_at ASC, id ASC
          ),
          0.00
        )::numeric(19,2) AS expected_before,
        balance_after,
        direction,
        amount
      FROM wallet_ledger_entry
    )
    SELECT
      wallet_id,
      entry_id,
      wallet_version,
      prev_version,
      balance_before::text AS balance_before,
      expected_before::text AS expected_before,
      balance_after::text AS balance_after
    FROM ordered
    WHERE wallet_version < 1
       OR (prev_version IS NOT NULL AND wallet_version <= prev_version)
       OR balance_before <> expected_before
       OR balance_after <> (balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)
  `;
  if (chainGaps.length > 0) {
    violations.push(`[2] Cadeia de ledger quebrada: ${JSON.stringify(chainGaps)}`);
  }

  // 3. Último wallet_version do ledger == wallet.version, salvo wallet nova com saldo zero
  const versionMismatches = await sql<
    Array<{
      wallet_id: string;
      wallet_version: number;
      wallet_balance: string;
      entry_count: number;
      max_ledger_version: number | null;
    }>
  >`
    SELECT
      w.id::text AS wallet_id,
      w.version AS wallet_version,
      w.balance::text AS wallet_balance,
      COUNT(l.id)::int AS entry_count,
      MAX(l.wallet_version)::int AS max_ledger_version
    FROM wallet w
    LEFT JOIN wallet_ledger_entry l ON l.wallet_id = w.id
    GROUP BY w.id, w.version, w.balance
    HAVING NOT (
      (COUNT(l.id) = 0 AND w.version = 1 AND w.balance = 0)
      OR (COUNT(l.id) > 0 AND MAX(l.wallet_version) = w.version)
    )
  `;
  if (versionMismatches.length > 0) {
    violations.push(
      `[3] Divergência entre wallet.version e MAX(ledger.wallet_version): ${JSON.stringify(versionMismatches)}`,
    );
  }

  // 4. Nenhuma transação REFUND/ROLLBACK PROCESSED duplicada por referência
  const duplicateReversals = await sql<
    Array<{ reference_transaction_id: string; reversal_count: number }>
  >`
    SELECT
      reference_transaction_id::text AS reference_transaction_id,
      COUNT(*)::int AS reversal_count
    FROM wager_transaction
    WHERE kind IN ('REFUND', 'ROLLBACK')
      AND status = 'PROCESSED'
    GROUP BY reference_transaction_id
    HAVING COUNT(*) > 1 OR reference_transaction_id IS NULL
  `;
  if (duplicateReversals.length > 0) {
    violations.push(
      `[4] Reversão PROCESSED duplicada ou sem referência: ${JSON.stringify(duplicateReversals)}`,
    );
  }

  // 5. Toda transação PROCESSED que move saldo (kind <> 'LOSS') tem exatamente 1 lançamento,
  // e nenhuma outra transação (LOSS ou status <> 'PROCESSED') tem lançamento.
  const txLedgerMismatches = await sql<
    Array<{
      tx_id: string;
      kind: string;
      status: string;
      entry_count: number;
      expected_count: number;
    }>
  >`
    SELECT
      t.id::text AS tx_id,
      t.kind,
      t.status,
      COUNT(l.id)::int AS entry_count,
      (CASE WHEN t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN 1 ELSE 0 END)::int AS expected_count
    FROM wager_transaction t
    LEFT JOIN wallet_ledger_entry l ON l.transaction_id = t.id
    GROUP BY t.id, t.kind, t.status
    HAVING COUNT(l.id) <> (CASE WHEN t.status = 'PROCESSED' AND t.kind <> 'LOSS' THEN 1 ELSE 0 END)
  `;
  if (txLedgerMismatches.length > 0) {
    violations.push(
      `[5] Transação com contagem inválida de lançamentos no ledger: ${JSON.stringify(txLedgerMismatches)}`,
    );
  }

  if (violations.length > 0) {
    throw new Error(
      `Violação de invariantes financeiras (D40):\n  ${violations.join('\n  ')}`,
    );
  }
}
