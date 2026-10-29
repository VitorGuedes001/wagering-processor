# T32 — Harness de concorrência 🔒

> Estado: Testada · Raia: C · Revisor: G · Branch: `t32-harness`

## O que muda

- `src/main.ts` — extrai e anuncia a porta real atribuída no log de boot (`address.port`) quando `PORT=0` (TESTES §6, ARQUITETURA §12).
- `src/infrastructure/fault-injector.ts` — define `FaultInjector` com `hit(point)` que finaliza o processo com `SIGKILL` quando `process.env.FAULT_POINT === point` (TESTES D38, §3.4, §6).
- `src/infrastructure/persistence/unit-of-work.ts` — invoca `FaultInjector.hit('uow.before-commit')` antes do commit da transação na `MikroOrmUnitOfWork.run` (TESTES §3.4, §4.2 I-04).
- `test/support/fault-injector.ts` — exporta `FaultInjector` e constantes `FaultPoint` para uso em testes.
- `test/support/app-process.ts` — implementa `spawnApp(options)` e `spawnCluster(count, options)` gerenciando instâncias reais da aplicação via `Bun.spawn`, extração de porta dos logs, espera por `/health/ready`, client round-robin e encerramento (TESTES D36, §3.2).
- `test/support/lock-gate.ts` — implementa `holdWalletLock(db, walletId)` segurando `FOR UPDATE` em conexão dedicada e inspecionando `wait_event_type = 'Lock'` em `pg_stat_activity` com `waitForWaiters(n)` e `release()` (TESTES D37, §3.3).
- `test/support/http.ts` — helper HTTP para submeter wagers e criar wallets com `Idempotency-Key` e `X-Correlation-Id` contra instâncias isoladas ou cluster round-robin (TESTES §3).
- `test/support/uow-fault-worker.ts` — script executado em processo isolado pelo I-04 para exercitar `uow.run` com inserções em todas as 5 entidades e interrupção por `uow.before-commit`.
- `test/integration/fault-injection.test.ts` — teste I-04 provando que `FAULT_POINT=uow.before-commit` em processo isolado não persiste nenhuma linha em nenhuma das 5 tabelas (atomicidade total).
- `test/concurrency/concurrency.test.ts` — implementa os cenários C-01 (50x mesma BET paralela em 3 instâncias com e sem portão), C-02 (2 BETs concorrentes com portão e saldo 100), C-02b (100 BETs concorrentes de 15 com saldo 1000) e C-03 (20 wallets com lock em 1 wallet só provando que o lock não é global), com verificação de invariantes financeiras e relato de prontidão de rotas.
- `test/concurrency/harness.test.ts` — testes de unidade e integração dos componentes do harness (`spawnApp`, `spawnCluster`, `holdWalletLock`, `FaultInjector`).

## Por quê

- **TESTES D36, §3.2:** Concorrência real com múltiplos processos da aplicação (`Bun.spawn`), portas isoladas via `PORT=0`, espera determinística por `/health/ready` e distribuição round-robin.
- **TESTES D37, §3.3:** Forçar contenção determinística de concorrência com portão de lock (`SELECT ... FOR UPDATE` + `pg_stat_activity` esperando bloqueados), sem depender do escalonador do SO.
- **TESTES D38, §3.4, §4.2 (I-04):** Ponto de falha nomeado `uow.before-commit` para provar atomicidade do Unit of Work sob morte do processo (`SIGKILL`).
- **TESTES §4.3 (C-01, C-02, C-02b, C-03) e CHALLENGE §5 / §13:** Exercitar e verificar a integridade sob disputa pesada de lock de wallet, replay idempotente de 50 requisições simultâneas e ausência de lock global.

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

- **Arquivos que vou tocar:**
  - `src/main.ts`
  - `src/infrastructure/fault-injector.ts`
  - `src/infrastructure/persistence/unit-of-work.ts`
  - `test/support/fault-injector.ts`
  - `test/support/app-process.ts`
  - `test/support/lock-gate.ts`
  - `test/support/http.ts`
  - `test/support/uow-fault-worker.ts`
  - `test/integration/fault-injection.test.ts`
  - `test/concurrency/concurrency.test.ts`
  - `test/concurrency/harness.test.ts`
  - `docs/notas/T32-harness.md`

- **Assinaturas públicas:**
  - `spawnApp(options?: AppProcessOptions): Promise<AppProcess>`
  - `spawnCluster(count: number, options?: AppProcessOptions): Promise<AppCluster>`
  - `holdWalletLock(db: TestDatabase, walletId: string): Promise<WalletLockGate>`
  - `FaultInjector.hit(point: FaultPointName): void`
  - `postTransaction(target: string | AppCluster, payload: unknown, options?: HttpRequestOptions): Promise<HttpResponse>`
  - `createWallet(target: string | AppCluster, payload: unknown, options?: HttpRequestOptions): Promise<HttpResponse>`

- **Alternativas descartadas e motivo:**
  - Mockar o processo ou usar supertest em memória para C-01..C-03: descartado por violação direta de TESTES D36 e CHALLENGE §14 ("Postgres e SQS reais", "processos reais com Bun.spawn").
  - Usar sleeps para esperar os bloqueios de lock: descartado por TESTES D39 (nada de sleep; espera via polling em `pg_stat_activity` até `waitForWaiters`).
  - Lock global ou em nível de aplicação: descartado por CHALLENGE restrição 6 (o lock é estritamente por wallet).

**Aprovação do humano:** Aprovado via diretiva do usuário para tarefas bloqueadas (documentar Abordagem e prosseguir com a implementação).

## Ordem de leitura do diff

1. `src/infrastructure/fault-injector.ts` — implementação do injetor de falhas com `SIGKILL`.
2. `src/infrastructure/persistence/unit-of-work.ts` — gatilho `uow.before-commit` no UoW.
3. `src/main.ts` — anúncio da porta real quando `PORT=0`.
4. `test/support/app-process.ts` — spawn de processos únicos e clusters com readiness e round-robin.
5. `test/support/lock-gate.ts` — portão de lock com conexão dedicada e verificação em `pg_stat_activity`.
6. `test/support/http.ts` — cliente HTTP fino para os testes de concorrência.
7. `test/integration/fault-injection.test.ts` — teste I-04 (atomicidade em `uow.before-commit`).
8. `test/concurrency/harness.test.ts` — validação dos componentes do harness.
9. `test/concurrency/concurrency.test.ts` — cenários C-01, C-02, C-02b e C-03.

## Como verificar

```bash
bun run tarefa:gate
bun run typecheck
bun test test/integration/fault-injection.test.ts
bun test test/concurrency
```

- `bun run tarefa:gate` passa 100% verde (typecheck, skills, unidade, arquitetura, integração e concorrência).
- I-04 passa comprovando rollback atômico na interrupção por `SIGKILL` antes do commit da UoW.
- Componentes do harness (`spawnApp`, `spawnCluster`, `holdWalletLock`, `FaultInjector`) testados e validados contra instâncias reais em portas efêmeras e `pg_stat_activity`.

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
