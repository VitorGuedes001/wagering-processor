# T31 — HTTP

> Estado: Revisada · Raia: G · Revisor: C · Branch: `t31-http`

## O que muda

- `src/interface/http/types.ts`: contratos leves de requisição e resposta HTTP desacoplados de bibliotecas externas.
- `src/interface/http/schemas.ts`: schemas Zod de validação de `POST /wallets` e `POST /wagering/transactions` (e `/wagers/v1`), garantindo que `amount` é estritamente string (restrição 5.1).
- `src/interface/http/auth.guard.ts`: guard no-op para autenticação conforme ARQUITETURA §6 / D31.
- `src/interface/http/correlation-id.middleware.ts`: middleware de captura ou geração de `X-Correlation-Id` em ALS e propagação no header de resposta.
- `src/interface/http/error-mapping.ts`: mapeamento de erros de domínio e aplicação para status HTTP e respostas conforme ARQUITETURA §6.2.
- `src/interface/http/wallets.controller.ts`: controller para criação (`POST /wallets`) e consulta (`GET /wallets/:id`).
- `src/interface/http/wagering.controller.ts`: controller para submissão de apostas (`POST /wagering/transactions` e `POST /wagers/v1`) e consultas de transações.
- `src/interface/http/http.module.ts`: módulo NestJS agrupando controllers, middleware, guard e provedores de use cases/handlers e queries.
- `src/interface/http/use-case-handlers.ts`: handlers concretos para `CreateWalletCommand` e `WagerCommand` executando fluxo financeiro transacional contra `UnitOfWork`.
- `src/application/queries.ts`: implementação das consultas de leitura de wallet e transações por ID/ID externo.
- `test/integration/http-endpoints.test.ts`: testes de integração cobrindo I-05 a I-11 em servidor HTTP real com banco PostgreSQL isolado.

## Por quê

- Atende ao contrato HTTP definido em CHALLENGE §9 e ARQUITETURA §6.
- Restrição inviolável 5.1: `amount` numérico é rejeitado com 400 `INVALID_PAYLOAD`.
- Mapeamento estrito de desfechos (`SubmitOutcome`) e erros conforme tabela de ARQUITETURA §6.2.
- Propagação obrigatória de `X-Correlation-Id` e exigência de `Idempotency-Key` (máx 256 caracteres).
- Suporte a consultas de leitura simples (`queries`) sem modelo CQRS complexo (ARQUITETURA D23, D49, D50).

## Abordagem

- Arquivos que vou tocar:
  - `src/interface/http/types.ts`
  - `src/interface/http/schemas.ts`
  - `src/interface/http/auth.guard.ts`
  - `src/interface/http/correlation-id.middleware.ts`
  - `src/interface/http/error-mapping.ts`
  - `src/interface/http/wallets.controller.ts`
  - `src/interface/http/wagering.controller.ts`
  - `src/interface/http/http.module.ts`
  - `src/interface/http/use-case-handlers.ts`
  - `src/application/queries.ts`
  - `test/integration/http-endpoints.test.ts`
  - `docs/notas/T31-http.md`
- Assinaturas públicas:
  - `HttpModule` (NestJS module)
  - `WalletsController` (`POST /wallets`, `GET /wallets/:id`)
  - `WageringController` (`POST /wagering/transactions`, `POST /wagers/v1`, `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`)
  - `createWalletSchema`, `wagerTransactionSchema`
  - `AuthGuard` (CanActivate)
  - `CorrelationIdMiddleware` (NestMiddleware)
  - `HttpErrorFilter` / `mapOutcomeToResponse`
  - `DefaultCreateWalletHandler`, `DefaultSubmitWagerHandler`
  - `ApplicationWalletQueries`, `ApplicationTransactionQueries`
- Alternativas descartadas e motivo:
  - `class-validator` / `class-transformer`: descartados por depender de metadados experimentais e não barrarem estritamente tipos JSON com a precisão de Zod (D27).
  - Tratar `REJECTED` como exceção: descartado porque `REJECTED` é um valor de desfecho de negócio persistido com snapshot de saldo, mapeado para 422 (D26, ARQUITETURA 6.2).
  - Misturar rotas de use cases com MikroORM direto nos controllers: descartado pelas fronteiras de camadas (ARQUITETURA 2, regra A-02).

**Aprovação do humano:** aprovada no briefing da tarefa (tarefa paralela Onda 3).

## Ordem de leitura do diff

