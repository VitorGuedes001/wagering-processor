# Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`,
`LOSS`, `REFUND`, `ROLLBACK`) vindas de vários provedores de jogos, por HTTP e
por SQS. Mantém uma wallet com saldo materializado e um ledger imutável, e
continua correto com mensagens duplicadas, fora de ordem ou processadas ao mesmo
tempo por várias instâncias.

Stack: Bun · TypeScript estrito · NestJS · MikroORM · PostgreSQL 16 · SQS
(LocalStack) · Docker Compose.

As decisões, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose
- Portas livres: `5434` (Postgres), `4566` (LocalStack) e `3000` (API)

## Subir o ambiente

### Windows, num comando

```powershell
.\bootstrap.ps1
```

Instala as dependências, roda o typecheck e sobe Postgres e LocalStack. Também
confere as filas e o redrive para a DLQ, roda as migrations (`up → down → up`),
sobe a aplicação e valida `/health/ready`.

### Passo a passo (qualquer sistema)

```bash
bun install --frozen-lockfile
bun run infra:up          # Postgres em localhost:5434 e LocalStack em localhost:4566
docker compose ps         # espere os dois ficarem healthy
bun run db:migrate
bun run start:dev         # API em http://localhost:3000
```

```bash
curl http://localhost:3000/health/live    # {"status":"ok"}
curl http://localhost:3000/health/ready   # 200 com postgres e sqs true; 503 se faltar algum
```

As filas são criadas pelo LocalStack na inicialização
(`docker/localstack/init-queues.sh`):

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada. Visibility 30 s, redrive para a DLQ depois de 5 recebimentos |
| `wager-transactions-dlq.fifo` | DLQ |
| `wagering-events.fifo` | eventos publicados pelo outbox |

### Várias instâncias

Cada instância é um processo com a sua porta. Todas compartilham o banco e as
filas: HTTP, consumidor SQS e workers rodam em todas.

```bash
PORT=3001 bun src/main.ts
PORT=3002 bun src/main.ts
PORT=3003 bun src/main.ts
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run infra:up` | sobe Postgres e LocalStack |
| `bun run infra:down` | derruba a infra **e apaga os volumes** |
| `bun run db:migrate` | aplica as migrations |
| `bun run db:rollback` | reverte a última migration |
| `bun run start:dev` | sobe a API com watch |
| `bun run typecheck` | checagem de tipos |
| `bun run test` | unidade e arquitetura. Não precisa de Docker |
| `bun run test:integration` | integração contra Postgres e LocalStack reais |
| `bun run test:concurrency` | concorrência e falha, com processos reais da aplicação |
| `bun run test:all` | typecheck e todas as suítes, em ordem |
| `bun run test:stress` | concorrência repetida 10 vezes, para pegar instabilidade |

Os testes de integração e concorrência precisam da infra de pé
(`bun run infra:up`). Cada arquivo de teste cria um banco e filas próprios, a
partir de um template, e apaga tudo ao terminar. Os dados de desenvolvimento não
são tocados.

## Configuração

Tudo tem default para rodar localmente. As variáveis principais:

