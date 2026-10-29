# T40 — Consumidor SQS 🔒

> Estado: Testada · Raia: C · Revisor: G · Branch: `t40-sqs-consumer`

## O que muda

- `src/interface/sqs/wager-transaction.consumer.ts` (novo): laço de long polling com concorrência limitada, ordem por `MessageGroupId` dentro do lote, ack só depois do commit, visibilidade 0 ou backoff, métricas, logs com contexto e drenagem no `SIGTERM`.
- `src/interface/sqs/wager-transaction.message.ts` (novo): schema do envelope, com `data` validado pelo schema do HTTP; `parseEnvelope`, `classifyOutcome`, `classifyError` e `retryDelaySeconds`, que são funções puras.
- `src/infrastructure/messaging/sqs-input-queue.ts` (novo): adaptador da fila de entrada (receive, ack, visibilidade, `maxReceiveCount` lido da `RedrivePolicy`). É o único arquivo do consumidor que importa o AWS SDK.
- `src/infrastructure/messaging/messaging.module.ts`: fornece o `SqsInputQueue` e fecha o `SQSClient` no shutdown.
- `src/application/record-processing-failure.ts` (novo): grava `FAILED`/`PROCESSING_FAILED` na última entrega, numa transação própria (DP-3).
- `src/application/submit-wager-transaction.ts`: marca a inbox `processed` nos retornos antecipados (DP-4). Commit próprio, `64005ef`, e mudança mínima por causa da T42.
- `src/interface/wagering.module.ts`: registra `RecordProcessingFailure` e `WagerTransactionConsumer`. `withUnitOfWork` (testes em processo) sobe só o HTTP, com `ENABLE_CONSUMER=false` e sem adaptador SQS.
- `test/integration/sqs-consumer.test.ts` (novo): I-12, I-13, I-14, I-15 (a e b) e a metade SQS do I-11, com app real e banco e filas próprios.
- `test/support/queues.ts`: `sendEnvelope`, `queueDepth` e `peekBodies`.
- `ARCHITECTURE.md` §8: inbox, classificação, retry, DLQ e desligamento. O outbox (§8.4) fica para a T41.

## Por quê

- **CHALLENGE §10 / D24:** o consumidor chama o mesmo use case do HTTP, com a inbox `(consumerName, messageId)` na mesma transação. O ack vem depois do commit.
- **ARQUITETURA 7.2:** a tabela de classificação está em `classifyOutcome`/`classifyError`. A DLQ chega só pelo redrive (`maxReceiveCount = 5`), nunca por envio manual. O backoff é `min(2^receiveCount, 60)` s.
- **D27 / restrição 5.1:** `data` passa pelo `wagerTransactionSchema` do HTTP, e `amount` numérico vai para a DLQ (I-11 via SQS).
- **D7:** mesmo `messageId` com payload diferente vai para a DLQ, com log `error` (I-14).
- **SCHEMA 4.4 / DP-3:** `FAILED` só na última entrega, numa transação separada.
- **MODELAGEM 7 / DP-4:** todo desfecho que passou pela inbox a deixa `processed`.
- **ARQUITETURA 7.3:** `SIGTERM` básico, passos 1 a 3 no consumidor e passo 5 no `MessagingModule`.
- **Restrição 8 / D28:** nenhum estado de correção em memória. O consumidor só liga com `ENABLE_CONSUMER`.
- **ARQUITETURA 9:** contadores do registry do T33 e contexto de log no ALS único (D29), sem valores monetários.

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

### Arquivos que vou tocar

A lista **depende do refactor `29e032b`** (branch local `fix-estrutura-onda3`,
ainda fora da `main`), que move os use cases para `src/application/*.ts`, cria
`src/interface/wagering.module.ts` e `infrastructure/observability/request-context.ts`,
e põe `UNIT_OF_WORK` no `PersistenceModule` (ver DP-1). As duas variantes:

