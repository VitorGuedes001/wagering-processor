# Passo 5 — Schema, constraints e estratégia de concorrência

Traduz o modelo de [MODELAGEM.md](MODELAGEM.md) em tabelas e define como o banco
segura as invariantes com várias instâncias. `§N` aponta para
[CHALLENGE.md](CHALLENGE.md); `Dn` para as decisões do passo 4.

O princípio é a restrição 9 (§5): unicidade, imutabilidade e não-negatividade
vivem **no schema**. O domínio verifica antes, para devolver um `failureCode`
bonito. O banco verifica de novo, e é ele que impede o estado errado se o código
tiver bug ou se alguém mexer por SQL.

---

## 1. Decisões deste passo

| # | Decisão | Por quê |
|---|---|---|
| D15 | **Lock pessimista por wallet**: `SELECT … FOR UPDATE` na linha da wallet, em `READ COMMITTED` | Ver seção 3 |
| D16 | O ledger guarda `wallet_version`, com `UNIQUE(wallet_id, wallet_version)` | Dois lançamentos derivados do mesmo saldo (lost update) viram violação de unicidade, mesmo com bug no lock. Também dá ordem estável para o cursor |
| D17 | Triggers garantem que saldo, `version` e ledger andam juntos | "Toda alteração de saldo tem lançamento" (§6.2) fica no schema, não só no código |
| D18 | Worker de outbox e de `PENDING_REFERENCE` reservam linhas por **lease** (`next_attempt_at` empurrado para frente) com `FOR UPDATE SKIP LOCKED` | Nenhuma transação aberta durante chamada de rede. Se o processo morre, o lease expira e outra instância assume |
| D19 | `player_id` é `uuid` | As fixtures de §9 são UUID. Valor fora do formato é `INVALID_PAYLOAD` |
| D20 | Eventos de saída vão para uma fila nova `wagering-events.fifo`, com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId` | O enunciado não define destino. A dedup do SQS é otimização, e o consumidor deduplica por `eventId` |
| D21 | Timeouts de sessão: `lock_timeout 2s`, `statement_timeout 5s`, `idle_in_transaction_session_timeout 10s` | Uma transação travada não segura o lock de uma wallet para sempre. Estouro de lock é falha transitória (503/retry) e conta como conflito de lock na métrica |
| D22 | Reconciliação roda em `REPEATABLE READ READ ONLY`, sem lock | Wallet e ledger lidos do mesmo snapshot, sem bloquear apostas |

## 2. Tabelas

Dinheiro é sempre `numeric(19,2)`, lido como string pelo MikroORM (validado no
passo 1) e convertido com `Money.fromPersistence`. Os nomes de constraint são
explícitos porque a aplicação traduz violação por nome (seção 5).

### 2.1 `wallet`

```sql
CREATE TABLE wallet (
  id          uuid          PRIMARY KEY,
  player_id   uuid          NOT NULL,
  currency    char(3)       NOT NULL,
  balance     numeric(19,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL,
  updated_at  timestamptz   NOT NULL,

  CONSTRAINT wallet_player_currency_uq   UNIQUE (player_id, currency),
  CONSTRAINT wallet_id_currency_uq       UNIQUE (id, currency),          -- alvo de FK do ledger
  CONSTRAINT wallet_balance_non_negative_ck CHECK (balance >= 0),
  CONSTRAINT wallet_version_positive_ck  CHECK (version >= 1),
  CONSTRAINT wallet_currency_format_ck   CHECK (currency ~ '^[A-Z]{3}$')
);
```

### 2.2 `wager_transaction`

`OPENING` é interno e não tem campos de provedor. Os demais kinds exigem todos.
`num_nulls` expressa isso em uma linha.

```sql
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

  -- D3: só LOSS aceita zero
  CONSTRAINT wager_tx_amount_ck CHECK (amount > 0 OR (kind = 'LOSS' AND amount = 0)),

  -- OPENING: sem campos de provedor e sempre PROCESSED
  CONSTRAINT wager_tx_provider_fields_ck CHECK (
    num_nulls(provider_id, external_transaction_id, idempotency_key, payload_hash, round_id, game_id)
      = CASE WHEN kind = 'OPENING' THEN 6 ELSE 0 END),
  CONSTRAINT wager_tx_opening_processed_ck CHECK (kind <> 'OPENING' OR status = 'PROCESSED'),

  -- referência por kind (MODELAGEM 4.2)
  CONSTRAINT wager_tx_reference_required_ck  CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_reference_forbidden_ck CHECK (kind NOT IN ('BET','OPENING') OR reference_external_transaction_id IS NULL),
  CONSTRAINT wager_tx_reference_pair_ck      CHECK (reference_transaction_id IS NULL OR reference_external_transaction_id IS NOT NULL),
  CONSTRAINT wager_tx_reference_not_self_ck  CHECK (reference_transaction_id <> id),
  CONSTRAINT wager_tx_reference_resolved_ck  CHECK (status <> 'PROCESSED' OR reference_external_transaction_id IS NULL OR reference_transaction_id IS NOT NULL),

  -- campos que existem se e somente se o status pede
  CONSTRAINT wager_tx_failure_code_ck  CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
  CONSTRAINT wager_tx_balance_after_ck CHECK ((status IN ('PROCESSED','REJECTED')) = (balance_after IS NOT NULL)),
  CONSTRAINT wager_tx_balance_after_non_negative_ck CHECK (balance_after >= 0),
  CONSTRAINT wager_tx_processed_at_ck  CHECK ((status = 'PROCESSED') = (processed_at IS NOT NULL)),
  CONSTRAINT wager_tx_reference_schedule_ck CHECK ((status = 'PENDING_REFERENCE') = (next_reference_attempt_at IS NOT NULL)),
  CONSTRAINT wager_tx_reference_attempts_ck CHECK (reference_attempts >= 0),
  CONSTRAINT wager_tx_payload_hash_format_ck CHECK (payload_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT wager_tx_id_wallet_currency_uq UNIQUE (id, wallet_id, currency)   -- alvo de FK do ledger
);

-- D4: idempotência por provedor
CREATE UNIQUE INDEX wager_tx_idempotency_uq ON wager_transaction (provider_id, idempotency_key);
-- §7.2 e rota GET /providers/:providerId/...; também serve a busca de referência
CREATE UNIQUE INDEX wager_tx_external_uq    ON wager_transaction (provider_id, external_transaction_id);
-- D1: no máximo uma reversão aplicada por referência
CREATE UNIQUE INDEX wager_tx_single_reversal_uq ON wager_transaction (reference_transaction_id)
  WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
-- uma OPENING por wallet
CREATE UNIQUE INDEX wager_tx_single_opening_uq ON wager_transaction (wallet_id) WHERE kind = 'OPENING';
-- fila do worker de referência
CREATE INDEX wager_tx_pending_reference_ix ON wager_transaction (next_reference_attempt_at)
  WHERE status = 'PENDING_REFERENCE';
```

`OPENING` tem `provider_id` nulo e não colide nos índices únicos, porque `NULL`
é distinto em índice único no Postgres.

Uma transação nunca é gravada como `PENDING`: a decisão acontece antes do
`INSERT`, na mesma transação SQL. O status existe no enum porque está em §6.3,
mas não aparece no banco.

### 2.3 `wallet_ledger_entry`

```sql
CREATE TABLE wallet_ledger_entry (
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  wallet_version  integer       NOT NULL,   -- D16: version da wallet depois deste lançamento
  direction       varchar(6)    NOT NULL,
  amount          numeric(19,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(19,2) NOT NULL,
  balance_after   numeric(19,2) NOT NULL,
  created_at      timestamptz   NOT NULL,

  -- moeda do lançamento = moeda da wallet = moeda da transação, e mesma wallet da transação
  CONSTRAINT ledger_wallet_fk      FOREIGN KEY (wallet_id, currency) REFERENCES wallet (id, currency),
  CONSTRAINT ledger_transaction_fk FOREIGN KEY (transaction_id, wallet_id, currency)
                                   REFERENCES wager_transaction (id, wallet_id, currency),

  CONSTRAINT ledger_transaction_uq    UNIQUE (transaction_id),              -- §6.4
  CONSTRAINT ledger_wallet_version_uq UNIQUE (wallet_id, wallet_version),   -- D16
  CONSTRAINT ledger_direction_ck      CHECK (direction IN ('DEBIT','CREDIT')),
  CONSTRAINT ledger_amount_positive_ck CHECK (amount > 0),
  CONSTRAINT ledger_balances_non_negative_ck CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ledger_arithmetic_ck CHECK (
    balance_after = balance_before + CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END),
  CONSTRAINT ledger_wallet_version_positive_ck CHECK (wallet_version >= 1)
);
```

O `UNIQUE(wallet_id, wallet_version)` também é o índice do cursor do extrato e
da reconciliação.

### 2.4 `inbox_message`

```sql
CREATE TABLE inbox_message (
  consumer_name varchar(128) NOT NULL,
  message_id    varchar(256) NOT NULL,
  payload_hash  char(64)     NOT NULL,
  received_at   timestamptz  NOT NULL,
  processed_at  timestamptz,
  PRIMARY KEY (consumer_name, message_id)
);
```

A linha é inserida **na mesma transação** do processamento. Se ela existe, o
processamento foi confirmado: não existe linha de inbox "órfã" de um processo que
morreu antes do commit.

### 2.5 `outbox_message`

```sql
CREATE TABLE outbox_message (
  id               uuid         PRIMARY KEY,     -- = eventId; o consumidor deduplica por ele
  aggregate_id     uuid         NOT NULL,
  event_type       varchar(128) NOT NULL,
  payload          jsonb        NOT NULL,
  occurred_at      timestamptz  NOT NULL,
  attempts         integer      NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz  NOT NULL,        -- também é o lease (D18)
  published_at     timestamptz,

  CONSTRAINT outbox_attempts_ck CHECK (attempts >= 0)
);

CREATE INDEX outbox_due_ix ON outbox_message (next_attempt_at) WHERE published_at IS NULL;
```

## 3. Triggers

Os `CHECK`s olham uma linha só. O que envolve histórico ou mais de uma tabela vai
em trigger.

| Trigger | Tabela | Quando | Garante |
|---|---|---|---|
| `ledger_immutable` | `wallet_ledger_entry` | `BEFORE UPDATE OR DELETE`, por linha | ledger append-only (§5.5) |
| `ledger_no_truncate` | `wallet_ledger_entry` | `BEFORE TRUNCATE`, por statement | idem |
| `ledger_chain` | `wallet_ledger_entry` | `BEFORE INSERT` | `balance_before` = `balance_after` do último lançamento da wallet (ou 0 no primeiro), e `wallet_version` maior que o último |
| `wallet_version_rule` | `wallet` | `BEFORE UPDATE` | saldo mudou ⇒ `version = OLD.version + 1`. Saldo igual ⇒ `version` igual. `id`, `player_id`, `currency` e `created_at` não mudam |
| `wallet_ledger_match` | `wallet` | `AFTER INSERT OR UPDATE`, **constraint trigger `DEFERRABLE INITIALLY DEFERRED`** | no commit, existe lançamento com `wallet_version = version` e `balance_after = balance`, salvo wallet nova com saldo zero |
| `wallet_no_delete` | `wallet` | `BEFORE DELETE` | wallet não é apagada |
| `wager_tx_guard` | `wager_transaction` | `BEFORE UPDATE OR DELETE` | status terminal não muda. `PENDING_REFERENCE` só vai para ela mesma ou terminal. Colunas de identidade (ids, kind, valor, moeda, hash, key) não mudam. Sem `DELETE` |

`wallet_ledger_match` é deferred porque a ordem dentro da transação é: atualizar
a wallet e depois inserir o lançamento (ou o inverso). A checagem só faz sentido
no commit. Junto com `ledger_chain` e `wallet_version_rule`, isso amarra três
invariantes no banco:

- não há mudança de saldo sem lançamento;
- não há lançamento que não bata com o saldo;
- o extrato forma uma cadeia contínua.

O custo é uma busca por índice único por commit.

**Testes de integração e os triggers.** `TRUNCATE` do ledger é bloqueado. O
reset entre testes usa `SET session_replication_role = replica` (o usuário do
Compose é superuser), ou recria o banco por migration. Fica documentado.

## 4. Concorrência

### 4.1 Escolha: lock pessimista por wallet (D15)

| Alternativa | Por que não |
|---|---|
| Update atômico condicionado (`UPDATE … SET balance = balance - x WHERE balance >= x`) | Resolve só o saldo. A decisão também depende da referência e de "já foi revertida" (§7), que precisam ser lidos sob a mesma exclusão. Para isso, o lock seria necessário de qualquer forma |
| Otimista com `version` e retry limitado | Na wallet quente (§13: 50 em paralelo), quase todo mundo perde a corrida e refaz. Com retry limitado, isso vira 503 espúrio, e com ilimitado vira livelock |
| `SERIALIZABLE` | Mesmo problema do otimista (falhas de serialização sob contenção) e menos explícito: a seção crítica fica implícita |
| Advisory lock por wallet | Funciona, mas é um segundo mecanismo. A linha da wallet já é o recurso natural |

`FOR UPDATE` na linha da wallet serializa só quem disputa **a mesma wallet**
(restrição 6: nada de lock global). Wallets diferentes rodam em paralelo. O lock
dura o tempo de uma transação curta, sem nenhuma chamada de rede dentro. Depois
de obter o lock, `READ COMMITTED` relê a versão mais recente da linha, então
quem esperou decide sobre o saldo já atualizado.

`version` continua existindo como defesa extra: o `UPDATE` da wallet usa
`WHERE id = $1 AND version = $2`. Zero linhas afetadas significa bug, nunca
corrida esperada.

**Deadlock.** Cada transação trava no máximo uma wallet, e a ordem de aquisição
é a mesma em todos os caminhos (seção 4.3). Não existe ciclo.

### 4.2 Fluxo de `POST /wagering/transactions`

```
fora de transação
  1. valida payload, calcula payloadHash
  2. busca (provider_id, idempotency_key)  → achou: replay ou IDEMPOTENCY_CONFLICT, fim

BEGIN  (READ COMMITTED; lock_timeout 2s)
  3. SELECT … FROM wallet WHERE id = $walletId FOR UPDATE
         → não achou: ROLLBACK, WALLET_NOT_FOUND (D13)
  4. busca de novo (provider_id, idempotency_key) e (provider_id, external_transaction_id)
         → achou: ROLLBACK, replay / conflito
  5. busca a referência por (provider_id, reference_external_transaction_id)
     e se ela já tem reversão PROCESSED
  6. decideWager(...)                                       -- função pura (MODELAGEM 5)
  7. INSERT wager_transaction (com o desfecho já definido)
  8. se APPLY com direção: INSERT wallet_ledger_entry; UPDATE wallet … WHERE version = $v
  9. INSERT outbox_message (1 ou 2 eventos)
COMMIT
```

O passo 2 é só atalho para replays (sem lock). A garantia está no passo 4, sob o
lock, e nos índices únicos:

| Corrida | Quem resolve |
|---|---|
| Mesma operação N× em paralelo, mesma wallet | o lock serializa; do 2º em diante, o passo 4 encontra a linha → replay |
| Mesma key, payloads com **wallets diferentes** | locks diferentes não se veem. O 2º `INSERT` viola `wager_tx_idempotency_uq` → a aplicação refaz o fluxo uma vez → passo 2 encontra → `IDEMPOTENCY_CONFLICT` |
| Duas reversões da mesma referência | mesma wallet (exigido pela regra 7 da tabela de decisão) → lock serializa → a 2ª vê `alreadyReversed`. `wager_tx_single_reversal_uq` é o backstop |
| Duas `BET` disputando saldo (§8) | lock serializa → a 2ª relê o saldo e recebe `INSUFFICIENT_FUNDS` |
| `POST /wallets` duplicado | `wallet_player_currency_uq` → `WALLET_ALREADY_EXISTS` |

### 4.3 Ordem de aquisição de locks

| Caminho | Ordem |
|---|---|
| HTTP | wallet |
| Consumidor SQS | linha de inbox (inserção) → wallet |
| Worker `PENDING_REFERENCE` | wallet → linha da transação pendente |
| Worker outbox | linhas de outbox (só no claim, transação separada) |
| Reconciliação | nenhum (snapshot, D22) |

A inbox vem antes da wallet de propósito: uma mensagem duplicada fica esperando
no índice da inbox, **sem** segurar o lock da wallet. Quando a primeira faz
commit, a duplicata recebe conflito e é tratada como já processada.

### 4.4 Consumidor SQS

```
BEGIN
  INSERT INTO inbox_message … ON CONFLICT DO NOTHING RETURNING message_id
    → sem linha: SELECT payload_hash
         igual   → ROLLBACK, ack (duplicata)
         diferente → ROLLBACK, DLQ (D7)
  passos 3–9 do fluxo HTTP (mesmo use case)
  UPDATE inbox_message SET processed_at = now()
COMMIT → ack
```

Ack só depois do commit (§10). Se o processo morre entre o commit e o ack, a
redelivery cai no `ON CONFLICT` e vira ack de duplicata (§13.5).

`FAILED` só é escrito pelo consumidor, quando a mensagem está na última entrega
antes da DLQ (`ApproximateReceiveCount`) e a falha é permanente. A escrita é uma
transação separada, porque a financeira já deu rollback. O HTTP nunca grava
`FAILED`: devolve 503 e o provedor reenvia.

### 4.5 Workers com lease (D18)

Outbox:

```sql
-- claim: transação curta
UPDATE outbox_message SET next_attempt_at = now() + interval '30 seconds'
 WHERE id IN (SELECT id FROM outbox_message
               WHERE published_at IS NULL AND next_attempt_at <= now()
               ORDER BY next_attempt_at
               LIMIT 50
               FOR UPDATE SKIP LOCKED)
RETURNING *;
-- publica no SQS fora de transação
-- sucesso: UPDATE … SET published_at = now()
-- falha:   UPDATE … SET attempts = attempts + 1, next_attempt_at = <backoff D12>
```

- **Dois publishers ao mesmo tempo** (§13.6): `SKIP LOCKED` faz cada um pegar
  linhas diferentes.
- **Processo morre depois do claim:** o lease expira em 30 s e outra instância
  pega a linha.
- **Publicação mais lenta que o lease:** pode gerar duplicata, que é aceita
  (§11.5). O consumidor deduplica por `eventId`.

O worker de `PENDING_REFERENCE` reserva do mesmo jeito, via
`next_reference_attempt_at`. Cada item é então processado em **sua própria**
transação: trava a wallet, relê a transação com `FOR UPDATE` e confere que ela
continua `PENDING_REFERENCE`. Isso protege contra dois workers e contra lease
vencido. Depois roda `decideWager`.

### 4.6 Métricas que saem daqui

| Métrica (§12) | Origem |
|---|---|
| conflitos de lock | `SQLSTATE 55P03` (lock_timeout) e `40P01`, contados antes de virar 503/retry |
| duplicatas detectadas | replay no passo 4, `ON CONFLICT` da inbox |
| outbox lag | `now() - min(occurred_at) WHERE published_at IS NULL` |
| retries | `attempts` do outbox, `reference_attempts`, `ApproximateReceiveCount` |

## 5. Tradução de erros do banco

| SQLSTATE | Constraint / caso | Tratamento |
|---|---|---|
| `23505` | `wager_tx_idempotency_uq`, `wager_tx_external_uq` | refaz o fluxo uma vez → replay ou conflito |
| `23505` | `wallet_player_currency_uq` | `WALLET_ALREADY_EXISTS` |
| `23505` | `wager_tx_single_reversal_uq`, `ledger_*_uq` | bug (o lock deveria ter impedido): 500 + log de erro |
| `23514`, `23503`, exceção de trigger | qualquer | bug: 500 + log. O estado errado **não** foi gravado |
| `55P03`, `40P01`, `57014`, conexão | lock, deadlock, timeout, rede | transitório: 503 no HTTP, retry na fila |

## 6. Consultas

| Uso | Consulta | Índice |
|---|---|---|
| Extrato com cursor | `WHERE wallet_id = $1 AND wallet_version > $cursor ORDER BY wallet_version LIMIT $n` | `ledger_wallet_version_uq` |
| Cursor | `base64url({"v": wallet_version})`. Estável porque o ledger é imutável | — |
| Reconciliação | soma com sinal + `lag(balance_after) OVER (ORDER BY wallet_version)` para checar a cadeia, em `REPEATABLE READ READ ONLY` | `ledger_wallet_version_uq` |
| Transação por id externo | `(provider_id, external_transaction_id)` | `wager_tx_external_uq` |

## 7. MikroORM

- Entidades de persistência separadas do domínio (§6.1), com mapeamento
  explícito `State ↔ domínio` por repositório.
- Transação: `em.transactional(...)`. Lock: `em.findOne(WalletRecord, id,
  { lockMode: LockMode.PESSIMISTIC_WRITE })`. Claims com `SKIP LOCKED` usam
  `LockMode.PESSIMISTIC_PARTIAL_WRITE` ou SQL direto.
- O `@Property({ version: true })` do MikroORM **não** é usado: a checagem de
  `version` é explícita no `UPDATE` (4.1), para não misturar dois mecanismos.
- Os `SET LOCAL` de timeout (D21) rodam no início de cada transação.

## 8. Migrations

Substituem a migration descartável do passo 1. Cada uma tem `down`.

| Migration | `up` | `down` |
|---|---|---|
| `…01_wallet_and_transactions` | `wallet`, `wager_transaction`, índices | `DROP TABLE` em ordem inversa |
| `…02_ledger` | `wallet_ledger_entry` e os triggers de §3 | `DROP TRIGGER`/`FUNCTION`, `DROP TABLE` |
| `…03_inbox_outbox` | `inbox_message`, `outbox_message` | `DROP TABLE` |

Junto: apagar `smoke_balance` (entidade, migration e `scripts/smoke.ts`), rodar
`bun run infra:down` para limpar o histórico de migrations do banco local, e
criar `wagering-events.fifo` no `init-queues.sh` (D20).

## 9. Testes de integração do schema

Cada garantia acima tem um teste que tenta violá-la **por SQL cru** e espera o
erro, além de confirmar que o caminho válido passa:

| Grupo | Casos |
|---|---|
| `wallet` | saldo negativo, wallet duplicada, `version` sem mudar saldo, saldo sem lançamento (commit falha), `DELETE` |
| `wager_transaction` | cada `CHECK` de 2.2, idempotency key repetida, id externo repetido, segunda reversão `PROCESSED`, segunda `OPENING`, terminal alterado, `DELETE` |
| `wallet_ledger_entry` | aritmética errada, moeda ≠ wallet, wallet ≠ transação, dois lançamentos por transação, `wallet_version` repetida, cadeia quebrada, `UPDATE`, `DELETE`, `TRUNCATE` |
| migrations | `up` → `down` → `up` limpo |
| locks | 2 transações em conexões separadas na mesma wallet: a 2ª espera. Em wallets diferentes: não espera. `lock_timeout` estoura em 2 s |
