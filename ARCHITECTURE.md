# Architecture

Decisões, trade-offs e limitações do Wagering Processor. Como subir e usar o
serviço está no [README](README.md).

## 1. Visão geral

O banco é a fonte da verdade de tudo o que precisa estar certo. Idempotência,
não-negatividade, imutabilidade do ledger e "toda mudança de saldo tem
lançamento" são garantidas por índices, `CHECK`s e triggers do PostgreSQL. A
fila e a memória dos processos são otimização, nunca a garantia.

```
interface        HTTP · consumidor SQS · worker de outbox · worker de referências · health · métricas
   │  chama
application      use cases · portas (interfaces) · resultados tipados
   │  usa
domain           Money · Wallet · WagerTransaction · WalletLedgerEntry · Inbox/Outbox
                 decideWager · reconcile · eventos · payloadHash
   ▲  implementa as portas
infrastructure   repositórios MikroORM · Unit of Work · publisher SQS · relógio · ids · logs · métricas
```

| Camada | Pode importar | Não pode importar |
|---|---|---|
| `domain` | só a stdlib | Nest, MikroORM, AWS SDK, zod |
| `application` | `domain` | MikroORM, AWS SDK, `infrastructure`, `interface` |
| `infrastructure` | `domain`, `application`, libs | `interface` |
| `interface` | `application`, `domain`, `infrastructure` | MikroORM e AWS SDK direto |

Um teste de arquitetura lê os `import` de cada pasta e falha se a regra for
quebrada.

HTTP e SQS entram no **mesmo** use case, `SubmitWagerTransaction`. Cada
instância roda HTTP, consumidor e os dois workers, e qualquer um pode ser
desligado por variável de ambiente. Nenhuma correção depende de estado em
memória, então o número de instâncias não muda o resultado.

O caminho de uma transação:

1. A borda valida o payload (zod) e converte o dinheiro para `Money`.
2. Fora do lock, o use case procura `(providerId, idempotencyKey)`. Se a chave já
   existe, devolve o resultado original sem tocar na wallet.
3. Abre a transação SQL. Pela fila, grava a inbox primeiro. Depois trava a wallet
   com `SELECT … FOR UPDATE`.
4. Sob o lock, confere a idempotência de novo, resolve a referência e chama
   `decideWager`.
5. Grava a transação, o lançamento, a nova versão da wallet e os eventos no
   outbox, tudo no mesmo commit.
6. Depois do commit: a resposta HTTP ou o ack da mensagem. O worker de outbox
   publica os eventos em seguida.

## 2. Domínio e `Money`

O domínio (`src/domain/`) é TypeScript puro. As invariantes ficam dentro das
classes, e não em serviços em volta.

### `Money`

- **Centavos em `bigint`**, e não `decimal.js`. A escala é fixa em 2 casas, então
  um inteiro na unidade mínima é exato, nativo e sem dependência.
- **Nunca arredonda.** Mais de 2 casas é rejeitado. Não há multiplicação nem
  divisão no domínio, então nada produz casa extra.
- **Entrada estrita:** `^(0|[1-9]\d*)\.\d{2}$`. Rejeita `25`, `25.5`, `1e3`,
  `+5.00`, `-5.00` e número JSON (`"amount": 25`), que já chegaria como `number`
  depois do `JSON.parse`.
- **Parse e formatação só textuais:** `BigInt(inteiro) * 100n + BigInt(centavos)`
  na ida e `/ 100n`, `% 100n` e `padStart` na volta. Nenhum caminho passa por float.
- **Dois construtores:** `from` é a entrada e rejeita negativo. `fromPersistence`
  lê o banco e aceita negativo, porque a diferença da reconciliação pode ser negativa.
- **Guarda estática:** um teste varre o domínio e a persistência e falha com
  `parseFloat`, `Number(`, `toFixed`, `Math.` ou propriedade de dinheiro tipada
  `number`.

