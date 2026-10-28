# Passo 6 — Arquitetura: camadas, portas e onde os patterns entram

Organiza o código que implementa [MODELAGEM.md](MODELAGEM.md) e
[SCHEMA.md](SCHEMA.md). `§N` aponta para [CHALLENGE.md](CHALLENGE.md); `Dn`
para as decisões dos passos 4 e 5.

Critério: cada pattern precisa nascer de uma fronteira real. A avaliação pontua
simplicidade (§14, "Modelagem e arquitetura"), então pattern sem fronteira é
custo sem retorno.

---

## 1. Decisões deste passo

| # | Decisão | Por quê |
|---|---|---|
| D23 | Quatro camadas: `domain`, `application`, `infrastructure`, `interface`. A dependência aponta só para dentro | O domínio não importa Nest nem MikroORM (§6.1). Os use cases não sabem se a entrada é HTTP ou SQS (§10) |
| D24 | Um único use case `SubmitWagerTransaction` para HTTP e SQS. A inbox é um parâmetro opcional dele, não um segundo caminho | §10: "o mesmo use case". A inbox precisa estar na mesma transação SQL (§6.5) |
| D25 | Os repositórios chegam ao use case **dentro** de uma Unit of Work explícita, `uow.run(async (tx) => …)`, e não por injeção global | Fica visível no código o que está dentro da transação. Nada de `AsyncLocalStorage` para transação |
| D26 | Desfechos esperados são **valores** (união discriminada). Exceção fica para bug e falha transitória | `REJECTED` não é erro: é resultado persistido. Assim o mapeamento para HTTP e SQS é uma tabela, não um `catch` espalhado |
| D27 | Validação de entrada com **zod**, num schema único para HTTP e SQS | Mesmas regras nas duas entradas. `z.string()` em `amount` barra número JSON (restrição 5.1, ver seção 8). Evita `class-validator` + `class-transformer`, que dependem de metadata de decorators |
| D28 | Um processo roda tudo (API, consumidor, workers), com componentes ligados por env | Os testes com ≥ 3 instâncias (§13.4) sobem o mesmo binário 3×. Flags permitem isolar componentes em teste |
| D29 | Logs com o `ConsoleLogger` do Nest em modo JSON. Contexto de log (`correlationId` etc.) via `AsyncLocalStorage` | Sem dependência nova. ALS aqui é só para log, nunca para transação |
| D30 | Métricas com `@prometheus-io/client` em `GET /metrics` | Formato padrão, contador e histograma prontos. §12 não fixa formato. É o sucessor oficial do `prom-client`, que foi depreciado, com a mesma API |
| D31 | Autenticação não implementada. Ficam `AuthGuard` no-op e `ProviderIdentityPort` como pontos de extensão | Auth não vale pontos (§2). O desenho com Keycloak fica descrito na seção 10 |
| D32 | Workers são laços simples com `setTimeout`, presos ao ciclo de vida do Nest | Dois workers não justificam `@nestjs/schedule`, e o laço permite drenar no `SIGTERM` |
| D48 | O lease das portas é `leaseMs: number`. O tipo `Duration` citado na seção 3 não existe | Sem tipo novo para uma duração em milissegundos (T01) |
| D49 | Tipos de entrada e saída dos use cases (`WagerCommand`, `TransactionView`, `SubmitOutcome` etc.) ficam em `src/application/contracts.ts`, separados das portas em `ports.ts` | O HTTP (T31) programa contra eles antes do use case (T30) existir (T01) |
| D50 | `RequestErrorCode` (MODELAGEM 10.2) fica em `application/contracts.ts`. `FailureCode` fica em `domain` | Erro de requisição nasce no use case. `FailureCode` é gravado na transação (T01) |

## 2. Camadas

```
interface        HTTP controllers · SQS consumer · workers · health · metrics
   │  chama
application      use cases · portas (interfaces) · resultado tipado
   │  usa
domain           Money · Wallet · WagerTransaction · WalletLedgerEntry · Inbox/Outbox
                 decideWager · reconcile · eventos · payloadHash
   ▲  implementa as portas de application
infrastructure   repositórios MikroORM · Unit of Work · publisher SQS · clock · ids · métricas
```

