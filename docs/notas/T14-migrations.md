# T14 — Migrations e triggers 🔒

> Estado: Abordagem · Raia: C · Revisor: G · Branch: `t14-migrations`

## O que muda

Uma frase por arquivo tocado.

## Por quê

Regras atendidas, com referência aos docs (ex.: MODELAGEM 4.3; D2).

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

> **Onde estou trabalhando.** O worktree que o app criou para esta sessão
> (`.claude/worktrees/t14-migrations-0aca3f`) é do repositório externo
> `backend-challenge`, que só tem o README. Criei um worktree do repositório
> real dentro dele: `.claude/worktrees/t14-migrations-0aca3f/wp`, branch
> `claude/t14-migrations-0aca3f` (o mesmo nome da sessão, sem renomear), saindo
> da `main` em `428e2d9`. O script aceitou com `--aqui`.

- **Arquivos que vou tocar:** `migrations/**` e esta nota. Nada mais.
  - `migrations/Migration20261028000001_wallet_and_transactions.ts`
  - `migrations/Migration20261028000002_ledger.ts`
  - `migrations/Migration20261028000003_inbox_outbox.ts`

  O MikroORM ordena os arquivos por nome (`glob().sort()`) e pega a primeira
  classe exportada; o nome da migration é o nome do arquivo. Cada classe estende
  `Migration` e usa `this.addSql` em `up`/`down`, como a migration do passo 1.
  `transactional: true` na config: cada migration roda numa transação.

- **Assinaturas públicas:** nenhuma em TypeScript. O "contrato" são os nomes de
  tabela, coluna, constraint, índice e trigger, **copiados literalmente** da
  SCHEMA §2–3 (o `UniqueConstraint` de `ports.ts` depende dos 7 nomes `_uq`).
  Dinheiro é `numeric(19,2)`. As funções PL/pgSQL ganham o nome do trigger com
  sufixo `_fn` (ex.: `ledger_chain_fn`).

### Migration 01 — `wallet_and_transactions`

`up`, nesta ordem:
1. `CREATE TABLE wallet` (DDL da 2.1, todas as constraints nomeadas).
2. `CREATE TABLE wager_transaction` (DDL da 2.2). A FK de `wallet_id` e a
   autorreferência `reference_transaction_id` ficam inline, como no doc (nome
   automático do Postgres: `wager_transaction_wallet_id_fkey` etc.).
3. Os 5 índices: `wager_tx_idempotency_uq`, `wager_tx_external_uq`,
   `wager_tx_single_reversal_uq`, `wager_tx_single_opening_uq`,
   `wager_tx_pending_reference_ix`.
4. Triggers de `wallet` e `wager_transaction` que **não** dependem do ledger:
   `wallet_version_rule`, `wallet_no_delete`, `wager_tx_guard` (e funções).

`down`: `DROP TABLE wager_transaction`, depois `DROP TABLE wallet` (o `DROP
TABLE` leva os triggers da tabela), depois `DROP FUNCTION` das 3 funções.

### Migration 02 — `ledger`

`up`:
1. `CREATE TABLE wallet_ledger_entry` (DDL da 2.3).
2. Funções e triggers `ledger_immutable`, `ledger_no_truncate`, `ledger_chain`.
3. Função e constraint trigger `wallet_ledger_match` em `wallet`. Fica aqui, não
   na 01, porque a função lê `wallet_ledger_entry`: com o `down` da 02 a tabela
   some, e o trigger não pode sobrar em `wallet` apontando para ela.

`down`: `DROP TRIGGER wallet_ledger_match ON wallet`, `DROP TABLE
wallet_ledger_entry` (leva os 3 triggers dela), `DROP FUNCTION` das 4 funções.

### Migration 03 — `inbox_outbox`

`up`: `inbox_message`, `outbox_message`, `outbox_due_ix`. `down`: `DROP TABLE`
das duas (ordem inversa).

`down` da cadeia toda é sempre o inverso exato do `up`. Nenhum `IF EXISTS` no
`down`: se algo que deveria existir não existe, quero que o `down` falhe alto
(I-01 roda `up → down → up` e pegaria a sobra).

### Os 7 triggers em PL/pgSQL

Erro de todos os triggers: `RAISE EXCEPTION '<trigger>: <o que quebrou>' USING
ERRCODE = 'integrity_constraint_violation' /* 23000 */, CONSTRAINT =
'<trigger>'`. Assim o teste (e o log) identifica o trigger pelo campo
`constraint` do erro do driver, igual a um `CHECK`, e a SCHEMA §5 já trata
"exceção de trigger" como bug/500. (Ver decisão pendente 1.)

1. **`ledger_immutable`** — `BEFORE UPDATE OR DELETE ON wallet_ledger_entry FOR
   EACH ROW`: a função só lança (`TG_OP` na mensagem). Nunca retorna.
2. **`ledger_no_truncate`** — `BEFORE TRUNCATE ON wallet_ledger_entry FOR EACH
   STATEMENT`: mesma ideia, função própria. Também bloqueia `TRUNCATE wallet
   CASCADE`, que chega ao ledger.