Na borda, dinheiro é string. No banco é `numeric(19,2)`, que o driver devolve
como string e só vira `Money` por `fromPersistence`.

### Entidades

| Entidade | Invariante estrutural |
|---|---|
| `Wallet` (aggregate root) | `debit`/`credit` **devolvem o lançamento**: não existe caminho que muda o saldo sem produzir ledger. `version` começa em 1 e só sobe junto com o saldo |
| `WalletLedgerEntry` | sem campos mutáveis nem transições. `create` valida `antes ± valor = depois`, moeda única e não-negatividade |
| `WagerTransaction` | transições explícitas: estado terminal não muda mais. Guarda o saldo do desfecho para o replay devolver o saldo daquele momento |

Todas têm construtor privado, factories para criar e `rehydrate` para
reconstruir do banco sem revalidar transições.

### A regra como função pura

`decideWager(transação, wallet, referência, jáRevertida, backoff)` devolve
`APPLY`, `REJECT` com `failureCode` ou `AWAIT_REFERENCE`. As verificações rodam
numa **ordem fixa**, e a primeira que falha decide. O mesmo caso sempre produz o
mesmo código.

- A regra envolve três objetos e não pertence a nenhum deles. Como função pura,
  HTTP, SQS e o worker de referências usam o mesmo caminho, e cada regra é
  testável sem banco.
- "Pura" vale para a decisão. A correção sob concorrência vem de ela ser chamada
  com a wallet travada (seção 4).

### Interpretações adotadas

| Ponto do enunciado | Decisão | Por quê |
|---|---|---|
| reversão única (§7.4) | uma transação é revertida **no máximo uma vez, por qualquer kind**. Reversão rejeitada não ocupa a vaga | lido ao pé da letra, §7.4 permitiria `REFUND` **e** `ROLLBACK` da mesma `BET`: crédito em dobro |
| referência em `WIN`/`LOSS` | resolvida igual à das reversões, e pode ficar `PENDING_REFERENCE` | uma regra só, sem exceção por kind |
| valor de `LOSS` | aceita `0.00`. Os outros kinds exigem valor positivo | `LOSS` não move saldo |
| escopo da idempotência | `(providerId, idempotencyKey)`, não global | a chave vem do provedor, e provedores diferentes podem repetir chaves |
| header `Idempotency-Key` | obrigatório. Ausente é `400` | o servidor não inventa a chave do provedor |
| mesmo `externalTransactionId` com outra chave | `409 EXTERNAL_ID_CONFLICT`, mesmo com payload idêntico | duas chaves para uma operação é erro do provedor |
| mesmo `messageId` com payload diferente | vai para a DLQ, com log e métrica | anomalia do transporte, sem resposta certa para escolher |
| wallet inexistente | `404`, sem gravar transação | sem wallet não há FK válida. Reenviar depois de criar a wallet funciona |
| referência ainda pendente quando as tentativas acabam | `REJECTED` com `REFERENCE_NOT_PROCESSED` | nunca espera além do limite |

### `payloadHash` e eventos

- **`payloadHash`:** SHA-256 de um JSON canônico (chaves ordenadas, opcionais
  omitidos) só dos campos de negócio. A mesma operação por HTTP ou por SQS gera
  o mesmo hash. Mesma chave com hash diferente é `IDEMPOTENCY_CONFLICT`.
- **Eventos:** `eventType` e `version` vivem no tipo de cada evento, e `data` só
  leva dinheiro como string. Um `bigint` que vazasse faria o `JSON.stringify`
  lançar, e não passar calado.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | transação `PROCESSED` |
| `WagerTransactionRejected` | transação `REJECTED`, inclusive referência que não chegou |
| `WalletBalanceChanged` | o saldo mudou (criação com saldo inclusive) |
| `WagerTransactionPendingReference` | a transação ficou esperando a referência |

`FAILED` não emite evento: nenhum dos eventos mínimos cobre esse caso, e ele
aparece por consulta e por métrica.