| # | Arquivo | Com `29e032b` na `main` (preferida) | Sem `29e032b` |
|---|---|---|---|
| 1 | `src/infrastructure/messaging/sqs-input-queue.ts` (novo) | adaptador da fila de entrada sobre o `SQSClient`: receive, ack, visibilidade, `maxReceiveCount` | igual |
| 2 | `src/infrastructure/messaging/messaging.module.ts` | fornece `SqsInputQueue` e faz `destroy()` do `SQSClient` no shutdown (ARQUITETURA 7.3 passo 5) | igual |
| 3 | `src/interface/sqs/wager-transaction.message.ts` (novo) | schema zod do envelope (CHALLENGE §10), `data` = `wagerTransactionSchema` do HTTP + `idempotencyKey`; `toWagerCommand`; `classify()` pura (tabela de ARQUITETURA 7.2) | igual |
| 4 | `src/interface/sqs/wager-transaction.consumer.ts` (novo) | laço de long polling, concorrência, ack/visibilidade, métricas, logs com contexto, `FaultPoint.ConsumerAfterCommitBeforeAck`, drenagem no `SIGTERM` | igual, mas importa `runWithLogContext` de `observability/logger.ts` e `UNIT_OF_WORK` de `interface/http/http.module.ts` |
| 5 | `src/interface/wagering.module.ts` | registra `WagerTransactionConsumer` na lista única de providers (§11) | — (não existe) |
| 5' | `src/interface/sqs/sqs-consumer.module.ts` (novo) | — | módulo próprio do consumidor + pedido ao integrador (PI-1) |
| 6 | `src/application/record-processing-failure.ts` (novo) | grava `FAILED`/`PROCESSING_FAILED` na última entrega (SCHEMA 4.4). **Só se DP-3 for aprovada** | `src/application/use-cases/record-processing-failure.ts` + export no `use-cases/index.ts` |
| 7 | `src/application/submit-wager-transaction.ts` | marca a inbox `processed` também nos desfechos que retornam cedo. **Só se DP-4 for aprovada** | `src/application/use-cases/submit-wager-transaction.ts` |
| 8 | `test/integration/sqs-consumer.test.ts` (novo) | aceite I-12, I-13, I-14, I-15 com app real (`spawnApp`), banco e filas próprios (D34/D35) | igual |
| 9 | `test/support/queues.ts` | helpers `sendEnvelope(queues, envelope, opts)` e `receiveAll(url)` para os testes de fila (reaproveitados por T50) | igual |
| 10 | `ARCHITECTURE.md` §8 | metade "consumidor": inbox, classificação, retry, DLQ, `SIGTERM`. A metade outbox fica para T41 | igual |
| 11 | `docs/notas/T40-sqs-consumer.md` | esta nota | igual |

Não toco: `ports.ts` (congelado), `src/domain/` (o domínio já tem `InboxMessage`,
`WagerTransaction.fail`, `FailureCode.ProcessingFailed`), `config.ts` (todas as
envs que uso já existem: `ENABLE_CONSUMER`, `SQS_INPUT_QUEUE`,
`SQS_CONSUMER_CONCURRENCY`, `CONSUMER_NAME`, `SHUTDOWN_GRACE_MS`), `metrics.ts`
(o registry do T33 já tem os contadores que uso), `fault-injector.ts` (o ponto
`consumer.after-commit-before-ack` já existe), `init-queues.sh` (já tem redrive 5
e visibility 30 s).

### Assinaturas públicas

