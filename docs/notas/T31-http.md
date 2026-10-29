# T31 — HTTP

> Estado: Testada · Raia: G · Revisor: C · Branch: `t31-http`

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

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