## 3. ORM, mapeamento e estratégia transacional

**MikroORM**, a opção preferida pelo enunciado, mas usado de forma explícita.

### Records separados do domínio

Cada tabela tem um *record* do MikroORM, e cada repositório converte
`record ↔ domínio` à mão. O domínio não conhece o ORM, e o record não tem regra.

- **Dinheiro é `string` no record**, com coluna `numeric(19,2)`. Nenhum `number`
  existe no caminho.
- **Sem relações declaradas:** as FKs compostas vivem no schema. Declarar
  `@ManyToOne` traria proxies e reordenaria as escritas.
- **Sem `@Property({ version: true })`:** a versão da wallet é conferida no
  próprio `UPDATE … WHERE version = $esperada`. Zero linhas é bug, não corrida,
  porque quem chega ali já tem o lock.

### Repositórios executam na hora

Nenhum `persist`/`flush` nem identity map: `insert`, `nativeUpdate` e leituras
sem cache. A ordem das escritas é a do use case (a FK do ledger exige a transação
antes do lançamento), e o erro aparece na chamada que o causou.

### Unit of Work explícita

```ts
await uow.run(async (tx) => {
  const wallet = await tx.wallets.lockById(id);   // SELECT … FOR UPDATE
  ...
});
```

- **`run`:** `READ COMMITTED` e, como primeira query, `lock_timeout` (2 s),
  `statement_timeout` (5 s) e `idle_in_transaction_session_timeout` (10 s), todos
  locais à transação.
- **`readSnapshot`:** `REPEATABLE READ READ ONLY` para a reconciliação, sem
  `lock_timeout` porque não trava nada.
- **Repositórios por fábrica:** a UoW monta os repositórios com o
  `EntityManager` da transação. Nenhum repositório é provider do Nest: injetado,
  receberia o `EntityManager` global e escreveria fora da transação, sem erro.

### Tradução de erro na borda da transação

A UoW traduz o erro do driver uma vez, num `try/catch` que envolve o trabalho
**e o COMMIT**. Os triggers *deferred* só falham no COMMIT, e um tradutor dentro
do repositório nunca os veria.

| Erro do Postgres | Vira |
|---|---|
| `23505` de índice único conhecido | `UniqueViolationError`, que o use case usa para devolver replay ou conflito |
| `55P03` (lock timeout), `40P01` (deadlock), `57014`, `57P01`–`57P03`, `25P03`, classe `08`, conexão perdida | `TransientInfrastructureError`: 503 no HTTP, nova tentativa na fila |
| `23514`, `23503`, `23000` de trigger e o resto | passa sem tradução: é bug, e o estado errado não foi gravado |

## 4. Concorrência

**Escolha: lock pessimista por wallet** (`SELECT … FOR UPDATE` na linha da
wallet), dentro de uma transação `READ COMMITTED` curta.

- **A unidade de concorrência é a wallet**, como o enunciado pede. Wallets
  diferentes nunca esperam umas pelas outras, e não existe lock global.
- **Por que pessimista:** uma wallet "quente" recebe rajadas na mesma rodada.
  Com lock otimista, cada conflito vira um retry com refeitura da regra, e sob
  disputa os retries se multiplicam. O lock serializa só quem disputa a mesma
  linha, e quem espera relê o estado já atualizado.
- **Decisão sob o lock:** o instante da transação, a segunda checagem de
  idempotência e `decideWager` acontecem depois do `FOR UPDATE`. Saldo nunca é
  `read → calculate → update` sem a linha travada.
- **Espera limitada:** `lock_timeout` de 2 s. Estourado, o HTTP responde
  `503` com `Retry-After: 1` e a fila tenta de novo com backoff. Nada é aplicado
  pela metade.
- **Defesa em profundidade:** mesmo com bug na aplicação, `UPDATE … WHERE version
  = $esperada` e `UNIQUE (wallet_id, wallet_version)` no ledger transformam um
  lost update em erro, e não em saldo errado.
