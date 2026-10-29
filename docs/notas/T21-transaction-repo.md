# T21 — Repositório de transações

> Estado: Testada · Raia: G · Revisor: C · Branch: `t21-transaction-repo`

## O que muda

- `src/infrastructure/persistence/records/wager-transaction.record.ts` (novo): define o record MikroORM `WagerTransactionRecord` para a tabela `wager_transaction`, mantendo `amount` e `balanceAfter` como `string` (`numeric(19,2)`).
- `src/infrastructure/persistence/wager-transaction-repository.ts` (novo): implementa a porta `WagerTransactionRepository` (`MikroOrmWagerTransactionRepository`), os mapeadores `toWagerTransactionDomain` e `toWagerTransactionRecordData` e o claim por lease com `FOR UPDATE SKIP LOCKED`, recebendo apenas o `EntityManager` da transação (D25) e deixando os erros do driver subirem para tradução na borda do `MikroOrmUnitOfWork` (T20).
- `test/integration/wager-transaction-repository.test.ts` (novo): implementa a suíte de integração **I-03 (transação)** contra PostgreSQL real, verificando ida e volta de todos os `kind` e `status`, `typeof === 'string'` nos valores monetários do record, consultas, `hasProcessedReversal` (incluindo reversões não `PROCESSED` com `reference_transaction_id`), `update` (incluindo bloqueio por `wager_tx_guard`), `lockById` (`FOR UPDATE` e `55P03`), `claimDuePendingReferences` (`SKIP LOCKED` + lease + desempate por `id`), violações `23505` e invariante financeira `assertAllWalletsConsistent` no `afterEach`.
- `docs/notas/T21-transaction-repo.md`: esta nota de mudança.

## Por quê

- **CHALLENGE §5.1, §6.1, MODELAGEM D45, SCHEMA §2.2 e §7, ARQUITETURA §2.1 e §8:** manter a entidade de persistência (`WagerTransactionRecord`) separada da entidade de domínio (`WagerTransaction`), lendo e gravando colunas `numeric(19,2)` exclusivamente como `string` e convertendo via `Money.fromPersistence` / `Money.toJSON().amount`.
- **ARQUITETURA §3 e SCHEMA §2.2, §4.2, §4.5 (D1, D4, D15, D18, D25):** implementar todas as operações de `WagerTransactionRepository` exigidas pelo fluxo de submissão (`findByIdempotencyKey`, `findByExternalId`, `findById`, `hasProcessedReversal`, `insert`, `update`) e pelo worker de referências pendentes (`claimDuePendingReferences` com lease e `FOR UPDATE SKIP LOCKED`, `lockById` com `SELECT … FOR UPDATE`), recebendo exclusivamente o `EntityManager` transacional do `UnitOfWork` (D25).
- **SCHEMA §5 e T20 (`db-errors.ts`):** deixar erros do driver (`23505`, `55P03`, `23000`, etc.) subirem sem tradução duplicada no repositório, para que `MikroOrmUnitOfWork` traduza na borda da transação (cobrindo `work` e `COMMIT`).
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
  - *Traduzir erros SQL localmente no repositório ou expor o repositório como `@Injectable()`:* descartado no retrabalho pós-revisão cruzada porque a tradução centralizada fica em `MikroOrmUnitOfWork` / `translateDbError` (T20, cobrindo também o `COMMIT`), e os repositórios só devem ser instanciados com o `EntityManager` da transação pelas `RepositoryFactories` (D25).

**Aprovação do humano:** não aplicável (tarefa sem 🔒 e com arquivos listados em `docs/EXECUCAO.md` §6)

## Ordem de leitura do diff

1. `src/infrastructure/persistence/records/wager-transaction.record.ts` — mapeamento das 22 colunas de `wager_transaction` (SCHEMA §2.2), com `amount` e `balanceAfter` tipados como `string` (`numeric(19,2)`).
2. `src/infrastructure/persistence/wager-transaction-repository.ts` — `toWagerTransactionDomain` / `toWagerTransactionRecordData` (conversão via `Money.fromPersistence` e `Money.toJSON().amount`) e `MikroOrmWagerTransactionRepository` (`findBy*`, `hasProcessedReversal`, `lockById` com `LockMode.PESSIMISTIC_WRITE`, `claimDuePendingReferences` com CTE + `FOR UPDATE SKIP LOCKED`, `insert` e `update` restrito às colunas mutáveis de `wager_tx_guard`).
3. `test/integration/wager-transaction-repository.test.ts` — testes de integração **I-03 (transação)** cobrindo ida e volta de todos os kinds/status, `typeof === 'string'` no record, extremos de `numeric(19,2)`, `hasProcessedReversal`, `update` + `wager_tx_guard`, `lockById` (`55P03`), `claimDuePendingReferences` (`SKIP LOCKED` + lease + desempate por `id`) e violações `23505`.

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
- Nas `RepositoryFactories` da T20 (no `PersistenceModule`): registrar `transactions: (em) => new MikroOrmWagerTransactionRepository(em)`; não exportar o repositório como provider Nest.

