# T52 — Métricas do caminho HTTP

> Estado: Testada · Raia: C · Revisor: — (sem revisão cruzada, a pedido do humano) · Branch: `t52-http-metrics`

## O que muda

- `src/interface/http/http-metrics.middleware.ts` (novo): conta
  `wagering_http_requests_total` e `wagering_http_request_duration_seconds` por
  método, rota casada e status, no `finish` da resposta. Requisição sem rota
  ganha o rótulo `unmatched`.
- `src/interface/wagering.module.ts`: registra o middleware junto do
  `CorrelationIdMiddleware`.
- `src/interface/http/wagering.controller.ts`: depois da submissão, conta
  `transactions_total{kind,status}`, `transactions_rejected_total{reason}`,
  `duplicates_total{source="http"}` no replay e
  `processing_duration_seconds{entry="http"}`. A contagem é a mesma do consumidor SQS.
- `src/interface/http/error-mapping.ts`: o `HttpErrorFilter` passa a ser
  `@Injectable` e conta `lock_conflicts_total` quando o 503 vem de lock.
- `src/infrastructure/persistence/db-errors.ts`: `isLockConflict(error)` diz se
  a `TransientInfrastructureError` veio de `55P03` (lock_timeout) ou `40P01`
  (deadlock), lendo o SQLSTATE da causa.
- `test/integration/http-metrics.test.ts` (novo): 5 testes com Postgres real,
  inclusive C-11 com portão de lock.
- `docs/EXECUCAO.md`: linha da T52 na onda 5 (briefing).

## Por quê

- ARQUITETURA 9 lista `transactions_total`, `duplicates_total{source=http|inbox}`,
  `lock_conflicts_total` e `processing_duration_seconds{entry}`. Até aqui só o
  consumidor SQS e os workers alimentavam essas métricas, e uma transação enviada
  por HTTP não aparecia em nenhuma.
- TESTES C-11 espera que `lock_conflicts_total` suba no 503. Ninguém
  incrementava esse contador, e o teste de observabilidade (I-22) só o
  incrementa direto no registry.
- Os registros de `http_requests_total` e `http_request_duration_seconds`
  existiam desde a T33 sem que nada os alimentasse.
- Encontrado no roteiro de teste manual (N10), rodando 3 instâncias.

## Abordagem

Tarefa criada e executada a pedido do humano, sem revisão cruzada.

- A porta `ports.ts` não muda (AGENTS regra 4). A distinção de lock lê
  `cause.code` da `TransientInfrastructureError` numa função da infraestrutura,
  sem tipo novo na aplicação. É o que D69 deixou como dívida, mas só para o HTTP.
- As injeções de `MetricsRegistry` são `@Optional()`, porque módulos de teste
  existentes (ex.: o 503 de I-08 em `http-endpoints.test.ts`) montam o
  controller sem o `ObservabilityModule`. Sem registry, nada é contado.
- O rótulo `path` usa a rota casada (`/wallets/:id`), não a URL, para não criar
  uma série por wallet.
- Alternativa descartada: contar o lock no controller com `try/catch`. O filtro
  cobre todas as rotas com um ponto só.

**Aprovação do humano:** pedido direto ("crie uma nova tarefa… e execute você mesmo sem revisão cruzada").

## Ordem de leitura do diff

1. `src/infrastructure/persistence/db-errors.ts`: `isLockConflict`.
2. `src/interface/http/error-mapping.ts`: o incremento no ramo 503.
3. `src/interface/http/wagering.controller.ts`: `countOutcome`, igual ao do consumidor.
4. `src/interface/http/http-metrics.middleware.ts` e o registro no módulo.
5. `test/integration/http-metrics.test.ts`.

## Como verificar

```bash
bun test ./test/integration/http-metrics.test.ts
bun run test:all
```

Manual: no roteiro N10, depois de um BET via HTTP, `metricas 3001` mostra
`wagering_transactions_total{kind="BET",status="PROCESSED"}` e
`wagering_http_requests_total{...}`. No N3, o 503 faz `wagering_lock_conflicts_total` subir.

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

- Adicionar a linha da T52 em `docs/TAREFAS.md` (só o humano edita o quadro):
  `| T52 Métricas do caminho HTTP | 5 | C | T33, T31 | Testada | t52-http-metrics | — | notas/T52-http-metrics.md |`
- Avaliar se C-11 ganha o teste desta tarefa como prova em TESTES.

## Fora de escopo / dívida

- O consumidor SQS e o worker de referências continuam sem
  `lock_conflicts_total` (D69). O consumidor poderia usar o mesmo `isLockConflict`.
- `wagering_reconciliation_inconsistencies_total` continua registrada e sem uso:
  a reconciliação usa `wagering_reconciliation_mismatch_total` (D73).
- Logs por transação: hoje só warn/error do consumidor trazem ids. O N10 do
  roteiro manual esperava mais.

## Revisão cruzada

Dispensada pelo humano nesta tarefa.

Veredito: —
