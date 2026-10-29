# Architecture

Decisões, trade-offs e limitações do Wagering Processor. Cada seção é escrita
quando o bloco correspondente fica pronto ([docs/PLANO.md](docs/PLANO.md)). Até
lá, aponta para o documento de planejamento de origem.

## 1. Visão geral

_A escrever no B12._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §2.

## 2. Modelo de domínio e `Money`

Detalhe em [docs/MODELAGEM.md](docs/MODELAGEM.md). Código em `src/domain/`: TypeScript
puro, sem Nest, ORM, AWS SDK ou zod. O teste de arquitetura A-01 garante isso com uma
lista branca de imports.

### `Money`

- **Representação:** centavos em `bigint` (D8), e não `decimal.js`. A escala é fixa em 2
  casas (§6.1), então um inteiro na unidade mínima é exato, nativo e sem dependência.
- **Sem arredondamento:** mais de 2 casas é rejeitado (D9). Não há multiplicação nem
  divisão no domínio, então nada produz casa extra.
- **Entrada estrita:** regex `^(0|[1-9]\d*)\.\d{2}$`. Rejeita `25`, `25.5`, `1e3`,
  `+5.00`, `-5.00` e **número JSON** (`"amount": 25`), que já chega como `number` depois
  do `JSON.parse`.
- **Parse e formatação só textuais:** `BigInt(inteiro) * 100n + BigInt(centavos)` na ida;
  `/ 100n`, `% 100n` e `padStart` na volta. Nenhum caminho passa por float.
- **Dois construtores:** `from` é o contrato de entrada e rejeita negativo.
  `fromPersistence` lê o banco e aceita negativo, porque a `difference` da reconciliação
  pode ser negativa.
- **Guarda estática (A-03):** um teste varre `src/domain` e `src/infrastructure/persistence`
  e falha com `parseFloat`, `Number(`, `toFixed`, `Math.` ou propriedade de dinheiro
  tipada `number`.

### Entidades e invariantes

| Entidade | Invariante que o desenho torna estrutural |
|---|---|
| `Wallet` (aggregate root) | `debit`/`credit` **devolvem o lançamento**: não existe caminho que muda saldo sem produzir ledger. `version` começa em 1 e só sobe com o saldo, e o `OPENING` não incrementa |
| `WalletLedgerEntry` | sem campos mutáveis e sem métodos de transição. `create` valida `antes ± valor = depois`, moeda única e não-negatividade (D58) |
| `WagerTransaction` | transições explícitas (MODELAGEM 4.3): terminal → qualquer coisa lança `InvalidTransactionStateError`. Guarda o snapshot do saldo no desfecho (D10), para o replay devolver o saldo "daquele momento" (§7.7) |

Todas usam construtor privado com factories (`create`/`open`/`opening`) e `rehydrate`,
que reconstrói do banco sem revalidar transições (§6.0).

### A regra de negócio como função pura

`decideWager(transação, wallet, referência, jáRevertida, backoff)` devolve `APPLY`,
`REJECT` com `failureCode` ou `AWAIT_REFERENCE`. As 10 verificações de §7 rodam numa
**ordem fixa**, e a primeira falha decide: o mesmo caso sempre produz o mesmo código.

- **Por que função pura:** a regra envolve três objetos e não pertence a nenhum deles.
  Sendo pura, HTTP, SQS e o worker de referências usam o mesmo caminho, e cada linha
  de §7 é testável sem banco.
- **Prova da ordem:** a revisão trocou 4 pares de regras vizinhas numa cópia do código,
  e cada troca quebrou de 1 a 5 testes.
- **Decisões que ela fixa:**
  - D1: uma transação é revertida no máximo uma vez, por qualquer kind. Lido ao pé da
    letra, §7.4 permitiria `REFUND` **e** `ROLLBACK` da mesma `BET`.
  - D2: `WIN`/`LOSS` com referência seguem as mesmas verificações de referência.
  - D3: `LOSS` aceita `0.00`.
  - D61: referência ainda pendente quando as tentativas acabam é rejeitada com
    `REFERENCE_NOT_PROCESSED`, e nunca espera além do limite.
