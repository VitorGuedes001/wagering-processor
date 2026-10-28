# Passo 3 — O que reaproveitar do enunciado

Mapa do que entra no código a partir de [CHALLENGE.md](CHALLENGE.md). Toda
referência `§N` aponta para a seção N desse arquivo. O enunciado chama os blocos
de "esqueletos de referência" e permite adaptar nomes e assinaturas (§6, §6.0),
então copiar é o uso esperado.

| Categoria | Significado |
|---|---|
| **Literal** | copia como está |
| **Estrutura** | copia a forma (campos, factories, getters) e escreve o corpo |
| **Checklist** | lista do enunciado que vira requisito verificável, sem código pronto |
| **Fixture** | JSON ou cenário que vira dado de teste |
| **Decisão própria** | citado, mas não definido. Entrada do passo 4 |

---

## 1. Literal

| Item | Origem | Destino sugerido | Observação |
|---|---|---|---|
| `WagerTransactionKind` | §6.3 | `domain/wager-transaction.ts` | Inclui `OPENING`. Ele precisa ser barrado na borda (DTO HTTP e parser SQS), não no enum |
| `WagerTransactionStatus` | §6.3 | idem | Os comentários do enum já documentam cada estado |
| `LedgerDirection` | §6.4 | `domain/wallet-ledger-entry.ts` | |
| `MoneyProps` | §6.1 | `domain/money.ts` | DTO, `interface` mesmo |
| Assinatura pública de `Money` | §6.1 | idem | `from`, `zero`, `add`, `subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`, `toString`, `assertSameCurrency` |
| `IntegrationEventProps<T>` | §11 | `domain/events/integration-event.ts` | |
| `IntegrationEvent<T>` (abstrata) | §11 | idem | Construtor `protected`, `eventType`/`version` abstratos. `toJSON()` converte `occurredAt` para ISO-8601 |
| `WalletBalanceChangedData` | §11 | `domain/events/wallet-balance-changed.ts` | Modelo para os outros três `*Data` |
| `WalletBalanceChanged` | §11 | idem | `eventType`/`version` como campo `readonly` da classe |
| Nomes das filas | §10 | `init-queues.sh` + config | `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (já no esqueleto) |
| Tipo da mensagem de entrada | §10 | parser SQS | `"WagerTransactionRequested"` |
| Pontos de extensão de auth | §2 | `infra/auth/` | `AuthGuard` no-op e `ProviderIdentityPort`, se auth não for implementada |
| Script de carga | §14 | `package.json` | `bun run test:load`, só se fizer o diferencial |

## 2. Estrutura (corpo próprio)

Na prática, estes construtores já são o schema: cada parâmetro vira coluna.

| Classe | Origem | Factories | O que fica para nós |
|---|---|---|---|
| `Money` | §6.1 | `from`, `zero` | Parser estrito: rejeitar `NaN`, `Infinity`, notação científica, vazio, mais de 2 casas, negativo em contrato de entrada. Serializar sempre com 2 casas |
| `Wallet` | §6.2 | `open`, `rehydrate` | Assinatura e retorno de `debit`/`credit`. Sugestão: retornar o `WalletLedgerEntry`, para "toda alteração tem lançamento" ficar estrutural |
| `WagerTransaction` | §6.3 | `create`, `rehydrate` | Corpo das transições, `ledgerDirectionFor`, validação de referência por kind em `create` |
| `WalletLedgerEntry` | §6.4 | `create`, `rehydrate` | `create` valida `balanceBefore ± money === balanceAfter`. Sem setters, sem transições |
| `InboxMessage` | §6.5 | `receive`, `rehydrate` | |
| `OutboxMessage` | §6.5 | `enqueue(event)`, `rehydrate` | `payload = event.toJSON()`. Curva de backoff do `scheduleRetry` |

Regra transversal (§6.0): construtor `private`/`protected`, e `rehydrate` **não**
revalida transições. O domínio não importa nada de MikroORM nem de NestJS (§6.1),
então as entidades do ORM são classes separadas, com mapeamento explícito
`State ↔ domínio`.

### Colunas implícitas (rascunho para o passo 5)

| Tabela | Colunas vindas do construtor | Constraint que o enunciado exige |
|---|---|---|
| `wallet` | `id, player_id, currency, balance, version, created_at, updated_at` | `UNIQUE(player_id, currency)` (§6.2), `CHECK(balance >= 0)` (§5.9) |
| `wager_transaction` | `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, created_at, processed_at` | `UNIQUE(provider_id, external_transaction_id)` (lookup da rota em §9 e resolução de referência em §7.2), unicidade da idempotency key, unicidade de reversão por referência (§7.4, ver 5.1), `CHECK` de `failure_code` presente sse `REJECTED`/`FAILED` |
| `wallet_ledger_entry` | `id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at` | `UNIQUE(transaction_id)` (§6.4: no máximo 1 por transação), `CHECK` da aritmética, `CHECK(amount > 0)`, `CHECK(balance_after >= 0)`, trigger bloqueando `UPDATE`/`DELETE` (§5.5) |
| `inbox_message` | `message_id, consumer_name, payload_hash, received_at, processed_at` | `PK(consumer_name, message_id)` (§10) |
| `outbox_message` | `id, aggregate_id, event_type, payload (jsonb), occurred_at, attempts, next_attempt_at, published_at` | índice parcial `WHERE published_at IS NULL` para o worker |

Já validado no passo 1: `numeric` volta do Postgres como **string exata** pelo
MikroORM, e `CHECK` no schema barra insert por SQL cru.

## 3. Checklists

Listas do enunciado que não trazem código, mas definem o que precisa existir.

| Tema | Origem | Itens |
|---|---|---|
| Campos de log | §12 | `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Sem payload financeiro completo |
| Métricas | §12 | transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag, latência de processamento, divergências de reconciliação (§9) |
| Eventos | §11 | `WagerTransactionProcessed` (inclusive `LOSS`), `WagerTransactionRejected`, `WalletBalanceChanged` (só se o saldo mudar), `WagerTransactionPendingReference` |
| Consumidor SQS | §10 | mesmo use case do HTTP, inbox por `(consumerName, messageId)`, ack só após commit, erro de negócio = ack, transitório = retry com backoff, permanente = DLQ, limite de tentativas, `SIGTERM` conclui ou devolve visibilidade |
| Situações HTTP distintas | §9 | payload inválido, conflito de idempotência, rejeição de negócio, aceite pendente, falha transitória. Mais o conflito de wallet duplicada |
| Unidade | §13 | `Money` (escala, arredondamento, inválidos), invariantes da `Wallet`, regras dos 5 kinds, conflito de moeda, idempotency key com payload divergente |
| Integração (containers reais) | §13 | migrations e constraints, atomicidade wallet/ledger/inbox/outbox, inbox e redelivery, publishers concorrentes, retry e DLQ, recuperação após reinício |
| Entrega | §14 | `README.md` com setup e comandos, `ARCHITECTURE.md` com decisões, trade-offs e limitações |

