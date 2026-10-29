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

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