| Camada | Pode importar | Não pode importar |
|---|---|---|
| `domain` | nada além da stdlib | Nest, MikroORM, AWS SDK, zod |
| `application` | `domain` | Nest (exceto `@Injectable` no módulo de composição), MikroORM, AWS SDK |
| `infrastructure` | `domain`, `application`, libs | `interface` |
| `interface` | `application`, `domain` (tipos), zod, Nest | MikroORM, AWS SDK diretamente |

A regra é verificada por um teste que lê os `import` de cada pasta (seção 11).

### 2.1 Pastas

```
src/
  domain/
    money.ts  wallet.ts  wager-transaction.ts  wallet-ledger-entry.ts
    inbox-message.ts  outbox-message.ts  failure-code.ts  errors.ts
    decide-wager.ts  reconcile.ts  payload-hash.ts
    events/  integration-event.ts  wager-transaction-processed.ts  …
  application/
    ports.ts                       # todas as portas, num arquivo só
    submit-wager-transaction.ts    create-wallet.ts
    resolve-pending-references.ts  publish-outbox.ts
    reconcile-wallet.ts            queries.ts   # leituras simples
  infrastructure/
    persistence/  persistence.module.ts  mikro-orm.config.ts  records/*.ts  unit-of-work.ts  *-repository.ts  db-errors.ts
    messaging/    messaging.module.ts  sqs-event-publisher.ts
    observability/  logger.ts  metrics.ts  request-context.ts
    health/       readiness-probe.ts   # toca Postgres e SQS, por isso fica fora de interface
    clock.ts  id-generator.ts  config.ts
  interface/
    http/     wallets.controller.ts  wagering.controller.ts  error-mapping.ts  schemas.ts  auth.guard.ts
    sqs/      wager-transaction.consumer.ts
    workers/  outbox.worker.ts  pending-reference.worker.ts
    health/   health.controller.ts
  app.module.ts  main.ts
migrations/
```

Os records do MikroORM (`records/`) são as entidades de persistência. O nome
evita confusão com as entidades de domínio.

## 3. Portas

Só existem portas onde há troca real de implementação (banco, fila) ou onde o
teste precisa de controle (relógio, ids).

```ts
interface UnitOfWork {
  /** Abre transação (READ COMMITTED + timeouts D21) e entrega os repositórios ligados a ela. */
  run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T>;
  /** Snapshot só-leitura para reconciliação (D22). */
  readSnapshot<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T>;
}

interface TxRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

interface WalletRepository {
  lockById(id: string): Promise<Wallet | undefined>;          // FOR UPDATE
  findById(id: string): Promise<Wallet | undefined>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet, expectedVersion: number): Promise<void>;  // WHERE version = $v
}

interface WagerTransactionRepository {
  findByIdempotencyKey(providerId: string, key: string): Promise<WagerTransaction | undefined>;
  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  lockById(id: string): Promise<WagerTransaction | undefined>;
  claimDuePendingReferences(now: Date, limit: number, lease: Duration): Promise<string[]>;
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
}

interface LedgerRepository {
  insert(entry: WalletLedgerEntry): Promise<void>;
  page(walletId: string, afterVersion: number, limit: number): Promise<WalletLedgerEntry[]>;
  all(walletId: string): Promise<WalletLedgerEntry[]>;   // reconciliação
}

interface InboxRepository {
  /** INSERT … ON CONFLICT DO NOTHING. Devolve o hash gravado quando já existia. */
  tryReceive(message: InboxMessage): Promise<{ accepted: true } | { accepted: false; storedPayloadHash: string }>;
  markProcessed(message: InboxMessage): Promise<void>;
}

interface OutboxRepository {
  enqueue(messages: OutboxMessage[]): Promise<void>;
  claimDue(now: Date, limit: number, lease: Duration): Promise<OutboxMessage[]>;
  markPublished(id: string, at: Date): Promise<void>;
  scheduleRetry(message: OutboxMessage): Promise<void>;
}

interface EventPublisher {       // SQS, fora de transação
  publish(message: OutboxMessage): Promise<void>;
}

interface Clock { now(): Date }
interface IdGenerator { next(): string }                // UUIDv7
interface ProviderIdentityPort { assertMaySubmit(caller: CallerIdentity, providerId: string): void }
```