3. **`ledger_chain`** — `BEFORE INSERT ON wallet_ledger_entry FOR EACH ROW`:
   ```sql
   PERFORM 1 FROM wallet WHERE id = NEW.wallet_id FOR UPDATE;   -- (a)
   SELECT wallet_version, balance_after INTO last
     FROM wallet_ledger_entry WHERE wallet_id = NEW.wallet_id
     ORDER BY wallet_version DESC LIMIT 1;                      -- usa ledger_wallet_version_uq
   IF NOT FOUND THEN
     IF NEW.balance_before <> 0 THEN RAISE ...; END IF;
   ELSIF NEW.balance_before <> last.balance_after THEN RAISE ...;
   ELSIF NEW.wallet_version <= last.wallet_version THEN RAISE ...;
   END IF;
   RETURN NEW;
   ```
   (a) é defesa em profundidade: o caminho normal já segura o lock da wallet
   (D15), então o `FOR UPDATE` é reentrante e de graça. Se um bug inserir
   lançamento sem lock, o segundo insert espera o primeiro commitar e, como
   cada comando PL/pgSQL em `READ COMMITTED` tira snapshot novo, o `SELECT`
   seguinte enxerga o lançamento do outro e acusa a cadeia quebrada. Sem (a),
   dois inserts concorrentes com versões diferentes (ex. v2 e v3) partindo do
   mesmo `balance_before` passariam: o `UNIQUE(wallet_id, wallet_version)` só
   pega versões iguais.
4. **`wallet_version_rule`** — `BEFORE UPDATE ON wallet FOR EACH ROW`:
   `id`, `player_id`, `currency`, `created_at` com `IS DISTINCT FROM` → erro.
   Se `NEW.balance <> OLD.balance`, exige `NEW.version = OLD.version + 1`;
   senão, exige `NEW.version = OLD.version`. `updated_at` é livre.
