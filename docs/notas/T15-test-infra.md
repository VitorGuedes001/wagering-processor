# T15 — Infra de teste e testes de schema

> Estado: Testada · Raia: G · Revisor: C · Branch: `t15-test-infra`

## O que muda

- `test/architecture/architecture.test.ts` — implementa os testes de arquitetura **A-01** (`src/domain` puro via lista branca: apenas imports relativos dentro de `src/domain` e `node:*`), **A-02** (fronteiras de `src/application`, `src/infrastructure` e `src/interface`) e **A-03** (guarda estática 5.1 contra `parseFloat`, `Number(`, `.toFixed`, `Math.` e `number` em propriedades monetárias com `:`, `?:`, `!:`, unions e prefixos/sufixos, com amostras positivas e negativas no auto-teste).
- `test/support/eventually.ts` — implementa `eventually(fn, { timeoutMs, intervalMs })` com polling curto (D39) para eliminar `sleep` em testes.
- `test/support/preload.ts` — implementa `checkInfrastructure()` (falha rápida com instrução `bun run infra:up` se PostgreSQL ou LocalStack SQS não responderem) e `ensureTemplateDatabase()` (recria `wagering_template_<hash do worktree>`, aplica migrations e encerra sessões antes do `CREATE DATABASE ... TEMPLATE`, D34, D60).
- `test/support/database.ts` — implementa `createTestDatabase({ fromTemplate })` e `dropTestDatabase()`, com conexões `Bun.SQL` isoladas por arquivo de teste, `connect()` para sessões concorrentes (locks), `migrateUp()`, `migrateDownToZero()`, `reset()` (`session_replication_role = replica`) e `drop()`.
- `test/support/invariants.ts` — implementa `assertAllWalletsConsistent(db)` em SQL puro (D40), verificando soma do ledger vs `wallet.balance`, cadeia contínua `balance_before = lag(balance_after)` (ou 0 no 1º lançamento) e ordem estritamente crescente de `wallet_version` (sem exigir contiguidade 1..N), correspondência com `wallet.version`, unicidade de reversão `PROCESSED` por referência e bijeção entre transações `PROCESSED` que movem saldo e lançamentos.
- `test/support/queues.ts` — implementa `createTestQueues(prefix)` e `deleteTestQueues()` no LocalStack SQS (D35), criando as 3 filas FIFO isoladas (`input`, `dlq`, `events`) com a mesma `RedrivePolicy` (`maxReceiveCount = 5`) e `VisibilityTimeout = 30` de `init-queues.sh`, limpeza de criação parcial em erro e propagação de falha no `delete()`.
- `test/support/fixtures.ts` — exporta as fixtures JSON literais de `CHALLENGE.md` §9/§10 e os builders (`aWalletRequest`, `aBet`, `aWin`, `aLoss`, `aRefundOf`, `aRollbackOf`, `anSqsEnvelope`) com IDs únicos por chamada.
- `test/integration/schema.test.ts` — implementa os testes de integração **I-01** (`up → down → up` em banco vazio conferindo ausência total de tabelas, funções, triggers e índices das migrations após o `down`) e **I-02** (caminho feliz incluindo wallet sem saldo inicial com 1º lançamento em `wallet_version = 2`, triggers deferred com falha comprovada no `COMMIT`, `assertAllWalletsConsistent`, cada `CHECK`, `UNIQUE`, `FOREIGN KEY` e trigger de `wallet`, `wager_transaction` — incluindo congelamento integral D52 nos 3 status terminais e caminhos válidos de `PENDING_REFERENCE` —, `wallet_ledger_entry`, `inbox_message`, `outbox_message`, filas de teste SQS e contenção de lock `FOR UPDATE` por wallet com `lock_timeout = '2s'` `55P03`).
- `docs/TESTES.md` — atualiza a D34 e a seção 3.1 e registra a decisão **D60** (`wagering_template_<hash>` por worktree).

## Por quê

- **ARQUITETURA §2 e §8 (TESTES 4.1 — A-01, A-02, A-03):** garantir de forma automatizada que o domínio permaneça livre de pacotes externos (lista branca: só relativos de `src/domain` e `node:*`), que as camadas respeitem a direção de dependência e que nenhum ponto flutuante (`number`, `parseFloat`, `Number(`, `.toFixed`, `Math.`) entre em domínio ou persistência (restrição inviolável 5.1).
- **TESTES §1–§3 e §5 (D34, D35, D39, D40, D60):** fornecer isolamento por arquivo de teste e por worktree (banco clonado de `wagering_template_<hash>` e filas FIFO com prefixo único), verificação prévia da infraestrutura, polling determinístico sem `sleep` e checagem independente das 5 invariantes financeiras no banco.
- **SCHEMA §2, §3, §9 e EXECUCAO §6 (TESTES 4.2 — I-01 e I-02, D51, D52, D53):** exercitar a reversibilidade limpa das migrations e a violação por SQL cru de cada constraint, índice único, FK, trigger e lock contra o PostgreSQL real, verificando sempre `SQLSTATE` e o campo `constraint` do erro (D51).

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
  - `docs/TESTES.md`
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

