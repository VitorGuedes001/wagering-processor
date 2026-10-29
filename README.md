# Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`,
`REFUND`, `ROLLBACK`) de múltiplos provedores, com wallet materializada e ledger
imutável. Stack: Bun · TypeScript · NestJS · MikroORM · PostgreSQL · SQS (LocalStack).

> Em construção. Hoje só existe o esqueleto de ambiente e o `/health`.

## Pré-requisitos

- Bun 1.x
- Docker Desktop rodando

## Subir tudo de uma vez (Windows)

```powershell
.\bootstrap.ps1
```

Instala dependências, sobe Postgres e LocalStack, roda migrations (up → down → up),
executa o smoke test e checa `/health`. Detalhes de cada verificação em
[SETUP.md](SETUP.md).

## Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala dependências |
| `bun run infra:up` | sobe Postgres (`localhost:5434`) e LocalStack (`localhost:4566`) |
| `bun run infra:down` | derruba a infra e apaga os volumes |
| `bun run db:migrate` | aplica migrations |
| `bun run db:rollback` | reverte a última migration |
| `bun run smoke` | smoke test de ambiente |
| `bun run start:dev` | sobe a API em `http://localhost:3000` com watch |
| `bun run typecheck` | checagem de tipos |
| `bun test` | testes |

## Configuração

| Variável | Default |
|---|---|
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5434` |
| `DB_USER` / `DB_PASSWORD` / `DB_NAME` | `wagering` |
| `SQS_ENDPOINT` | `http://localhost:4566` |
| `AWS_REGION` | `us-east-1` |
| `PORT` | `3000` |
| `MIKRO_ORM_DEBUG` | `false` |

## Endpoints disponíveis

```http
GET /health/live
GET /health/ready
```

## Documentação

- [docs/CHALLENGE.md](docs/CHALLENGE.md): enunciado do desafio
- [SETUP.md](SETUP.md): passo 1, validação do ambiente
- [docs/REAPROVEITAMENTO.md](docs/REAPROVEITAMENTO.md): o que vem do enunciado para o código
- [docs/MODELAGEM.md](docs/MODELAGEM.md): entidades, invariantes, transições e códigos de falha
- [docs/SCHEMA.md](docs/SCHEMA.md): tabelas, constraints, triggers e estratégia de concorrência
- [docs/ARQUITETURA.md](docs/ARQUITETURA.md): camadas, portas, use cases, contrato HTTP, mensageria e observabilidade
- [docs/TESTES.md](docs/TESTES.md): plano de testes e infraestrutura de concorrência
- [docs/PLANO.md](docs/PLANO.md): blocos de implementação com timebox e cortes por orçamento
- [docs/EXECUCAO.md](docs/EXECUCAO.md): execução com agentes em paralelo, revisão humana e marcos
- [docs/ONDA-1.md](docs/ONDA-1.md): o que a onda 1 entregou, como testar e o que revisar
- `ARCHITECTURE.md`: decisões e trade-offs (a criar)
