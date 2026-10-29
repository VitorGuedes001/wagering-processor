# T22 — Repositórios de inbox e outbox

> Estado: Testada · Raia: G · Revisor: C · Branch: `t22-inbox-outbox-repo`

## O que muda

- `src/application/ports.ts` — Atualiza apenas a docstring de `OutboxRepository.claimDue` conforme decisão **D62** (usa a transação recebida; o worker o chama sozinho num `uow.run` curto).
- `src/infrastructure/persistence/records/inbox-message.record.ts` — Record MikroORM da tabela `inbox_message` (PK composta `(consumer_name, message_id)`) com mapeamento explícito `fromDomain` / `toDomain` (SCHEMA 2.4, 7).
- `src/infrastructure/persistence/records/outbox-message.record.ts` — Record MikroORM da tabela `outbox_message` (`payload` `jsonb`, `attempts`, lease `next_attempt_at`, `published_at`) com mapeamento explícito `fromDomain` / `toDomain` (SCHEMA 2.5, 7).
- `src/infrastructure/persistence/inbox-repository.ts` — Implementa `InboxRepository` (`tryReceive` com `INSERT … ON CONFLICT DO NOTHING` e leitura do `payload_hash` existente; `markProcessed` atualizando `processed_at` e validando pré-condição via `InboxMessageNotProcessedError`, SCHEMA 4.4, D7, D25).
- `src/infrastructure/persistence/outbox-repository.ts` — Implementa `OutboxRepository` (`enqueue`, `claimDue` por lease em `next_attempt_at` com `FOR UPDATE SKIP LOCKED`, `markPublished` e `scheduleRetry` com `attempts = attempts + 1` e `WHERE published_at IS NULL`, SCHEMA 4.5, D12, D18, D25, D48, D62).
- `test/integration/inbox-outbox-repository.test.ts` — Testes de integração I-03 (ida e volta `domínio → record → domínio` de `InboxMessage` e `OutboxMessage` com valores monetários do payload como `string`, `tryReceive` com replay, conflito de hash D7 e corrida concorrente de SCHEMA 4.3 com commit e rollback via `eventually()`, `markProcessed`, `claimDue` com lease e `FOR UPDATE SKIP LOCKED` concorrente, `markPublished`, `scheduleRetry` e atomicidade via interface `UnitOfWork`).

## Por quê

Atende ao contrato de persistência de `InboxRepository` e `OutboxRepository` congelado no M0 (`src/application/ports.ts`, ARQUITETURA 3 e 5), às tabelas e consultas de deduplicação e publicação transacional com lease e `FOR UPDATE SKIP LOCKED` (SCHEMA 2.4, 2.5, 4.3, 4.4, 4.5, 5, 7; D7, D12, D18, D25, D48, D62), à restrição inviolável 5.1 (valores monetários nos eventos do outbox preservados como `string` no `jsonb`) e ao teste de aceite I-03 de inbox e outbox (TESTES 4.2, EXECUCAO §6).

## Abordagem

- Arquivos que vou tocar:
  - `src/application/ports.ts` (apenas docstring de `claimDue`, autorizada por D62)
  - `src/infrastructure/persistence/records/inbox-message.record.ts`
  - `src/infrastructure/persistence/records/outbox-message.record.ts`
  - `src/infrastructure/persistence/inbox-repository.ts`
  - `src/infrastructure/persistence/outbox-repository.ts`
  - `test/integration/inbox-outbox-repository.test.ts`
  - `docs/notas/T22-inbox-outbox-repo.md`
- Assinaturas públicas:
  - `InboxMessageRecord` (`fromDomain(message: InboxMessage): InboxMessageRecord`, `toDomain(record: InboxMessageRecord): InboxMessage`)
  - `OutboxMessageRecord` (`fromDomain(message: OutboxMessage): OutboxMessageRecord`, `toDomain(record: OutboxMessageRecord): OutboxMessage`)
  - `InboxMessageNotProcessedError` (erro de infraestrutura para `markProcessed` sem `processedAt`)
  - `MikroOrmInboxRepository` (alias `SqlInboxRepository`) implementando `InboxRepository` (`tryReceive`, `markProcessed`, além de `findByKey` para leitura direta por PK composta)
  - `MikroOrmOutboxRepository` (alias `SqlOutboxRepository`) implementando `OutboxRepository` (`enqueue`, `claimDue`, `markPublished`, `scheduleRetry`, além de `findById` para leitura direta por PK)