## Fora de escopo / dívida

- A integração de `MikroOrmWagerTransactionRepository` dentro do `MikroOrmUnitOfWork` real (incluindo a tradução via `translateDbError` de `db-errors.ts`) depende do merge da **T20** (`docs/EXECUCAO.md` §6: *"T21 e T22 implementam as portas do T01 e usam o `UnitOfWork` só pela interface. A integração com o UoW real é testada depois do merge do T20"*).

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

Revisor: Claude Code (subagente `revisor`), 28/10/2026, sobre `efce60b`. A coluna
"Resolução" traz a sugestão do revisor; o autor substitui pelo que fez.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | importante | `test/integration/wager-transaction-repository.test.ts:687-701` | O teste "hasProcessedReversal distingue reversões PROCESSED de REJECTED/FAILED" não exercita o filtro de `status` (D1, porta `hasProcessedReversal`). O `REFUND` `REJECTED` é gravado com `reference_transaction_id` nulo (`reject()` não preenche a referência), então a consulta nunca o enxerga. Mutação M1 (remover `status: PROCESSED` do `count`) deixa os 9 testes verdes. O código está certo; o teste passa pelo motivo errado. | Resolvido: gravados um `REFUND` `REJECTED` e um `ROLLBACK` `FAILED` **com** `referenceTransactionId: bet1.id` (via `WagerTransaction.rehydrate`) antes do `REFUND` `PROCESSED`, afirmando `hasProcessedReversal(bet1.id) === false` em ambos para exercitar diretamente o filtro `status: PROCESSED`. |
| 2 | importante | `test/integration/wager-transaction-repository.test.ts:891-897` | O caso "regravar transação terminal é barrado por `wager_tx_guard`" passa mesmo se o `update` não falhar: o `throw new Error('Deveria ter falhado…')` está dentro do `try`, é capturado pelo `catch`, e as duas asserções negativas (`not.toBeInstanceOf`) aceitam esse erro. Mutação M6 (`update` retorna sem gravar para essa cópia) deixa os 9 testes verdes. Asserção mais fraca do que a garantia D52 que o teste diz cobrir. | Resolvido: substituído o `try/catch` com `throw` interno pelo helper `caught(() => repo.update(staleCopy))` (que lança fora do `try` se não falhar), verificando `code === '23000'` e `constraint === 'wager_tx_guard'` (D51, D52) e relendo a linha para confirmar que permanece `REJECTED` com `REFERENCE_NOT_FOUND`. |
| 3 | importante | `src/infrastructure/persistence/wager-transaction-repository.ts:18-98` (e cada `catch` das linhas 185-325) | `translatePersistenceError` duplica a tradução de SCHEMA §5 que a T20 centraliza em `db-errors.ts` (`translateDbError`, local previsto em ARQUITETURA §2, árvore de `persistence/`), com tabela divergente: a T21 trata como transitório também `53300` e todo `57P*` (inclui `57P04 database_dropped`, que não é transitório) e códigos `ECONN*/ETIMEDOUT/EPIPE` por string; a T20 trata `55P03`, `40P01`, `57014`, `57P01`, classe `08` e `ConnectionException`. O mesmo erro seria classificado diferente conforme apareça numa query do repositório (T21) ou no COMMIT (T20). Não há tradução dupla: `translateDbError` devolve inalterados `UniqueViolationError`/`TransientInfrastructureError`, e as duas classificam `23505` igual. Os repositórios da T20 não traduzem; quem traduz é o `MikroOrmUnitOfWork`, envolvendo `work` e COMMIT. | Resolvido: removidos `translatePersistenceError` e todos os blocos `try/catch` de `wager-transaction-repository.ts`, deixando o erro do driver subir para `MikroOrmUnitOfWork` (T20). Nos testes do repositório (como a T20 ainda não está mergeada nesta branch), conferimos o SQLSTATE cru (`code === '55P03'` em `lockById` e `code === '23505'` + `constraint` em `insert`). |
| 4 | importante | `src/infrastructure/persistence/wager-transaction-repository.ts:170`; nota, "Pedidos ao integrador" | A classe é `@Injectable()` e a nota pede ao integrador "exportar `MikroOrmWagerTransactionRepository` em `persistence.module.ts`". Registrado como provider Nest, o repositório receberia o `EntityManager` global, não o da transação, e escreveria fora do UoW (D25: "o que está dentro da transação é o que roda dentro de `work`"). A T20 monta repositórios só por `RepositoryFactories` (`(em: EntityManager) => TxRepositories[K]`), compostas no `PersistenceModule`, e seus repositórios não são `@Injectable`. O pedido também diz para conectar o repositório "dentro de `unit-of-work.ts`", mas na T20 isso fica na factory, não no UoW. O construtor é compatível: recebe `EntityManager` de `@mikro-orm/postgresql`, o mesmo tipo da T20. | Resolvido: removido `@Injectable()` de `MikroOrmWagerTransactionRepository` (construtor recebe apenas o `em` da transação, D25) e atualizado "Pedidos ao integrador" para registrar `transactions: (em) => new MikroOrmWagerTransactionRepository(em)` nas `RepositoryFactories` da T20. |
| 5 | menor | `test/integration/wager-transaction-repository.test.ts:1042-1046` | Passo 5 do teste de claim só afirma `toHaveLength(2)` e que `future` não veio. Não confere quais duas nem a ordem: com due1/due2/due3 todas em `now+30s`, o desempate é por `id`. | Resolvido: o passo 5 agora afirma exatamente `[due1.id, due2.id, due3.id].sort().slice(0, 2)`, exercitando a ordenação de desempate `(next_reference_attempt_at ASC, id ASC)`. |
| 6 | menor | `test/integration/wager-transaction-repository.test.ts:189-254` | `openFundedWallet` recebe `repo` e não usa (`void repo`); confunde o leitor sobre qual `EntityManager` grava. | Resolvido: removido o parâmetro `repo` de `openFundedWallet` e de todas as chamadas. |
| 7 | menor | `src/infrastructure/persistence/records/wager-transaction.record.ts:77` | O worktree tem uma alteração não commitada nesse arquivo (só uma linha em branco no fim), anterior a esta revisão. Não afeta o gate. | Resolvido: linha em branco solta descartada (`git checkout -- src/infrastructure/persistence/records/wager-transaction.record.ts`). |

