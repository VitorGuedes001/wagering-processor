# Passo 3 — O que reaproveitar do README do desafio

Mapa do que entra no código a partir do enunciado ([CHALLENGE.md](CHALLENGE.md),
seções 6–13). Toda referência `§N` abaixo aponta para a seção N desse arquivo.
O próprio README chama os blocos de "esqueletos de referência" e permite adaptar
nomes e assinaturas (§6, §6.0), então copiar é o uso esperado.

Categorias:

- **Literal:** copia como está.
- **Estrutura:** copia a forma (campos, factories, getters) e escreve o corpo.
- **Fixture:** JSON ou cenário que vira dado de teste.
- **Decisão própria:** citado no README, mas não definido. Fica para o passo 4.

---

## 1. Literal

| Item | Origem | Destino sugerido | Observação |
|---|---|---|---|
| `WagerTransactionKind` | §6.3 | `domain/wager-transaction.ts` | Inclui `OPENING`. Ele precisa ser barrado na borda (DTO HTTP e parser SQS), não no enum |
| `WagerTransactionStatus` | §6.3 | idem | Comentários do enum já documentam a semântica de cada estado |
| `LedgerDirection` | §6.4 | `domain/wallet-ledger-entry.ts` | |
| `MoneyProps` | §6.1 | `domain/money.ts` | DTO, `interface` mesmo, como o README indica |
| Assinatura pública de `Money` | §6.1 | idem | `from`, `zero`, `add`, `subtract`, `negate`, `is*`, `equals`, `toJSON`, `toString`. O corpo é nosso (ver §4 `Decimal`) |
| `IntegrationEventProps<T>` | §11 | `domain/events/integration-event.ts` | |
| `IntegrationEvent<T>` (abstrata) | §11 | idem | Construtor `protected`, `eventType`/`version` abstratos. `toJSON()` converte `occurredAt` para ISO-8601 |
| `WalletBalanceChangedData` | §11 | `domain/events/wallet-balance-changed.ts` | Modelo para os outros três `*Data` |
| `WalletBalanceChanged` | §11 | idem | `eventType`/`version` como campo `readonly` da classe, nunca em string no call site |
| Nomes das filas | §10 | `docker/localstack/init-queues.sh` + config | `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (já está no esqueleto) |
| Rotas HTTP | §9 | controllers | Ver a lista completa em §3.2 deste documento |

## 2. Estrutura (corpo próprio)

Na prática, estes construtores já são o schema: cada parâmetro vira coluna.

| Classe | Origem | Factories | O que fica para nós |
|---|---|---|---|
| `Wallet` | §6.2 | `open`, `rehydrate` | Assinatura e retorno de `debit`/`credit`. Sugestão: retornar o `WalletLedgerEntry`, porque a regra "toda alteração de saldo tem lançamento" fica estrutural |
| `WagerTransaction` | §6.3 | `create`, `rehydrate` | Corpo das transições, `ledgerDirectionFor`, validação de referência por kind em `create` |
| `WalletLedgerEntry` | §6.4 | `create`, `rehydrate` | `create` valida `balanceBefore ± money === balanceAfter`. Sem setters, sem transições |
| `InboxMessage` | §6.5 | `receive`, `rehydrate` | |
| `OutboxMessage` | §6.5 | `enqueue(event)`, `rehydrate` | `payload = event.toJSON()`. Curva de backoff do `scheduleRetry` |

Regra transversal (§6.0): construtor `private`/`protected`, e `rehydrate` **não**
revalida transições.

### Colunas implícitas (rascunho para o passo 5)

| Tabela | Colunas vindas do construtor | Constraint que o README exige (§5.9) |
|---|---|---|
| `wallet` | `id, player_id, currency, balance, version, created_at, updated_at` | `UNIQUE(player_id, currency)`, `CHECK(balance >= 0)` |
| `wager_transaction` | `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, reference_external_transaction_id, reference_transaction_id, status, failure_code, created_at, processed_at` | `UNIQUE(provider_id, external_transaction_id)`, `UNIQUE(idempotency_key)`, `CHECK(amount > 0)`, unicidade de reversão por referência (ver §5.1) |
| `wallet_ledger_entry` | `id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at` | `UNIQUE(transaction_id)` (no máx. 1 lançamento por transação/wallet), `CHECK` da aritmética, `CHECK(balance_after >= 0)`, trigger bloqueando `UPDATE`/`DELETE` |
| `inbox_message` | `message_id, consumer_name, payload_hash, received_at, processed_at` | `PK(consumer_name, message_id)` |
| `outbox_message` | `id, aggregate_id, event_type, payload (jsonb), occurred_at, attempts, next_attempt_at, published_at` | índice parcial `WHERE published_at IS NULL` para o worker |

## 3. Fixtures de teste

### 3.1 JSONs

| Fixture | Origem | Uso |
|---|---|---|
| `POST /wallets` request (`initialBalance 1000.00 BRL`) | §9 | criação com `OPENING` |
| `POST /wallets` response (`version: 1`) | §9 | confirma que `OPENING` na criação **não** incrementa `version` |
| `POST /wagering/transactions` request (`BET 25.00`) | §9 | payload base. As variações (`WIN`, `REFUND`…) derivam dele |
| `POST /wagering/transactions` response (`975.00`, `idempotentReplay: false`) | §9 | primeira chamada. O replay deve devolver o mesmo corpo com `true` |
| Header `Idempotency-Key: provider-a:transaction-123` | §9 | formato default `{providerId}:{externalTransactionId}` |
| Envelope SQS `WagerTransactionRequested` | §10 | mesmo `data` do HTTP + `idempotencyKey` dentro de `data` |
| Resposta de reconciliação (`checkedEntries: 42`) | §9 | forma do DTO. Os valores dependem do cenário |
| `{ "amount": "25.00", "currency": "BRL" }` | §6.1 | formato canônico de `MoneyProps` |

IDs prontos (UUIDv7) para reaproveitar nas fixtures:
`playerId 0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1`,
`walletId 0192f291-27dd-7d3f-8071-5f8685deef37`,
`transactionId 0192f298-345e-7e38-af88-e43f851a819d`.
Os IDs seguem o formato v7, então a geração interna deve ser UUIDv7, que também
ordena por tempo e ajuda o cursor do ledger.

### 3.2 Cenários com resultado esperado

| Cenário | Origem | Resultado verificável |
|---|---|---|
| 100.00 com duas `BET` de 80.00 simultâneas | §8 | 1 `PROCESSED`, 1 `REJECTED` (saldo insuficiente), saldo 20.00, 1 `DEBIT`, retry não duplica |
| Mesma aposta 50× em paralelo | §13.1 | 1 débito |
| Wallets distintas em paralelo | §13.3 | nenhuma serialização entre elas |
| ≥ 3 instâncias | §13.4 | invariantes mantidas |
| Worker morto após commit, antes do ack | §13.5 | redelivery vira replay via inbox |
| Dois publishers na mesma outbox | §13.6 | nenhum evento perdido. Duplicata é tolerada |
| `REFUND`/`ROLLBACK` antes da referência | §13.7 | `PENDING_REFERENCE` → `PROCESSED` quando a referência chega, ou `REJECTED` com código próprio quando o limite estoura |
| Commit → crash → outra instância publica | §11 | evento sai ao menos uma vez |
| Reinício com consistência final | §13.8 | reconciliação `consistent: true` |

Invariante de fechamento de **todo** teste: `wallet.balance == Σ ledger`.

Rotas a cobrir (§9): `POST /wallets`, `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger?cursor&limit`, `POST /wagering/transactions`,
`GET /wagering/transactions/:transactionId`,
`GET /providers/:providerId/wagering/transactions/:externalTransactionId`,
`POST /wallets/:walletId/reconciliation`, `GET /health/live`, `GET /health/ready`.

## 4. Decisão própria (citado, mas não definido)

| Tipo / tema | Onde aparece | Nota para o passo 4 |
|---|---|---|
| `Decimal` | `Money` (§6.1) | **Não está na lista do CONTEXT.** O README não diz qual lib. Com escala fixa de 2, `bigint` em centavos resolve sem dependência. No Postgres, `numeric(19,2)` mapeado como string |
| `CreateWagerTransactionProps` | §6.3 | basicamente o payload de entrada + `walletId` resolvido + `payloadHash` |
| `WalletState`, `WagerTransactionState`, `LedgerEntryState` | §6.2–6.4 | forma "linha do banco". Fronteira entre entidade MikroORM e domínio |
| `CreateLedgerEntryProps`, `ReceiveInboxProps`, `InboxMessageState`, `OutboxMessageState` | §6.4–6.5 | **também não estão na lista do CONTEXT** |
| `FailureCode` | §6.3, §7.2 | taxonomia nossa. Mínimo exigido: saldo insuficiente ≠ reversão que negativaria saldo (§7.9), referência inexistente após limite (§7.1), conflito de moeda |
| `EventContext` | §11 | provavelmente `{ correlationId, causationId?, occurredAt }` |
| `InvalidTransactionStateError` | §6.3 | erro de programação, não de negócio. Não vira `failureCode` |
| Assinatura de `debit`/`credit` | §6.2 | explicitamente aberta |
| `payloadHash` | §9 | algoritmo (ex.: SHA-256 de JSON canônico) e **quais campos** entram |
| Mapeamento de status HTTP | §9 | 5 situações distintas: inválido, conflito de idempotência, rejeição de negócio, pendente, falha transitória |
| Corpo da resposta para `REJECTED`/`PENDING_REFERENCE` | §9 | o README só mostra `PROCESSED`. Provavelmente adiciona `failureCode` |
| Estratégia de lock | §8 | justificar no `ARCHITECTURE.md` |
| Limite/TTL de `PENDING_REFERENCE` | §7.1 | justificar |
| Backoff da outbox e limite antes da DLQ | §6.5, §10 | |
| Formato do cursor do ledger | §9 | "estável e opaco": base64 de `(created_at, id)` ou só `id` UUIDv7 |

## 5. Sinais escondidos e ambiguidades

Coisas que o texto implica sem dizer, ou onde duas regras se cruzam.

### 5.1 Ambiguidades que exigem decisão documentada

1. **`REFUND` e `ROLLBACK` sobre a mesma `BET`.** §7.4 diz "não pode ser revertida
   duas vezes *pelo mesmo tipo de operação*". Lida ao pé da letra, uma `BET` pode
   receber um `REFUND` **e** um `ROLLBACK`, creditando duas vezes, e isso
   contraria o invariante "não duplicar créditos" (§3). Proposta: uma transação
   só pode ser revertida **uma vez, por qualquer kind**. No schema:
   `UNIQUE(reference_transaction_id) WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`.
   `ROLLBACK` de um `REFUND` continua válido, porque a referência é outra linha.
2. **`WIN` com referência.** "Pode referenciar" (§7). Se a `BET` referenciada não
   existe ainda, é `PENDING_REFERENCE` como na reversão? §7.8 fala em "referência
   ausente" sem restringir a reversões. Decidir e documentar.
3. **`ROLLBACK` de `ROLLBACK`** e **`ROLLBACK` de `OPENING`**: proibidos por
   §7.3 (só `BET`/`WIN`/`REFUND`). Merece `failureCode` próprio
   (ex.: `REFERENCE_KIND_NOT_REVERSIBLE`).
4. **Referência `REJECTED` ou `PENDING`.** §7 exige `PROCESSED`. Se a referência
   existe mas foi rejeitada, a reversão é rejeitada, não `PENDING_REFERENCE`.
5. **`playerId` e `walletId` no payload.** Ambos chegam (§9). A wallet precisa
   pertencer ao player, e a moeda de `money` precisa bater com a da wallet.
   Cada divergência tem um `failureCode`.
6. **Inbox + idempotency key: duas camadas.** A mensagem SQS traz `messageId`
   (inbox) **e** `idempotencyKey` (§10). Mesma operação com `messageId` diferente
   passa pela inbox e cai no replay por idempotência. Mesmo `messageId` com
   payload diferente é anomalia do transporte e merece log/métrica.

### 5.2 Sinais nas assinaturas

- `ledgerDirectionFor(reference?)` recebe a referência porque a direção de um
  `ROLLBACK` é o inverso da direção da transação revertida.
- `affectsBalance()` é `false` para `LOSS`, porque a aposta já foi debitada no
  `BET`. Evento `Processed` sai, `WalletBalanceChanged` não.
- `matchesPayload(hash)` mora na `WagerTransaction`: a detecção de conflito é
  regra de domínio, não do controller.
- `referenceExternalTransactionId` é `readonly`, enquanto
  `_referenceTransactionId` é mutável e privado: a resolução da referência
  acontece **depois** da criação (cenário `PENDING_REFERENCE`) e é gravada em
  `markProcessed(referenceTransactionId, at)`.
- `markPendingReference()` não recebe nada e `reject`/`fail` recebem código:
  `PENDING_REFERENCE` não é terminal e não tem código.
- `version` começa em `1` e "incrementa somente quando o saldo muda" (§6.2). O
  `OPENING` acontece na criação, então a resposta de `POST /wallets` mostra
  `version: 1` mesmo com saldo inicial.
- `OutboxMessage.enqueue(event: IntegrationEvent<unknown>)` recebe o evento
  inteiro, então `eventType`/`aggregateId`/`occurredAt` vêm dele, nunca do call site.
- `IntegrationEvent.occurredAt` é `Date` e `toJSON().occurredAt` é `string`: a
  conversão acontece só na serialização.

### 5.3 Organização

- Resolvido: o enunciado foi movido para `docs/CHALLENGE.md`, e o `README.md`
  passou a ser o de setup e comandos, como §14 exige.