- **Ordem de locks:** inbox, depois wallet. Uma mensagem duplicada espera no
  índice da inbox sem segurar a wallet.

Trade-off aceito: uma wallet muito disputada processa uma operação por vez. A
seção crítica é curta (poucos `INSERT`s indexados), e é o preço de a correção não
depender de retry.

## 5. Idempotência e replay

- **No banco, não em memória:** `UNIQUE (provider_id, idempotency_key)` e
  `UNIQUE (provider_id, external_transaction_id)` em `wager_transaction`, e
  `inbox_message` com chave `(consumer_name, message_id)` para a fila.
- **Duas checagens:** uma rápida antes do lock, para responder replay sem
  disputar a wallet, e outra sob o lock, para resolver corridas.
- **Corrida entre wallets:** se duas requisições com a mesma chave para wallets
  diferentes colidem no índice único, o use case captura a violação e lê a linha
  vencedora para devolver replay ou conflito.
- **Replay determinístico:** o saldo resultante é gravado na transação no
  desfecho. O replay devolve o resultado e o saldo **daquele momento**, mesmo
  depois de outras movimentações, com `idempotentReplay: true`.
- **Rejeição é terminal:** reenviar com a mesma chave devolve a mesma rejeição.
  Corrigir exige um novo `externalTransactionId`.

## 6. Schema e garantias no banco

Três migrations reversíveis em `migrations/`. **Princípio:** o domínio verifica
primeiro, para devolver um `failureCode` útil. O banco verifica de novo, e é ele
que impede o estado errado quando o código tem bug ou quando alguém mexe por SQL.

Tabelas: `wallet`, `wager_transaction`, `wallet_ledger_entry`, `inbox_message` e
`outbox_message`.

### Constraints

