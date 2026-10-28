# T15 — Infra de teste e testes de schema

> Estado: Testada · Raia: G · Revisor: C · Branch: `t15-test-infra`

## O que muda

- `test/architecture/architecture.test.ts` — implementa os testes de arquitetura **A-01** (`src/domain` puro), **A-02** (fronteiras de `src/application`, `src/infrastructure` e `src/interface`) e **A-03** (guarda estática 5.1 contra `parseFloat`, `Number(`, `.toFixed`, `Math.` e `number` em propriedades monetárias, com auto-teste do scanner).
- `test/support/eventually.ts` — implementa `eventually(fn, { timeoutMs, intervalMs })` com polling curto (D39) para eliminar `sleep` em testes.
- `test/support/preload.ts` — implementa `checkInfrastructure()` (falha rápida com instrução `bun run infra:up` se PostgreSQL ou LocalStack SQS não responderem) e `ensureTemplateDatabase()` (recria `wagering_template`, aplica migrations quando `./migrations` existir e encerra sessões antes do `CREATE DATABASE ... TEMPLATE`, D34).
- `test/support/database.ts` — implementa `createTestDatabase({ fromTemplate })` e `dropTestDatabase()`, com conexões `Bun.SQL` isoladas por arquivo de teste, `connect()` para sessões concorrentes (locks), `migrateUp()`, `migrateDownToZero()`, `reset()` (`session_replication_role = replica`) e `drop()`.
- `test/support/invariants.ts` — implementa `assertAllWalletsConsistent(db)` em SQL puro (D40), verificando soma do ledger vs `wallet.balance`, cadeia contínua `balance_before = lag(balance_after)` e `wallet_version` 1..N, correspondência com `wallet.version`, unicidade de reversão `PROCESSED` por referência e bijeção entre transações `PROCESSED` que movem saldo e lançamentos.
- `test/support/queues.ts` — implementa `createTestQueues(prefix)` e `deleteTestQueues()` no LocalStack SQS (D35), criando as 3 filas FIFO isoladas (`input`, `dlq`, `events`) com a mesma `RedrivePolicy` (`maxReceiveCount = 5`) e `VisibilityTimeout = 30` de `init-queues.sh`.
- `test/support/fixtures.ts` — exporta as fixtures literais de `CHALLENGE.md` §9/§10 e os builders (`aWalletRequest`, `aBet`, `aWin`, `aLoss`, `aRefundOf`, `aRollbackOf`, `anSqsEnvelope`) com IDs únicos por chamada.
- `test/integration/schema.test.ts` — implementa os testes de integração **I-01** (`up → down → up` em banco vazio) e **I-02** (caminho feliz, triggers deferred em ambas as ordens, `assertAllWalletsConsistent`, cada `CHECK`, `UNIQUE`, `FOREIGN KEY` e trigger de `wallet`, `wager_transaction`, `wallet_ledger_entry`, `inbox_message`, `outbox_message`, além de contenção de lock `FOR UPDATE` por wallet e `lock_timeout` `55P03`).

## Por quê

- **ARQUITETURA §2 e §8 (TESTES 4.1 — A-01, A-02, A-03):** garantir de forma automatizada que o domínio permaneça livre de frameworks, que as camadas respeitem a direção de dependência e que nenhum ponto flutuante (`number`, `parseFloat`, `Number(`, `.toFixed`, `Math.`) entre em domínio ou persistência (restrição inviolável 5.1).
- **TESTES §1–§3 e §5 (D34, D35, D39, D40):** fornecer isolamento por arquivo de teste (banco clonado de `wagering_template` e filas FIFO com prefixo único), verificação prévia da infraestrutura, polling determinístico sem `sleep` e checagem independente das 5 invariantes financeiras no banco.
- **SCHEMA §2, §3, §9 e EXECUCAO §6 (TESTES 4.2 — I-01 e I-02):** escrever os testes críticos de reversibilidade das migrations e de violação por SQL cru de cada constraint, índice único, trigger e lock antes da entrada do T14 (princípio 6 de `EXECUCAO.md` §1: rodam contra o PostgreSQL real e falham pelo motivo certo — ausência das migrations/tabelas da T14 — até o merge da T14).

## Abordagem