## 4. Fixtures de teste

### 4.1 JSONs

| Fixture | Origem | Uso |
|---|---|---|
| `POST /wallets` request (`initialBalance 1000.00 BRL`) | §9 | criação com `OPENING` |
| `POST /wallets` response (`version: 1`) | §9 | `OPENING` na criação **não** incrementa `version` |
| `POST /wagering/transactions` request (`BET 25.00`) | §9 | payload base. `WIN`, `LOSS`, `REFUND`, `ROLLBACK` derivam dele |
| `POST /wagering/transactions` response (`975.00`, `idempotentReplay: false`) | §9 | primeira chamada. O replay devolve o mesmo corpo com `true` |
| Header `Idempotency-Key: provider-a:transaction-123` | §9 | formato default `{providerId}:{externalTransactionId}` |
| Envelope SQS `WagerTransactionRequested` | §10 | mesmo `data` do HTTP + `idempotencyKey` dentro de `data` |
| Resposta de reconciliação (`checkedEntries: 42`) | §9 | forma do DTO. Os valores dependem do cenário |
| `{ "amount": "25.00", "currency": "BRL" }` | §6.1 | formato canônico de `MoneyProps` |

IDs prontos para as fixtures: `playerId 0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1`,
`walletId 0192f291-27dd-7d3f-8071-5f8685deef37`,
`transactionId 0192f298-345e-7e38-af88-e43f851a819d`. Todos são UUIDv7, um
indício para gerar IDs internos em v7. Eles ordenam por tempo, o que serve ao
cursor do ledger.

### 4.2 Cenários com resultado esperado

| Cenário | Origem | Resultado verificável |
|---|---|---|
| 100.00 com duas `BET` de 80.00 simultâneas | §8 | 1 `PROCESSED`, 1 `REJECTED` (saldo insuficiente), saldo 20.00, 1 `DEBIT`, retry não duplica |
| Mesma aposta 50× em paralelo | §13.1 | 1 débito |
| Disputa de saldo na mesma wallet | §13.2 | o cenário de §8 |
| Wallets distintas em paralelo | §13.3 | sem serialização entre elas |
| ≥ 3 processos/instâncias | §13.4 | invariantes mantidas |
| Worker morto após commit, antes do ack | §13.5 | redelivery vira replay via inbox |
| Dois publishers na mesma outbox | §13.6 | nada perdido. Duplicata tolerada |
| `REFUND`/`ROLLBACK` antes da referência | §13.7 | `PENDING_REFERENCE` → `PROCESSED`, ou `REJECTED` com código próprio ao estourar o limite |
| Reinício do serviço | §13.8 | reconciliação `consistent: true` |
| Commit → crash → outra instância publica | §11 | evento sai ao menos uma vez |
| Wallet duplicada (`playerId` + `currency`) | §9 | conflito |
| Reversão que negativaria o saldo | §7.9 | `REJECTED` com código ≠ saldo insuficiente, sem lançamento |

