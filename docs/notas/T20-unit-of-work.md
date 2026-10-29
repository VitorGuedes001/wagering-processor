# T20 — Unit of Work, wallet e ledger 🔒

> Estado: Testada · Raia: C · Revisor: G · Branch: `t20-unit-of-work`

## O que muda

- `unit-of-work.ts`: `MikroOrmUnitOfWork` abre a transação, aplica os `SET LOCAL` de D21,
  entrega os repositórios montados pelas `RepositoryFactories` e traduz o erro, inclusive o
  do COMMIT.
- `db-errors.ts`: `translateDbError` (SCHEMA 5) e `StaleWalletVersionError`.
- `records/wallet.record.ts`, `records/ledger-entry.record.ts`: entidades de persistência,
  com dinheiro tipado `string`.
- `wallet-repository.ts`: `lockById` com `FOR UPDATE`, `findById`, `insert` e `update`
  condicionado à `version`.
- `ledger-repository.ts`: `insert`, `page` por cursor de `wallet_version` e `all`.
- `test/integration/persistence-wallet-ledger.test.ts`: I-03 de wallet e ledger, e o
  comportamento da Unit of Work, e a tabela do `translateDbError` (37 testes depois da revisão).

## Por quê

- D25: a transação é explícita (`uow.run(async (tx) => …)`), sem `AsyncLocalStorage`.
- D15 e D21: `READ COMMITTED` com `lock_timeout`, `statement_timeout` e
  `idle_in_transaction_session_timeout` locais à transação.
- D22: `readSnapshot` em `REPEATABLE READ READ ONLY`.
- SCHEMA 4.1 e 7: `version` conferida no `UPDATE`, sem `@Property({ version: true })`.
- SCHEMA 5 e D53: tradução na borda da UoW, porque os triggers deferred só falham no commit.
- Restrição 5.1: dinheiro só passa como string entre banco e domínio
  (`Money.fromPersistence` na ida, `toJSON().amount` na volta).

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

- Arquivos que vou tocar (lista exata da EXECUCAO §6, mais o teste do aceite):
  - `src/infrastructure/persistence/unit-of-work.ts`
  - `src/infrastructure/persistence/db-errors.ts`
  - `src/infrastructure/persistence/records/wallet.record.ts`
  - `src/infrastructure/persistence/records/ledger-entry.record.ts`
  - `src/infrastructure/persistence/wallet-repository.ts`
  - `src/infrastructure/persistence/ledger-repository.ts`
  - `test/integration/persistence-wallet-ledger.test.ts` (I-03 wallet e ledger, mais o
    comportamento da UoW)

- Assinaturas públicas:

  ```ts
  // records/*.record.ts — entidades de persistência (SCHEMA 7), dinheiro tipado string
  export class WalletRecord { id; playerId; currency; balance: string; version: number; createdAt; updatedAt }
  export class LedgerEntryRecord { id; walletId; transactionId; walletVersion; direction; amount: string;
                                   currency; balanceBefore: string; balanceAfter: string; createdAt }

  // unit-of-work.ts
  export type RepositoryFactories = { [K in keyof TxRepositories]: (em: EntityManager) => TxRepositories[K] };
  export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(orm: MikroORM, config: Pick<AppConfig, 'DB_LOCK_TIMEOUT_MS'>, factories: RepositoryFactories);
    run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T>;          // READ COMMITTED + SET LOCAL D21
    readSnapshot<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T>; // REPEATABLE READ, readOnly (D22)
  }

  // db-errors.ts
  export function translateDbError(error: unknown): unknown;  // devolve o erro traduzido, ou o original
  export class StaleWalletVersionError extends Error {}       // UPDATE com 0 linhas: bug, não corrida

  // wallet-repository.ts / ledger-repository.ts
  export class MikroOrmWalletRepository implements WalletRepository { constructor(em: EntityManager) }
  export class MikroOrmLedgerRepository implements LedgerRepository { constructor(em: EntityManager) }
  ```

