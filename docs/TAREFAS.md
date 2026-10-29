# Quadro de tarefas

Fonte da verdade do andamento ([EXECUCAO.md](EXECUCAO.md) §7). **Só o humano
edita este arquivo, na `main`, no momento do merge.** Os scripts
(`bun run tarefa:status`, `bun run tarefa:iniciar`) leem a versão da `main`, não
a do worktree.

- Estados: `Proposta`, `Abordagem`, `Implementada`, `Testada`, `Revisada`,
  `Validada`, `Entregue`.
- Raia: `C` = Claude Code, `G` = Antigravity, `H` = humano. 🔒 = abordagem
  aprovada antes de codar.
- Deps: tarefas que precisam estar `Entregue` para esta começar.
- O briefing de cada tarefa é a linha dela nas tabelas de [EXECUCAO.md](EXECUCAO.md)
  §6, mais os docs citados.

| Tarefa | Onda | Raia | Deps | Estado | Branch | Revisor | Nota |
|---|---|---|---|---|---|---|---|
| T00 Regras, skills e quadro | 0 | H | — | Entregue | — | — | — |
| T01 Contratos 🔒 | 0 | H | T00 | Entregue | t01-contratos | G | notas/T01-contratos.md |
| T10 Money e payloadHash | 1 | C | T01 | Entregue | t10-money | G | notas/T10-money.md |
| T11 Wallet e WalletLedgerEntry | 1 | G | T01 | Entregue | t11-wallet | C | notas/T11-wallet.md |
| T12 WagerTransaction 🔒 | 1 | C | T01 | Entregue | t12-wager-transaction | G | notas/T12-wager-transaction.md |
| T13 Inbox, Outbox e eventos | 1 | G→C | T01 | Entregue | t13-inbox-outbox | G | notas/T13-inbox-outbox.md |
| T14 Migrations e triggers 🔒 | 1 | C | T01 | Entregue | t14-migrations | G | notas/T14-migrations.md |
| T15 Infra de teste e testes de schema | 1 | G | T01 | Entregue | t15-test-infra | C | notas/T15-test-infra.md |
| T16 decideWager e reconcile 🔒 | 1 | G | T10, T11, T12 | Entregue | t16-decide-wager | C | notas/T16-decide-wager.md |
| T20 Unit of Work, wallet e ledger 🔒 | 2 | C | T10, T11, T14, T15 | Entregue | t20-unit-of-work | G | notas/T20-unit-of-work.md |
| T21 Repositório de transações | 2 | G | T12, T14, T15 | Entregue | t21-transaction-repo | C | notas/T21-transaction-repo.md |
| T22 Repositórios de inbox e outbox | 2 | G | T13, T14, T15 | Entregue | t22-inbox-outbox-repo | C | notas/T22-inbox-outbox-repo.md |
| T30 Use cases de wallet e submissão 🔒 | 3 | C | T16, T20, T21, T22 | Entregue | t30-use-cases | G | notas/T30-use-cases.md |
| T31 HTTP | 3 | G | T20, T21, T22 | Entregue | t31-http | C | notas/T31-http.md |
| T32 Harness de concorrência 🔒 | 3 | C | T15 | Entregue | t32-harness | G | notas/T32-harness.md |
| T33 Observabilidade base | 3 | G | T01 | Entregue | t33-observability | C | notas/T33-observability.md |
| T40 Consumidor SQS 🔒 | 4 | C | T22, T30, T33 | Entregue | t40-sqs-consumer | G | notas/T40-sqs-consumer.md |
| T41 Worker de outbox | 4 | G | T22, T33 | Entregue | t41-outbox-worker | C | notas/T41-outbox-worker.md |
| T42 Worker de referências | 4 | C | T30, T33 | Entregue | t42-reference-worker | G | notas/T42-reference-worker.md |
| T43 Extrato e reconciliação | 4 | G | T20, T31 | Entregue | t43-ledger-reconciliation | C | notas/T43-ledger-reconciliation.md |
| T50 Cenários de falha | 5 | C | T32, T40, T41 | Proposta | t50-failure-scenarios | G | — |
| T51 Entrega | 5 | H | T42, T43, T50 | Proposta | t51-entrega | C | — |

A coluna Onda é o planejamento. As Deps dizem quando uma tarefa **pode**
começar, e algumas ficam liberadas antes da onda delas (ex.: T32 e T33). Respeite
o limite de 4 agentes ativos e 3 tarefas esperando revisão (EXECUCAO §6).

## Marcos

| Marco | Fecha quando | Tag | Estado |
|---|---|---|---|
| M0 | T01 | `m0-contratos` | fechado em 28/10/2026 |
| M1 | T10–T13, T16 | `m1-dominio` | fechado em 28/10/2026 |
| M2 | T14, T15 | `m2-schema` | fechado em 28/10/2026 |
| M3 | T20–T22 | `m3-persistencia` | fechado em 28/10/2026 |
| M4 | T30, T31 | `m4-fatia-vertical` | fechado em 29/10/2026 |
| M5 | T32 + C-01, C-02, C-02b, C-03 verdes em `test:stress` | `m5-concorrencia` | fechado em 29/10/2026 |
| M6 | T40, T41 | `m6-mensageria` | — |
| M7 | T42, T43 | `m7-completo` | — |
| M8 | T50, T51 | `v1.0.0` | — |