Invariante de fechamento de **todo** teste: `wallet.balance == Σ ledger`.

Rotas a cobrir (§9): `POST /wallets`, `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger?cursor&limit`, `POST /wagering/transactions`,
`GET /wagering/transactions/:transactionId`,
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`,
`POST /wallets/:walletId/reconciliation`, `GET /health/live`, `GET /health/ready`.

## 5. Decisão própria (citado, mas não definido)

| Tipo / tema | Onde aparece | Nota para o passo 4 |
|---|---|---|
| `Decimal` | `Money` (§6.1) | O nome bate com a classe do `decimal.js`, que já é dependência. Alternativa: `bigint` em centavos, sem dependência. Nos dois casos o parser de entrada é regex próprio, porque `new Decimal('1e3')` aceita notação científica |
| `CreateWagerTransactionProps` | §6.3 | payload de entrada + `payloadHash` |
| `WalletState`, `WagerTransactionState`, `LedgerEntryState`, `InboxMessageState`, `OutboxMessageState` | §6.2–6.5 | forma "linha do banco". Fronteira entre entidade ORM e domínio |
| `CreateLedgerEntryProps`, `ReceiveInboxProps` | §6.4–6.5 | |
| `FailureCode` | §6.3, §7.2 | taxonomia. Mínimo derivado das regras: ver 6.3 |
| `EventContext` | §11 | provavelmente `{ correlationId, causationId?, occurredAt }` |
| `*Data` dos outros três eventos | §11 | só `WalletBalanceChangedData` é dado |
| `InvalidTransactionStateError` | §6.3 | erro de programação, não de negócio. Não vira `failureCode` |
| Assinatura de `debit`/`credit` | §6.2 | explicitamente aberta |
| `payloadHash` | §9 | algoritmo (ex.: SHA-256 de JSON canônico) e **quais campos** entram |
| Mapeamento de status HTTP | §9 | as 5 situações + wallet duplicada |
| Corpo da resposta para `REJECTED`/`PENDING_REFERENCE` | §9 | o enunciado só mostra `PROCESSED`. Provavelmente adiciona `failureCode` |
| Transições válidas | §6.3 | "defina e documente". Ver 6.2 |
| Estratégia de lock | §8 | justificar no `ARCHITECTURE.md` |
| Limite/TTL de `PENDING_REFERENCE` | §7.1 | justificar |
| Backoff da outbox e limite antes da DLQ | §6.5, §10 | |
| Cursor do ledger | §9 | "estável e opaco": base64 de `(created_at, id)`, ou só o `id` v7 |

## 6. Sinais escondidos e ambiguidades

### 6.1 Ambiguidades que exigem decisão documentada

1. **`REFUND` e `ROLLBACK` sobre a mesma `BET`.** §7.4 proíbe reverter duas
   vezes "pelo mesmo tipo de operação". Ao pé da letra, uma `BET` aceitaria um
   `REFUND` **e** um `ROLLBACK`, creditando em dobro, contra o invariante de
   §3. Proposta: uma transação é revertida **no máximo uma vez, por qualquer
   kind**, com
   `UNIQUE(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
   `ROLLBACK` de um `REFUND` continua válido, porque a referência é outra linha.
2. **`WIN` com referência ausente.** "Pode referenciar" (§7). §7.8 fala em
   "referência ausente" sem restringir a reversões. Proposta: `WIN` com
   referência segue a mesma regra de `PENDING_REFERENCE`, e `WIN` sem
   referência é processado direto.
3. **Valor de `LOSS`.** O payload exige `money`, mas `LOSS` não move saldo. Se o
   provedor mandar `0.00`, um `CHECK(amount > 0)` em `wager_transaction`
   rejeitaria. Decidir se `LOSS` aceita zero; o ledger mantém `> 0` de qualquer
   jeito.
4. **Escopo da idempotency key.** O header é "fonte da verdade" (§9) e vem do
   provedor. `UNIQUE(idempotency_key)` global deixa dois provedores colidirem.
   Proposta: `UNIQUE(provider_id, idempotency_key)`.
5. **Header obrigatório vs. default.** "Obrigatório" e "default recomendado"
   convivem em §9. Leitura: o default é o que o provedor deve enviar. Header
   ausente é payload inválido, o servidor não preenche.
6. **Referência existente, mas não `PROCESSED`.** §7 exige referência
   `PROCESSED`. Se ela foi `REJECTED`, a reversão é rejeitada. Se está
   `PENDING_REFERENCE` (ex.: `ROLLBACK` de um `WIN` que também espera), a
   reversão continua esperando.
7. **Inbox + idempotency key: duas camadas.** A mensagem SQS traz `messageId`
   (inbox) **e** `idempotencyKey` (§10). A mesma operação com outro `messageId`
   passa pela inbox e cai no replay por idempotência. O mesmo `messageId` com
   payload diferente é anomalia do transporte e merece log e métrica.

### 6.2 Transições derivadas

Do enum e das assinaturas de §6.3:

```
PENDING ──markProcessed──▶ PROCESSED
PENDING ──reject─────────▶ REJECTED
PENDING ──fail───────────▶ FAILED
PENDING ──markPendingReference──▶ PENDING_REFERENCE
PENDING_REFERENCE ──markProcessed | reject | fail──▶ terminal
```

`PENDING_REFERENCE → PENDING_REFERENCE` (nova tentativa sem sucesso) não é
transição de estado: só atualiza tentativas e próximo agendamento, que **não**
estão no esqueleto. A `WagerTransaction` (ou uma tabela ao lado) precisa de
`attempts` e `next_attempt_at` para o worker de §7.1.

### 6.3 Códigos de falha que as regras já obrigam

Cada regra de rejeição do enunciado precisa de um código distinto:

| Situação | Origem |
|---|---|
| saldo insuficiente na aposta | §7, §8 |
| reversão que negativaria o saldo (≠ do anterior) | §7.9 |
| referência inexistente após o limite | §7.1 |
| referência de outro provider, player, wallet, moeda ou rodada | §7.2 |
| kind de referência inválido (`REFUND` de não-`BET`, `ROLLBACK` de `LOSS`/`ROLLBACK`/`OPENING`) | §7.3 |
| referência já revertida | §7.4 |
| valor da reversão ≠ valor da referência | §7.5 |
| referência não `PROCESSED` | §7 |
| moeda da operação ≠ moeda da wallet | §6.2 |
| wallet não pertence ao player / wallet inexistente | §9 (payload traz os dois) |

Conflito de idempotência e payload inválido **não** são `failureCode`: não chegam
a criar transação, são respostas HTTP.

### 6.4 Sinais nas assinaturas

- **O replay precisa do saldo daquele momento, e o esqueleto não guarda.** §7.7
  exige devolver "o resultado original, incluindo o saldo observado naquele
  momento". A `WagerTransaction` de §6.3 não tem campo de saldo. Para `BET`,
  `WIN` e reversões, o `balanceAfter` do lançamento resolve. Para `LOSS` e
  `REJECTED` não existe lançamento, então é preciso persistir um snapshot
  (ex.: `balance_after` na transação, ou a resposta serializada).
- **`FAILED` exige uma segunda transação SQL.** "Erro permanente de
  infraestrutura (terminal, auditável)": se a transação financeira deu rollback,
  o registro `FAILED` precisa ser gravado fora dela.
- `ledgerDirectionFor(reference?)` recebe a referência porque a direção de um
  `ROLLBACK` é o inverso da direção da transação revertida.
- `affectsBalance()` é `false` para `LOSS`, porque a aposta já foi debitada no
  `BET`. `WagerTransactionProcessed` sai, `WalletBalanceChanged` não.
- `matchesPayload(hash)` mora na `WagerTransaction`: detectar conflito é regra de
  domínio, não do controller.
- `referenceExternalTransactionId` é `readonly`, enquanto
  `_referenceTransactionId` é mutável: a referência é resolvida **depois** da
  criação e gravada em `markProcessed(referenceTransactionId, at)`.
- `markPendingReference()` não recebe código e `reject`/`fail` recebem:
  `PENDING_REFERENCE` não é terminal e não tem `failureCode`.
- `version` começa em `1` e "incrementa somente quando o saldo muda" (§6.2). O
  `OPENING` acontece na criação, então `POST /wallets` devolve `version: 1` mesmo
  com saldo inicial.
- `OutboxMessage.enqueue(event)` recebe o evento inteiro: `eventType`,
  `aggregateId` e `occurredAt` vêm dele, nunca do call site.
- `IntegrationEvent.occurredAt` é `Date` e `toJSON().occurredAt` é `string`: a
  conversão acontece só na serialização.
- O envelope SQS de entrada (§10) tem `type`, mas não tem `version`, ao
  contrário dos eventos de saída. Aceitar só `WagerTransactionRequested` e tratar
  qualquer outro `type` como erro permanente (DLQ).
- Health e fila ficam fora da auth (§2), mas a identidade do provedor **dentro**
  da mensagem passa pelas mesmas validações de domínio.