Ficam **sem** porta: logger e métricas, que são infraestrutura transversal
injetada direto (trocar por fake em teste não agrega), e as leituras de
`queries.ts`, que usam os mesmos repositórios.

## 4. Use cases

| Use case | Entrada | Transação | Notas |
|---|---|---|---|
| `CreateWallet` | `{ playerId, initialBalance }` | 1 | `Wallet.open` + `OPENING` + lançamento + eventos |
| `SubmitWagerTransaction` | `WagerCommand` + `inbox?` | 1 | fluxo de SCHEMA 4.2/4.4 |
| `ResolvePendingReferences` | tick do worker | 1 de claim + 1 por item | SCHEMA 4.5 |
| `PublishOutbox` | tick do worker | claim + 1 update por item | publica fora de transação |
| `ReconcileWallet` | `walletId` | snapshot | `reconcile()` do domínio. Divergência → log + métrica |
| `queries.ts` | ids, cursor | nenhuma ou leitura simples | wallet, extrato, transação por id, por id externo |

### 4.1 `SubmitWagerTransaction`

```ts
interface WagerCommand {
  providerId: string; externalTransactionId: string; idempotencyKey: string;
  playerId: string; walletId: string; roundId: string; gameId: string;
  kind: SubmittableKind;                 // WagerTransactionKind sem OPENING
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string; causationId?: string;
}

type SubmitOutcome =
  | { type: 'RESULT'; view: TransactionView; idempotentReplay: boolean }   // PROCESSED | REJECTED | PENDING_REFERENCE
  | { type: 'IDEMPOTENCY_CONFLICT' }
  | { type: 'EXTERNAL_ID_CONFLICT' }
  | { type: 'WALLET_NOT_FOUND' }
  | { type: 'DUPLICATE_MESSAGE' }                 // inbox, mesmo hash
  | { type: 'MESSAGE_PAYLOAD_MISMATCH' };         // inbox, D7

interface TransactionView {
  transactionId: string; status: WagerTransactionStatus;
  balance: MoneyProps | undefined;     // snapshot D10; ausente em PENDING_REFERENCE e FAILED
  failureCode?: FailureCode;
}
```

O use case faz: comando → `Money.from` + `WagerTransaction.create` +
`payloadHash`, depois o fluxo de SCHEMA 4.2 dentro de `uow.run`. Em violação
`23505` dos índices de idempotência, refaz **uma** vez (SCHEMA 5).

Exceções que escapam do use case:

| Exceção | Significado |
|---|---|
| `InvalidMoneyError`, `InvalidWagerRequestError` | payload inválido, lançadas antes da transação |
| `TransientInfrastructureError` | lock_timeout, deadlock, conexão (SCHEMA 5) |
| qualquer outra | bug |

## 5. Onde cada pattern entra

| Pattern | Onde | Fronteira que justifica |
|---|---|---|
| Value Object | `Money` | precisão e moeda (§6.1) |
| Aggregate Root | `Wallet` | unidade de consistência e de lock (§8) |
| Factory methods + `rehydrate` | todas as entidades | exigido por §6.0. Separa "criar com regra" de "reconstruir do banco" |
| Domain Service (função pura) | `decideWager`, `reconcile` | a regra envolve três objetos (transação, wallet, referência). Não pertence a nenhum deles sozinho |
| Repository | `infrastructure/persistence` | domínio ↔ MikroORM |
| Unit of Work | `UnitOfWork.run` | atomicidade inbox + wallet + ledger + outbox (§11) |
| Transactional Outbox | `OutboxMessage` + `PublishOutbox` | publicar só depois do commit (restrição 4) |
| Idempotent Consumer (Inbox) | `InboxRepository.tryReceive` | entrega at-least-once (§3, §10) |
| Competing Consumers com lease | workers | várias instâncias no mesmo outbox (§13.6) |
| Ports & Adapters | `application/ports.ts` | banco e fila reais em teste. Relógio e ids controlados |

