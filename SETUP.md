# Passo 1 — provar que a stack fecha

Objetivo: descobrir atrito de ambiente antes de escrever uma linha de domínio.
Nada aqui é código final — `SmokeBalance` e a migration inicial são descartáveis.

## 1. Dependências

```bash
bun add @nestjs/common @nestjs/core @nestjs/platform-express reflect-metadata rxjs
bun add @mikro-orm/core @mikro-orm/postgresql @mikro-orm/migrations @mikro-orm/nestjs
bun add @aws-sdk/client-sqs decimal.js
bun add -d @mikro-orm/cli typescript bun-types
```

Sem versões fixas de propósito: deixa o Bun resolver o que está atual e confere
o `package.json` gerado depois.

## 2. Infra

```bash
bun run infra:up
docker compose ps        # os dois healthy
docker compose logs localstack | Select-String init-queues   # PowerShell
```

## 3. Migration

```bash
bun run db:migrate
bun run db:rollback      # reversível, exigência do desafio
bun run db:migrate
```

## 4. Smoke

```bash
bun run smoke
```

Esperado: todas as linhas `OK`.

## 5. App

```bash
bun run start:dev
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

`ready` deve trazer `postgres: true` e `sqs: true`.

---

## O que cada verificação derruba de incerteza

| Verificação | Prova |
|---|---|
| App sobe | Bun executa NestJS; decorators e DI funcionam |
| `migration:up` / `down` | CLI do MikroORM roda sob Bun; migrations reversíveis |
| decimal volta string | dinheiro não passa por float no caminho ORM ↔ banco |
| insert negativo barrado | constraint vive no schema, não só no código |
| envio e recebimento FIFO | LocalStack acessível; FIFO exige `MessageGroupId` |
| `/health/ready` | readiness consegue tocar as duas dependências |

## Onde isso costuma quebrar

**CLI do MikroORM sob Bun.** É o ponto mais provável de atrito. Se
`bunx mikro-orm` falhar, roda com Node (`npx mikro-orm migration:up`) — só a CLI,
a aplicação continua no Bun. Registrar isso no `ARCHITECTURE.md` como limitação
conhecida vale mais que esconder.

**Descoberta de entidades.** A config usa lista explícita e `ReflectMetadataProvider`
de propósito. Varrer pastas `.ts` depende de ts-morph e é a primeira coisa a
quebrar fora do Node. Se trocar, troca sabendo.

**`emitDecoratorMetadata`.** Se a DI do Nest reclamar de dependência não
resolvida sem motivo aparente, é quase sempre isso no `tsconfig.json`.

**Endpoint do LocalStack.** `localhost:4566` vale rodando na máquina. Quando a
app for para dentro do Compose, vira `http://localstack:4566` — por isso o
endpoint sai de env var desde já.

**FIFO sem `MessageGroupId`** rejeita o envio. E a ordenação é garantida dentro
do grupo: usar `walletId` como grupo serializa por carteira. Útil, mas é
otimização — o desafio proíbe depender disso para a consistência.

## Antes de seguir para o passo seguinte

```bash
rm -rf src/entities/smoke-balance.entity.ts scripts/smoke.ts
# e a migration inicial, se preferir começar o schema real do zero
```

O `/health` fica — já é requisito da seção 12.
