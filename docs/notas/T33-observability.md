# T33 — Observabilidade base

> Estado: Testada · Raia: G · Revisor: C · Branch: `t33-observability`

## O que muda

- `src/infrastructure/observability/logger.ts` — Logger estruturado JSON com AsyncLocalStorage, propagação de correlationId, transactionId, walletId, providerId e sanitização estrita sem quantias monetárias (restrição 5.1).
- `src/infrastructure/observability/metrics.ts` — MetricsRegistry encapsulando `@prometheus-io/client` com registro de todos os contadores, gauges e histogramas de ARQUITETURA §9.
- `src/infrastructure/observability/observability.module.ts` — Módulo global Nest fornecendo e exportando AppLogger e MetricsRegistry.
- `src/interface/http/controllers/metrics.controller.ts` — Controller HTTP expondo `GET /metrics` em formato texto Prometheus.
- `src/interface/http/metrics.module.ts` — Módulo Nest da camada interface registrando MetricsController.
- `test/integration/observability.test.ts` — Testes de integração de aceite I-22 (readiness 503 quando Postgres/SQS falham e exportação de métricas) e I-23 (logger JSON com ALS e restrição 5.1).

## Por quê

- **ARQUITETURA §9, D29, D30:** Registro de métricas Prometheus com `@prometheus-io/client` em `GET /metrics` e log estruturado em linhas JSON com contexto assíncrono via `AsyncLocalStorage`.
- **ARQUITETURA §6.3:** `/health/ready` responde 200 com dependências ativas e 503 quando alguma falha (PostgreSQL ou SQS).
- **CHALLENGE §5 restrição 5.1 e TESTES I-23:** Dinheiro nunca vaza em logs (`amount`, `balance`, `balanceBefore`, `balanceAfter`, `money` são omitidos ou redigidos de mensagens e metadados).
- **TESTES §4.2 I-22 e I-23:** Suíte de integração cobrindo readiness probe, registry de métricas, controller HTTP e logger isolado em fluxos assíncronos concorrentes.

## Abordagem

- Arquivos que vou tocar:
  - `src/infrastructure/observability/logger.ts`
  - `src/infrastructure/observability/metrics.ts`
  - `src/infrastructure/observability/observability.module.ts`
  - `src/interface/http/controllers/metrics.controller.ts`
  - `src/interface/http/metrics.module.ts`
  - `test/integration/observability.test.ts`
  - `docs/notas/T33-observability.md`
- Assinaturas públicas:
  - `AppLogger` (`log`, `error`, `warn`, `debug`, `verbose`, `setWriter`)
  - `runWithLogContext`, `getLogContext`, `updateLogContext`, `sanitizeLogData`
  - `MetricsRegistry` (`getMetrics`, `getContentType`, `reset`, instâncias tipadas de `Counter<string>`, `Gauge<string>`, `Histogram<string>`)
  - `MetricsController` (`getMetrics` mapeado para `GET /metrics`)
  - `ObservabilityModule`, `MetricsModule`
- Alternativas descartadas e motivo:
  - Injetar métricas em memória proprietárias em vez de Prometheus: descartado pois D30 e I-22 exigem formato padrão Prometheus com `@prometheus-io/client`.
  - Usar `AsyncLocalStorage` para controle transacional: descartado pois D25 proíbe explicitamente ALS para transação SQL (Unit of Work explícita); ALS é restrito a logs e contexto de rastreabilidade.

**Aprovação do humano:** aprovada

## Ordem de leitura do diff

1. `src/infrastructure/observability/logger.ts` — ALS, sanitização estrita de quantias monetárias e AppLogger estruturado.
2. `src/infrastructure/observability/metrics.ts` — MetricsRegistry com todas as métricas obrigatórias de ARQUITETURA §9.
3. `src/infrastructure/observability/observability.module.ts` — Provedores globais do Nest para observabilidade.
4. `src/interface/http/controllers/metrics.controller.ts` e `src/interface/http/metrics.module.ts` — Rota `GET /metrics`.
5. `test/integration/observability.test.ts` — Testes de integração de aceite I-22 e I-23.

## Como verificar

```bash
bun run tarefa:gate
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM, `package.json`) que o humano aplica no merge.

- Em `src/app.module.ts`: importar `ObservabilityModule` (de `./infrastructure/observability/observability.module`) e `MetricsModule` (de `./interface/http/metrics.module`) no array `imports`.

## Fora de escopo / dívida

- (nenhum)

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
