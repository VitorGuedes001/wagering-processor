# T21 — Repositório de transações

> Estado: Testada · Raia: G · Revisor: C · Branch: `t21-transaction-repo`

## O que muda

- `src/infrastructure/persistence/records/wager-transaction.record.ts` (novo): define o record MikroORM `WagerTransactionRecord` para a tabela `wager_transaction`, mantendo `amount` e `balanceAfter` como `string` (`numeric(19,2)`).
- `src/infrastructure/persistence/wager-transaction-repository.ts` (novo): implementa a porta `WagerTransactionRepository` (`MikroOrmWagerTransactionRepository`), os mapeadores `toWagerTransactionDomain` e `toWagerTransactionRecordData`, o claim por lease com `FOR UPDATE SKIP LOCKED` e a tradução de erros `23505` (`UniqueViolationError`) e transitórios (`TransientInfrastructureError`).
- `test/integration/wager-transaction-repository.test.ts` (novo): implementa a suíte de integração **I-03 (transação)** contra PostgreSQL real, verificando ida e volta de todos os `kind` e `status`, `typeof === 'string'` nos valores monetários do record, consultas, `hasProcessedReversal`, `update`, `lockById` (`FOR UPDATE`), `claimDuePendingReferences` (`SKIP LOCKED` + lease), tradução de erros e invariante financeira `assertAllWalletsConsistent` no `afterEach`.
- `docs/notas/T21-transaction-repo.md`: esta nota de mudança.

## Por quê

- **CHALLENGE §5.1, §6.1, MODELAGEM D45, SCHEMA §2.2 e §7, ARQUITETURA §2.1 e §8:** manter a entidade de persistência (`WagerTransactionRecord`) separada da entidade de domínio (`WagerTransaction`), lendo e gravando colunas `numeric(19,2)` exclusivamente como `string` e convertendo via `Money.fromPersistence` / `Money.toJSON().amount`.
- **ARQUITETURA §3 e SCHEMA §2.2, §4.2, §4.5 (D1, D4, D15, D18):** implementar todas as operações de `WagerTransactionRepository` exigidas pelo fluxo de submissão (`findByIdempotencyKey`, `findByExternalId`, `findById`, `hasProcessedReversal`, `insert`, `update`) e pelo worker de referências pendentes (`claimDuePendingReferences` com lease e `FOR UPDATE SKIP LOCKED`, `lockById` com `SELECT … FOR UPDATE`).
- **SCHEMA §5 e `src/application/ports.ts`:** traduzir violações de unicidade (`23505` nos índices de `UniqueConstraint`) em `UniqueViolationError` e falhas transitórias (`55P03`, `40P01`, `57014`, conexão) em `TransientInfrastructureError` sem vazar exceções do driver para a camada de aplicação.
- **TESTES §4.2 (I-03) e D34, D40, D60:** provar a ida e volta completa (`domínio → record → domínio`) e os mecanismos de concorrência (`FOR UPDATE` e `SKIP LOCKED`) em banco PostgreSQL isolado por arquivo de teste, com `assertAllWalletsConsistent(db)` em todo `afterEach`.

## Abordagem

- **Arquivos que vou tocar:**
  - `src/infrastructure/persistence/records/wager-transaction.record.ts`
  - `src/infrastructure/persistence/wager-transaction-repository.ts`
  - `test/integration/wager-transaction-repository.test.ts`
  - `docs/notas/T21-transaction-repo.md`
- **Assinaturas públicas:**
  - `class WagerTransactionRecord`
  - `class MikroOrmWagerTransactionRepository implements WagerTransactionRepository`
  - `function toWagerTransactionDomain(record: WagerTransactionRecord): WagerTransaction`
  - `function toWagerTransactionRecordData(transaction: WagerTransaction): RequiredEntityData<WagerTransactionRecord>`
- **Alternativas descartadas e motivo:**
  - *Mapear `wallet_id` e `reference_transaction_id` como relações `@ManyToOne` no MikroORM:* descartado porque `WagerTransaction` no domínio carrega apenas os UUIDs (`walletId`, `referenceTransactionId`), relações trariam proxies/joins desnecessários e acoplariam o record de `wager_transaction` ao `WalletRecord` da T20.
  - *Depender do Identity Map (`em.persist` + `em.flush`) para `insert` e `update`:* descartado porque o domínio é imutável/separado dos records do ORM (SCHEMA §7). Usar `em.insert`, `em.nativeUpdate` e `{ disableIdentityMap: true }` garante execução imediata do SQL dentro da transação atual (capturando `23505` no ponto exato da chamada), atualiza apenas as colunas mutáveis permitidas pelo trigger `wager_tx_guard` (SCHEMA §3) e evita leituras obsoletas em `findById`/`lockById`.
  - *Usar `em.getConnection().execute` em vez de `em.execute` no claim:* descartado porque `em.getConnection().execute` não propaga automaticamente o contexto transacional de `em.transactional(...)`, enquanto `em.execute` respeita a transação ativa do `EntityManager`.

**Aprovação do humano:** não aplicável (tarefa sem 🔒 e com arquivos listados em `docs/EXECUCAO.md` §6)

## Ordem de leitura do diff

1. `src/infrastructure/persistence/records/wager-transaction.record.ts` — mapeamento das 22 colunas de `wager_transaction` (SCHEMA §2.2), com `amount` e `balanceAfter` tipados como `string` (`numeric(19,2)`).
2. `src/infrastructure/persistence/wager-transaction-repository.ts` — `toWagerTransactionDomain` / `toWagerTransactionRecordData` (conversão via `Money.fromPersistence` e `Money.toJSON().amount`), `MikroOrmWagerTransactionRepository` (`findBy*`, `hasProcessedReversal`, `lockById` com `LockMode.PESSIMISTIC_WRITE`, `claimDuePendingReferences` com CTE + `FOR UPDATE SKIP LOCKED`, `insert` e `update` restrito às colunas mutáveis de `wager_tx_guard`) e `translatePersistenceError`.
3. `test/integration/wager-transaction-repository.test.ts` — testes de integração **I-03 (transação)** cobrindo ida e volta de todos os kinds/status, `typeof === 'string'` no record, extremos de `numeric(19,2)`, `hasProcessedReversal`, `update`, `lockById` (`55P03` → `TransientInfrastructureError`), `claimDuePendingReferences` (`SKIP LOCKED` + lease) e `23505` → `UniqueViolationError`.

## Como verificar

```bash
bun run tarefa:gate
bun test ./test/integration/wager-transaction-repository.test.ts
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge:

- Em `src/infrastructure/persistence/mikro-orm.config.ts`: registrar `WagerTransactionRecord` (de `./records/wager-transaction.record`) no array `entities`.
- Quando a **T20** for integrada: conectar `new MikroOrmWagerTransactionRepository(txEm)` na propriedade `transactions` de `TxRepositories` dentro de `src/infrastructure/persistence/unit-of-work.ts`, exportar `MikroOrmWagerTransactionRepository` em `src/infrastructure/persistence/persistence.module.ts` e, se desejar unificar a tradução de erros SQL, delegar `translatePersistenceError` de `wager-transaction-repository.ts` para `src/infrastructure/persistence/db-errors.ts`.

## Fora de escopo / dívida

- A integração de `MikroOrmWagerTransactionRepository` dentro do `UnitOfWork` real depende do merge da **T20** (`docs/EXECUCAO.md` §6: *"T21 e T22 implementam as portas do T01 e usam o `UnitOfWork` só pela interface. A integração com o UoW real é testada depois do merge do T20"*).

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