```ts
// infrastructure/messaging/sqs-input-queue.ts — único arquivo do consumidor que importa @aws-sdk
export interface InputMessage {
  sqsMessageId: string;      // só para log; a inbox usa o messageId do envelope
  receiptHandle: string;
  body: string;
  receiveCount: number;      // ApproximateReceiveCount
}
@Injectable()
export class SqsInputQueue {
  constructor(sqs: SQSClient, @Inject(APP_CONFIG) config: AppConfig);
  receive(max: number, signal: AbortSignal): Promise<InputMessage[]>; // WaitTimeSeconds 20, até 10
  ack(message: InputMessage): Promise<void>;                          // DeleteMessage
  releaseNow(message: InputMessage): Promise<void>;                   // ChangeMessageVisibility 0
  delay(message: InputMessage, seconds: number): Promise<void>;       // ChangeMessageVisibility n
  maxReceiveCount(): Promise<number | undefined>;                     // RedrivePolicy da fila, lida 1× (DP-2)
}

// interface/sqs/wager-transaction.message.ts
export const wagerEnvelopeSchema: z.ZodType<…>; // { messageId: 1..256, type: 'WagerTransactionRequested', occurredAt, data }
export type ParsedEnvelope =
  | { ok: true; messageId: string; command: WagerCommand }
  | { ok: false; reason: 'INVALID_JSON' | 'INVALID_ENVELOPE' | 'UNKNOWN_TYPE' | 'INVALID_PAYLOAD'; messageId?: string };
export function parseEnvelope(body: string): ParsedEnvelope; // correlationId = causationId = messageId (MODELAGEM 8)

export type ConsumerAction =
  | { type: 'ACK'; log?: 'warn' }
  | { type: 'RELEASE_PERMANENT'; reason: string }        // visibilidade 0 → redrive leva à DLQ
  | { type: 'RETRY'; delaySeconds: number; reason: 'TRANSIENT' | 'BUG' };
export function classifyOutcome(outcome: SubmitOutcome): ConsumerAction;
export function classifyError(error: unknown, receiveCount: number): ConsumerAction;
export function retryDelaySeconds(receiveCount: number): number; // min(2^receiveCount, 60)

// interface/sqs/wager-transaction.consumer.ts
@Injectable()
export class WagerTransactionConsumer implements OnApplicationBootstrap, BeforeApplicationShutdown {
  onApplicationBootstrap(): void;                  // só inicia o laço se ENABLE_CONSUMER
  beforeApplicationShutdown(): Promise<void>;      // ARQUITETURA 7.3 passos 1–3
  /** Processa uma mensagem. Público para o teste chamar sem fila, se preciso. */
  handle(message: InputMessage): Promise<ConsumerAction>;
}

// application/record-processing-failure.ts — só com DP-3
export class RecordProcessingFailure {
  constructor(uow: UnitOfWork, clock: Clock, ids: IdGenerator);
  /** Transação própria. Insere a transação já FAILED/PROCESSING_FAILED se a key ainda não existe; senão não faz nada. */
  execute(command: WagerCommand): Promise<'RECORDED' | 'ALREADY_EXISTS'>;
}
```

Fluxo de `handle` (ARQUITETURA 7.2, SCHEMA 4.4):

1. `parseEnvelope`. Falhou → `RELEASE_PERMANENT` (inclui `amount: 25`, I-11 via fila).
2. `runWithLogContext({ correlationId, messageId, walletId, providerId })` →
   `SubmitWagerTransaction.execute(command, { consumerName: CONSUMER_NAME, messageId })`.
   `InvalidMoneyError`/`InvalidWagerRequestError`/`CurrencyMismatchError` → permanente.
3. `classifyOutcome`: `RESULT`, `DUPLICATE_MESSAGE` → ack; `WALLET_NOT_FOUND`,
   `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` → ack + `warn`;
   `MESSAGE_PAYLOAD_MISMATCH` → `RELEASE_PERMANENT` + log `error` (D7).
4. `TransientInfrastructureError` e bug → `delay(min(2^receiveCount, 60))`.
5. Antes do ack: `FaultInjector.hit('consumer.after-commit-before-ack')` (TESTES 3.4, C-05).
6. Última entrega (`receiveCount >= maxReceiveCount`) com falha → `wagering_dlq_total`
   e, com DP-3, `RecordProcessingFailure` numa transação separada.

Métricas (registry do T33, nada novo): `wagering_sqs_messages_received_total{queue}`,
`wagering_transactions_total{kind,status}`, `wagering_transactions_rejected_total{reason}`,
`wagering_duplicates_total{source="inbox"}`, `wagering_retries_total{component="sqs-consumer"}`,
`wagering_dlq_total` + `wagering_sqs_messages_dlq_total{queue,reason}`,
`wagering_processing_duration_seconds{entry="sqs"}`. Nenhum valor monetário em
label ou log (ARQUITETURA 8 e 9).

Concorrência do laço: recebe `min(10, SQS_CONSUMER_CONCURRENCY − emAndamento)`
mensagens; dentro do lote, mensagens do mesmo `MessageGroupId` rodam em
sequência e grupos diferentes em paralelo. Isso preserva a ordem do FIFO como
otimização; a correção continua no banco (restrição 3).