**O que verifiquei e está conforme:**

- **Gate:** `bun run tarefa:gate` verde (typecheck, skills, unidade, arquitetura, integração; concorrência sem testes ainda). `bun test --rerun-each 5 ./test/integration/wager-transaction-repository.test.ts`: 45 pass, 0 fail.
- **Escopo:** o diff `main...t21-transaction-repo` toca só os 4 arquivos da Abordagem.
- **`update` × `wager_tx_guard`:** grava só `status`, `reference_transaction_id`, `failure_code`, `balance_after`, `reference_attempts`, `next_reference_attempt_at`, `updated_at`, `processed_at`. Nenhuma coluna de identidade do trigger (migration 01, linhas 153-166) é enviada. As transições de MODELAGEM 4.3 a partir de `PENDING_REFERENCE` (`scheduleReferenceRetry`, `markProcessed`, `reject`, `fail`) passam nos CHECKs de 2.2 e no trigger, e estão testadas. `UPDATE` idêntico em linha terminal também passa (`NEW IS DISTINCT FROM OLD`).
- **`claimDuePendingReferences` (D18, SCHEMA 4.5):** CTE com `FOR UPDATE SKIP LOCKED`, filtro `status = PENDING_REFERENCE AND next_reference_attempt_at <= now`, `ORDER BY next_reference_attempt_at, id`, `LIMIT`, lease `next_reference_attempt_at = now + leaseMs` sem mudar `status` nem `reference_attempts` (permitido pelo trigger e por `wager_tx_reference_schedule_ck`). Devolve ids, como a porta. Se o worker morre, o lease vence e a linha volta a ser elegível. Isso está testado no passo 5. Usa o `now` da porta (relógio injetável) em vez do `now()` do banco, coerente com a assinatura.
- **`hasProcessedReversal` (D1):** filtra `kind IN (REFUND, ROLLBACK)` e `status = PROCESSED`. O filtro de kind está coberto (mutação M7 quebra); o de status, não (achado 1).
- **5.1:** sem `number`, `parseFloat`, `Number(`, `toFixed` ou `Math.` em dinheiro. `amount`/`balance_after` são `string` no record, convertidos por `Money.fromPersistence` e `toJSON().amount`. A-03 cobre `persistence/` e passa. Todos os opcionais mapeiam `null ↔ undefined` nos dois sentidos; datas são `Date` com `forceUtcTimezone`.
- **Testes:** banco próprio por arquivo (D34), `assertAllWalletsConsistent` no `afterEach` (D40), sem `sleep`, sem mock nem test double do domínio, Postgres real.
- **Mutações** (aplicadas no worktree e restauradas com `git checkout --`): M2 (sem `SKIP LOCKED`) quebra o claim; M3 (lease = `now`) quebra; M4 (`update` sem `reference_transaction_id`) quebra; M5 (`55P03` fora da lista) quebra; M7 (sem filtro de kind) quebra; M8 (ordem `DESC`) quebra. M1 e M6 sobrevivem (achados 1 e 2).

Veredito: aprovado com ressalvas