| Garantia | Como |
|---|---|
| saldo e lançamentos nunca negativos | `CHECK` em `wallet.balance`, `balance_before` e `balance_after` |
| uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| idempotência por provedor | `UNIQUE (provider_id, idempotency_key)` e `(provider_id, external_transaction_id)` |
| uma reversão por referência | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` |
| no máximo um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| lost update vira violação | `UNIQUE (wallet_id, wallet_version)` no ledger |
| ledger, wallet e transação na mesma moeda e wallet | FKs compostas `(wallet_id, currency)` e `(transaction_id, wallet_id, currency)` |
| campos coerentes com o status | `CHECK`s do tipo "existe se e somente se": `failure_code`, `balance_after`, `processed_at`, agenda de referência |

### Triggers

Um `CHECK` olha uma linha só. O que envolve histórico ou mais de uma tabela vai
em trigger. Todos lançam SQLSTATE `23000` com o nome do trigger no erro, para o
teste e o log saberem qual garantia disparou.

| Trigger | Garante |
|---|---|
| `ledger_immutable`, `ledger_no_truncate` | ledger append-only: sem `UPDATE`, `DELETE` ou `TRUNCATE` |
| `ledger_chain` | cada lançamento continua o saldo do anterior, ou parte de zero |
| `wallet_version_rule` | o saldo mudou se e somente se `version + 1`. A identidade da wallet não muda |
| `wallet_ledger_match` + `ledger_wallet_match` | **deferred**: no commit, o saldo da wallet e o último lançamento batem nos dois sentidos |
| `wallet_no_delete` | wallet não é apagada |
| `wager_tx_guard` | transição só a partir de estado permitido, e transação terminal congelada inteira |

O par deferred transforma "toda mudança de saldo tem lançamento" numa garantia do
banco: o commit falha tanto para saldo sem lançamento quanto para lançamento sem
saldo.

Trade-offs:

- **Triggers custam leituras por escrita**, uma busca por índice por commit e
  outra por lançamento. A escrita financeira é a operação cara e rara, e o ganho
  é invariante garantida mesmo com bug.
- **`TRUNCATE` bloqueado complica testes.** Por isso cada arquivo de teste usa um
  banco próprio clonado de um template, em vez de limpar tabelas.
- **Wallet criada sem saldo começa sem lançamento.** O primeiro movimento sai na
  versão 2. A cadeia do ledger é conferida por saldo, não por versão contígua.

## 7. Mensageria: inbox, outbox, retry e DLQ

### Consumidor e inbox

- Long polling de 20 s, até `SQS_CONSUMER_CONCURRENCY` mensagens em andamento por
  instância. Mensagens do mesmo `MessageGroupId` rodam em sequência, e grupos
  diferentes em paralelo. Isso aproveita a ordem do FIFO, mas a correção vem do
  lock e dos índices únicos.
- O envelope é validado por zod, e `data` usa o **mesmo** schema do HTTP.
- A linha da inbox é gravada na **mesma transação** do efeito financeiro e marcada
  como processada em qualquer desfecho. O ack (`DeleteMessage`) só acontece
  depois do commit. Se o processo morre entre os dois, a redelivery cai na inbox
  e vira ack de duplicata, sem efeito novo.

| Desfecho | Ação na fila |
|---|---|
| resultado (qualquer status), duplicata na inbox | ack |
| wallet inexistente, conflito de idempotência ou de id externo | ack e log `warn` |
| JSON, envelope ou `Money` inválido, mesmo `messageId` com payload diferente | visibilidade 0, até o redrive levar à DLQ |
| falha transitória ou bug | visibilidade `min(2^tentativa, 60)` s |

Nenhuma mensagem é mandada para a DLQ pelo código. O redrive da fila
(`maxReceiveCount = 5`) faz isso, e o SQS conta as entregas, então não há janela
em que a mensagem se perca. Na última entrega, uma falha transitória ou bug com
comando válido grava a transação como `FAILED`/`PROCESSING_FAILED`, numa
transação separada. Assim o provedor que reenviar recebe replay em vez de efeito
tardio. O HTTP nunca grava `FAILED`: devolve 503.

### Outbox

Os eventos são gravados em `outbox_message` **dentro** da transação financeira.
Nada é publicado antes do commit.

O worker roda em três passos, cada um com a sua transação:

1. **Claim curto:** `UPDATE … SET next_attempt_at = now() + lease` sobre um
   `SELECT … FOR UPDATE SKIP LOCKED`. Dois publishers pegam linhas diferentes.
2. **Publica fora de transação**, com o `eventId` como `MessageDeduplicationId`.
3. **Marca** cada mensagem publicada, ou agenda nova tentativa.

- **Processo morre depois do claim:** o lease (30 s) expira e outra instância
  pega a linha.
- **Morre depois de publicar e antes de marcar:** o evento é publicado de novo.
  A fila FIFO deduplica pelo `eventId`, e o consumidor deve deduplicar também. A
  entrega é at-least-once, como o enunciado assume.
- **Nunca desiste:** backoff exponencial, primeira retentativa em 2 s, teto de
  60 s, sem limite de tentativas. Desistir seria perder evento confirmado. O
  atraso aparece em `wagering_outbox_lag_seconds`.

### Desligamento

No `SIGTERM`, o consumidor para de receber e aborta o long poll. Espera as
mensagens em andamento até `SHUTDOWN_GRACE_MS` e devolve à fila, com visibilidade
0, as recebidas que não começaram. Os workers terminam o item atual, e o que
ficou reservado volta pelo lease. O MikroORM e o cliente SQS fecham por último.
Se o processo morrer sem drenar (`SIGKILL`), a correção continua: o commit é
atômico e a redelivery cai na inbox.

## 8. Referências fora de ordem

Uma operação que referencia algo que ainda não existe (`REFUND` antes da `BET`,
por exemplo) é gravada como `PENDING_REFERENCE` e responde `202`. O worker de
referências resolve depois.

- **Limite: 10 tentativas, backoff exponencial de 1 s até 5 min**, cerca de
  13,5 min no total. Fora de ordem aqui é reordenação de transporte, que se
  resolve em segundos. O limite deixa folga para uma fila atrasada sem manter
  transações penduradas por horas. Os três valores são configuráveis.
- **Claim com lease**, como o outbox. Cada item é processado na sua própria
  transação: trava a wallet, relê a transação com `FOR UPDATE` e confere que ela
  continua pendente. Isso protege contra dois workers e contra lease vencido.
- **Quando a referência chega**, `decideWager` roda normalmente e o resultado é
  o mesmo de uma entrega em ordem.
- **Esgotado o limite:** `REJECTED` com `REFERENCE_NOT_FOUND` e evento
  `WagerTransactionRejected`. Se a referência existe mas ainda está pendente, o
  código é `REFERENCE_NOT_PROCESSED`.

## 9. Códigos de falha

`failureCode` gravado na transação, sempre com status `REJECTED`, exceto o
último:

| Código | Situação | O que o provedor faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | `BET` maior que o saldo | não reenvia |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` de `WIN`/`REFUND` deixaria o saldo negativo. Separado do anterior porque é um caso operacional, não uma aposta sem saldo | escala para a operação |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrige, com novo id externo |
| `WALLET_PLAYER_MISMATCH` | wallet de outro player | corrige, com novo id externo |
| `REFERENCE_NOT_FOUND` | a referência não apareceu até o limite | investiga a referência |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada, falhou ou ainda estava pendente no limite | não reenvia |
| `REFERENCE_KIND_NOT_ALLOWED` | ex.: `REFUND` de `WIN`, `ROLLBACK` de `LOSS` | corrige |
| `REFERENCE_CONTEXT_MISMATCH` | wallet, player, moeda ou rodada diferentes da referência | corrige |
| `REFERENCE_AMOUNT_MISMATCH` | valor diferente da referência (reversão parcial está fora de escopo) | corrige |
| `REFERENCE_ALREADY_REVERSED` | a referência já tem reversão `PROCESSED` | não reenvia |
| `PROCESSING_FAILED` | status `FAILED`: falha de infraestrutura que persistiu até a última entrega da fila | contata a operação |

