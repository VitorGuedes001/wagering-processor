# Ambiente local

Como subir e validar a infra. O `bootstrap.ps1` faz tudo isto em sequência no
Windows. Os comandos abaixo são o passo a passo manual.

## 1. Dependências

```bash
bun install --frozen-lockfile
bun run typecheck
```

## 2. Infra

```bash
bun run infra:up
docker compose ps        # postgres e localstack healthy
docker exec wagering-localstack awslocal sqs list-queues
```

Filas esperadas:

| Fila | Papel |
|---|---|
| `wager-transactions.fifo` | entrada. Redrive para a DLQ após 5 recebimentos, visibility 30 s |
| `wager-transactions-dlq.fifo` | DLQ |
| `wagering-events.fifo` | saída do outbox, dedup por `MessageDeduplicationId` |

Se as filas mudarem no `init-queues.sh`, recrie o LocalStack:
`docker compose up -d --force-recreate localstack`.

## 3. Migrations

```bash
bun run db:migrate
bun run db:rollback      # reversível, exigência do desafio
bun run db:migrate
```

## 4. App

```bash
bun run start:dev
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready   # 200 com postgres e sqs true; 503 se alguma falhar
```

---

## O que o passo 1 provou

O passo 1 usou uma entidade e um script descartáveis (`smoke_balance`,
`scripts/smoke.ts`), removidos no B0. Ficou provado:

| Verificação | Prova |
|---|---|
| App sobe | Bun executa NestJS. Decorators e DI funcionam |
| `migration:up` / `down` | a CLI do MikroORM roda sob Bun, sem fallback para Node |
| `numeric` volta string | dinheiro não passa por float no caminho ORM ↔ banco |
| insert negativo barrado | `CHECK` vive no schema, não só no código |
| envio e recebimento FIFO | LocalStack acessível. FIFO exige `MessageGroupId` |
| redrive (B0) | após 5 recebimentos sem ack, a mensagem aparece na DLQ |

## Onde isso costuma quebrar

**Descoberta de entidades.** A config usa lista explícita e
`ReflectMetadataProvider` de propósito. Varrer pastas `.ts` depende de ts-morph e
é a primeira coisa a quebrar fora do Node.

**`emitDecoratorMetadata`.** Se a DI do Nest reclamar de dependência não
resolvida sem motivo aparente, é quase sempre isso no `tsconfig.json`.

**Endpoint do LocalStack.** `localhost:4566` vale rodando na máquina. Dentro do
Compose vira `http://localstack:4566`, por isso o endpoint sai de env var.

**`init-queues.sh` com CRLF** faz o container falhar com `bad interpreter`. O
`.gitattributes` força LF em `*.sh`.