1. `test/architecture/architecture.test.ts` — lista branca de imports em `src/domain` (A-01), fronteiras de camada (A-02) e scanner da guarda 5.1 com amostras positivas e negativas (A-03).
2. `test/support/eventually.ts` — helper de polling curto (D39).
3. `test/support/preload.ts`, `test/support/database.ts` e `docs/TESTES.md` — verificação de infra, criação do `wagering_template_<hash>` isolado por worktree (D34, D60) e ciclo de vida dos bancos `t_<uuid>` por arquivo.
4. `test/support/invariants.ts` — as 5 consultas SQL independentes da invariante financeira (D40), aceitando 1º lançamento em `wallet_version = 2` para wallet aberta sem saldo.
5. `test/support/queues.ts` e `test/support/fixtures.ts` — filas FIFO isoladas por teste (D35) e fixtures literais + builders de payloads (`CHALLENGE.md` §9/§10).
6. `test/integration/schema.test.ts` — testes I-01 e I-02 cobrindo migrations, constraints, FKs, triggers (`23000` com `constraint`), filas SQS de teste e locks (`FOR UPDATE` e `lock_timeout = '2s'` `55P03`).

## Como verificar

```bash
bun run tarefa:gate
bun run typecheck
bun run test
bun run test:integration
```

- `bun run tarefa:gate`, `bun run typecheck`, `bun run test` e `bun run test:integration` passam 100% verdes contra o PostgreSQL e o LocalStack SQS reais.

## Decisões pendentes