- Alternativas descartadas e motivo:
  - *Usar `em.getConnection().execute(...)` direto sem contexto transacional:* em MikroORM 7, `em.getConnection().execute(sql, params)` não propaga automaticamente `em.getTransactionContext()` de um `EntityManager` transacional (`em.transactional`), o que executaria `tryReceive`, `markProcessed` ou `enqueue` fora da transação do `UnitOfWork`. Por isso usamos `this.em.execute(sql, params)` e `this.em.insertMany(...)` sobre o `EntityManager` da transação recebido pelas `RepositoryFactories` (D25).
  - *Usar `now()` do banco em `claimDue`:* descartado porque `claimDue(now, limit, leaseMs)` recebe o instante do relógio injetado (`Clock`), garantindo determinismo nos testes de lease e retry sem `sleep`.
  - *Traduzir erros SQL localmente em cada repositório ou expor os repositórios como `@Injectable()` / `scopedEm()`:* descartado no retrabalho pós-revisão cruzada porque quem traduz erros do banco (incluindo o `COMMIT`) é o `MikroOrmUnitOfWork` da T20 (`db-errors.ts`), e os repositórios só devem receber o `em` da transação corrente via `RepositoryFactories` (D25).

**Aprovação do humano:** não aplicável (tarefa sem 🔒 e com arquivos listados em `docs/EXECUCAO.md` §6; docstring de `ports.ts` autorizada por D62)

## Ordem de leitura do diff

1. `src/application/ports.ts` — Docstring de `OutboxRepository.claimDue` atualizada conforme D62.
2. `src/infrastructure/persistence/records/inbox-message.record.ts` — Mapeamento MikroORM de `inbox_message` (PK composta `consumer_name` + `message_id`) e conversão `State ↔ domínio`.
3. `src/infrastructure/persistence/records/outbox-message.record.ts` — Mapeamento MikroORM de `outbox_message` (`payload` `jsonb`, `attempts`, `next_attempt_at`, `published_at`) e conversão `State ↔ domínio`.
4. `src/infrastructure/persistence/inbox-repository.ts` — `tryReceive` (`INSERT … ON CONFLICT DO NOTHING` + leitura de `payload_hash` quando já existe), `markProcessed` (com `InboxMessageNotProcessedError`) e `findByKey`.
5. `src/infrastructure/persistence/outbox-repository.ts` — `enqueue`, `claimDue` (reserva por lease com `FOR UPDATE SKIP LOCKED` e `RETURNING *`), `markPublished`, `scheduleRetry` (`attempts = attempts + 1` e `WHERE published_at IS NULL`) e `findById`.
6. `test/integration/inbox-outbox-repository.test.ts` — Testes I-03 de ida e volta (`domínio → record → domínio`), preservação de strings monetárias em `jsonb` (5.1), `tryReceive`/`markProcessed`, corrida de SCHEMA 4.3 com commit e rollback usando `eventually()`, `claimDue` com lease e `SKIP LOCKED` entre conexões concorrentes, `markPublished`/`scheduleRetry` e uso via interface `UnitOfWork`.

## Como verificar

```bash
bun run tarefa:gate
bun test test/integration/inbox-outbox-repository.test.ts
```

## Decisões pendentes

- **D62, decidida pelo humano em 28/10/2026 (na conversa):** `OutboxRepository.claimDue`
  usa a transação que recebe e não abre outra. A "transação curta própria" da porta é
  responsabilidade do worker (T41):
  1. `uow.run((tx) => tx.outbox.claimDue(...))` sozinho, num `uow.run` curto;
  2. publica no SQS **fora** de transação (restrição 4);
  3. `markPublished` ou `scheduleRetry` de cada mensagem, cada um no seu próprio `uow.run`.

  Coerente com D18, SCHEMA 4.5 e ARQUITETURA §7.3. Consequências:
  - no retrabalho da T22, a docstring de `claimDue` em `src/application/ports.ts` passa a
    dizer isso. É mudança de comentário, não de assinatura, e está autorizada por esta
    decisão (AGENTS, regra 4). A docstring do `outbox-repository.ts` também;
  - na integração, o humano registra D62 em `docs/ARQUITETURA.md` §1 e na linha da T41.

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- Registrar `InboxMessageRecord` e `OutboxMessageRecord` no array `entities` de `src/infrastructure/persistence/mikro-orm.config.ts`.
- Nas `RepositoryFactories` da T20 (no `PersistenceModule`): registrar `inbox: (em) => new MikroOrmInboxRepository(em)` e `outbox: (em) => new MikroOrmOutboxRepository(em)`; não exportar os repositórios como providers Nest.

