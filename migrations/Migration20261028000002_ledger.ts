import { Migration } from '@mikro-orm/migrations';

/**
 * `wallet_ledger_entry` (SCHEMA 2.3) e os triggers que amarram wallet e ledger
 * (SCHEMA 3, D16, D17): ledger append-only, cadeia contínua e, no commit, saldo e
 * `version` da wallet batendo com o último lançamento.
 *
 * `ledger_wallet_match` não está na tabela da SCHEMA 3: é o lado do ledger da
 * mesma checagem do `wallet_ledger_match` (decisão 3 da nota T14, aprovada).
 */
export class Migration20261028000002_ledger extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallet_ledger_entry (
        id              uuid          PRIMARY KEY,
        wallet_id       uuid          NOT NULL,
        transaction_id  uuid          NOT NULL,
        wallet_version  integer       NOT NULL,
        direction       varchar(6)    NOT NULL,
        amount          numeric(19,2) NOT NULL,
        currency        char(3)       NOT NULL,
        balance_before  numeric(19,2) NOT NULL,
        balance_after   numeric(19,2) NOT NULL,
        created_at      timestamptz   NOT NULL,

        CONSTRAINT ledger_wallet_fk      FOREIGN KEY (wallet_id, currency) REFERENCES wallet (id, currency),
        CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency)
                                         REFERENCES wager_transaction (id, wallet_id, currency),

        CONSTRAINT ledger_transaction_uq    UNIQUE (transaction_id),
        CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_direction_ck      CHECK (direction IN ('DEBIT','CREDIT')),
        CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
        CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
        CONSTRAINT ledger_arithmetic_ck CHECK (
          balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),
        CONSTRAINT ledger_wallet_version_positive_ck CHECK (wallet_version >= 1)
      )
    `);

    // §5.5: ledger não é atualizado nem apagado.
    this.addSql(`
      CREATE FUNCTION ledger_immutable_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_immutable: ledger é append-only (% em %)', TG_OP, OLD.id
          USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_immutable';
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON wallet_ledger_entry
        FOR EACH ROW EXECUTE FUNCTION ledger_immutable_fn()
    `);

    this.addSql(`
      CREATE FUNCTION ledger_no_truncate_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_no_truncate: ledger é append-only (TRUNCATE)'
          USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_no_truncate';
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entry
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_no_truncate_fn()
    `);

    // O FOR UPDATE é reentrante no caminho normal (D15 já segura o lock). Com bug
    // sem lock, serializa os inserts da wallet: em READ COMMITTED cada comando tira
    // snapshot novo, então o SELECT seguinte vê o lançamento que acabou de commitar.
    this.addSql(`
      CREATE FUNCTION ledger_chain_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        last record;
      BEGIN
        PERFORM 1 FROM wallet WHERE id = NEW.wallet_id FOR UPDATE;

        SELECT wallet_version, balance_after INTO last
          FROM wallet_ledger_entry
         WHERE wallet_id = NEW.wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'ledger_chain: primeiro lançamento da wallet % parte de 0, veio %',
              NEW.wallet_id, NEW.balance_before
              USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_chain';
          END IF;
        ELSIF NEW.balance_before <> last.balance_after THEN
          RAISE EXCEPTION 'ledger_chain: balance_before % não bate com o último balance_after % (wallet %)',
            NEW.balance_before, last.balance_after, NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_chain';
        ELSIF NEW.wallet_version <= last.wallet_version THEN
          RAISE EXCEPTION 'ledger_chain: wallet_version % não é maior que a última % (wallet %)',
            NEW.wallet_version, last.wallet_version, NEW.wallet_id
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = 'ledger_chain';
        END IF;

        RETURN NEW;
      END
      $$
    `);
    this.addSql(`
      CREATE TRIGGER ledger_chain BEFORE INSERT ON wallet_ledger_entry
        FOR EACH ROW EXECUTE FUNCTION ledger_chain_fn()
    `);

    // Checagem comum aos dois constraint triggers. Lê o estado atual da wallet, não
    // o NEW do evento: com duas mudanças na mesma transação, o NEW do primeiro
    // evento já está velho no commit.
    this.addSql(`
      CREATE FUNCTION wallet_ledger_assert(p_wallet_id uuid, p_constraint text) RETURNS void
      LANGUAGE plpgsql AS $$
      DECLARE
        w record;
        last record;
      BEGIN
        SELECT balance, version INTO w FROM wallet WHERE id = p_wallet_id;

        SELECT wallet_version, balance_after INTO last
          FROM wallet_ledger_entry
         WHERE wallet_id = p_wallet_id
         ORDER BY wallet_version DESC
         LIMIT 1;

        IF NOT FOUND THEN
          -- Wallet nova sem saldo não tem lançamento. Não existe lançamento válido
          -- com version 1 e saldo 0, então a isenção não esconde nada.
          IF w.version = 1 AND w.balance = 0 THEN
            RETURN;
          END IF;
          RAISE EXCEPTION '%: wallet % com version % e saldo % sem lançamento',
            p_constraint, p_wallet_id, w.version, w.balance
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = p_constraint;
        END IF;

        IF last.wallet_version <> w.version OR last.balance_after <> w.balance THEN
          RAISE EXCEPTION '%: wallet % em version % e saldo %, último lançamento em version % e saldo %',
            p_constraint, p_wallet_id, w.version, w.balance, last.wallet_version, last.balance_after
            USING ERRCODE = 'integrity_constraint_violation', CONSTRAINT = p_constraint;
        END IF;
      END
      $$
    `);

    this.addSql(`
      CREATE FUNCTION wallet_ledger_match_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM wallet_ledger_assert(NEW.id, 'wallet_ledger_match');
        RETURN NULL;
      END
      $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_ledger_match AFTER INSERT OR UPDATE ON wallet
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION wallet_ledger_match_fn()
    `);

    this.addSql(`
      CREATE FUNCTION ledger_wallet_match_fn() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM wallet_ledger_assert(NEW.wallet_id, 'ledger_wallet_match');
        RETURN NULL;
      END
      $$
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_wallet_match AFTER INSERT ON wallet_ledger_entry
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_wallet_match_fn()
    `);
  }

  override async down(): Promise<void> {
    // O trigger em wallet sai antes: ele lê wallet_ledger_entry.
    this.addSql(`DROP TRIGGER wallet_ledger_match ON wallet`);
    this.addSql(`DROP TABLE wallet_ledger_entry`);
    this.addSql(`DROP FUNCTION wallet_ledger_match_fn()`);
    this.addSql(`DROP FUNCTION ledger_wallet_match_fn()`);
    this.addSql(`DROP FUNCTION wallet_ledger_assert(uuid, text)`);
    this.addSql(`DROP FUNCTION ledger_chain_fn()`);
    this.addSql(`DROP FUNCTION ledger_no_truncate_fn()`);
    this.addSql(`DROP FUNCTION ledger_immutable_fn()`);
  }
}