Recusados de propósito, com motivo para o `ARCHITECTURE.md`:

| Pattern | Por que não |
|---|---|
| CQRS com modelo de leitura separado | as leituras são poucas e simples. O ledger já é o histórico |
| Event Sourcing | o enunciado pede saldo materializado + ledger. O ledger já é a trilha auditável |
| `@nestjs/cqrs` (command bus, mediator) | uma camada de indireção para cinco use cases |
| Repositório genérico `Repository<T>` | cada repositório tem consultas próprias (lock, claim, `SKIP LOCKED`) |
| Saga / orquestração | não há transação distribuída: tudo financeiro está em um banco só |

## 6. Contrato HTTP

### 6.1 Cabeçalhos

| Header | Regra |
|---|---|
| `Idempotency-Key` | obrigatório em `POST /wagering/transactions` (D5). No máximo 256 caracteres |
| `X-Correlation-Id` | opcional. Se ausente, gera UUIDv7. Sempre devolvido na resposta |

### 6.2 Status

Fecha o que o passo 4 deixou como proposta (MODELAGEM 10.3). O corpo de erro é
sempre `{ "code": "...", "message": "...", "details"?: [...] }`.

| Situação | HTTP | `code` |
|---|---|---|
| `POST /wallets` criado | 201 | — |
| `PROCESSED` | 200 | — |
| `PENDING_REFERENCE` | 202 | — |
| `REJECTED` | 422 | o `failureCode` |
| payload inválido (zod, `Money`, regras de `create`, header ausente) | 400 | `INVALID_PAYLOAD` |
| wallet / transação inexistente | 404 | `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` |
| conflitos | 409 | `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` |
| `FAILED` (consultado depois) | 200 no `GET`, com `status: FAILED` | — |
| falha transitória | 503 + `Retry-After: 1` | `SERVICE_UNAVAILABLE` |
| bug | 500 | `INTERNAL_ERROR` |

Os 2xx e o 422 têm o mesmo corpo, `TransactionView` + `idempotentReplay`. Assim o
provedor decide pela combinação de status + `code`, sem ler mensagem. O replay
devolve o status original.

### 6.3 Formatos

| Rota | Resposta |
|---|---|
| `POST /wallets`, `GET /wallets/:id` | `{ id, playerId, balance, version }` (§9) |
| `GET /wallets/:id/ledger` | `{ items: [{ id, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion, createdAt }], nextCursor }`, com `limit` de 1 a 200 e padrão 50 |
| `POST /wagering/transactions` | `{ transactionId, status, balance, failureCode?, idempotentReplay }` |
| `GET /wagering/transactions/:id` e por id externo | a transação completa: ids, kind, money, status, failureCode, referências, datas |
| `POST /wallets/:id/reconciliation` | formato de §9 |
| `GET /health/live` | 200 sempre que o processo responde |
| `GET /health/ready` | 200 com as duas dependências OK. **503** quando alguma falha |

Hoje `/health/ready` devolve 200 mesmo `degraded`, e isso precisa mudar: um
orquestrador lê readiness pelo status, não pelo corpo.

## 7. Mensageria

### 7.1 Filas

| Fila | Atributos |
|---|---|
| `wager-transactions.fifo` | **redrive para a DLQ com `maxReceiveCount = 5`**, visibility timeout 30 s |
| `wager-transactions-dlq.fifo` | — |
| `wagering-events.fifo` | saída do outbox (D20) |

O `init-queues.sh` atual cria as duas filas **sem** redrive policy: a DLQ existe,
mas nada chega nela. É preciso corrigir antes de testar retry e DLQ (§13).

### 7.2 Consumidor

- Long polling de 20 s, lotes de até 10 mensagens, até N handlers em paralelo
  por instância (`SQS_CONSUMER_CONCURRENCY`, padrão 5).
- O FIFO entrega em ordem por `MessageGroupId`. Recomendação ao produtor:
  `walletId` como grupo. É otimização: a correção vem do banco.
