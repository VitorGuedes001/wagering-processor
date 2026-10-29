# T41 — Worker de outbox

> Estado: Testada · Raia: G · Revisor: C · Branch: `t41-outbox-worker`

## O que muda

- `src/infrastructure/messaging/sqs-event-publisher.ts` — Implementa a porta `EventPublisher` via AWS SDK SQS com envio para `SQS_EVENTS_QUEUE`, deduplicação por `eventId` e agrupamento por `aggregateId` (D20).
- `src/infrastructure/messaging/messaging.module.ts` — Registra e exporta `SqsEventPublisher` e o token `EVENT_PUBLISHER`.
- `src/infrastructure/persistence/outbox-repository.ts` — Adiciona método `computeLagSeconds` para cálculo do lag de outbox via `MIN(occurred_at) WHERE published_at IS NULL` (SCHEMA 4.6; ARQUITETURA §9).
- `src/interface/workers/outbox.worker.ts` — Implementa `OutboxWorker` com laço de polling baseado em `setTimeout` (D32), claim em `uow.run` curto, publicação fora de transação e `markPublished`/`scheduleRetry` em `uow.run` separados (D18, D62), injeção de falhas (D38), métricas de lag/publicação/retries e drenagem em shutdown (ARQUITETURA §7.3).
- `src/interface/workers/workers.module.ts` — Módulo NestJS que declara e exporta `OutboxWorker`.
- `src/main.ts` — Inicia e encerra o `OutboxWorker` de acordo com a flag `ENABLE_OUTBOX_WORKER`.
- `test/integration/outbox-worker.test.ts` — Testes de integração I-16 (publicação após commit, bloqueio total com `uow.before-commit`, publicação única no caminho feliz, métricas e retries).
- `test/concurrency/outbox-worker.test.ts` — Testes de concorrência C-06 (1000 eventos no outbox em 2 instâncias de worker sem perda de eventos) e C-06b (falha de processo com `FAULT_POINT=outbox.after-claim-before-publish` e recuperação por lease expirado em outra instância).
- `docs/notas/T41-outbox-worker.md` — Nota de documentação da tarefa T41.

## Por quê

Atende às decisões arquiteturais D18 (workers com lease `FOR UPDATE SKIP LOCKED`), D20 (publicação na fila FIFO `wagering-events.fifo` com dedup por `eventId` e grupo por `aggregateId`), D32 (laço com `setTimeout` integrado ao ciclo de vida), D62 (claim, publicação fora de transação e marcação em transações separadas), à restrição inviolável 4 (publicação nunca em transação de banco), à observabilidade ARQUITETURA §9 / SCHEMA §4.6 (`wagering_outbox_lag_seconds`, `wagering_outbox_published_total`, `wagering_retries_total{component="outbox"}`) e aos critérios de aceite I-16, C-06 e C-06b (TESTES §4.2, §4.3; EXECUCAO §6).

## Abordagem

- Arquivos que vou tocar:
  - `docs/notas/T41-outbox-worker.md`
  - `src/infrastructure/messaging/sqs-event-publisher.ts`
  - `src/infrastructure/messaging/messaging.module.ts`
  - `src/infrastructure/persistence/outbox-repository.ts`
  - `src/interface/workers/outbox.worker.ts`
  - `src/interface/workers/workers.module.ts`
  - `src/main.ts`
  - `test/integration/outbox-worker.test.ts`
  - `test/concurrency/outbox-worker.test.ts`

- Assinaturas públicas:
  - `SqsEventPublisher implements EventPublisher` (`publish(message: OutboxMessage): Promise<void>`)
  - `EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER')`
  - `OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown` (`start(): Promise<void>`, `stop(): Promise<void>`, `tick(now?: Date): Promise<number>`, `computeLag(now?: Date): Promise<number>`, `updateLag(now?: Date): Promise<void>`, `isRunning(): boolean`)
  - `WorkersModule` (`@Module`)
  - `MikroOrmOutboxRepository.prototype.computeLagSeconds(now: Date): Promise<number>`