Erros de requisição não gravam transação: `INVALID_PAYLOAD` (400),
`WALLET_NOT_FOUND` e `TRANSACTION_NOT_FOUND` (404), `WALLET_ALREADY_EXISTS`,
`IDEMPOTENCY_CONFLICT` e `EXTERNAL_ID_CONFLICT` (409), `SERVICE_UNAVAILABLE`
(503). Todo corpo de erro traz `code`, para o provedor decidir sem ler a
mensagem. Pela fila, os mesmos casos viram: 422 e 404 → ack; 400 → DLQ;
503 → nova tentativa.

## 10. Reconciliação

`POST /wallets/:id/reconciliation` lê a wallet e o ledger num snapshot
`REPEATABLE READ` e confere que o primeiro lançamento parte de zero, que a cadeia
não tem buraco e que `Σ CREDIT − Σ DEBIT` é igual ao saldo guardado. Devolve
`storedBalance`, `calculatedBalance`, `difference`, `consistent` e
`checkedEntries`. Divergência é logada, contada em métrica e devolvida, nunca
corrigida automaticamente.

## 11. Observabilidade

- **Logs JSON** com `correlationId`, `messageId`, `transactionId`, `walletId` e
  `providerId`, injetados por `AsyncLocalStorage`. O `correlationId` vem do
  header `X-Correlation-Id`, ou do `messageId` na fila.
- **Sem dado financeiro nos logs:** um sanitizador remove `amount`, `balance`,
  `money` e afins de qualquer metadado.
- **Métricas Prometheus** em `GET /metrics`, por instância:

