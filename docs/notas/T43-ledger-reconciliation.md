# T43 — Extrato e reconciliação

> Estado: Implementada · Raia: G · Revisor: C · Branch: `t43-ledger-reconciliation`

## O que muda

- `src/application/contracts.ts`: adiciona interfaces de visão para extrato (`LedgerEntryView`, `LedgerPageView`) e reconciliação (`ReconciliationView`).
- `src/application/queries.ts`: adiciona método `getLedger` a `WalletQueriesPort` e sua implementação `ApplicationWalletQueries` com paginação por cursor sob `readSnapshot`.
- `src/application/use-cases/reconcile-wallet.ts`: implementa o caso de uso `ReconcileWallet` sob snapshot isolado `uow.readSnapshot` executando `reconcile` de domínio.
- `src/application/use-cases/index.ts`: exporta `ReconcileWallet`.
- `src/interface/http/schemas.ts`: define `getLedgerQuerySchema` com validação de `afterVersion`, `cursor` e `limit` (1 a 200, padrão 50).
- `src/interface/http/use-case-handlers.ts`: adiciona token `RECONCILE_WALLET_USE_CASE`, interface `ReconcileWalletUseCase` e `DefaultReconcileWalletHandler`.
- `src/interface/http/http.module.ts`: registra e exporta o provedor de `RECONCILE_WALLET_USE_CASE`.
- `src/interface/http/wallets.controller.ts`: implementa as rotas `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation`, emitindo log estruturado `warn` e incrementando a métrica `wagering_reconciliation_mismatch_total` quando inconsistente.
- `test/integration/ledger-reconciliation.test.ts`: cria suíte de integração cobrindo I-20 (extrato estável sob inserções concorrentes) e I-21 (reconciliação consistente e inconsistente por SQL cru sem autocorreção).
- `docs/notas/T43-ledger-reconciliation.md`: documenta as decisões, abordagem e verificação da tarefa.

## Por quê

- **CHALLENGE §9 & ARQUITETURA §6.3:** disponibiliza os endpoints `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation` nos formatos estritos definidos pelas especificações.
- **MODELAGEM §11 & D22:** a reconciliação roda sob snapshot isolado `REPEATABLE READ READ ONLY` (`uow.readSnapshot`), garantindo consistência temporal de leitura sem lock pessimista e sem interferir na concorrência de operações transacionais.
- **CHALLENGE §9 & MODELAGEM §11 (Invariante sem autocorreção):** divergências de saldo nunca são corrigidas silenciosamente. Quando `consistent: false`, a divergência é reportada na resposta HTTP 200, contabilizada na métrica `wagering_reconciliation_mismatch_total` e registrada em log estruturado `warn`.
- **Restrição inviolável 5.1 & I-23:** nenhum campo ou quantia monetária (`amount`, `balance`) vaza no log estruturado emitido em caso de divergência.
- **I-20 (Cursor estável):** a paginação por `wallet_version > afterVersion` em tabela append-only é monotonicamente crescente e imutável, permanecendo imune a descolamento de páginas sob inserções concorrentes.

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

- Arquivos que vou tocar:
  - `src/application/contracts.ts`: DTOs de extrato (`LedgerEntryView`, `LedgerPageView`) e reconciliação (`ReconciliationView`).
  - `src/application/queries.ts`: assinatura e implementação de `getLedger` em `WalletQueriesPort` e `ApplicationWalletQueries` via snapshot.
  - `src/application/use-cases/reconcile-wallet.ts` (novo): caso de uso `ReconcileWallet` sob `uow.readSnapshot` executando `reconcile` de domínio.
  - `src/application/use-cases/index.ts`: re-export de `reconcile-wallet`.
  - `src/interface/http/schemas.ts`: validação Zod de query params para o extrato (`getLedgerQuerySchema`).
  - `src/interface/http/use-case-handlers.ts`: token `RECONCILE_WALLET_USE_CASE`, interface e handler padrão delegando ao use case.
  - `src/interface/http/http.module.ts`: registro do provider `RECONCILE_WALLET_USE_CASE`.
  - `src/interface/http/wallets.controller.ts`: rotas `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation`, com emissão de log `warn` estruturado e métrica `wagering_reconciliation_mismatch_total`.
  - `test/integration/ledger-reconciliation.test.ts` (novo): testes I-20 e I-21 com PostgreSQL real e simulação de adulteração de saldo com triggers desligados.
  - `docs/notas/T43-ledger-reconciliation.md`: documentação da tarefa.

- Assinaturas públicas:
  - `WalletQueriesPort.getLedger(walletId: string, afterVersion: number, limit: number): Promise<LedgerPageView | undefined>`
  - `ReconcileWallet.execute(walletId: string): Promise<ReconciliationView | undefined>`
  - `ReconcileWalletUseCase.execute(walletId: string): Promise<ReconciliationView | undefined>`
  - `GET /wallets/:id/ledger?afterVersion=...&limit=...` -> `{ items: LedgerEntryView[], nextCursor: number | null }`
  - `POST /wallets/:id/reconciliation` -> `{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries }`

- Alternativas descartadas e motivo:
  - *Usar `uow.run` (READ COMMITTED com lock) para reconciliação:* Descartada porque a reconciliação não altera estado e D22 especifica explicitamente transação snapshot `REPEATABLE READ READ ONLY` sem travar a wallet nem interferir na concorrência do processador.
  - *Corrigir o saldo automaticamente quando `consistent: false`:* Descartada porque CHALLENGE §9 e MODELAGEM §11 proíbem expressamente correção automática/silenciosa; inconsistência deve ser reportada na resposta, contada na métrica e registrada em log.
  - *Paginação por OFFSET:* Descartada porque em tabelas com inserções frequentes (`append-only`), OFFSET sofre com descolamento/duplicação de linhas entre páginas; o cursor por `wallet_version` é monotonicamente crescente e imutável.

**Aprovação do humano:** não necessária (tarefa sem 🔒 no quadro).

## Ordem de leitura do diff

1. `src/application/contracts.ts` — DTOs da borda para extrato (`LedgerEntryView`, `LedgerPageView`) e reconciliação (`ReconciliationView`).
2. `src/application/queries.ts` — query `getLedger` paginada via `uow.readSnapshot` e `LedgerRepository.page`.
3. `src/application/use-cases/reconcile-wallet.ts` — caso de uso puro da aplicação chamando a função de domínio `reconcile` sob `uow.readSnapshot`.
4. `src/application/use-cases/index.ts` — re-export do caso de uso.
5. `src/interface/http/schemas.ts` — schema Zod `getLedgerQuerySchema` validando limites e cursores.
6. `src/interface/http/use-case-handlers.ts` & `src/interface/http/http.module.ts` — integração do handler e injeção de dependências.
7. `src/interface/http/wallets.controller.ts` — endpoints HTTP `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation`, com tratamento de métricas e logging.
8. `test/integration/ledger-reconciliation.test.ts` — testes de integração cobrindo I-20 e I-21.

## Como verificar

```bash
# Validação do gate completo da tarefa
bun run tarefa:gate

# Execução direcionada do teste de integração T43 (I-20 e I-21)
bun test test/integration/ledger-reconciliation.test.ts

# Testes de unidade e arquitetura
bun test test/unit test/architecture
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

- (nenhum)

## Fora de escopo / dívida

- (nenhum)

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