5. **`wallet_ledger_match`** — `CREATE CONSTRAINT TRIGGER wallet_ledger_match
   AFTER INSERT OR UPDATE ON wallet DEFERRABLE INITIALLY DEFERRED FOR EACH ROW`.
   Pontos de atenção:
   - O evento é enfileirado com o `NEW` **do momento do comando**. Se a wallet
     muda duas vezes na transação, o `NEW` do primeiro evento está velho no
     commit. Por isso a função **relê** a linha atual: `SELECT balance, version
     FROM wallet WHERE id = NEW.id` e checa contra ela (eventos repetidos fazem
     a mesma checagem, idempotente).
   - Isenção "wallet nova com saldo zero": `version = 1 AND balance = 0`. Não
     existe lançamento válido com `wallet_version = 1` e `balance_after = 0`
     (crédito de `amount > 0` sai de 0 para > 0; débito de 0 fica negativo),
     então a isenção não esconde nada.
   - Senão, exige que exista lançamento com `wallet_version = version` e
     `balance_after = balance` (busca por `ledger_wallet_version_uq`, o custo
     de uma busca por índice por commit que a SCHEMA cita).
   - Por ser deferred, o erro sai no `COMMIT` (o teste "saldo sem lançamento:
     commit falha" da SCHEMA 9). `SET CONSTRAINTS wallet_ledger_match
     IMMEDIATE` continua funcionando para quem quiser antecipar.
6. **`wallet_no_delete`** — `BEFORE DELETE ON wallet FOR EACH ROW`: só lança.
7. **`wager_tx_guard`** — `BEFORE UPDATE OR DELETE ON wager_transaction FOR EACH
   ROW`:
   - `DELETE` → erro.
   - Colunas imutáveis (`IS DISTINCT FROM` → erro): `id`, `wallet_id`,
     `player_id`, `kind`, `amount`, `currency`, `provider_id`,
     `external_transaction_id`, `idempotency_key`, `payload_hash`, `round_id`,
     `game_id`, `reference_external_transaction_id`, `created_at`. O doc lista
     "ids, kind, valor, moeda, hash, key"; incluí `round_id`, `game_id` e a
     referência externa porque são campos do payload que o `payload_hash`
     cobre, e `created_at` porque é fato histórico. Mutáveis: `status`,
     `reference_transaction_id`, `failure_code`, `balance_after`,
     `reference_attempts`, `next_reference_attempt_at`, `processed_at`,
     `updated_at` (exatamente o que `markProcessed`, `reject`, `fail` e
     `scheduleReferenceRetry` mexem, MODELAGEM 4.x).
   - `OLD.status` terminal (`PROCESSED`, `REJECTED`, `FAILED`): a linha inteira
     congela, `NEW IS DISTINCT FROM OLD` → erro (ver decisão pendente 2).
   - `OLD.status = 'PENDING_REFERENCE'`: `NEW.status` tem que ser ela mesma ou
     terminal (na prática: não pode voltar a `PENDING`).
   - `OLD.status = 'PENDING'` nunca é gravado (SCHEMA 2.2); se aparecer por SQL,
     a mesma regra da `PENDING_REFERENCE` vale (vai para `PENDING_REFERENCE` ou
     terminal, MODELAGEM 4).

Os `CHECK`s de linha continuam valendo depois do trigger (ex.: virar
`PROCESSED` sem `processed_at` cai no `wager_tx_processed_at_ck`), então o
trigger não repete o que o `CHECK` já garante.

### Validação manual (passo 5 do briefing)

Banco `t14_scratch` no Postgres do Compose (porta 5434), criado e apagado por
mim. `DB_NAME=t14_scratch bunx --bun mikro-orm migration:up` → `down --to 0` →
`up`; conferir `\d` vazio depois do `down` (só `mikro_orm_migrations`). Depois,
por `psql` dentro do container (`docker compose exec postgres psql`, sem parar
nada), o caminho válido (wallet + OPENING + lançamento v1, aposta com v2) e
pelo menos uma violação de cada trigger e de cada `_uq`. Registro tudo na nota.

- **Alternativas descartadas e motivo:**
  - *Uma migration só, ou triggers numa 04 separada*: a SCHEMA §8 fixa três
    migrations e diz que os triggers entram junto do ledger.
  - *`wallet_version_rule`, `wallet_no_delete` e `wager_tx_guard` na 02*:
    funcionaria, mas deixaria `wallet` e `wager_transaction` sem as garantias
    de imutabilidade entre a 01 e a 02; elas não dependem do ledger, então
    nascem com as tabelas. Só o `wallet_ledger_match` vai na 02, porque lê o
    ledger. Se o humano preferir tudo na 02 ao pé da letra do §8, é mover três
    blocos.
  - *Regras como `RULE` (`CREATE RULE … DO INSTEAD NOTHING`)*: engole o
    `UPDATE`/`DELETE` em silêncio em vez de falhar; o teste I-02 espera erro.
  - *`REVOKE UPDATE, DELETE` no ledger*: o usuário do Compose é superuser e
    ignora grants. Trigger vale para todos.
  - *`wallet_ledger_match` não deferred*: quebra a ordem "atualiza a wallet,
    depois insere o lançamento" (SCHEMA §3).
  - *`wallet_ledger_match` usando o `NEW` do evento*: falso positivo/negativo
    quando a wallet muda mais de uma vez na transação (ver acima).
  - *`ledger_chain` sem `FOR UPDATE` na wallet*: deixa passar a cadeia quebrada
    por inserts concorrentes sem lock (ver acima).
  - *`RAISE` com o `P0001` padrão*: funciona, mas sem `CONSTRAINT` o teste só
    tem a mensagem para saber qual trigger disparou.

**Aprovação do humano:** pendente

## Ordem de leitura do diff

1. `arquivo` — o que olhar nele

## Como verificar

```bash
bun run tarefa:gate
```

## Decisões pendentes

1. **SQLSTATE dos triggers.** A SCHEMA não fixa. Proposta: `23000`
   (`integrity_constraint_violation`) com `CONSTRAINT = '<nome do trigger>'`.
   Motivo: classe 23 é a de violação de integridade, e o nome no campo
   `constraint` deixa o I-02 checar qual trigger disparou. A T15 precisa saber
   disso para escrever o I-02.
2. **Terminal congela a linha inteira, não só o `status`.** A SCHEMA §3 diz
   "status terminal não muda". Proposta: qualquer coluna mudando numa linha
   terminal é erro. Motivo: nenhum método de MODELAGEM 4 mexe em transação
   terminal, e deixar `balance_after`, `failure_code` ou `reference_transaction_id`
   editáveis depois do fato abriria a porta para reescrever o histórico.
   Alternativa: só travar `status` (mais literal, mais fraco).
3. **Lançamento sem mudança na wallet não é pego no commit.**
   `wallet_ledger_match` só dispara em `INSERT/UPDATE` de `wallet`. Um `INSERT`
   de lançamento v2 sem atualizar a wallet (que fica em v1) passa: cadeia ok,
   nenhum evento na wallet. Isso fura "não há lançamento que não bata com o
   saldo" (SCHEMA §3). Proposta: um 8º trigger, `ledger_wallet_match`
   (constraint trigger deferred `AFTER INSERT ON wallet_ledger_entry`), que
   reusa a mesma checagem da wallet. E reforçar a checagem para "o **último**
   lançamento da wallet tem `wallet_version = version` e `balance_after =
   balance`", em vez de "existe um". Custa um nome novo fora da tabela da
   SCHEMA §3, por isso peço OK. Sem OK, sigo com os 7 do doc e registro a
   lacuna em "Fora de escopo / dívida".

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- (nenhum)

## Fora de escopo / dívida

- SCHEMA §8 "Junto": apagar `smoke_balance` já foi feito na B0; criar
  `wagering-events.fifo` já está no `init-queues.sh`. Limpar o histórico de
  migrations do banco `wagering` (`bun run infra:down`) é do humano: é proibido
  para agentes e eu não toco no banco `wagering`.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