`SIGTERM` básico (ARQUITETURA 7.3): para de receber e aborta o long poll em
curso (`AbortController`), espera os handlers até `SHUTDOWN_GRACE_MS`, devolve
com `releaseNow` as recebidas e não iniciadas. MikroORM fecha no
`onApplicationShutdown` do módulo dele; o `SQSClient` no do `MessagingModule`.
Sem teste de aceite: C-10 é só Linux (TESTES 3.4) e não está no aceite da T40.

Testes (`test/integration/sqs-consumer.test.ts`, app real com
`ENABLE_OUTBOX_WORKER=false`, `ENABLE_REFERENCE_WORKER=false`):

- **I-12**: `POST` HTTP e depois a mesma operação via fila (mesma `idempotencyKey`)
  → transação única, 1 lançamento no ledger, mensagem com ack (fila vazia, DLQ vazia).
- **I-13**: mesmo envelope enviado 3× com `MessageDeduplicationId` distintos (o
  FIFO com `ContentBasedDeduplication` engoliria as cópias) → 1 lançamento, 1
  linha de inbox, 3 acks.
- **I-14**: mesmo `messageId`, payload diferente → a 2ª chega à DLQ; saldo só
  da 1ª.
- **I-15**: (a) `type` desconhecido chega à DLQ após 5 recebimentos;
  (b) falha transitória → reprocessa com sucesso. A forma de simular (b) é DP-5.
- `afterEach`: `assertAllWalletsConsistent` (D40). Esperas por `eventually()` (D39).

### Alternativas descartadas e motivo

| Alternativa | Por que não |
|---|---|
| `SendMessage` manual para a DLQ | ARQUITETURA 7.2: a DLQ chega pelo redrive, o SQS conta as entregas e não há janela de perda |
| Chave da inbox = `MessageId` do SQS | muda a cada reenvio do produtor, e a dedupe sumiria. CHALLENGE §10 e MODELAGEM 7 usam o `messageId` do envelope |
| Nova porta `MessageSource` em `ports.ts` | `ports.ts` está congelado (AGENTS regra 4) e a application não consome a fila; o adaptador fica em `infrastructure/messaging` e a `interface` usa a classe sem importar `@aws-sdk` (ARQUITETURA §2) |
| Consumidor dentro do `MessagingModule` (infraestrutura) | ARQUITETURA 2.1 põe o consumidor em `interface/sqs/`; ele chama use case, que é papel da interface |
| Schema próprio para `data` | ARQUITETURA 7.2/D27: o **mesmo** schema do HTTP. Só acrescento `idempotencyKey`, que no HTTP vem do header |
| `@nestjs/schedule` ou lib de consumidor (`sqs-consumer`) | D32 (laço simples preso ao ciclo do Nest) e regra 3 (sem mexer em `package.json`) |
| Processar o lote todo em paralelo, sem olhar o grupo | descarta de graça a ordem por `MessageGroupId`, que ARQUITETURA 7.2 recomenda usar como otimização |
| Retry dentro do processo (laço de tentativas em memória) | estado de correção em memória (restrição 8); o backoff fica na visibilidade da mensagem |

**Aprovação do humano:** aprovada em 2026-10-29 (na conversa): Abordagem aceita como proposta, com a lista de arquivos da variante com o refactor 29e032b (já na main, 71dbc44) e todas as decisões pendentes DP-1 a DP-5 resolvidas conforme as propostas da nota.

## Ordem de leitura do diff