- Alternativas descartadas e motivo:
  - *Publicar eventos no SQS dentro da transação da UoW:* Descartado. Violação da restrição inviolável 4 e decisão D62. A publicação deve ser fora de transação; se a chamada de rede falhar ou o processo morrer, o lease expira e outro worker assume.
  - *Usar `@nestjs/schedule` ou `@Interval`:* Descartado por D32. Dois workers não justificam dependência de agendador externo e o laço com `setTimeout` permite drenagem determinística e encerramento limpo no `SIGTERM` (ARQUITETURA §7.3).
  - *Calcular lag carregando todas as mensagens pendentes para memória:* Descartado. `outbox_message` pode acumular grande volume em cenários de indisponibilidade da fila; o cálculo via `SELECT MIN(occurred_at) FROM outbox_message WHERE published_at IS NULL` no banco aproveita o índice parcial `outbox_due_ix` e executa em tempo constante.
  - *Editar `src/app.module.ts` diretamente na branch:* Descartado pela regra estrita de governança (AGENTS.md, regra 3). O `WorkersModule` é criado em `src/interface/workers/workers.module.ts`, o `main.ts` o instancia/conecta via container e a adição em `AppModule` é requisitada na seção "Pedidos ao integrador".

**Aprovação do humano:** não aplicável (tarefa sem 🔒; arquivos detalhados nesta nota e alinhados a EXECUCAO §6 e D62)

## Ordem de leitura do diff

1. `src/infrastructure/messaging/sqs-event-publisher.ts` — Publicador SQS fora de transação com resolução de QueueUrl, dedup e MessageGroupId.
2. `src/infrastructure/messaging/messaging.module.ts` — Exposição de `SqsEventPublisher` e `EVENT_PUBLISHER`.
3. `src/infrastructure/persistence/outbox-repository.ts` — Consulta SQL de `computeLagSeconds` para observabilidade de lag.
4. `src/interface/workers/outbox.worker.ts` — Ciclo do worker: claim curto, publicação externa, `markPublished`/`scheduleRetry`, injeção de falhas e shutdown.
5. `src/interface/workers/workers.module.ts` — Encapsulamento do worker em módulo Nest.
6. `src/main.ts` — Ativação condicional do worker no boot.
7. `test/integration/outbox-worker.test.ts` — Suíte de testes I-16 e validação de lag/retries.
8. `test/concurrency/outbox-worker.test.ts` — Suíte de concorrência com 2 instâncias para C-06 e recuperação de falha com lease para C-06b.

## Como verificar