## Fora de escopo / dívida

- A integração com a implementação concreta do `UnitOfWork` (T20, incluindo a tradução de erros em `db-errors.ts`) será exercitada após o merge da T20 na `main`, conforme `docs/EXECUCAO.md` §6 ("T21 e T22 implementam as portas do T01 e usam o `UnitOfWork` só pela interface. A integração com o UoW real é testada depois do merge do T20").

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | importante | `src/infrastructure/persistence/inbox-repository.ts:12-60`, `outbox-repository.ts:7-55`; `test/integration/inbox-outbox-repository.test.ts:646-668` | Cada repositório traduz erros por conta própria (`rethrowPersistenceError`, duplicada nos dois arquivos), e a tradução diverge do SCHEMA §5 e do `translateDbError` da T20. Ela trata como transitórios `40001`, `53300`, `57P02`, `57P03` e códigos Node (`ECONNRESET` etc.), e percorre `cause`/`previous`. O SCHEMA §5 lista só `55P03`, `40P01`, `57014` e conexão. Isso é uma escolha que os docs não fazem e que não está em "Decisões pendentes". Além disso, a T20 descartou de propósito "traduzir erro em cada repositório" e traduz na borda da `uow.run`, cobrindo o COMMIT. Dentro da UoW, a tradução local é redundante (a T20 repassa `TransientInfrastructureError`), e duas listas de SQLSTATE vão se desencontrar com o tempo. O teste de `55P03` exercita só essa cópia local. | Resolvido: removidas `rethrowPersistenceError` e todos os blocos `try/catch` de `inbox-repository.ts` e `outbox-repository.ts`, deixando os erros do driver subirem para tradução na borda do `MikroOrmUnitOfWork` (T20, `db-errors.ts`). No teste de `lock_timeout` (como a T20 ainda não está mergeada nesta branch), conferimos o SQLSTATE cru `code === '55P03'`. |
| 2 | importante | `inbox-repository.ts:67-74`, `outbox-repository.ts:57-70` (docstring e `scopedEm`), nota "Pedidos ao integrador" | Os repositórios funcionam em modo duplo: com o `EntityManager` global, `scopedEm()` faz `fork()` e `this.em.execute` roda em autocommit. A docstring do outbox diz que `claimDue`/`markPublished`/`scheduleRetry` recebem "o `EntityManager` raiz". As classes têm `@Injectable()`, e a nota pede para "conectar no `PersistenceModule`". Isso contraria D25 (os repositórios chegam **só** dentro de `uow.run`) e as `RepositoryFactories` da T20, que sempre passam o `em` da transação. Se alguém injetar via Nest, `enqueue` e `tryReceive` gravam fora da transação financeira **sem erro**, o que quebra a restrição 4 e §6.5 em silêncio. Os construtores `(em: EntityManager)` encaixam nas factories da T20 (o `merge-tree` das duas branches não tem conflito). | Resolvido: removidos `@Injectable()`, `scopedEm()` e qualquer uso do `EntityManager` global nos repositórios e nos testes; os construtores recebem apenas o `em` da transação (D25). Atualizado "Pedidos ao integrador" para registrar `(em) => new MikroOrmInboxRepository(em)` e `(em) => new MikroOrmOutboxRepository(em)` nas `RepositoryFactories` da T20. |
| 3 | importante | `test/integration/inbox-outbox-repository.test.ts:173-224` | Falta cobertura da corrida do SCHEMA 4.3: duas transações com o mesmo `messageId`, em que a segunda espera no índice e recebe conflito quando a primeira faz commit (ou é aceita quando a primeira faz rollback). Os testes só cobrem entregas sequenciais. O revisor conferiu com um teste temporário (já apagado): o código **está correto**. A segunda transação fica bloqueada até o fim da primeira e depois devolve `{accepted:false, storedPayloadHash: <hash da primeira>}` no commit, ou `{accepted:true}` no rollback. Esse comportamento ainda não está protegido contra regressão. | Resolvido: adicionado o teste da corrida de SCHEMA 4.3 com duas transações concorrentes no mesmo `messageId`, verificando via `eventually()` em `pg_stat_activity` (`wait_event_type = 'Lock'`) que a segunda aguarda a primeira e recebe `{ accepted: false, storedPayloadHash: HASH_A }` quando a primeira faz commit, e `{ accepted: true }` quando a primeira faz rollback. |
| 4 | menor | `outbox-repository.ts:157-174` | `scheduleRetry` grava `attempts` com o valor absoluto do objeto em memória e não filtra `published_at IS NULL`. O SCHEMA 4.5 diz `attempts = attempts + 1`. Com o lease vencido e dois workers na mesma linha (C-06b), um incremento pode se perder (métrica de retries, SCHEMA 4.6). Um `scheduleRetry` atrasado também pode encurtar o lease de quem reclamou depois e gerar duplicata. Duplicata é aceita por §11.5, então isso não fere a correção. | Resolvido: `scheduleRetry` agora grava `SET attempts = attempts + 1, next_attempt_at = ?` com `WHERE id = ? AND published_at IS NULL`, e o teste cobre também a rejeição de `scheduleRetry` sobre mensagem já publicada. |
| 5 | menor | `inbox-repository.ts:132-136` | `markProcessed` sem `processedAt` lança `InvalidTransactionStateError`, uma classe de domínio documentada como "transição a partir de estado terminal (MODELAGEM 4.3)" de `WagerTransaction`. Aqui é uma pré-condição violada pelo chamador (bug de infraestrutura). Um `Error` comum ou um erro da própria persistência evita confundir essa falha com uma regra de domínio. | Resolvido: criado e exportado `InboxMessageNotProcessedError` em `inbox-repository.ts` (removendo o uso de `InvalidTransactionStateError` do domínio) e atualizado o teste correspondente. |
| 6 | menor | `outbox-repository.ts:92-128` (port em `src/application/ports.ts:109`) | **Decisão pendente.** A porta diz que `claimDue` roda "em transação curta própria", mas ela está em `TxRepositories` e a T22 usa o `em` recebido, sem abrir transação. O revisor verificou que, dentro de uma transação, o claim fica travado até o commit: um claim concorrente vê 0 linhas e o lease só passa a valer depois do commit. Então o desenho é coerente com D18, SCHEMA 4.5 e ARQUITETURA §7.3 **se** o worker chamar `uow.run(tx => tx.outbox.claimDue(...))` sozinho, publicar fora da transação e fazer `markPublished`/`scheduleRetry` cada um no seu `uow.run`. Proposta: registrar isso no comentário da porta e na tarefa do worker, e corrigir a docstring do outbox (achado 2). Também falta documentar a reordenação em memória por `occurred_at` (linhas 120-122). O SQL ordena por `next_attempt_at`, como no SCHEMA 4.5, então a reordenação é inofensiva. | Resolvido (D62): atualizadas as docstrings de `OutboxRepository.claimDue` em `src/application/ports.ts` e `src/infrastructure/persistence/outbox-repository.ts` explicitando que `claimDue` usa a transação recebida, que o worker deve chamá-lo sozinho num `uow.run` curto, e documentando a ordenação do lote devolvido por `(occurredAt ASC, id ASC)`. |