1. `src/interface/sqs/wager-transaction.message.ts`: a tabela de ARQUITETURA 7.2 em `classifyOutcome`/`classifyError`. Ver também o `extend` do schema HTTP com `idempotencyKey` e `correlationId = causationId = messageId` (MODELAGEM 8).
2. `src/interface/sqs/wager-transaction.consumer.ts`: em `handle → decide → apply`, ver o ack só depois do retorno do use case, o `FaultInjector` antes do `DeleteMessage`, a última entrega (métrica de DLQ e `RecordProcessingFailure`) e o fato de nunca haver `SendMessage` para a DLQ. Depois, `dispatch` (grupos em sequência) e `beforeApplicationShutdown`.
3. `src/application/submit-wager-transaction.ts` (commit `64005ef`): `closeInbox` nos retornos antecipados.
4. `src/application/record-processing-failure.ts`: as guardas (key ou id externo já existem, wallet ausente ou de outra moeda) e a ausência de evento no outbox.
5. `src/infrastructure/messaging/sqs-input-queue.ts`: `ApproximateReceiveCount`, `abortSignal` no long poll e o cache da URL e do `maxReceiveCount`.
6. `src/interface/wagering.module.ts`: o registro do consumidor e o `withUnitOfWork` sem fila.
7. `test/integration/sqs-consumer.test.ts`: o I-13 usa `MessageDeduplicationId` distintos, e o I-15 (b) usa portão de lock com `lock_timeout` de 300 ms (DP-5).
8. `ARCHITECTURE.md` §8.

## Como verificar

```bash
bun run tarefa:gate                                   # typecheck, skills, unidade, arquitetura, integração, concorrência
bun test ./test/integration/sqs-consumer.test.ts      # só o aceite da T40 (~6 s)
```

Resultado em 2026-10-29: gate verde em todos os níveis (typecheck, skills,
unidade, arquitetura, integração, concorrência). `sqs-consumer.test.ts` deu 6/6
em 3 execuções seguidas.

## Decisões pendentes

Nenhuma aberta. DP-1 a DP-5 foram aprovadas pelo humano em 2026-10-29 conforme
as propostas abaixo e implementadas assim. O texto fica como registro.

- **DP-1. Base estrutural: com ou sem `29e032b`.** O refactor da branch
  `fix-estrutura-onda3` move `application/use-cases/*` → `application/*.ts`,
  `interface/http/http.module.ts` + `metrics.module.ts` → `interface/wagering.module.ts`,
  `UNIT_OF_WORK` → `persistence.module.ts`, e cria `request-context.ts` (um ALS
  só, D29) e `infrastructure/clock.ts`/`id-generator.ts`.
  **Proposta:** mergear `29e032b` na `main` antes de eu codar e fazer rebase da
  T40 nele (coluna "preferida" da tabela). **Motivo:** ARQUITETURA 2.1/11 já
  descreve essa estrutura; sem ele eu teria de criar um `SqsConsumerModule` à
  parte (PI-1), importar `UNIT_OF_WORK` de dentro do módulo HTTP e usar o ALS
  que, segundo o próprio commit, não leva o `correlationId` aos logs. T41–T43
  também vão registrar workers no `wagering.module.ts`, então decidir agora evita
  quatro rebases.
- **DP-2. De onde vem o `maxReceiveCount`.** Os docs fixam 5 na fila (7.1), mas
  não dizem como o consumidor sabe que é a última entrega (SCHEMA 4.4).
  **Proposta:** `SqsInputQueue.maxReceiveCount()` lê a `RedrivePolicy` da fila
  uma vez no boot. Sem política, nunca é "última entrega": não grava `FAILED` e
  loga `warn`. **Motivo:** a fila é a fonte da verdade; uma env nova duplicaria
  o número e poderia divergir do `init-queues.sh`/`queues.ts`.
- **DP-3. Quando gravar `FAILED` na última entrega.** ARQUITETURA 7.2 diz "grava
  `FAILED` se a transação for identificável", e SCHEMA 4.4 diz "falha permanente".
  Mas nos casos permanentes da tabela não dá para gravar: payload inválido não
  forma comando; `MESSAGE_PAYLOAD_MISMATCH` já tem transação terminal da 1ª
  mensagem; erro de domínio em `create` impede criar a `WagerTransaction`.
  Também não há evento de integração para `FAILED` (MODELAGEM 8).
  **Proposta:** gravar `FAILED`/`PROCESSING_FAILED` só quando, na última entrega,
  o comando é válido e o erro é transitório ou bug (o "persistiu" da tabela),
  num `uow.run` separado, sem evento no outbox, e só se a
  `(providerId, idempotencyKey)` ainda não existe. Se essa escrita falhar, loga e
  deixa o redrive seguir. Use case novo `RecordProcessingFailure` (arquivo 6).
  **Alternativa:** adiar o `FAILED` para T50 e entregar só o redrive (I-12 a
  I-15 não cobrem `FAILED`). **Motivo da proposta:** cumpre SCHEMA 4.4 sem
  inventar transação para mensagem sem forma, e o provedor que reenviar recebe
  replay `FAILED` em vez de efeito tardio.