- **Ressalva:** "função pura" vale para a **decisão**. Correção sob concorrência depende
  de ela ser chamada com a wallet travada (`SELECT … FOR UPDATE`), o que é papel do use
  case e da Unit of Work (seções 3 e 5, ondas 2 e 3).

### `payloadHash` e eventos

- **`payloadHash`:** SHA-256 de um JSON canônico (chaves ordenadas, opcionais omitidos)
  dos campos de negócio de MODELAGEM 9.1. Copia só esses campos, então passar o comando
  inteiro, com `idempotencyKey` e `correlationId`, não muda o hash. A mesma operação por
  HTTP ou por SQS gera o mesmo hash.
- **Eventos:** `eventType` e `version` vivem no tipo de cada subclasse, nunca numa string
  no call site, e `data` só leva `MoneyProps`, com string (§11). Um `bigint` que vazasse
  faria o `JSON.stringify` lançar, e não passar calado.

### Cobertura

338 testes de unidade, **sem test double do domínio**: todos montam objetos pelas
factories reais. Duas tarefas chegaram a usar `Money` falso para contornar dependências
ainda não integradas, e isso foi removido na revisão.

## 3. ORM, mapeamento e estratégia transacional

Detalhe em [docs/SCHEMA.md](docs/SCHEMA.md) §5 e §7. Código em `src/infrastructure/persistence/`.

### Records separados do domínio

Cada tabela tem um *record* do MikroORM (`records/*.record.ts`), e cada repositório
converte `record ↔ domínio` à mão, com `rehydrate` na ida e `toJSON().amount` na
volta. O domínio não conhece o ORM (A-01), e o record não tem regra nenhuma.

- **Dinheiro é `string` no record**, com coluna `numeric(19,2)`. Do banco para o
  domínio passa só por `Money.fromPersistence`; nenhum `number` existe no caminho.
- **Sem relações declaradas:** as FKs compostas vivem no schema. Declarar
  `@ManyToOne` traria proxies e reordenaria escritas.
- **Sem `@Property({ version: true })`:** a `version` da wallet é conferida no
  próprio `UPDATE … WHERE version = $esperada`. Zero linhas é bug, não corrida, porque
  quem chega ali já tem o lock (`StaleWalletVersionError`).

### Repositórios executam na hora

Nenhum `persist`/`flush`, nenhum identity map: `insert`, `nativeUpdate` e leituras
com `disableIdentityMap`. A ordem das escritas é a do use case (a FK do ledger exige
a transação antes do lançamento), e o erro aparece na chamada que o causou.

### Unit of Work explícita (D25)

```ts
await uow.run(async (tx) => {
  const wallet = await tx.wallets.lockById(id);   // SELECT … FOR UPDATE (D15)
  ...
});
```

- **`run`:** `READ COMMITTED` e, como primeira query, `lock_timeout` (2 s),
  `statement_timeout` (5 s) e `idle_in_transaction_session_timeout` (10 s) locais à
  transação (D21). Um teste com uma conexão só prova que eles não vazam para a
  transação seguinte.
- **`readSnapshot`:** `REPEATABLE READ READ ONLY` para a reconciliação (D22), sem
  `lock_timeout` porque não trava nada.
- **Repositórios por fábrica:** `RepositoryFactories` monta os cinco repositórios com
  o `EntityManager` da transação. Nenhum repositório é provider do Nest: injetado,
  receberia o `EntityManager` global e escreveria fora da transação, sem erro.
- **Outbox (D62):** o worker faz o claim num `uow.run` curto, publica fora de
  transação e marca cada mensagem no seu próprio `uow.run`.

### Tradução de erro na borda

A UoW traduz o erro do driver uma vez, num `try/catch` que envolve o `work` **e o
COMMIT**. Os triggers *deferred* (D53) só falham no COMMIT, e um tradutor dentro do
repositório nunca os veria.

| Erro | Vira |
|---|---|
| `23505` de constraint conhecida | `UniqueViolationError(constraint)`, que o use case usa para refazer o fluxo ou responder `WALLET_ALREADY_EXISTS` |
| `55P03`, `40P01`, `57014`, `57P01`–`57P03`, `25P03`, classe `08`, socket, conexão perdida | `TransientInfrastructureError`: 503 no HTTP, retry na fila |
| `23514`, `23503`, `23000` de trigger, o resto | passa sem tradução: é bug, e o estado errado não foi gravado |