O que foi verificado e está conforme:

- **Gate.** `bun run tarefa:gate` deu verde (typecheck, skills, unidade, arquitetura e integração; 29/29). `bun test --rerun-each 5` deu 50/50.
- **Mutações.** As 6 mutações temporárias quebraram testes, e os arquivos foram restaurados com `git checkout`:
  - sem `SKIP LOCKED`;
  - `ON CONFLICT DO UPDATE` sobrescrevendo o hash;
  - lease que não avança;
  - `scheduleRetry` sem gravar `attempts`;
  - claim sem `published_at IS NULL`;
  - `storedPayloadHash` devolvendo o hash recebido em vez do gravado.
- **Inbox.** `tryReceive` usa `INSERT … ON CONFLICT DO NOTHING RETURNING` e um `SELECT` do hash gravado, de acordo com D7 e SCHEMA 4.4. O `char(64)` passa por `trim`.
- **Outbox.** `claimDue` está de acordo com D18, SCHEMA 4.5 e D48: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`, com o lease em `now + leaseMs` vindo do `Clock`. O cenário de C-06b (o lease expira e outra chamada reclama a linha) está coberto. O backoff fica no domínio, sem limite de tentativas (D12).
- **Mapeamento.** Payload em `jsonb`, com `Money` lido como `string`, inclusive `99999999999999999.99` (5.1). As datas fazem ida e volta, e os campos opcionais `processedAt`/`publishedAt` passam por `null ↔ undefined`. Nenhum dinheiro é `number`.
- **Testes.** Sem `sleep` e sem double de domínio. O único double é da porta `UnitOfWork`, permitido por EXECUCAO §6.
- **Escopo.** O diff toca só os arquivos da Abordagem.

Veredito: aprovado com ressalvas