- **Arquivos tocados:**
  - `test/architecture/architecture.test.ts`
  - `test/support/eventually.ts`
  - `test/support/preload.ts`
  - `test/support/database.ts`
  - `test/support/invariants.ts`
  - `test/support/queues.ts`
  - `test/support/fixtures.ts`
  - `test/integration/schema.test.ts`
  - `docs/notas/T15-test-infra.md`
- **Assinaturas públicas (`test/support/**`):**
  - `eventually<T>(fn: () => T | Promise<T>, options?: EventuallyOptions): Promise<T>`
  - `checkInfrastructure(): Promise<void>`
  - `ensureTemplateDatabase(): Promise<void>`
  - `createTestDatabase(options?: CreateTestDatabaseOptions): Promise<TestDatabase>`
  - `dropTestDatabase(dbOrName: TestDatabase | string): Promise<void>`
  - `assertAllWalletsConsistent(dbOrSql: TestDatabase | SQL): Promise<void>`
  - `createTestQueues(customPrefix?: string): Promise<TestQueues>`
  - `deleteTestQueues(queues: TestQueues): Promise<void>`
  - `aWalletRequest`, `aBet`, `aWin`, `aLoss`, `aRefundOf`, `aRollbackOf`, `anSqsEnvelope`
- **Alternativas descartadas e motivo:**
  - Usar `pg` (`node-postgres`) para SQL cru nos testes: descartado porque `@types/pg` não faz parte das dependências e `Bun.SQL` (`import { SQL } from 'bun'`) já oferece cliente PostgreSQL nativo com tipagem estrita e suporte a conexões dedicadas (`max: 1`).

## Ordem de leitura do diff

1. `test/architecture/architecture.test.ts` — regras de import por camada (A-01, A-02) e scanner da guarda 5.1 com auto-teste (A-03).
2. `test/support/eventually.ts` — helper de polling curto (D39).
3. `test/support/preload.ts` e `test/support/database.ts` — verificação de infra, criação do `wagering_template` e ciclo de vida dos bancos `t_<uuid>` por arquivo (D34).
4. `test/support/invariants.ts` — as 5 consultas SQL independentes da invariante financeira (D40).
5. `test/support/queues.ts` e `test/support/fixtures.ts` — filas FIFO isoladas por teste (D35) e builders de payloads (`CHALLENGE.md` §9/§10).
6. `test/integration/schema.test.ts` — testes I-01 e I-02 cobrindo migrations, constraints, triggers (`23000`) e locks (`FOR UPDATE` e `55P03`).

## Como verificar

```bash
bun run typecheck
bun run test
bun run test:integration
```

- `bun run typecheck` e `bun run test` (incluindo `test/architecture`) passam verdes.
- `bun run test:integration` conecta no PostgreSQL real, cria os bancos isolados `t_<id>` e falha pelo motivo esperado antes do merge da T14 (`Nenhuma migration encontrada em .../migrations` no I-01 e `42P01: relation "wallet" does not exist` no I-02). Assim que a T14 entrar na `main`, I-01 e I-02 passam integralmente.

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

- (nenhum)

## Fora de escopo / dívida

- Helpers da Onda 3 (`app-process.ts`, `lock-gate.ts`, `http.ts`, `events.ts`) pertencem à tarefa **T32** (`docs/EXECUCAO.md` §6), pois dependem dos contratos de boot e rotas HTTP da aplicação.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

Revisor: Claude (raia C), 28/10/2026, sobre `t15-test-infra` rebaseada na `main` com as migrations da T14.

**Execução:** `bun run tarefa:gate` ficou verde (typecheck, skills, unidade, arquitetura e integração). `bun run test:integration` deu 17 pass, 0 fail, 70 `expect()`, em 2,4 s. `bun run test` deu 82 pass. Depois da execução não sobrou nenhum banco `t_*` em `pg_database`.