```bash
bun run tarefa:gate
bun test test/integration/outbox-worker.test.ts
bun test test/concurrency/outbox-worker.test.ts
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- Registrar `WorkersModule` nos imports de `src/app.module.ts`.

## Fora de escopo / dívida

- (nenhum)

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

Revisor: Claude Code, 29/10/2026, sobre `bb99e57` (base `991a198`; `main` em `71dbc44`).

**Gate.** `bun run tarefa:gate` recusa rodar: "a branch não contém a main atual". O
revisor não faz rebase, então rodou os mesmos passos do gate à mão na branch:
typecheck ok, skills ok, unidade + arquitetura 343/343, integração 131/131 (inclui
I-16), concorrência 11/11 (inclui C-06 e C-06b). **Na árvore mesclada com a `main`**
(`git merge-tree --write-tree main t41-outbox-worker` → `f640131`, sem conflito
textual), o typecheck **falha**:

```
src/interface/workers/outbox.worker.ts(14,30): error TS2307: Cannot find module '../http/http.module'
src/main.ts(8,30): error TS2307: Cannot find module './interface/http/http.module'
```

**Frente ao refactor `29e032b`.** Para adaptar: (a) `UNIT_OF_WORK` agora vem de
`src/infrastructure/persistence/persistence.module.ts`; (b) `http.module.ts` não existe
mais, e workers são registrados em `src/interface/wagering.module.ts` (ARQUITETURA
§2.1, §11), arquivo que não é protegido pela regra 3; com isso o `WorkersModule` e o
pedido ao integrador para editar `app.module.ts` deixam de fazer sentido; (c) o relógio
existe como provider `SystemClock` no `WageringModule`, e o token `'CLOCK'` não é
fornecido por ninguém; (d) a lógica de D62 deveria ir para `src/application/publish-outbox.ts`
(achado 2), ao lado de `create-wallet.ts` e `submit-wager-transaction.ts`.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | bloqueante | `src/interface/workers/outbox.worker.ts:14`, `src/main.ts:8` | Mesclada com a `main`, a branch não compila: importa `UNIT_OF_WORK` de `interface/http/http.module`, que o refactor `29e032b` removeu. O gate também recusa a branch porque ela não contém a `main`. É preciso rebase e adaptação (ver "Frente ao refactor" acima) | |
| 2 | bloqueante | `src/interface/workers/outbox.worker.ts:119-148` | O ciclo de D62 (claim → publish → mark/retry) mora inteiro no worker de `interface`. ARQUITETURA §2.1 e §4 definem o use case `PublishOutbox` em `src/application/publish-outbox.ts` ("tick do worker · claim + 1 update por item"), e o worker só agenda e chama esse use case (D32). O código usa só portas (`UnitOfWork`, `EventPublisher`, `Clock`), então a mudança é mecânica. A escolha não está em "Decisões pendentes" | |
| 3 | bloqueante | `src/main.ts:17-32`, `src/interface/workers/workers.module.ts` | `main.ts` monta o worker fora do DI (`new SqsEventPublisher`, `new OutboxWorker`) e liga `process.once('SIGTERM')` por conta própria. Isso fere D32 ("presos ao ciclo de vida do Nest") e §7.3, que manda os workers terminarem **antes** de fechar o MikroORM: o handler próprio corre em paralelo com o `app.close()` de `enableShutdownHooks()`, e o ORM pode fechar no meio do `markPublished`. Além disso, se o integrador aplicar o pedido da nota (registrar `WorkersModule`), o `onApplicationBootstrap` do provider também chama `start()`, e cada processo passa a ter **dois** workers. Registrar o `OutboxWorker` no `WageringModule` e apagar o bloco do `main.ts` resolve os dois problemas | |
| 4 | importante | `test/integration/outbox-worker.test.ts:196-231` | I-16 pede "com `uow.before-commit`, nada sai". O teste confere que o outbox está vazio (isso já é o I-04) e que a fila de eventos está vazia, mas **nenhum worker roda** depois que o processo morre, e por isso a segunda asserção passa sempre. Falta um `worker.tick()` (ou a instância subir com o worker) antes de checar a fila, e checar que o tick devolveu 0. Hoje a asserção é mais fraca do que a do TESTES §4.2 | |
| 5 | importante | `test/concurrency/outbox-worker.test.ts:122-162` | C-06 pede "duplicatas registradas, não falhas". O `Set` engole as duplicatas sem contá-las, e o laço para quando chega a 1000 ids distintos, de modo que as duplicatas que ainda estão na fila nunca são lidas. Falta contar as entregas totais e registrar (log ou asserção `>= 1000`) quantas foram duplicadas | |
| 6 | importante | `src/interface/workers/outbox.worker.ts:100`, `:164`, `:175`, `:195` | Os quatro `catch {}` engolem o erro sem log nenhum. Com o banco fora ou a fila inexistente, o worker gira em silêncio, e só o lag denuncia o problema. ARQUITETURA §9 pede log estruturado: falta pelo menos um `warn` com `eventId`/código, sem payload | |
| 7 | menor | `src/interface/workers/outbox.worker.ts:181-189` | `computeLag` chega a `computeLagSeconds` por cast (`as unknown as`), um método que não existe na porta `OutboxRepository` (congelada no M0). Com outro adaptador, o lag vira 0 sem aviso. Registrar em "Decisões pendentes": ou se estende a porta, ou se lê o lag por outro caminho | |
| 8 | menor | `src/interface/workers/outbox.worker.ts:40` | `@Inject('CLOCK')` usa um token string que ninguém fornece, e o fallback `defaultClock` acaba sempre em uso. Depois do refactor, injetar `SystemClock` | |
| 9 | menor | `test/integration/outbox-worker.test.ts:233-290` | O título diz "incrementa `wagering_retries_total`", mas nenhuma asserção lê a métrica. Ou se ajusta o título, ou se lê o contador no `metrics.registry` | |
| 10 | menor | `test/concurrency/outbox-worker.test.ts:100`, `:254` | C-06 diz "2 instâncias só com o worker de outbox", mas as instâncias sobem com `ENABLE_HTTP=true` (usado para o readiness). Vale um comentário explicando por que, ou então esperar a prontidão de outro jeito | |

Verificado e sem achado: escopo (os 9 arquivos batem com a lista da Abordagem); D20
(`MessageGroupId = aggregateId`, `MessageDeduplicationId = eventId`, conferido no
I-16); D62/restrição 4 (o claim roda num `uow.run` próprio, `publish` fica fora de
transação, e `markPublished`/`scheduleRetry` rodam cada um no seu `uow.run`); D12 (o
backoff vem de `OutboxMessage.scheduleRetry`, e o teste confere `attempts = 1` e
`+2 s`); os pontos de falha `outbox.after-claim-before-publish` e
`outbox.after-publish-before-mark` estão no lugar certo; C-06b prova que o lease foi
empurrado e que B publica tudo depois que ele expira; o lag é calculado no SQL
(`MIN(occurred_at) WHERE published_at IS NULL`, SCHEMA 4.6); não há dinheiro como
`number` (o payload sai como `jsonb` serializado); nenhuma camada importa ORM nem AWS
direto (o teste de arquitetura passa também na árvore mesclada); os testes usam
banco e filas próprios.

Veredito: mudanças necessárias