| Variável | Default | Para quê |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DB_HOST` / `DB_PORT` | `localhost` / `5434` | Postgres |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `wagering` | Postgres |
| `DB_LOCK_TIMEOUT_MS` | `2000` | quanto uma operação espera o lock da wallet antes de desistir com 503 |
| `SQS_ENDPOINT` / `AWS_REGION` | `http://localhost:4566` / `us-east-1` | LocalStack |
| `SQS_INPUT_QUEUE` / `SQS_DLQ` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wagering-events.fifo` | filas |
| `SQS_CONSUMER_CONCURRENCY` | `5` | mensagens em andamento por instância |
| `ENABLE_HTTP` / `ENABLE_CONSUMER` / `ENABLE_OUTBOX_WORKER` / `ENABLE_REFERENCE_WORKER` | `true` | liga ou desliga cada componente na instância |
| `OUTBOX_POLL_MS` / `OUTBOX_BATCH` / `OUTBOX_LEASE_MS` | `500` / `50` / `30000` | worker de outbox |
| `REFERENCE_MAX_ATTEMPTS` | `10` | tentativas de resolver uma referência que ainda não chegou |
| `REFERENCE_BACKOFF_BASE_MS` / `REFERENCE_BACKOFF_MAX_MS` | `1000` / `300000` | backoff exponencial dessas tentativas |
| `SHUTDOWN_GRACE_MS` | `20000` | quanto o desligamento espera as mensagens em andamento |
| `MIKRO_ORM_DEBUG` | `false` | loga o SQL |

Uma configuração inválida derruba o processo na largada, com a mensagem do erro.

## API

Todo valor em dinheiro é **string** com duas casas (`"25.00"`). Um número JSON
(`25`) é recusado com `400 INVALID_PAYLOAD`. Toda resposta traz
`X-Correlation-Id`: o enviado pelo cliente ou um gerado.

| Método e rota | O que faz |
|---|---|
| `POST /wallets` | cria a wallet de um player numa moeda, com saldo inicial (pode ser `0.00`) |
| `GET /wallets/:walletId` | saldo e versão |
| `GET /wallets/:walletId/ledger?limit=&cursor=` | extrato paginado por cursor |
| `POST /wallets/:walletId/reconciliation` | compara o saldo guardado com o reconstruído pelo ledger |
| `POST /wagering/transactions` | submete uma transação. Exige o header `Idempotency-Key` |
| `GET /wagering/transactions/:transactionId` | consulta por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `GET /health/live` e `GET /health/ready` | liveness e readiness |
| `GET /metrics` | métricas Prometheus da instância |

### Exemplo

```bash
curl -X POST localhost:3000/wallets -H 'Content-Type: application/json' -d '{
  "playerId": "3f6c1d1e-5a2b-4c8e-9f10-7a1b2c3d4e5f",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}'

curl -X POST localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: provider-a:bet-1' -d '{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "3f6c1d1e-5a2b-4c8e-9f10-7a1b2c3d4e5f",
  "walletId": "<id devolvido acima>",
  "roundId": "round-1",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}'
```

`WIN`, `LOSS`, `REFUND` e `ROLLBACK` aceitam `referenceExternalTransactionId`.
Em `REFUND` e `ROLLBACK` ele é obrigatório.

| Status | Quando |
|---|---|
| `201` | wallet criada |
| `200` | `PROCESSED`, inclusive replay (`idempotentReplay: true`) |
| `202` | `PENDING_REFERENCE`: a referência ainda não chegou |
| `422` | `REJECTED`, com `failureCode` e o saldo daquele momento |
| `400` | `INVALID_PAYLOAD` |
| `404` | `WALLET_NOT_FOUND`, `TRANSACTION_NOT_FOUND` |
| `409` | `WALLET_ALREADY_EXISTS`, `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT` |
| `503` | falha transitória (lock, banco ou fila), com `Retry-After: 1` |

Os códigos de falha estão em [ARCHITECTURE.md](ARCHITECTURE.md#9-códigos-de-falha).

### Por SQS

Mande para `wager-transactions.fifo`, de preferência com `MessageGroupId` igual
ao `walletId`. `data` tem o mesmo formato do corpo HTTP, mais a `idempotencyKey`:

```json
{
  "messageId": "msg-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-30T12:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-2",
    "idempotencyKey": "provider-a:bet-2",
    "playerId": "3f6c1d1e-5a2b-4c8e-9f10-7a1b2c3d4e5f",
    "walletId": "<walletId>",
    "roundId": "round-1",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }
}
```

## Estrutura

```
src/
  domain/          regra de negócio pura: Money, Wallet, WagerTransaction, ledger, decideWager
  application/     use cases e portas
  infrastructure/  MikroORM, Unit of Work, SQS, config, logs, métricas
  interface/       HTTP, consumidor SQS, workers, health
migrations/        3 migrations reversíveis, com constraints e triggers
test/
  unit/            domínio, sem infra
  architecture/    fronteiras de camada e proibição de float em dinheiro
  integration/     Postgres e LocalStack reais
  concurrency/     processos reais da aplicação, locks e quedas
  support/         banco e filas por teste, portão de lock, cluster de processos
docker/            init das filas no LocalStack
```