**Verificado sem achado:** os bancos `t_<uuid>` são clonados de `wagering_template`, o I-01 roda em banco vazio próprio e o `drop()` fica em `afterAll`/`finally`, então roda mesmo quando o teste falha. Nada usa o banco `wagering` nem as filas padrão: os nomes levam o prefixo `t<id>-` e repetem os atributos de `init-queues.sh`. `invariants.ts` só importa tipos (`bun`, `./database`) e nada de `src/`. Não há `sleep`: o único `setTimeout` é o intervalo de polling do `eventually` e o timeout do probe de infra. O Bun.SQL expõe `errno` (SQLSTATE) e `constraint` no erro (conferido por script). Há teste para os 8 triggers e para todas as constraints nomeadas, exceto as listadas abaixo. `wallet_id_currency_uq` e `wager_tx_id_wallet_currency_uq` não podem ser violadas sozinhas, porque contêm a PK. `queues.ts` e `fixtures.ts` estão no escopo (`test/support/**`, TESTES §3 e §5).

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | bloqueante | `test/support/invariants.ts:85` | A checagem 2 exige `wallet_version = ROW_NUMBER()` (1..N), o que TESTES 3.5 não pede: o item 2 é só `balance_before = lag(balance_after)`. Isso gera falso positivo num fluxo válido. Uma wallet criada sem saldo fica com `version = 1` e sem lançamento (MODELAGEM 6, SCHEMA 3). O primeiro `WIN` a leva para `version = 2`, e o lançamento sai com `wallet_version = 2`. Reproduzi por SQL cru: o schema aceita e `assertAllWalletsConsistent` lança `[2] Cadeia de ledger quebrada … wallet_version 2, expected_version 1`. Como D40 roda no `afterEach` de todo teste de integração e concorrência, I-05 (sem saldo) e I-06 vão falhar. A versão já é coberta pela checagem 3 e por `ledger_chain` (versão estritamente crescente) | |
| 2 | bloqueante | `test/architecture/architecture.test.ts:131` | A guarda A-03 (ARQUITETURA 8: "o tipo `number` em propriedade chamada `amount`, `balance*` ou `money`") não pega `balance!: number` nem `amount!: number`. Essa é a forma padrão dos records do MikroORM em `src/infrastructure/persistence`, justamente a pasta que a guarda varre. Também não pega `amount: string \| number` nem `amount: bigint \| number`. As 4 amostras foram conferidas contra a regex e todas passam sem violação. O auto-teste não cobre `!:` nem union | |
| 3 | importante | `test/integration/schema.test.ts:51` | `expectPgError` aceita `constraint === nome` **ou** `message.includes(nome)`. As mensagens dos triggers e dos CHECKs trazem o nome no texto, então a verificação de nome cai para a mensagem quando o campo `CONSTRAINT` falta ou vem errado. Isso quebra D51 ("nome do trigger no campo `CONSTRAINT`"), e o campo existe no erro do Bun.SQL. Deve comparar só `constraint` | |
| 4 | importante | `test/integration/schema.test.ts:1594` | A PK duplicada do `inbox_message` só confere `23505`, sem nome de constraint (`inbox_message_pkey`). I-02 pede o código e a garantia que disparou | |
| 5 | importante | `test/integration/schema.test.ts` (grupo `wager_transaction`) | Duas FKs de `wager_transaction` não têm teste de violação: `wallet_id REFERENCES wallet` (`wager_transaction_wallet_id_fkey`) e `reference_transaction_id REFERENCES wager_transaction` (`wager_transaction_reference_transaction_id_fkey`). A nota (linha 14) diz que cobre "cada … `FOREIGN KEY`" | |
| 6 | importante | `test/integration/schema.test.ts:1089-1177` | `wager_tx_guard` só é testado mudando `status` de uma transação `PROCESSED`, o que falharia mesmo sem D52. Falta o caso central de D52, "terminal congelado inteiro": alterar só `balance_after`, `failure_code`, `reference_transaction_id` ou `updated_at` de uma terminal e esperar `23000 wager_tx_guard`. Faltam também os terminais `REJECTED` e `FAILED` e o caminho válido (`PENDING_REFERENCE` → ela mesma com novo agendamento, e → terminal), que SCHEMA 9 pede ("confirmar que o caminho válido passa") | |
| 7 | importante | `test/integration/schema.test.ts:241-248` | No I-01, a checagem de sobras depois do `down` só procura funções `%_fn` e as 5 tabelas. `wallet_ledger_assert(uuid, text)` não termina em `_fn`: se o `down` deixar de apagá-la, o teste passa. Também não confere triggers, índices nem objetos fora da lista, então o "down limpo" de SCHEMA 9 não é provado. Sugestão: exigir que `public` só tenha `mikro_orm_migrations` (e nenhuma função ou tipo) | |
| 8 | importante | `test/support/preload.ts:162` | `ensureTemplateDatabase` faz `DROP … WITH (FORCE)` e recria `wagering_template`, um nome fixo, na mesma instância de Postgres que todos os worktrees usam (AGENTS: infra compartilhada). Duas execuções em paralelo de branches diferentes derrubam o template uma da outra (o `pg_terminate_backend` mata o migrator alheio) ou clonam o schema da outra branch, e o teste passa ou falha contra migrations erradas. D34 fixa o nome, então mudar (ex.: `wagering_template_<runId>`, apagado no fim) é decisão pendente. Deve ser registrada | |
| 9 | importante | `test/architecture/architecture.test.ts:158-172` | A-01 usa lista negra (Nest, MikroORM, AWS, zod, outras camadas), mas ARQUITETURA 2 diz que `domain` importa "nada além da stdlib". Um `import Decimal from 'decimal.js'` ou qualquer pacote npm no domínio passa, e esse é justamente o caminho para float/decimal fora de 5.1. Deveria aceitar só imports relativos dentro de `src/domain` e `node:*` | |
| 10 | menor | `test/architecture/architecture.test.ts:197` | A-02 proíbe `zod` em `src/application`, e nem ARQUITETURA 2 nem TESTES A-02 fazem isso (só Nest, MikroORM e AWS). É uma decisão que os docs não tomam: precisa entrar em "Decisões pendentes" ou sair | |
| 11 | menor | `test/architecture/architecture.test.ts:131` | Nomes com prefixo ou sufixo (`totalAmount`, `openingBalance`, `amountCents`) não são pegos. Isso está fora da letra de ARQUITETURA 8, mas são propriedades de dinheiro. Vale ao menos aceitar maiúscula (`[aA]mount`, `[bB]alance`) | |
| 12 | menor | `test/integration/schema.test.ts:467-497, 1509-1539` | Os triggers deferred são verificados pelo nome, que só pode vir do `COMMIT`, mas o teste não separa o passo: não prova que os statements antes do `COMMIT` passaram e que o erro veio dele. Rodar o trabalho, conferir que não falhou e só então esperar o erro no `COMMIT` deixaria explícito o "commit falha" de SCHEMA 9 | |
| 13 | menor | `test/integration/schema.test.ts:1666` | `lock_timeout = '200ms'`, mas SCHEMA 9 diz "estoura em 2 s" (D21). Ou usa o valor de D21, ou a nota justifica a troca (tempo de suíte) | |
| 14 | menor | `test/support/fixtures.ts:3, 27, 44` | As fixtures "literais" de CHALLENGE 9/10 usam `WagerTransactionKind.Bet` do domínio em vez de `'BET'`. TESTES 5 pede os JSONs "como estão". Acoplado ao enum, o oráculo deixa de ser independente do código | |
| 15 | menor | `test/support/queues.ts:302, 234-286` | `delete()` usa `Promise.allSettled` e descarta as falhas, então filas vazam sem aviso. Se a criação falha no meio, a DLQ já criada não é apagada. `queues.ts` não é exercitado por nenhum teste da T15 | |
| 16 | menor | `test/integration/schema.test.ts:414-465` | `wallet_version_rule` cobre `currency` e `player_id`, mas não `id` nem `created_at`. `wager_tx_guard` cobre só `amount` entre as colunas de identidade (faltam ids, `kind`, `currency`, hash, key) | |
| 17 | menor | `docs/notas/T15-test-infra.md:14, 65` | A seção "Como verificar" ainda descreve a falha esperada antes da T14, mas a branch já está na `main` com as migrations. A linha 14 diz que cobre toda `FOREIGN KEY` (ver #5) | |

**Constraints e triggers sem teste de violação com SQLSTATE e nome:** `wager_transaction_wallet_id_fkey`, `wager_transaction_reference_transaction_id_fkey` e `inbox_message_pkey` (tem teste, mas sem nome). `wager_tx_guard` está coberto em parte: falta o congelamento inteiro (D52). Os 8 triggers têm ao menos um teste.

Veredito: mudanças necessárias