- Parse: `JSON.parse` → schema zod do envelope (`type` precisa ser
  `WagerTransactionRequested`) → `data` validado pelo **mesmo** schema do HTTP.

| Resultado | Ação na fila | Métrica |
|---|---|---|
| `RESULT` (qualquer status), `DUPLICATE_MESSAGE` | `DeleteMessage` (ack) | por status / duplicatas |
| `WALLET_NOT_FOUND`, conflitos de idempotência | ack + log `warn` | rejeições |
| payload inválido, `type` desconhecido, `MESSAGE_PAYLOAD_MISMATCH` | não faz ack e zera a visibilidade (`ChangeMessageVisibility 0`) até o redrive levar à DLQ. Na última entrega, grava `FAILED` se a transação for identificável | DLQ |
| `TransientInfrastructureError` | não faz ack. Visibilidade com backoff: `min(2^receiveCount, 60) s` | retries |
| bug | igual ao transitório. Se persistir, a DLQ recebe | erro |

Uma mensagem permanentemente inválida vai para a DLQ pelo redrive, e não por
envio manual: o SQS cuida da contagem e não há janela em que a mensagem possa se
perder.

### 7.3 Desligamento (`SIGTERM`)

1. Nest `enableShutdownHooks()`. O consumidor para de chamar `ReceiveMessage`.
2. Aguarda os handlers em andamento até `SHUTDOWN_GRACE_MS` (padrão 20 s).
3. Mensagens ainda em memória sem processar: `ChangeMessageVisibility 0`, que
   devolve à fila na hora.
4. Workers terminam o item atual. Linhas reservadas e não concluídas voltam pelo
   lease.
5. Fecha o MikroORM e o cliente SQS.

Se o processo morrer sem drenar (`SIGKILL`), a correção não depende disso: o
commit é atômico e a redelivery cai na inbox.

## 8. Restrição 5.1 nas fronteiras

O núcleo já usa `bigint` (D8) e `numeric(19,2)`. A fronteira é onde o float
costuma entrar sem ninguém notar, então cada passagem tem uma regra:

| Passagem | Regra | Verificação |
|---|---|---|
| JSON de entrada → DTO | `amount: z.string()`. Número JSON é `INVALID_PAYLOAD` | teste HTTP e SQS com `"amount": 25` → 400 / DLQ |
| string → `Money` | parse só textual: separa inteiro e centavos por regex e monta `BigInt(inteiro) * 100n + BigInt(centavos)` | teste unitário. Guarda estática (abaixo) |
| `Money` → string | formatação textual de `bigint` (`/ 100n`, `% 100n`, `padStart`) | teste unitário |
| banco → record | propriedades de dinheiro tipadas `string`, sem `runtimeType: 'number'` | teste de integração: `typeof` do valor lido |
| agregação SQL | soma em `numeric`, sem `::float`. Resultado lido como string | teste de reconciliação |
| eventos / respostas | só `MoneyProps` | o `toJSON` de `bigint` lança. Um vazamento quebra o teste em vez de passar calado |
| métricas | nenhum valor monetário vira label ou observação de histograma | revisão. Não há métrica de valor |

**Guarda estática:** um teste (`bun test`) varre `src/domain` e
`src/infrastructure/persistence` e falha se encontrar `parseFloat`, `Number(`,
`toFixed`, `Math.` ou o tipo `number` em propriedade chamada `amount`,
`balance*` ou `money`. É simples e grosseiro de propósito: um falso positivo se
resolve com um comentário de exceção explícito.

## 9. Observabilidade

| Item | Como |
|---|---|
| Logs | `ConsoleLogger({ json: true })`. Contexto por requisição/mensagem via ALS: `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` (§12) |
| Proibido em log | payload completo, `amount`, saldo. Só ids, kind, status e código |
| Métricas | `wagering_transactions_total{kind,status}`, `wagering_duplicates_total{source=http\|inbox}`, `wagering_retries_total{component}`, `wagering_dlq_total`, `wagering_lock_conflicts_total`, `wagering_outbox_lag_seconds` (gauge), `wagering_processing_duration_seconds{entry}` (histograma), `wagering_reconciliation_mismatch_total` |
| Health | `live` = processo. `ready` = `select 1` + `GetQueueAttributes` na fila de entrada, com timeout de 2 s cada |