| Pede o enunciado | Métrica |
|---|---|
| transações por status | `wagering_transactions_total{kind,status}`, `wagering_transactions_rejected_total{reason}` |
| duplicatas | `wagering_duplicates_total{source="http"\|"inbox"}` |
| retries | `wagering_retries_total{component}` |
| DLQ | `wagering_dlq_total`, `wagering_sqs_messages_dlq_total{queue,reason}` |
| conflitos de lock | `wagering_lock_conflicts_total` |
| outbox lag | `wagering_outbox_lag_seconds` |
| latência | `wagering_processing_duration_seconds{entry="http"\|"sqs"}`, `wagering_http_request_duration_seconds{method,path,status}` |

Também há `wagering_http_requests_total`, `wagering_outbox_published_total`,
`wagering_pending_reference_age_seconds` e `wagering_reconciliation_mismatch_total`.
A rota é rotulada pelo padrão (`/wallets/:id`), não pela URL, para não criar uma
série por wallet.

- **Health:** `live` responde enquanto o processo está de pé. `ready` faz
  `select 1` no Postgres e `GetQueueAttributes` na fila de entrada, com timeout
  de 2 s cada, e responde 503 se alguma falhar.

## 12. Autenticação

**Não implementada**, por decisão. Autenticação não vale pontos no enunciado, e o
tempo foi para correção financeira, concorrência e idempotência. Ficam no código
os dois pontos de extensão:

- **`AuthGuard` no-op** em `/wallets` e `/wagering`. Anexa
  `CallerIdentity { providerId: undefined }` ao request e deixa passar.
  `/health/*` e `/metrics` ficam abertos.
- **`ProviderIdentityPort`:** o controller chama
  `assertMaySubmit(caller, payload.providerId)` antes do use case. A
  implementação atual aceita tudo.

Desenho que seria adotado:

1. Keycloak no Docker Compose, com um client por provedor no fluxo *client
   credentials* (OIDC, máquina a máquina).
2. O `AuthGuard` valida o JWT pelo JWKS do realm (assinatura, `exp`, `iss`,
   `aud`) e responde 401 se faltar ou for inválido. O `azp` do token vira
   `CallerIdentity.providerId`.
3. O `ProviderIdentityPort` real lança quando `caller.providerId` diverge do
   `providerId` do payload, e a borda responde 403. Um provedor não submete em
   nome de outro.
4. A troca é só de implementação, no módulo de composição. Controllers, use
   cases e domínio não mudam.

Mensagens da fila são canal interno confiável e não passam pelo guard. O
`providerId` delas passa pelas mesmas validações de domínio, porque o consumidor
chama o mesmo use case.

## 13. Testes

Postgres e LocalStack **reais**. Nenhum teste substitui banco ou fila por mock.

| Nível | Testes | O que cobre |
|---|---|---|
| unidade e arquitetura | 342 | `Money`, `Wallet`, cada kind e cada `failureCode`, transições, `payloadHash`, reconciliação. Fronteiras de camada e proibição de float em dinheiro |
| integração | 152 | migrations `up → down → up`, cada constraint e trigger violada por SQL, atomicidade wallet/ledger/inbox/outbox, inbox e redelivery, retry e DLQ, contrato HTTP completo, workers, métricas |
| concorrência e falha | 16 | os 8 cenários do enunciado, com até 3 processos reais da aplicação |

Cenários de concorrência (§13 do enunciado):

