# T22 — Repositórios de inbox e outbox

> Estado: Testada · Raia: G · Revisor: C · Branch: `t22-inbox-outbox-repo`

## O que muda

- `src/infrastructure/persistence/records/inbox-message.record.ts` — Record MikroORM da tabela `inbox_message` (PK composta `(consumer_name, message_id)`) com mapeamento explícito `fromDomain` / `toDomain` (SCHEMA 2.4, 7).
- `src/infrastructure/persistence/records/outbox-message.record.ts` — Record MikroORM da tabela `outbox_message` (`payload` `jsonb`, `attempts`, lease `next_attempt_at`, `published_at`) com mapeamento explícito `fromDomain` / `toDomain` (SCHEMA 2.5, 7).
- `src/infrastructure/persistence/inbox-repository.ts` — Implementa `InboxRepository` (`tryReceive` com `INSERT … ON CONFLICT DO NOTHING` e leitura do `payload_hash` existente; `markProcessed` atualizando `processed_at`, SCHEMA 4.4, D7).
- `src/infrastructure/persistence/outbox-repository.ts` — Implementa `OutboxRepository` (`enqueue`, `claimDue` por lease em `next_attempt_at` com `FOR UPDATE SKIP LOCKED`, `markPublished` e `scheduleRetry`, SCHEMA 4.5, D12, D18, D48).
- `test/integration/inbox-outbox-repository.test.ts` — Testes de integração I-03 (ida e volta `domínio → record → domínio` de `InboxMessage` e `OutboxMessage` com valores monetários do payload como `string`, `tryReceive` com replay e conflito de hash D7, `markProcessed`, `claimDue` com lease e `FOR UPDATE SKIP LOCKED` concorrente, `markPublished`, `scheduleRetry` e atomicidade via interface `UnitOfWork`).

## Por quê

Atende ao contrato de persistência de `InboxRepository` e `OutboxRepository` congelado no M0 (`src/application/ports.ts`, ARQUITETURA 3 e 5), às tabelas e consultas de deduplicação e publicação transacional com lease e `FOR UPDATE SKIP LOCKED` (SCHEMA 2.4, 2.5, 4.4, 4.5, 5, 7; D7, D12, D18, D48), à restrição inviolável 5.1 (valores monetários nos eventos do outbox preservados como `string` no `jsonb`) e ao teste de aceite I-03 de inbox e outbox (TESTES 4.2, EXECUCAO §6).

## Abordagem

- Arquivos que vou tocar:
  - `src/infrastructure/persistence/records/inbox-message.record.ts`
  - `src/infrastructure/persistence/records/outbox-message.record.ts`
  - `src/infrastructure/persistence/inbox-repository.ts`
  - `src/infrastructure/persistence/outbox-repository.ts`
  - `test/integration/inbox-outbox-repository.test.ts`
  - `docs/notas/T22-inbox-outbox-repo.md`
- Assinaturas públicas:
  - `InboxMessageRecord` (`fromDomain(message: InboxMessage): InboxMessageRecord`, `toDomain(record: InboxMessageRecord): InboxMessage`)
  - `OutboxMessageRecord` (`fromDomain(message: OutboxMessage): OutboxMessageRecord`, `toDomain(record: OutboxMessageRecord): OutboxMessage`)
  - `MikroOrmInboxRepository` (alias `SqlInboxRepository`) implementando `InboxRepository` (`tryReceive`, `markProcessed`, além de `findByKey` para leitura direta por PK composta)
  - `MikroOrmOutboxRepository` (alias `SqlOutboxRepository`) implementando `OutboxRepository` (`enqueue`, `claimDue`, `markPublished`, `scheduleRetry`, além de `findById` para leitura direta por PK)
- Alternativas descartadas e motivo:
  - *Usar `em.getConnection().execute(...)` direto sem contexto transacional:* em MikroORM 7, `em.getConnection().execute(sql, params)` não propaga automaticamente `em.getTransactionContext()` de um `EntityManager` transacional (`em.transactional`), o que executaria `tryReceive`, `markProcessed` ou `enqueue` fora da transação do `UnitOfWork`. Por isso usamos `this.em.execute(sql, params)` e `this.scopedEm().insertMany(...)`, que respeitam o contexto transacional do `EntityManager` recebido e fazem `fork()` automático quando invocados sobre o `EntityManager` global (ex.: worker fora de transação).
  - *Usar `now()` do banco em `claimDue`:* descartado porque `claimDue(now, limit, leaseMs)` recebe o instante do relógio injetado (`Clock`), garantindo determinismo nos testes de lease e retry sem `sleep`.

**Aprovação do humano:** não aplicável (tarefa sem 🔒 e com arquivos listados em `docs/EXECUCAO.md` §6)

## Ordem de leitura do diff

1. `src/infrastructure/persistence/records/inbox-message.record.ts` — Mapeamento MikroORM de `inbox_message` (PK composta `consumer_name` + `message_id`) e conversão `State ↔ domínio`.
2. `src/infrastructure/persistence/records/outbox-message.record.ts` — Mapeamento MikroORM de `outbox_message` (`payload` `jsonb`, `attempts`, `next_attempt_at`, `published_at`) e conversão `State ↔ domínio`.
3. `src/infrastructure/persistence/inbox-repository.ts` — `tryReceive` (`INSERT … ON CONFLICT DO NOTHING` + leitura de `payload_hash` quando já existe), `markProcessed` e tradução de erros transitórios.
4. `src/infrastructure/persistence/outbox-repository.ts` — `enqueue`, `claimDue` (reserva por lease com `FOR UPDATE SKIP LOCKED` e `RETURNING *`), `markPublished`, `scheduleRetry` e tradução de erros transitórios.
5. `test/integration/inbox-outbox-repository.test.ts` — Testes I-03 de ida e volta (`domínio → record → domínio`), preservação de strings monetárias em `jsonb` (5.1), `tryReceive`/`markProcessed`, `claimDue` com lease e `SKIP LOCKED` entre conexões concorrentes, `markPublished`/`scheduleRetry` e uso via interface `UnitOfWork`.

## Como verificar

```bash
bun run tarefa:gate
bun test test/integration/inbox-outbox-repository.test.ts
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- Registrar `InboxMessageRecord` e `OutboxMessageRecord` no array `entities` de `src/infrastructure/persistence/mikro-orm.config.ts`.
- Conectar `MikroOrmInboxRepository` e `MikroOrmOutboxRepository` no `UnitOfWork` (T20) e no `PersistenceModule` (`src/infrastructure/persistence/persistence.module.ts`).
- Opcional no merge da T20: unificar a função auxiliar `rethrowPersistenceError` de `inbox-repository.ts` e `outbox-repository.ts` com `src/infrastructure/persistence/db-errors.ts` (mantida local aqui para respeitar a posse de `db-errors.ts` pela T20).

## Fora de escopo / dívida

- A integração com a implementação concreta do `UnitOfWork` (T20) será exercitada após o merge da T20 na `main`, conforme `docs/EXECUCAO.md` §6 ("T21 e T22 implementam as portas do T01 e usam o `UnitOfWork` só pela interface. A integração com o UoW real é testada depois do merge do T20").

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