`outbox_lag` é calculado pelo worker a cada tick (SCHEMA 4.6) e publicado como
gauge.

## 10. Autenticação (D31)

Não implementada. Fica no código:

- `AuthGuard` global no-op que anexa `CallerIdentity { providerId: undefined }`.
  As rotas `/health/*` e `/metrics` ficam marcadas como `@Public()`.
- `ProviderIdentityPort.assertMaySubmit(caller, payload.providerId)`, chamado
  pelo controller. A implementação atual aceita tudo.

Desenho que seria adotado: um Keycloak no Compose, com um client por provedor
(fluxo client credentials). O guard valida o JWT pelo JWKS, e o `azp` do token
vira `providerId`. O port rejeita com 403 quando o `providerId` do payload
diverge do token. Mensagens da fila são canal interno confiável (§2), mas o
`providerId` delas passa pelas mesmas validações de domínio.

## 11. Composição e configuração

**Módulos Nest:** `PersistenceModule` (MikroORM, UoW, repositórios),
`MessagingModule` (cliente SQS, publisher, consumidor), `WageringModule`
(controllers, use cases, workers), `ObservabilityModule` (logger, métricas,
contexto) e `HealthModule`. O domínio não é módulo: é código puro importado.

| Variável | Padrão | Para quê |
|---|---|---|
| `DB_*`, `SQS_ENDPOINT`, `AWS_REGION`, `PORT` | já existem | |
| `ENABLE_HTTP`, `ENABLE_CONSUMER`, `ENABLE_OUTBOX_WORKER`, `ENABLE_REFERENCE_WORKER` | `true` | isolar componentes em teste (D28) |
| `SQS_CONSUMER_CONCURRENCY` | 5 | |
| `OUTBOX_POLL_MS` / `OUTBOX_BATCH` / `OUTBOX_LEASE_MS` | 500 / 50 / 30000 | |
| `REFERENCE_POLL_MS` / `REFERENCE_MAX_ATTEMPTS` / `REFERENCE_BACKOFF_BASE_MS` | 1000 / 10 / 1000 | D11 |
| `SQS_INPUT_QUEUE` / `SQS_DLQ` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events.fifo` | filas isoladas por teste ([TESTES.md](TESTES.md), D35) |
| `DB_LOCK_TIMEOUT_MS` | 2000 | D21. Os testes com portão de lock sobem esse valor |
| `FAULT_POINT` | — | só em teste ([TESTES.md](TESTES.md), D38) |
| `SHUTDOWN_GRACE_MS` | 20000 | |
| `CONSUMER_NAME` | `wager-transactions-consumer` | chave da inbox |

A configuração é lida e validada (zod) uma vez no boot. Valor inválido derruba o
processo na largada.

**Testes de arquitetura (`bun test`):** a regra de import da seção 2 e a guarda
5.1 da seção 8.

## 12. O que muda no esqueleto atual

| Arquivo | Mudança |
|---|---|
| `docker/localstack/init-queues.sh` | redrive policy (`maxReceiveCount 5`), visibility 30 s, fila `wagering-events.fifo` |
| `src/app.module.ts` | quebra em módulos. Health vai para `interface/health` com 503 em `ready` degradado |
| `src/main.ts` | `enableShutdownHooks()` e logger JSON |
| `src/mikro-orm.config.ts` | move para `infrastructure/persistence`. Records explícitos |
| `smoke_balance` (entidade, migration, script) | remover (SCHEMA 8) |
| `package.json` | `+ zod`, `+ @prometheus-io/client`, `- decimal.js` (D8). Scripts de teste por nível ([TESTES.md](TESTES.md) 2) |
| `src/main.ts` | aceitar `PORT=0` e anunciar a porta real no log de boot |
| `Dockerfile` (novo) | imagem da aplicação, para entrar no Compose e para o teste de `SIGTERM` em Linux |