- Como funciona, em cinco pontos:
  1. **`run`:** `orm.em.fork()` + `em.transactional(..., { isolationLevel: READ_COMMITTED })`.
     A primeira coisa dentro da transação é `set_config(..., true)` (equivale a `SET LOCAL`)
     para `lock_timeout = DB_LOCK_TIMEOUT_MS`, `statement_timeout = 5s` e
     `idle_in_transaction_session_timeout = 10s` (D21). Os repositórios são montados pelas
     `factories` com esse `em` e entregues ao `work` (D25).
  2. **Tradução de erro na borda da UoW:** o `catch` envolve o `work` **e o COMMIT**, porque
     os triggers deferred (D53) só falham no commit. Regras de SCHEMA 5:
     `23505` com constraint de `UniqueConstraint` → `UniqueViolationError`;
     `55P03`, `40P01`, `57014`, `57P01` e classe `08` (conexão) → `TransientInfrastructureError`;
     todo o resto (`23514`, `23503`, `23000` de trigger) passa **sem tradução**, como bug.
  3. **Repositórios executam na hora, sem `persist`/`flush`:** `em.insert`, `em.nativeUpdate`
     e `em.findOne(..., { lockMode: PESSIMISTIC_WRITE })` sem identity map. A ordem das
     escritas fica a do use case (SCHEMA 4.2), o `UPDATE … WHERE version = $esperada` devolve
     linhas afetadas, e o erro aparece na chamada que o causou.
  4. **Mapeamento explícito `record ↔ domínio`:** `Money.fromPersistence(string, currency)` na
     ida e `money.amount` (string) na volta; `Wallet.rehydrate` e `WalletLedgerEntry.rehydrate`
     com o `State` (D45). Nenhum `number` toca dinheiro (5.1, A-03 cobre a pasta).
  5. **`readSnapshot`:** `REPEATABLE READ` + `readOnly: true`, sem `SET LOCAL` de lock (não trava
     nada). Wallet e ledger saem do mesmo snapshot (D22).

- Como o I-03 prova:
  - ida e volta de `Wallet` aberta com e sem saldo, e depois de `debit`/`credit` + `update`;
    `typeof` de `balance` lido do banco é `string`;
  - ida e volta de `WalletLedgerEntry` (OPENING e débito), `page` por cursor e `all` em ordem;
  - `lockById` bloqueia uma segunda conexão até o commit (`FOR UPDATE` real);
  - `update` com versão errada lança `StaleWalletVersionError`;
  - `POST /wallets` duplicado vira `UniqueViolationError('wallet_player_currency_uq')`;
  - saldo alterado sem lançamento falha **no commit**, sem tradução (trigger deferred);
  - lock esperando mais que `DB_LOCK_TIMEOUT_MS` vira `TransientInfrastructureError`;
  - `readSnapshot` recusa escrita (`25006`).

  A linha de `wager_transaction` que o ledger exige (FK) é inserida por SQL cru no teste,
  porque o repositório de transações é da T21. `transactions`, `inbox` e `outbox` nas
  `factories` do teste lançam "fora da T20" se chamados.

- Alternativas descartadas e motivo:
  - **`persist` + `flush` com identity map:** o MikroORM reordena as escritas no flush, e os
    records não declaram relação (SCHEMA 7 separa record de domínio), então a ordem
    exigida pela FK do ledger e a contagem de linhas do `UPDATE` ficariam implícitas.
  - **`@Property({ version: true })`:** proibido por SCHEMA 7, para não misturar dois
    mecanismos de versão.
  - **Traduzir erro em cada repositório:** perderia as falhas do COMMIT (triggers deferred
    D53), que são justamente as garantias mais fortes.
  - **`AsyncLocalStorage` para a transação:** proibido por D25.
  - **UoW montando T21/T22 diretamente:** esses repositórios ainda não existem. As `factories`
    deixam a composição para o `PersistenceModule`, e T21/T22 só implementam a porta.
  - **`EntitySchema` em vez de decorators:** o config já usa `ReflectMetadataProvider` de
    `@mikro-orm/decorators/legacy`. Decorators mantêm um estilo só.

**Aprovação do humano:** aprovada como proposta (28/10/2026, na conversa)

## Ordem de leitura do diff

1. `src/infrastructure/persistence/unit-of-work.ts`: o `SET LOCAL` como primeira query do
   `run`, e o `try/catch` em volta do `transactional`, que cobre o COMMIT.
2. `src/infrastructure/persistence/db-errors.ts`: o que vira `UniqueViolationError`, o que
   vira transitório e o que passa sem tradução.
3. `src/infrastructure/persistence/wallet-repository.ts`: `lockById` e o `update` com
   `WHERE version = $esperada`; o `toDomain` com `Money.fromPersistence`.
4. `src/infrastructure/persistence/ledger-repository.ts`: só `insert` e leituras ordenadas
   por `wallet_version`.
5. `src/infrastructure/persistence/records/*.ts`: os tipos das colunas.
6. `test/integration/persistence-wallet-ledger.test.ts`: começar por "saldo alterado sem
   lançamento falha no COMMIT" e "esperar o lock além de DB_LOCK_TIMEOUT_MS".

## Como verificar

```bash
bun run tarefa:gate
bun test --rerun-each 10 ./test/integration/persistence-wallet-ledger.test.ts
```

