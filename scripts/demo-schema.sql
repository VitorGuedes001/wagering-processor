-- Demonstração das garantias do schema da onda 1 (docs/ONDA-1.md §3.3).
-- Cada bloco tenta gravar um estado proibido por SQL cru e é desfeito: nada fica no banco.
--
--   docker exec -i wagering-postgres psql -U wagering -d wagering < scripts/demo-schema.sql

\set VERBOSITY verbose
\echo '── 1. Saldo negativo (restrição 9: não-negatividade no schema)'
BEGIN;
INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
VALUES (gen_random_uuid(), gen_random_uuid(), 'BRL', -1.00, 1, now(), now());
ROLLBACK;

\echo '── 2. Mudar o saldo sem lançamento no ledger (barrado no COMMIT, trigger deferred)'
BEGIN;
INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), 'BRL', 0.00, 1, now(), now());
UPDATE wallet SET balance = 50.00, version = 2 WHERE id = '00000000-0000-0000-0000-0000000000a1';
COMMIT;

\echo '── 3. Mudar o saldo sem subir a version (lost update)'
BEGIN;
INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000000a2', gen_random_uuid(), 'BRL', 0.00, 1, now(), now());
UPDATE wallet SET balance = 50.00 WHERE id = '00000000-0000-0000-0000-0000000000a2';
ROLLBACK;

\echo '── 4. Abertura válida (wallet + OPENING + lançamento), depois tentar reescrever o ledger'
BEGIN;
INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000b3', 'BRL', 100.00, 1, now(), now());
INSERT INTO wager_transaction (id, wallet_id, player_id, kind, status, amount, currency,
  balance_after, created_at, updated_at, processed_at)
VALUES ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a3',
  '00000000-0000-0000-0000-0000000000b3', 'OPENING', 'PROCESSED', 100.00, 'BRL', 100.00, now(), now(), now());
INSERT INTO wallet_ledger_entry (id, wallet_id, transaction_id, wallet_version, direction, amount,
  currency, balance_before, balance_after, created_at)
VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000c3',
  1, 'CREDIT', 100.00, 'BRL', 0.00, 100.00, now());
SELECT 'abertura válida aceita: saldo ' || balance || ', version ' || version AS ok FROM wallet
 WHERE id = '00000000-0000-0000-0000-0000000000a3';
UPDATE wallet_ledger_entry SET amount = 1000.00 WHERE wallet_id = '00000000-0000-0000-0000-0000000000a3';
ROLLBACK;

\echo '── 5. Mesma idempotency key do mesmo provedor duas vezes (idempotência no banco, não em memória)'
BEGIN;
INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000b5', 'BRL', 0.00, 1, now(), now());
INSERT INTO wager_transaction (id, wallet_id, player_id, kind, status, amount, currency, provider_id,
  external_transaction_id, idempotency_key, payload_hash, round_id, game_id, failure_code, balance_after,
  created_at, updated_at)
SELECT gen_random_uuid(), '00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000b5',
  'BET', 'REJECTED', 25.00, 'BRL', 'provider-a', 'ext-' || n, 'provider-a:mesma-key', repeat('a', 64),
  'round-1', 'game-1', 'INSUFFICIENT_FUNDS', 0.00, now(), now()
FROM generate_series(1, 2) AS n;
ROLLBACK;

\echo '── fim: nada foi gravado'
SELECT count(*) AS wallets_da_demo FROM wallet WHERE id::text LIKE '00000000-0000-0000-0000-0000000000a%';