- **DP-4. Inbox não marcada `processed` nos retornos cedo do use case.** Em
  `submit-wager-transaction.ts` (T30), `tryReceive` insere a linha, mas
  `markProcessed` só roda no fim. Os retornos de replay (passos 2 e 4),
  `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` e `WALLET_NOT_FOUND` fazem
  commit com `processed_at` nulo. I-12 cai exatamente nesse caminho. Além disso,
  no retry por `23505`, a linha da inbox some com o rollback e o retry não a
  regrava. O efeito financeiro está correto (a redelivery vira duplicata ou
  replay), mas a inbox fica incompleta (MODELAGEM 7, "rejeitada por negócio
  também fica processed"). **Proposta:** marcar `processed` em todo retorno
  dentro do `uow.run` que passou pela inbox (arquivo 7, mudança de poucas linhas,
  sem mudar assinatura) e deixar o caminho `23505` como está, registrado como
  dívida. **Alternativa:** não mexer em T30 e só registrar a dívida.
- **DP-5. Como simular a falha transitória do I-15.** TESTES §4 descreve
  `docker pause` do Postgres, mas AGENTS.md proíbe parar containers da infra
  compartilhada: os outros worktrees rodam testes no mesmo Postgres ao mesmo
  tempo. **Proposta:** usar o portão de lock (`holdWalletLock`, D37) com
  `DB_LOCK_TIMEOUT_MS=300` na app: o `lock_timeout` vira
  `TransientInfrastructureError` (SCHEMA 5), a mensagem volta com backoff de 2 s,
  o teste confirma `receiveCount ≥ 2` e o contador de retries, solta o portão e
  vê o processamento com sucesso. Prova a mesma coisa (transitório → retry →
  sucesso) sem tocar container. **Alternativa:** `docker pause` mantendo o texto
  do I-15, marcado `skipIf` fora do CI. Mudar o texto do I-15 é decisão do humano
  (AGENTS regra 5).

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- (nenhum) O `29e032b` entrou na `main` (`71dbc44`), então o PI-1 abaixo não se aplica.
- ~~**PI-1 (só se `29e032b` NÃO entrar na `main`):** em `src/app.module.ts`,
  importar `SqsConsumerModule` de `./interface/sqs/sqs-consumer.module` na lista
  de `imports`. Com o refactor, nenhum pedido: o consumidor entra no
  `wagering.module.ts`.~~
- Nenhuma mudança em `package.json`/`bun.lock`: `@aws-sdk/client-sqs` e `zod` já
  são dependências.

## Fora de escopo / dívida

- C-05 (morte entre commit e ack) e C-10 (`SIGTERM` com mensagens em andamento,
  só Linux): o consumidor deixa o ponto de falha e a drenagem prontos, mas os
  testes são de T50.
- Retry por `23505` no use case não regrava a inbox (ver DP-4).
- Worker de outbox e publicação: T41.
- A gravação de `FAILED` na última entrega (DP-3) não tem teste de integração.
  Ela exige 5 falhas transitórias seguidas, com backoff de 2+4+8+16 s (~30 s).
  Fica para a T50, junto com C-05 e C-10.
- Para T41/T42: um worker que entrar no `WageringModule` e depender de
  `MessagingModule` ou de `APP_CONFIG` precisa respeitar o `withUnitOfWork`
  (testes em processo sem fila). Hoje ele fornece `APP_CONFIG` com
  `ENABLE_CONSUMER=false` e `SqsInputQueue = null`.
- `wagering_lock_conflicts_total` não é incrementado pelo consumidor. Distinguir
  `lock_timeout` de outra falha transitória exigiria ler o SQLSTATE do driver na
  camada `interface`. Hoje ele cai em `wagering_retries_total{component="sqs-consumer"}`.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