- (nenhuma — D60 aprovada pelo humano e registrada em `docs/TESTES.md`)

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
| 1 | bloqueante | `test/support/invariants.ts:85` | A checagem 2 exige `wallet_version = ROW_NUMBER()` (1..N), o que TESTES 3.5 não pede: o item 2 é só `balance_before = lag(balance_after)`. Isso gera falso positivo num fluxo válido. Uma wallet criada sem saldo fica com `version = 1` e sem lançamento (MODELAGEM 6, SCHEMA 3). O primeiro `WIN` a leva para `version = 2`, e o lançamento sai com `wallet_version = 2`. Reproduzi por SQL cru: o schema aceita e `assertAllWalletsConsistent` lança `[2] Cadeia de ledger quebrada … wallet_version 2, expected_version 1`. Como D40 roda no `afterEach` de todo teste de integração e concorrência, I-05 (sem saldo) e I-06 vão falhar. A versão já é coberta pela checagem 3 e por `ledger_chain` (versão estritamente crescente) | Corrigido: a checagem 2 em `test/support/invariants.ts` agora verifica `balance_before = lag(balance_after, 0)` e `wallet_version` estritamente crescente (`wallet_version > prev_version`), sem exigir contiguidade 1..N. Adicionado teste de integração cobrindo wallet aberta com saldo zero que recebe o 1º lançamento em `wallet_version = 2`, o 2º em `wallet_version = 3` e a detecção de quebra de cadeia. |
| 2 | bloqueante | `test/architecture/architecture.test.ts:131` | A guarda A-03 (ARQUITETURA 8: "o tipo `number` em propriedade chamada `amount`, `balance*` ou `money`") não pega `balance!: number` nem `amount!: number`. Essa é a forma padrão dos records do MikroORM em `src/infrastructure/persistence`, justamente a pasta que a guarda varre. Também não pega `amount: string \| number` nem `amount: bigint \| number`. As 4 amostras foram conferidas contra a regex e todas passam sem violação. O auto-teste não cobre `!:` nem union | Corrigido: a regex da guarda A-03 foi atualizada para capturar `:`, `?:`, `!:`, unions (`string \| number`, `bigint \| number`) e nomes com prefixo/sufixo (`*amount*`, `*balance*`, `*money*`). Adicionadas amostras positivas e negativas no auto-teste. |
| 3 | importante | `test/integration/schema.test.ts:51` | `expectPgError` aceita `constraint === nome` **ou** `message.includes(nome)`. As mensagens dos triggers e dos CHECKs trazem o nome no texto, então a verificação de nome cai para a mensagem quando o campo `CONSTRAINT` falta ou vem errado. Isso quebra D51 ("nome do trigger no campo `CONSTRAINT`"), e o campo existe no erro do Bun.SQL. Deve comparar só `constraint` | Corrigido: `expectPgError` agora compara exclusivamente `pgErr.constraint === expectedConstraintOrTrigger`, sem consultar `pgErr.message` (D51). |
| 4 | importante | `test/integration/schema.test.ts:1594` | A PK duplicada do `inbox_message` só confere `23505`, sem nome de constraint (`inbox_message_pkey`). I-02 pede o código e a garantia que disparou | Corrigido: o teste de PK duplicada de `inbox_message` agora confere `'23505'` e `'inbox_message_pkey'`. |
| 5 | importante | `test/integration/schema.test.ts` (grupo `wager_transaction`) | Duas FKs de `wager_transaction` não têm teste de violação: `wallet_id REFERENCES wallet` (`wager_transaction_wallet_id_fkey`) e `reference_transaction_id REFERENCES wager_transaction` (`wager_transaction_reference_transaction_id_fkey`). A nota (linha 14) diz que cobre "cada … `FOREIGN KEY`" | Corrigido: adicionados testes de violação (`23503`) para `wager_transaction_wallet_id_fkey` e `wager_transaction_reference_transaction_id_fkey`. |
| 6 | importante | `test/integration/schema.test.ts:1089-1177` | `wager_tx_guard` só é testado mudando `status` de uma transação `PROCESSED`, o que falharia mesmo sem D52. Falta o caso central de D52, "terminal congelado inteiro": alterar só `balance_after`, `failure_code`, `reference_transaction_id` ou `updated_at` de uma terminal e esperar `23000 wager_tx_guard`. Faltam também os terminais `REJECTED` e `FAILED` e o caminho válido (`PENDING_REFERENCE` → ela mesma com novo agendamento, e → terminal), que SCHEMA 9 pede ("confirmar que o caminho válido passa") | Corrigido: adicionados testes de D52 alterando individualmente `balance_after`, `processed_at`, `failure_code`, `reference_transaction_id` e `updated_at` (sem mudar `status`) em transações `PROCESSED`, `REJECTED` e `FAILED`, além dos caminhos válidos de `PENDING_REFERENCE` (reagendamento `PENDING_REFERENCE → PENDING_REFERENCE` e transições para `PROCESSED`, `REJECTED` e `FAILED`). |
| 7 | importante | `test/integration/schema.test.ts:241-248` | No I-01, a checagem de sobras depois do `down` só procura funções `%_fn` e as 5 tabelas. `wallet_ledger_assert(uuid, text)` não termina em `_fn`: se o `down` deixar de apagá-la, o teste passa. Também não confere triggers, índices nem objetos fora da lista, então o "down limpo" de SCHEMA 9 não é provado. Sugestão: exigir que `public` só tenha `mikro_orm_migrations` (e nenhuma função ou tipo) | Corrigido: após `migrateDownToZero()`, o I-01 agora verifica que em `public` resta apenas a tabela `mikro_orm_migrations` e zero funções (`pg_proc`), zero triggers (`pg_trigger`) e zero índices das migrations (`pg_indexes`). |
| 8 | importante | `test/support/preload.ts:162` | `ensureTemplateDatabase` faz `DROP … WITH (FORCE)` e recria `wagering_template`, um nome fixo, na mesma instância de Postgres que todos os worktrees usam (AGENTS: infra compartilhada). Duas execuções em paralelo de branches diferentes derrubam o template uma da outra (o `pg_terminate_backend` mata o migrator alheio) ou clonam o schema da outra branch, e o teste passa ou falha contra migrations erradas. D34 fixa o nome, então mudar (ex.: `wagering_template_<runId>`, apagado no fim) é decisão pendente. Deve ser registrada | Corrigido conforme decisão D60 aprovada pelo humano: `TEMPLATE_DB_NAME` agora é `wagering_template_<hash curto do caminho absoluto do worktree>`, e `docs/TESTES.md` foi atualizado na D34, na seção 3.1 e com o registro da D60. |
| 9 | importante | `test/architecture/architecture.test.ts:158-172` | A-01 usa lista negra (Nest, MikroORM, AWS, zod, outras camadas), mas ARQUITETURA 2 diz que `domain` importa "nada além da stdlib". Um `import Decimal from 'decimal.js'` ou qualquer pacote npm no domínio passa, e esse é justamente o caminho para float/decimal fora de 5.1. Deveria aceitar só imports relativos dentro de `src/domain` e `node:*` | Corrigido: A-01 agora usa lista branca (`isAllowedDomainImport`), aceitando exclusivamente caminhos relativos que resolvem dentro de `src/domain` e módulos `node:*`, com auto-teste cobrindo pacotes externos (`decimal.js`, `zod`, `@nestjs/*`, etc.) e outras camadas. |
| 10 | menor | `test/architecture/architecture.test.ts:197` | A-02 proíbe `zod` em `src/application`, e nem ARQUITETURA 2 nem TESTES A-02 fazem isso (só Nest, MikroORM e AWS). É uma decisão que os docs não tomam: precisa entrar em "Decisões pendentes" ou sair | Corrigido: removida a proibição de `zod` em `src/application` no teste A-02. |
| 11 | menor | `test/architecture/architecture.test.ts:131` | Nomes com prefixo ou sufixo (`totalAmount`, `openingBalance`, `amountCents`) não são pegos. Isso está fora da letra de ARQUITETURA 8, mas são propriedades de dinheiro. Vale ao menos aceitar maiúscula (`[aA]mount`, `[bB]alance`) | Corrigido: a regex de A-03 agora é case-insensitive e captura qualquer identificador com prefixo ou sufixo contendo `amount`, `balance` ou `money` (`totalAmount`, `openingBalance`, `amountCents`, `balanceAfter`, `initialMoney`, etc.). |
| 12 | menor | `test/integration/schema.test.ts:467-497, 1509-1539` | Os triggers deferred são verificados pelo nome, que só pode vir do `COMMIT`, mas o teste não separa o passo: não prova que os statements antes do `COMMIT` passaram e que o erro veio dele. Rodar o trabalho, conferir que não falhou e só então esperar o erro no `COMMIT` deixaria explícito o "commit falha" de SCHEMA 9 | Corrigido: extraído `expectDeferredCommitError`, que executa o `INSERT`/`UPDATE` dentro de `BEGIN`, confirma que os statements completaram sem erro e verifica que `expectPgError` dispara especificamente no `COMMIT`. |
| 13 | menor | `test/integration/schema.test.ts:1666` | `lock_timeout = '200ms'`, mas SCHEMA 9 diz "estoura em 2 s" (D21). Ou usa o valor de D21, ou a nota justifica a troca (tempo de suíte) | Corrigido: o teste de `lock_timeout` agora usa `SET LOCAL lock_timeout = '2s'` (valor literal de D21 e SCHEMA §9) e confere a duração até o erro `55P03`. |
| 14 | menor | `test/support/fixtures.ts:3, 27, 44` | As fixtures "literais" de CHALLENGE 9/10 usam `WagerTransactionKind.Bet` do domínio em vez de `'BET'`. TESTES 5 pede os JSONs "como estão". Acoplado ao enum, o oráculo deixa de ser independente do código | Corrigido: `CHALLENGE_WAGER_FIXTURE` e `CHALLENGE_SQS_MESSAGE_FIXTURE` agora usam a string literal `'BET'`, mantendo os JSONs de `CHALLENGE.md` §9/§10 desacoplados do enum de domínio. |
| 15 | menor | `test/support/queues.ts:302, 234-286` | `delete()` usa `Promise.allSettled` e descarta as falhas, então filas vazam sem aviso. Se a criação falha no meio, a DLQ já criada não é apagada. `queues.ts` não é exercitado por nenhum teste da T15 | Corrigido: `createTestQueues` agora remove filas parcialmente criadas em caso de falha no meio da criação, `delete()` propaga erro se qualquer `DeleteQueueCommand` falhar (exceto fila já inexistente) e `schema.test.ts` exercita `createTestQueues`/`deleteTestQueues` verificando os atributos FIFO e `RedrivePolicy` no LocalStack. |
| 16 | menor | `test/integration/schema.test.ts:414-465` | `wallet_version_rule` cobre `currency` e `player_id`, mas não `id` nem `created_at`. `wager_tx_guard` cobre só `amount` entre as colunas de identidade (faltam ids, `kind`, `currency`, hash, key) | Corrigido: adicionados testes de mutação de `id` e `created_at` em `wallet_version_rule` e de todas as 14 colunas de identidade (`id`, `wallet_id`, `player_id`, `kind`, `amount`, `currency`, `provider_id`, `external_transaction_id`, `idempotency_key`, `payload_hash`, `round_id`, `game_id`, `reference_external_transaction_id`, `created_at`) em `wager_tx_guard`. |
| 17 | menor | `docs/notas/T15-test-infra.md:14, 65` | A seção "Como verificar" ainda descreve a falha esperada antes da T14, mas a branch já está na `main` com as migrations. A linha 14 diz que cobre toda `FOREIGN KEY` (ver #5) | Corrigido: a seção "Como verificar" e o resumo da nota foram atualizados para refletir a branch pós-rebase com T10, T11, T12 e T14 e a cobertura completa de FKs. |

**Constraints e triggers sem teste de violação com SQLSTATE e nome:** `wager_transaction_wallet_id_fkey`, `wager_transaction_reference_transaction_id_fkey` e `inbox_message_pkey` (tem teste, mas sem nome). `wager_tx_guard` está coberto em parte: falta o congelamento inteiro (D52). Os 8 triggers têm ao menos um teste.

Veredito: mudanças necessárias