### Prova

I-03 para as cinco entidades, contra Postgres real: ida e volta com dinheiro como
string, `FOR UPDATE` travando uma segunda conexão, `SKIP LOCKED` e lease nos claims,
corrida da inbox (SCHEMA 4.3), conexão derrubada antes do COMMIT, saldo sem
lançamento recusado no COMMIT e snapshot recusando escrita. As mutações que a revisão
cruzada fez sobreviver (tirar o filtro de status, `SET SESSION` no lugar de `SET
LOCAL`, tradução só no `work`) passaram a quebrar testes.

## 4. Schema e garantias no banco

Detalhe em [docs/SCHEMA.md](docs/SCHEMA.md). São 3 migrations reversíveis em `migrations/`.

**Princípio (restrição 9):** o domínio verifica primeiro, para devolver um `failureCode`
útil. O banco verifica de novo, e é ele que impede o estado errado quando o código tem
bug ou quando alguém mexe por SQL.

### Tabelas

`wallet`, `wager_transaction`, `wallet_ledger_entry`, `inbox_message` e `outbox_message`.
Todo dinheiro é `numeric(19,2)` e chega ao domínio como string exata.

### O que é constraint simples

| Garantia | Como |
|---|---|
| saldo e lançamentos nunca negativos | `CHECK` em `wallet.balance`, `balance_before`, `balance_after` |
| uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| idempotência por provedor (D4) | `UNIQUE (provider_id, idempotency_key)` e `(provider_id, external_transaction_id)` |
| uma reversão por referência (D1) | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` |
| no máximo um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| lost update vira violação | `UNIQUE (wallet_id, wallet_version)` no ledger (D16): dois lançamentos derivados do mesmo saldo colidem |
| ledger, wallet e transação na mesma moeda e wallet | FKs compostas `(wallet_id, currency)` e `(transaction_id, wallet_id, currency)` |
| campos coerentes com o status | `CHECK`s "existe se e somente se": `failure_code` em `REJECTED`/`FAILED`, `balance_after`, `processed_at`, agenda de referência |
| `OPENING` é interno | `num_nulls(campos de provedor) = 6` para `OPENING` e `0` para os outros kinds |

### O que exige trigger

Um `CHECK` olha só uma linha. O que envolve histórico ou mais de uma tabela vai em
trigger. Todos lançam SQLSTATE `23000` com o nome do trigger no campo `constraint` do
erro (D51), para o teste e o log saberem qual garantia disparou.

| Trigger | Garante |
|---|---|
| `ledger_immutable`, `ledger_no_truncate` | ledger append-only (§5.5) |
| `ledger_chain` | cada lançamento continua o saldo do anterior, ou parte de 0 |
| `wallet_version_rule` | saldo mudou ⇔ `version + 1`; identidade da wallet não muda |
| `wallet_ledger_match` + `ledger_wallet_match` (D53) | **deferred**: no commit, o saldo da wallet e o último lançamento batem nos dois sentidos |
| `wallet_no_delete` | wallet não é apagada |
| `wager_tx_guard` | transição só a partir de estado permitido, e transação terminal congelada inteira (D52) |

O par deferred é o que transforma "toda mudança de saldo tem lançamento" (§6.2) numa
garantia do banco. O commit falha tanto para saldo sem lançamento quanto para lançamento
sem saldo.

### Trade-offs

- **Triggers custam leitura por escrita:** uma busca por índice único por commit e uma
  por lançamento. É aceito: a escrita financeira é a operação rara e cara, e o ganho é
  invariante garantido mesmo com bug.
- **`TRUNCATE` bloqueado complica os testes.** Por isso cada arquivo de teste usa um banco
  próprio, clonado de um template por worktree (D34, D60), em vez de limpar tabelas.
- **A primeira wallet sem saldo começa sem lançamento.** O primeiro movimento sai na
  `wallet_version = 2`. A cadeia é conferida por saldo, não por contiguidade de versão.

### Prova

19 testes de integração contra Postgres real (TESTES I-01 e I-02):
- I-01 roda as migrations `up → down → up` e confere que o `down` não deixa função,
  trigger nem índice para trás;
- I-02 viola cada constraint, FK e trigger por SQL cru, conferindo SQLSTATE **e** nome.

A demo [`scripts/demo-schema.sql`](scripts/demo-schema.sql) mostra cinco desses casos
manualmente.

## 5. Concorrência

Detalhe em [docs/SCHEMA.md](docs/SCHEMA.md) §4. Código em `src/application/submit-wager-transaction.ts`, `src/infrastructure/persistence/unit-of-work.ts` e `test/concurrency/`.

- **Lock pessimista por wallet (`SELECT … FOR UPDATE`, D15):** serializa exclusivamente operações que disputam a mesma carteira, sem lock global (restrição 6). Em `READ COMMITTED`, o processo que aguarda o lock relê o estado mais recente da carteira assim que o detentor faz commit.
- **Timestamp e decisão sob o lock:** a captura do instante da transação, a re-verificação de idempotência/ID externo (passo 4 de SCHEMA §4.2) e a execução de `decideWager` ocorrem após adquirir o `FOR UPDATE`, garantindo que `wallet_version` e `created_at` avancem em ordem monotônica.
- **Defesa em profundidade:** `UPDATE wallet … WHERE id = $1 AND version = $expectedVersion` e `UNIQUE (wallet_id, wallet_version)` no ledger impedem lost updates mesmo diante de bug na camada de aplicação.
- **Prova (M5):** cenários `C-01` (50× mesma `BET` paralela em 3 processos reais com e sem portão), `C-02` (disputa de saldo `100.00` por duas `BET` de `80.00`), `C-02b` (100 `BET` de `15.00` disputando `1000.00` → 66 `PROCESSED`, 34 `REJECTED`, saldo `10.00`) e `C-03` (20 wallets em paralelo com portão em uma só, provando ausência de lock global), além de `I-04` (`FaultInjector` abortando com `SIGKILL` em `uow.before-commit` com zero linhas persistidas).

## 6. Idempotência

Detalhe em [docs/MODELAGEM.md](docs/MODELAGEM.md) §9 e [docs/SCHEMA.md](docs/SCHEMA.md) §4.2.

- **Persistida no banco (restrição 2):** garantida por `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` em `wager_transaction`, mais `inbox_message` para deduplicação SQS (D7).
- **Dois níveis de checagem (SCHEMA §4.2):**
  1. Passo 2 (antes do lock da wallet): busca rápida por `(provider_id, idempotency_key)` para responder replays sem disputar `FOR UPDATE` na carteira.
  2. Passo 4 (após o lock da wallet): re-verifica `(provider_id, idempotency_key)` e `(provider_id, external_transaction_id)` sob o lock, tratando corridas concorrentes para a mesma carteira.
  3. Recuperação em `23505` (SCHEMA §5): se duas requisições com a mesma chave mas carteiras distintas colidirem no índice único, o use case captura `UniqueViolationError` e consulta a linha vencedora para devolver replay ou conflito.
- **Replay determinístico com snapshot (D10):** `balanceAfter` é gravado na transação no momento do desfecho (`PROCESSED` ou `REJECTED`). Replays devolvem sempre o saldo daquele momento, mesmo após movimentações posteriores na carteira (`I-09`).

## 7. Contrato HTTP e códigos de falha

Detalhe em [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §6 e [docs/MODELAGEM.md](docs/MODELAGEM.md) §10. Código em `src/interface/http/`.

- **Validação estrita na borda com Zod (D27, restrição 5.1):** `moneySchema` exige `amount` como `string` no formato `^(0|[1-9]\d*)\.\d{2}$`. Qualquer `number` JSON em `amount` é rejeitado imediatamente na borda com `400 INVALID_PAYLOAD` (`I-11`).
- **Headers e rastreabilidade:** `Idempotency-Key` obrigatório em submissões (`1..256` chars); `CorrelationIdMiddleware` propaga ou gera `X-Correlation-Id` em `AsyncLocalStorage` e no cabeçalho de resposta.
- **Mapeamento de desfechos (`ARQUITETURA §6.2`):**
  - `200 OK`: `PROCESSED` (incluindo replay idempotente com `idempotentReplay: true`).
  - `202 Accepted`: `PENDING_REFERENCE` quando a transação referenciada ainda não chegou (`I-08`).
  - `422 Unprocessable Entity`: `REJECTED` com `failureCode` (`INSUFFICIENT_FUNDS`, `REVERSAL_INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_CONTEXT_MISMATCH`, `REFERENCE_AMOUNT_MISMATCH`, `REFERENCE_ALREADY_REVERSED`) e snapshot de `balance` (`I-07`).
  - `409 Conflict`: `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` (`I-10`).
  - `503 Service Unavailable` com `Retry-After: 1`: falhas transitórias de infraestrutura (`TransientInfrastructureError`).

## 8. Mensageria: inbox, outbox, retry e DLQ

Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §7, [docs/SCHEMA.md](docs/SCHEMA.md) §4.4–4.5.

### 8.1 Consumidor e inbox

O consumidor (`src/interface/sqs/wager-transaction.consumer.ts`) faz long polling
de 20 s em `wager-transactions.fifo`, com até `SQS_CONSUMER_CONCURRENCY`
mensagens em andamento. No mesmo lote, mensagens do mesmo `MessageGroupId`
rodam em sequência e grupos diferentes em paralelo. Isso aproveita a ordem do
FIFO, mas a correção não depende dela: vem do lock da wallet e dos índices
únicos.

O envelope é validado por zod, e `data` usa o **mesmo** schema do HTTP. A
mensagem entra no **mesmo** `SubmitWagerTransaction`, com
`(consumerName, messageId)` do envelope. A linha da inbox é inserida na mesma
transação SQL do débito, antes do lock da wallet, e marcada `processed` em
qualquer desfecho. Uma duplicata espera no índice da inbox sem segurar a
wallet. O ack (`DeleteMessage`) só acontece depois do commit. Se o processo
morre entre os dois, a redelivery cai no `ON CONFLICT` e vira ack de duplicata.

### 8.2 Classificação, retry e DLQ

| Desfecho | Ação na fila |
|---|---|
| `RESULT` (qualquer status), duplicata na inbox | ack |
| wallet inexistente, conflito de idempotência ou de id externo | ack + `warn` |
| JSON/envelope/`type` inválido, `Money` inválido, mesmo `messageId` com payload diferente (D7) | visibilidade 0 até o redrive levar à DLQ |
| falha transitória (`lock_timeout`, deadlock, conexão) e bug | visibilidade `min(2^receiveCount, 60)` s |

Nenhuma mensagem é enviada à DLQ pelo código. O redrive da fila
(`maxReceiveCount = 5`) faz isso, e o SQS conta as entregas, então não há janela
em que a mensagem se perca. Na última entrega (`ApproximateReceiveCount` ≥
`maxReceiveCount`, lido da `RedrivePolicy`), uma falha transitória ou bug com
comando válido grava a transação como `FAILED`/`PROCESSING_FAILED`, numa
transação separada (`RecordProcessingFailure`). Assim o provedor que reenviar
recebe replay em vez de efeito tardio. O HTTP nunca grava `FAILED`: devolve 503.

### 8.3 Desligamento

No `SIGTERM`, o consumidor para de receber e aborta o long poll em curso. Depois
espera as mensagens em andamento até `SHUTDOWN_GRACE_MS` e devolve à fila, com
visibilidade 0, as recebidas e não iniciadas. O MikroORM e o cliente SQS fecham
depois. Se o processo morrer sem drenar (`SIGKILL`), a correção continua: o commit
é atômico e a redelivery cai na inbox.

### 8.4 Outbox

_A escrever na T41._

## 9. Referências fora de ordem

_A escrever no B8._ Fonte: [docs/MODELAGEM.md](docs/MODELAGEM.md) D11.

## 10. Observabilidade

Detalhe em [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §9. Código em `src/infrastructure/observability/` e `src/interface/http/metrics.controller.ts`.

- **Logger estruturado JSON com ALS (D29):** `AppLogger` injeta automaticamente `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status` e `failureCode` a partir de `AsyncLocalStorage`, sem usar ALS para transações de banco (D25).
- **Sanitização financeira (restrição 5.1, `I-23`):** `sanitizeLogData` remove/redige recursivamente chaves monetárias (`amount`, `balance`, `balanceBefore`, `balanceAfter`, `money`) de metadados e mensagens.
- **Métricas Prometheus (D30, `I-22`):** `MetricsRegistry` (`@prometheus-io/client`) exposto em `GET /metrics` com contadores, gauges e histogramas padronizados (`wagering_transactions_total`, `wagering_duplicates_total`, `wagering_retries_total`, `wagering_dlq_total`, `wagering_lock_conflicts_total`, `wagering_outbox_lag_seconds`, `wagering_processing_duration_seconds`, `wagering_reconciliation_mismatch_total`).

## 11. Autenticação

Detalhe em [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §10 (D31). Código em `src/interface/http/auth.guard.ts` e `src/infrastructure/provider-identity.ts`.

- **Decisão: não implementada.** Autenticação não vale pontos (CHALLENGE §2 e §14), e o tempo foi para correção financeira, concorrência e idempotência. Ficam no código os dois pontos de extensão que o §2 pede.
- **`AuthGuard` no-op:** aplicado em `/wallets` e `/wagering`. Anexa ao request um `CallerIdentity { providerId: undefined }` e deixa passar. `/health/*` e `/metrics` não usam o guard e ficam abertos.
- **`ProviderIdentityPort`:** o `WageringController` chama `assertMaySubmit(caller, payload.providerId)` depois de validar o payload e antes do use case. A implementação atual, `AcceptAllProviderIdentity`, aceita tudo.
- **Desenho que seria adotado:**
  1. Keycloak no Docker Compose, com um client por provedor no fluxo *client credentials* (OIDC, máquina a máquina).
  2. O `AuthGuard` valida o JWT pelo JWKS do realm (assinatura, `exp`, `iss`, `aud`) e responde 401 quando o token falta ou é inválido. O `azp` do token vira `CallerIdentity.providerId`.
  3. O `ProviderIdentityPort` real lança quando `caller.providerId` diverge do `providerId` do payload, e a borda responde 403. Assim um provedor não submete em nome de outro.
  4. A troca é de implementação: o guard e o provider do token `PROVIDER_IDENTITY` no `WageringModule`. Controllers, use cases e domínio não mudam.
- **Fila:** mensagens do SQS são canal interno confiável (§2) e não passam pelo guard. O `providerId` delas segue as mesmas validações de domínio do HTTP, porque o consumidor chama o mesmo use case.
- **Fora de escopo:** tabela própria de usuários, hash de senha e autorização por papel.

## 12. Testes

_A escrever no B12._ Fonte: [docs/TESTES.md](docs/TESTES.md).

## 13. Ambiente e stack sob Bun

- A CLI do MikroORM 7 roda sob Bun (`bunx --bun mikro-orm`). O fallback para
  Node, previsto no passo 1, não foi necessário.
- TypeScript 7 removeu `baseUrl`. O alias `@/*` usa `paths` relativo.
- `prom-client` foi depreciado. O projeto usa o sucessor oficial,
  `@prometheus-io/client`, com a mesma API.
- Entidades são registradas explicitamente com `ReflectMetadataProvider`. Não há
  varredura de pastas, que depende de ts-morph.

## 14. Limitações conhecidas

Orçamento de 36 h ([docs/PLANO.md](docs/PLANO.md) §2):

- sem teste automatizado de desligamento por `SIGTERM`. Não existe no Windows,
  e o teste exige Linux;
- a aplicação roda fora do Compose (`bun run start:dev`). Só a infra está no
  Compose;
- ≥ 3 instâncias é provado pelos cenários de concorrência com três processos,
  não por um cenário misto dedicado;
- sem teste de carga;
- **conexão presa no pool quando a sessão do Postgres morre no meio da transação.**
  O Kysely 0.29.6, usado pelo MikroORM 7, só devolve a conexão ao pool depois de um
  COMMIT ou ROLLBACK bem-sucedido; com o socket morto, os dois falham. O chamador
  recebe `TransientInfrastructureError` corretamente, mas a vaga no pool se perde.
  Acontece só com a sessão morta (restart ou failover do Postgres,
  `pg_terminate_backend`, `idle_in_transaction_session_timeout`), não com lock,
  timeout de statement ou trigger. Algumas quedas seguidas esgotam o pool, e a
  instância precisa reiniciar. Aceito na T20, sem patch da dependência.