Resultado em 28/10/2026: gate verde (typecheck, skills, unidade, arquitetura e
integração), e 370 de 370 na repetição, depois do retrabalho da revisão.

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- `mikro-orm.config.ts`: registrar `WalletRecord` e `LedgerEntryRecord` em `entities`.
- `ARCHITECTURE.md` §14: registrar a limitação da conexão presa no pool quando a sessão do
  Postgres morre no meio da transação (Kysely 0.29.6; ver "Fora de escopo / dívida").
- Para T21 e T22: `Money` não expõe `amount` como getter. A ida para o record usa
  `money.toJSON().amount`, para não mexer na assinatura congelada do domínio.
  O teste monta o próprio `MikroORM` com essas entidades, então não depende disso.

## Fora de escopo / dívida

- Ligar a UoW no `PersistenceModule` (provider com as factories): só faz sentido quando
  T21 e T22 existirem, na T30.
- Ponto de falha `uow.before-commit` (I-04): é da T32, que escreve o `FaultInjector`.
- **Conexão presa no pool quando o socket morre no meio da transação** (achado ao tratar
  a revisão, fora do código da T20). O Kysely 0.29.6, que o MikroORM 7 usa, só devolve a
  conexão ao pool depois de um COMMIT ou ROLLBACK **bem-sucedido** (`ControlledTransaction`
  chama `release()` depois do `await`, sem `finally`). Com o socket morto, os dois
  falham, e a conexão fica contada como em uso para sempre. Reproduzido com pool de 1
  conexão: a query seguinte trava. O erro já chega traduzido como transitório; o que se
  perde é a vaga no pool. Só acontece quando a sessão morre (restart ou failover do
  Postgres, `pg_terminate_backend`, `idle_in_transaction_session_timeout`), não em
  `lock_timeout`, `statement_timeout` nem trigger. **Decisão do humano
  (28/10/2026): aceitar e documentar.** Na integração, entra como limitação conhecida em
  `ARCHITECTURE.md` §14, sem patch do Kysely. Os dois testes que derrubam a conexão usam um ORM descartável por
  causa disso.
- No teste, as linhas de `wager_transaction` que a FK do ledger exige são gravadas por SQL
  cru no `em` da transação, e os repositórios de transação, inbox e outbox lançam se
  chamados. Quando a T21 entrar, dá para trocar pelo repositório real.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

- **Gate e stress:** `bun run tarefa:gate` verde (typecheck, skills, unidade, arquitetura A-01..A-03 e integração) e `bun test --rerun-each 10 ./test/integration/persistence-wallet-ledger.test.ts` verde (`120 pass`, `0 fail`).
- **Pontos verificados sem ressalva:**
  - **Escopo:** `git diff --stat main...t20-unit-of-work` toca apenas os 7 arquivos da Abordagem aprovada e esta nota.
  - **Restrição 5.1 (ARQUITETURA §8, SCHEMA §7):** nenhum caminho de dinheiro passa por `number`. `WalletRecord` (`balance`) e `LedgerEntryRecord` (`amount`, `balanceBefore`, `balanceAfter`) declaram `@Property({ type: 'decimal', precision: 19, scale: 2 })` tipados como `string` (`ReflectMetadataProvider` define `runtimeType: 'string'`, preservando `string` em `DecimalType.convertToJSValue`). Ida usa `money.toJSON().amount` (`bigint` → `string`) e volta usa `Money.fromPersistence(string, currency)` (`string` → `bigint`), validado com 19 dígitos (`12345678901234567.89`).
  - **Lock e identity map (D15, SCHEMA §4.1 e §7):** `lockById` com `{ lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true }` cria internamente um fork limpo mantendo o mesmo contexto transacional (`em.fork({ keepTransactionContext: true })`), emitindo `SELECT … FOR UPDATE` real no banco mesmo se a mesma wallet já tiver sido lida por `findById` ou inserida antes na mesma transação.
  - **Erro no COMMIT (D53, SCHEMA §5):** em `unit-of-work.ts:59`, `return await this.orm.em.fork().transactional(work, options)` aguarda o `COMMIT` dentro do `try/catch`, garantindo que falhas de triggers `DEFERRABLE INITIALLY DEFERRED` (`23000`) cheguem a `translateDbError` e passem sem tradução como bug.
  - **Mutações verificadas em cópia descartável:** remover `try/catch` da UoW quebra 2 testes; remover `set_config` quebra 2 testes; trocar `affected !== 1` por `false` em `wallet-repository.ts:49` quebra o teste de `StaleWalletVersionError`.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | `importante` | `src/infrastructure/persistence/db-errors.ts:26,48-52` | **Queda de conexão e falhas de rede não viram `TransientInfrastructureError` (SCHEMA §5, D21):** (a) O comentário na linha 48 afirma que `ConnectionException` cobre `ECONNREFUSED` e afins, mas no `@mikro-orm/sql` v7 apenas `MySqlExceptionConverter` instancia `ConnectionException` — `PostgreSqlExceptionConverter` nunca a emite. Erros de rede/socket do Node/Bun (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `ENOTFOUND`, `ECONNABORTED`) trazem `code` de sistema (não classe `08` nem `ConnectionException`) e escapam sem tradução; (b) Quando a conexão cai **no meio da transação** (ex.: sessão morta por `pg_terminate_backend` ou por `idle_in_transaction_session_timeout` entre duas queries do `work` ou antes do `COMMIT`, ou corte de socket durante query), o `pg` marca o client como `_queryable = false` no evento assíncrono de erro e rejeita a operação atual/seguinte (ou o `COMMIT`) com `Error('Client has encountered a connection error and is not queryable')` ou `Error('Connection terminated unexpectedly')` (ou `DriverException` com a mesma mensagem) e `code: undefined`, escapando sem tradução; (c) Em `TRANSIENT_SQLSTATES` (`linha 26`), faltam `57P02` (`crash_shutdown`), `57P03` (`cannot_connect_now`) e `25P03` (`idle_in_transaction_session_timeout`, configurado em D21). || Corrigido. O conversor do MikroORM para Postgres de fato não emite `ConnectionException` (conferido em `PostgreSqlExceptionConverter.js`), e o import saiu. Transitórios agora: `55P03`, `40P01`, `57014`, `57P01`–`57P03`, `25P03`, classe `08`, os códigos de socket do Node e, sem `code`, as mensagens de conexão perdida do `pg`. Testes novos: conexão derrubada no meio do `work` e antes do COMMIT (por `pg_terminate_backend`), e uma tabela de códigos do `translateDbError`. |