| # | Cenário | Teste |
|---|---|---|
| 1 | mesma `BET` 50× em paralelo | 3 instâncias, com e sem portão de lock: 1 débito, 49 replays |
| 2 | disputa de saldo | `100.00` e duas `BET` de `80.00`: 1 `PROCESSED`, 1 `INSUFFICIENT_FUNDS`, saldo `20.00`. E 100 `BET` de `15.00` sobre `1000.00`: exatamente 66 e 34 |
| 3 | wallets em paralelo | 20 wallets com uma travada: as outras 19 terminam enquanto ela espera |
| 4 | ≥ 3 instâncias | os cenários 1, 7 e 8 rodam com 3 processos da aplicação ao mesmo tempo |
| 5 | morte depois do commit e antes do ack | `SIGKILL` no ponto de falha. A redelivery cai na inbox: 1 débito |
| 6 | dois publishers no outbox | 1000 eventos, 2 workers, nenhum perdido. E queda depois do claim, recuperada pelo lease |
| 7 | reversão antes da referência | `ROLLBACK` e `REFUND` por SQS antes das referências, em 3 instâncias |
| 8 | reinício com consistência | `SIGKILL` em 2 de 3 instâncias no meio da carga, duas novas sobem. Reconciliação consistente em todas as wallets |

Como os testes ficam determinísticos:

- **Banco e filas por arquivo de teste**, clonados de um template. Nada é
  compartilhado entre arquivos.
- **Portão de lock:** uma conexão segura `FOR UPDATE` na wallet, o teste espera
  as N requisições aparecerem bloqueadas em `pg_stat_activity` e só então solta.
  A disputa acontece de verdade, e não por sorte de agendamento.
- **Pontos de falha:** `FAULT_POINT` mata o processo com `SIGKILL` num ponto
  exato (antes do commit, depois do commit, depois do claim ou da publicação no
  outbox).
- **Sem `sleep`:** espera por condição (`eventually`).
- **Invariante final em todos os testes:** `wallet.balance` igual ao saldo
  reconstruído pelo ledger, sem lançamento órfão.
- Os resultados são exatos (66 e 34, não "por volta de"). O teste não verifica
  *quem* ganhou a disputa, só *quantos*.

## 14. Ambiente

- A CLI do MikroORM 7 roda sob Bun (`bunx --bun mikro-orm`). Não foi preciso
  fallback para Node.
- As entidades são registradas explicitamente com `ReflectMetadataProvider`. Não
  há varredura de pastas, que depende de ts-morph e quebra fora do Node.
- `prom-client` foi depreciado. O projeto usa o sucessor oficial,
  `@prometheus-io/client`, com a mesma API.
- A aplicação roda fora do Compose (`bun run start:dev`). Só Postgres e
  LocalStack estão nele.

## 15. Limitações conhecidas

- **Desligamento por `SIGTERM` sem teste automatizado.** O teste exige Linux. A
  recuperação depois de `SIGKILL`, mais dura, é testada.
- **Sem teste de carga.** O diferencial `test:load` não foi feito.
- **Conexão presa no pool quando a sessão do Postgres morre no meio da
  transação.** O Kysely 0.29.6, usado pelo MikroORM 7, só devolve a conexão ao
  pool depois de um COMMIT ou ROLLBACK bem-sucedido, e com o socket morto os dois
  falham. O chamador recebe `TransientInfrastructureError` corretamente, mas a
  vaga no pool se perde. Só acontece com a sessão morta (restart ou failover do
  Postgres, `pg_terminate_backend`), não com lock, timeout ou trigger. Várias
  quedas seguidas esgotam o pool, e a instância precisa reiniciar. Aceito sem
  patch na dependência.
- **`wagering_lock_conflicts_total` só conta no HTTP.** O consumidor SQS e o
  worker de referências tratam o lock timeout como falha transitória e contam em
  `wagering_retries_total`, sem separar o motivo.
- **Logs por transação são poucos.** Os ids aparecem em avisos e erros, mas uma
  transação processada com sucesso não gera linha de log própria. O
  acompanhamento normal é por métrica.
- **O ponto de falha `http.after-commit-before-response` está declarado, mas não
  é usado.** O cenário "cliente perde a resposta e reenvia" é coberto pelo replay
  idempotente, sem queda real do processo.
- **Métricas são por instância.** Com várias instâncias, o total é a soma, feita
  pelo Prometheus.
- **Reversão parcial** está fora de escopo, como diz o enunciado.
