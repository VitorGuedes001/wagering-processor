import { Migration } from '@mikro-orm/migrations';

/**
 * `wallet` e `wager_transaction`, com os triggers delas que não
 * dependem do ledger. Os nomes de constraint e índice são contrato:
 * a infraestrutura traduz violação por nome (`UniqueConstraint`).
 *
 * Erro de trigger: SQLSTATE 23000 com `CONSTRAINT = <nome do trigger>` (nota T14).
 */
export class Migration20261028000001_wallet_and_transactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet (
        id          uuid          PRIMARY KEY,
        player_id   uuid          NOT NULL,
        currency    char(3)       NOT NULL,
        balance     numeric(19,2) NOT NULL,
        version     integer       NOT NULL,
        created_at  timestamptz   NOT NULL,
        updated_at  timestamptz   NOT NULL,

        CONSTRAINT wallet_player_currency_uq      UNIQUE (player_id, currency),
        CONSTRAINT wallet_id_currency_uq          UNIQUE (id, currency),
        CONSTRAINT wallet_balance_non_negative_ck CHECK (balance >= 0),
        CONSTRAINT wallet_version_positive_ck     CHECK (version >= 1),
        CONSTRAINT wallet_currency_format_ck      CHECK (currency ~ '^[A-Z]{3}$')
      )
    `);

    this.addSql(`
      CREATE TABLE wager_transaction (
        id                                uuid          PRIMARY KEY,
        wallet_id                         uuid          NOT NULL REFERENCES wallet (id),
        player_id                         uuid          NOT NULL,
        kind                              varchar(16)   NOT NULL,
        status                            varchar(24)   NOT NULL,
        amount                            numeric(19,2) NOT NULL,
        currency                          char(3)       NOT NULL,
        provider_id                       varchar(128),
        external_transaction_id           varchar(128),
        idempotency_key                   varchar(256),
        payload_hash                      char(64),
        round_id                          varchar(128),
        game_id                           varchar(128),
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid          REFERENCES wager_transaction (id),
        failure_code                      varchar(64),
        balance_after                     numeric(19,2),
        reference_attempts                integer       NOT NULL DEFAULT 0,
        next_reference_attempt_at         timestamptz,
        created_at                        timestamptz   NOT NULL,
        updated_at                        timestamptz   NOT NULL,
        processed_at                      timestamptz,

        CONSTRAINT wager_tx_kind_ck   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT wager_tx_status_ck CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),

        CONSTRAINT wager_tx_amount_ck CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),

        CONSTRAINT wager_tx_provider_fields_ck CHECK (
          num_nulls(provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id)
            = CASE WHEN kind = 'OPENING' THEN 6 ELSE 0 END),
        CONSTRAINT wager_tx_opening_processed_ck CHECK (kind <> 'OPENING' OR status = 'PROCESSED'),

        CONSTRAINT wager_tx_reference_required_ck  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_reference_forbidden_ck CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
        CONSTRAINT wager_tx_reference_pair_ck      CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_reference_not_self_ck  CHECK (reference_transaction_id <> id),
        CONSTRAINT wager_tx_reference_resolved_ck  CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),

        CONSTRAINT wager_tx_failure_code_ck  CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_balance_after_ck CHECK ((status IN ('PROCESSED','REJECTED')) = (balance_after IS NOT NULL)),
        CONSTRAINT wager_tx_balance_after_non_negative_ck CHECK (balance_after >= 0),
        CONSTRAINT wager_tx_processed_at_ck  CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_reference_schedule_ck CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
        CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
        CONSTRAINT wager_tx_payload_hash_format_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),

        CONSTRAINT wager_tx_id_wallet_currency_uq UNIQUE (id, wallet_id, currency)
      )
    `);

    // idempotência por provedor
    this.addSql(`CREATE UNIQUE INDEX wager_tx_idempotency_uq ON wager_transaction (provider_id, idempotency_key)`);
    // rota GET /providers/:providerId/... e busca de referência
    this.addSql(`CREATE UNIQUE INDEX wager_tx_external_uq ON wager_transaction (provider_id, external_transaction_id)`);
    // no máximo uma reversão aplicada por referência
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_uq ON wager_transaction (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'
    `);
    this.addSql(`CREATE UNIQUE INDEX wager_tx_single_opening_uq ON wager_transaction (wallet_id) WHERE kind = 'OPENING'`);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_ix ON wager_transaction (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'
    `);

    // Saldo mudou ⇒ version + 1; saldo igual ⇒ version igual. Identidade não muda.
    this.addSql(`
      CREATE FUNCTION wallet_version_rule_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wallet_version_rule: id, player_id, currency e created_at não mudam (wallet %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallet_version_rule';
        END IF;

        IF NEW.balance <> OLD.balance THEN
          IF NEW.version <> OLD.version + 1 THEN
            RAISE EXCEPTION 'wallet_version_rule: saldo mudou, version deveria ser % e veio % (wallet %)',
              OLD.version + 1, NEW.version, OLD.id
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallet_version_rule';
          END IF;
        ELSIF NEW.version <> OLD.version THEN
          RAISE EXCEPTION 'wallet_version_rule: saldo igual, version não muda (wallet %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallet_version_rule';
        END IF;

        RETURN NEW;
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_version_rule BEFORE UPDATE ON wallet
        FOR EACH ROW EXECUTE FUNCTION wallet_version_rule_fn()
    `);

    this.addSql(`
      CREATE FUNCTION wallet_no_delete_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_no_delete: wallet não é apagada (wallet %)', OLD.id
          USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wallet_no_delete';
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wallet_no_delete BEFORE DELETE ON wallet
        FOR EACH ROW EXECUTE FUNCTION wallet_no_delete_fn()
    `);

    // terminal congela a linha; PENDING_REFERENCE só vai para ela mesma
    // ou terminal. Mutáveis: só o que markProcessed/reject/fail/scheduleReferenceRetry mexem.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_tx_guard: transação não é apagada (transação %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wager_tx_guard';
        END IF;

        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.wallet_id IS DISTINCT FROM OLD.wallet_id
           OR NEW.player_id IS DISTINCT FROM OLD.player_id
           OR NEW.kind IS DISTINCT FROM OLD.kind
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
           OR NEW.external_transaction_id IS DISTINCT FROM OLD.external_transaction_id
           OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
           OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
           OR NEW.round_id IS DISTINCT FROM OLD.round_id
           OR NEW.game_id IS DISTINCT FROM OLD.game_id
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'wager_tx_guard: coluna de identidade não muda (transação %)', OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wager_tx_guard';
        END IF;

        IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
          IF NEW IS DISTINCT FROM OLD THEN
            RAISE EXCEPTION 'wager_tx_guard: transação terminal (%) não muda (transação %)', OLD.status, OLD.id
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wager_tx_guard';
          END IF;
        ELSIF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
          RAISE EXCEPTION 'wager_tx_guard: % não volta para PENDING (transação %)', OLD.status, OLD.id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'wager_tx_guard';
        END IF;

        RETURN NEW;
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transaction
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard_fn()
    `);
  }

  override async down(): Promise<void> {
    // DROP TABLE leva os triggers da tabela; as funções saem depois.
    this.addSql(`DROP TABLE wager_transaction`);
    this.addSql(`DROP TABLE wallet`);
    this.addSql(`DROP FUNCTION wager_tx_guard_fn()`);
    this.addSql(`DROP FUNCTION wallet_no_delete_fn()`);
    this.addSql(`DROP FUNCTION wallet_version_rule_fn()`);
  }
}