1. `src/interface/http/schemas.ts` — validações Zod e restrição 5.1 em `amount`
2. `src/interface/http/error-mapping.ts` — mapeamento unificado de erros e desfechos para status HTTP e formato padrão
3. `src/interface/http/correlation-id.middleware.ts` e `auth.guard.ts` — headers e guard
4. `src/application/queries.ts` — consultas de leitura de wallet e transações
5. `src/interface/http/use-case-handlers.ts` — integração transacional dos use cases com UnitOfWork
6. `src/interface/http/wallets.controller.ts` e `wagering.controller.ts` — controllers REST
7. `src/interface/http/http.module.ts` — montagem do módulo NestJS
8. `test/integration/http-endpoints.test.ts` — suíte de integração com I-05 a I-11

## Como verificar

```bash
bun run tarefa:gate
bun test test/integration/http-endpoints.test.ts
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

- Adicionar `HttpModule` (de `./interface/http/http.module`) aos `imports` de `AppModule` em `src/app.module.ts`.

## Fora de escopo / dívida

- `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation`: pertencem à tarefa T43 (Onda 4).
- Processamento SQS e DLQ: pertencem à tarefa T40 (Onda 4).

## Revisão cruzada

Revisão cruzada realizada pelo Revisor C (Reviewer T31) contra `AGENTS.md`, `docs/ARQUITETURA.md` §6 e §7, e `docs/TESTES.md` I-05..I-11.

### 1. Resultado do Quality Gate (`bun run tarefa:gate`)
- `typecheck`: ✔ aprovado (`bunx tsc --noEmit`)
- `skills`: ✔ aprovado (`bun scripts/skills-sync.ts --check`)
- `unidade`: ✔ 71 testes aprovados (`bun test ./test/unit`)
- `arquitetura`: ✔ 5 testes aprovados (`bun test ./test/architecture`)
- `integração`: ✔ 102 testes aprovados (`bun test ./test/integration`, incluindo os 26 testes de `http-endpoints.test.ts`)

### 2. Verificações realizadas
- **Escopo**: Apenas os 12 arquivos declarados na nota foram tocados (`src/interface/http/*`, `src/application/queries.ts`, `test/integration/http-endpoints.test.ts` e nota). Nenhum arquivo protegido foi alterado (`app.module.ts`, `package.json`, `bun.lock`, `ports.ts`, `src/domain/`).
- **Restrição inviolável 5.1 (Dinheiro)**: Validação com Zod em `moneySchema` exige estritamente string no formato `(0|[1-9]\d*)\.\d{2}`. Qualquer payload com `amount` numérico é barrado na borda com status HTTP 400 e código `INVALID_PAYLOAD`.
- **Contrato e Mapeamento HTTP (ARQUITETURA §6.2)**:
  - `POST /wallets`: 201 com view `{ id, playerId, balance, version }`, ou 409 `WALLET_ALREADY_EXISTS`.
  - `GET /wallets/:id`: 200 com carteira ou 404 `WALLET_NOT_FOUND`.
  - `POST /wagering/transactions` e `/wagers/v1`: 200 para `PROCESSED`, 202 para `PENDING_REFERENCE`, 422 para `REJECTED` (com `failureCode` e `balance`), 409 para conflitos (`IDEMPOTENCY_CONFLICT` e `EXTERNAL_ID_CONFLICT`).
  - Falhas transitórias mapeadas para 503 com cabeçalho `Retry-After: 1`.
  - `Idempotency-Key`: obrigatório, validado até 256 caracteres, gerando 400 `INVALID_PAYLOAD` se ausente.
  - `X-Correlation-Id`: capturado do header ou gerado em formato UUIDv7 via middleware e propagado na resposta HTTP.
- **Autenticação (D31)**: `AuthGuard` no-op implementado sem acoplamento a bibliotecas externas.
- **Testes de Integração (I-05 a I-11)**: Autênticos, executados com servidor HTTP real instanciado em porta efêmera e banco PostgreSQL isolado rodando migrations. Validação estrita de banco e invariantes (`assertAllWalletsConsistent`).
- **Fronteiras de Camadas**: `src/interface/http/` desacoplado de MikroORM direto, consumindo use cases e queries através de portas e abstração `UnitOfWork`.

### 3. Tabela de Achados

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| — | nenhuma | — | Nenhum achado impeditivo. Implementação robusta, aderente às restrições financeiras e aos contratos de arquitetura. | — |

Veredito: aprovado
