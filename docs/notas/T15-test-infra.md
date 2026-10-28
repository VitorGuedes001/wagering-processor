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

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