| 2 | `menor` | `test/integration/persistence-wallet-ledger.test.ts:276-285,321-340` | **Duas mutações sobrevivem nos testes da UoW:** (a) No teste `"SET LOCAL de D21 vale só dentro da transação"` (`linhas 276-285`), os `current_setting(...)` só são lidos **dentro** do `run`; mutar `set_config(..., true)` para `set_config(..., false)` (`SET SESSION`, vazando timeout para o pool) não quebra nenhum teste — convém asserir fora/depois do `run` (ex.: em `readSnapshot`) que `lock_timeout` volta a `'0'`; (b) Mutar o `try/catch` de `unit-of-work.ts:58-62` para envolver apenas `work` (deixando o `COMMIT` de fora) também não quebra nenhum teste porque o único teste que falha no `COMMIT` (`linhas 321-340`, `23000` de `wallet_ledger_match`) espera erro **sem** tradução. Além disso, nesse teste de `D53`, registrar uma flag logo após `await tx.wallets.update(wallet, 1)` deixaria explícito que o `UPDATE` passou dentro do `work` e a falha ocorreu no `COMMIT`. || Corrigido. (a) Teste novo com pool de 1 conexão: depois de um `run` com 1234ms, o `readSnapshot` na mesma conexão lê `lock_timeout = 0`. A mutação para `set_config(..., false)` agora quebra esse teste. (b) O teste da conexão derrubada antes do COMMIT só passa se a tradução cobrir o COMMIT, e a mutação "try só no work" agora o quebra. O teste de D53 ganhou a flag `updatedInsideWork`. |
| 3 | `menor` | `src/infrastructure/persistence/unit-of-work.ts:43-48` | **`readSnapshot` sem timeouts de sessão (D21, D22, SCHEMA §7):** Não aplicar `lock_timeout` em `readSnapshot` está correto e aprovado na Abordagem (transação `READ ONLY` não trava linhas), mas `readSnapshot` também não aplica `statement_timeout = 5s` nem `idle_in_transaction_session_timeout = 10s` (SCHEMA §7 diz "no início de cada transação"). Aceitável pelo escopo aprovado e por `ports.ts:54`, mas aplicar `statement_timeout` e `idle_in_transaction_session_timeout` também no `readSnapshot` evitaria que um snapshot `REPEATABLE READ` travado segure conexão do pool e o horizonte de `xmin`. || Corrigido. `readSnapshot` aplica `statement_timeout` e `idle_in_transaction_session_timeout`, sem `lock_timeout`. O teste confere os três valores e `transaction_read_only = on`. |

Veredito: aprovado com ressalvas
