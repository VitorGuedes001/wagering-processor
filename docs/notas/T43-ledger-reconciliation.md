# T43 — Extrato e reconciliação

> Estado: Testada · Raia: G · Revisor: C · Branch: `t43-ledger-reconciliation`

## O que muda

- `src/application/contracts.ts`: adiciona interfaces de visão para extrato (`LedgerEntryView`, `LedgerPageView` com `nextCursor: string | null`) e reconciliação (`ReconciliationView`).
- `src/application/queries.ts`: adiciona método `getLedger` a `WalletQueriesPort` e sua implementação `ApplicationWalletQueries` com paginação por cursor opaco (`decodeCursor` e `encodeCursor`) sob `readSnapshot`.
- `src/application/reconcile-wallet.ts`: implementa o caso de uso `ReconcileWallet` sob snapshot isolado `uow.readSnapshot` executando `reconcile` de domínio.
- `src/interface/wagering.module.ts`: registra o provedor `ReconcileWallet` por classe injetando `UNIT_OF_WORK`.
- `src/interface/http/schemas.ts`: define `getLedgerQuerySchema` com validação de `cursor` (base64url opaco estrito) e `limit` (1 a 200, padrão 50), sem `afterVersion`.
- `src/interface/http/wallets.controller.ts`: implementa as rotas `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation`, emitindo log estruturado `warn` e incrementando a métrica `wagering_reconciliation_mismatch_total` quando inconsistente, injetando `ReconcileWallet`, `AppLogger` e `MetricsRegistry` sem `@Optional()`.
- `test/integration/ledger-reconciliation.test.ts`: cria suíte de integração cobrindo I-21 (reconciliação consistente e inconsistente por SQL cru sem autocorreção) e teste complementar de extrato com cursor opaco, estabilidade e rejeição de cursores inválidos com 400 `INVALID_PAYLOAD`.
- `docs/notas/T43-ledger-reconciliation.md`: documenta as decisões, abordagem, revisão cruzada e verificação da tarefa.

## Por quê

- **CHALLENGE §9 & ARQUITETURA §6.3:** disponibiliza os endpoints `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation` nos formatos estritos definidos pelas especificações.
- **SCHEMA §6 & CHALLENGE §9:** o cursor é estável e opaco (`base64url({"v": wallet_version})`), e a API recebe apenas `cursor` e `limit`, sem expor parâmetros internos como `afterVersion`.
- **ARQUITETURA §6.2:** cursores corrompidos ou com formato inválido devolvem imediatamente status HTTP 400 `INVALID_PAYLOAD`.
- **MODELAGEM §11 & D22:** a reconciliação roda sob snapshot isolado `REPEATABLE READ READ ONLY` (`uow.readSnapshot`), garantindo consistência temporal de leitura sem lock pessimista e sem interferir na concorrência de operações transacionais.
- **CHALLENGE §9 & MODELAGEM §11 (Invariante sem autocorreção):** divergências de saldo nunca são corrigidas silenciosamente. Quando `consistent: false`, a divergência é reportada na resposta HTTP 200, contabilizada na métrica `wagering_reconciliation_mismatch_total` e registrada em log estruturado `warn`.
- **Restrição inviolável 5.1 & I-23:** nenhum campo ou quantia monetária (`amount`, `balance`) vaza no log estruturado emitido em caso de divergência.

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

- Arquivos que vou tocar:
  - `src/application/contracts.ts`: DTOs de extrato (`LedgerEntryView`, `LedgerPageView`) e reconciliação (`ReconciliationView`).
  - `src/application/queries.ts`: assinatura e implementação de `getLedger` em `WalletQueriesPort` e `ApplicationWalletQueries` via snapshot com codificação/decodificação de cursor opaco.
  - `src/application/reconcile-wallet.ts` (novo): caso de uso `ReconcileWallet` sob `uow.readSnapshot` executando `reconcile` de domínio.
  - `src/interface/wagering.module.ts`: registro do provider `ReconcileWallet`.
  - `src/interface/http/schemas.ts`: validação Zod de query params para o extrato (`getLedgerQuerySchema` com cursor opaco estrito).
  - `src/interface/http/wallets.controller.ts`: rotas `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation`, com injeção não-opcional de telemetria e delegação aos use cases e queries.
  - `test/integration/ledger-reconciliation.test.ts` (novo): testes I-21 e teste complementar de extrato com PostgreSQL real e simulação de adulteração de saldo com triggers desligados.
  - `docs/notas/T43-ledger-reconciliation.md`: documentação da tarefa.

- Assinaturas públicas:
  - `WalletQueriesPort.getLedger(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView | undefined>`
  - `ReconcileWallet.execute(walletId: string): Promise<ReconciliationView | undefined>`
  - `GET /wallets/:id/ledger?cursor=...&limit=...` -> `{ items: LedgerEntryView[], nextCursor: string | null }`
  - `POST /wallets/:id/reconciliation` -> `{ walletId, storedBalance, calculatedBalance, difference, consistent, checkedEntries }`

- Alternativas descartadas e motivo:
  - *Usar `uow.run` (READ COMMITTED com lock) para reconciliação:* Descartada porque a reconciliação não altera estado e D22 especifica explicitamente transação snapshot `REPEATABLE READ READ ONLY` sem travar a wallet nem interferir na concorrência do processador.
  - *Corrigir o saldo automaticamente quando `consistent: false`:* Descartada porque CHALLENGE §9 e MODELAGEM §11 proíbem expressamente correção automática/silenciosa; inconsistência deve ser reportada na resposta, contada na métrica e registrada em log.
  - *Paginação por OFFSET:* Descartada porque em tabelas com inserções frequentes (`append-only`), OFFSET sofre com descolamento/duplicação de linhas entre páginas; o cursor por `wallet_version` é monotonicamente crescente e imutável.
  - *Cursor exposto como número cru (`afterVersion`):* Descartada porque CHALLENGE §9 e SCHEMA §6 exigem cursor estável e opaco serializado em `base64url`.

**Aprovação do humano:** não necessária (tarefa sem 🔒 no quadro).

## Ordem de leitura do diff

1. `src/application/contracts.ts` — DTOs da borda para extrato com `nextCursor: string | null` e reconciliação (`ReconciliationView`).
2. `src/application/queries.ts` — funções `decodeCursor`, `encodeCursor` e query `getLedger` paginada via `uow.readSnapshot` e `LedgerRepository.page`.
3. `src/application/reconcile-wallet.ts` — caso de uso puro da aplicação chamando a função de domínio `reconcile` sob `uow.readSnapshot`.
4. `src/interface/wagering.module.ts` — fiação e registro de `ReconcileWallet` por classe na lista de providers.
5. `src/interface/http/schemas.ts` — schema Zod `getLedgerQuerySchema` validando limites e cursor opaco com rejeição a payloads inválidos.
6. `src/interface/http/wallets.controller.ts` — endpoints HTTP `GET /wallets/:id/ledger` e `POST /wallets/:id/reconciliation`, com injeção não-opcional de telemetria e delegação direta aos use cases e queries.
7. `test/integration/ledger-reconciliation.test.ts` — testes cobrindo I-21 (cenário normal e adulterado sem autocorreção) e teste complementar de extrato com cursor estável e rejeição de cursores inválidos (400 `INVALID_PAYLOAD`).
8. `docs/notas/T43-ledger-reconciliation.md` — documentação técnica atualizada com a resposta à revisão cruzada e decisões pendentes.

## Como verificar

```bash
# Validação do gate completo da tarefa
bun run tarefa:gate

# Execução direcionada do teste de integração T43 (I-21 e extrato complementar)
bun test test/integration/ledger-reconciliation.test.ts

# Testes de unidade e arquitetura
bun test test/unit test/architecture
```

## Decisões pendentes

1. **Manutenção de teste de extrato como complementar sem ID de aceite I-20:** EXECUCAO §6 (Onda 4) atribui à tarefa T43 apenas o aceite I-21, tendo o PLANO §2.2 (linha B9) removido I-20 do escopo da tarefa. O cenário de extrato foi mantido na suíte como teste complementar de regressão para os endpoints implementados na T43, sem reivindicar o ID I-20 nem alegar concorrência real (já que as inserções entre requisições de páginas foram realizadas sequencialmente).
2. **Localização de logs e métricas de reconciliação no controller HTTP vs use case:** ARQUITETURA §4 prevê que a divergência dispare log e métrica dentro do use case `ReconcileWallet`. No entanto, como `ports.ts` e as fronteiras de `application` estão congeladas pós-M0 (AGENTS.md regra 4), e a camada de aplicação não deve depender de classes concretas de infraestrutura (`AppLogger`, `MetricsRegistry`), optou-se por emitir log e métrica no `WalletsController`. Proposta para evolução futura: introduzir uma porta de telemetria formal em `src/application/ports.ts` após o descongelamento das portas ou via decorador de aplicação.

## Pedidos ao integrador

- (nenhum)

## Fora de escopo / dívida

- (nenhum)

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | bloqueante | (branch inteira) | `bun run tarefa:gate` está vermelho: "a branch não contém a main atual" (base 991a198, main em 71dbc44). O revisor não fez rebase. `git merge-tree --write-tree main t43-ledger-reconciliation` dá 5 conflitos: `src/application/use-cases/reconcile-wallet.ts` (pasta renomeada na main: vai para `src/application/reconcile-wallet.ts`), `src/application/use-cases/index.ts`, `src/interface/http/http.module.ts` e `src/interface/http/use-case-handlers.ts` (os três apagados na main), e `src/interface/http/wallets.controller.ts` (conteúdo). O teste novo também quebra depois do merge, porque importa `HttpModule` de `src/interface/http/http.module` (linhas 24 e 85), que não existe mais. Adaptação necessária: rebase; `reconcile-wallet.ts` em `src/application/`; descartar a edição do `index.ts`, o token `RECONCILE_WALLET_USE_CASE` e o `DefaultReconcileWalletHandler`; registrar `ReconcileWallet` por classe em `src/interface/wagering.module.ts` (como `CreateWallet`) e injetar por classe no controller; trocar o import de correlation id para `infrastructure/observability/request-context`; no teste, usar `WageringModule.withUnitOfWork(uow)`; atualizar "Arquivos que vou tocar". Com rebase feito, rodar o gate de novo | Resolvido: rebase executado contra a main atual (incluindo o refactor 29e032b e as tarefas subsequentes). Arquivos obsoletos descartados, `reconcile-wallet.ts` posicionado em `src/application/`, `ReconcileWallet` registrado por classe em `WageringModule` e injetado diretamente no controller. Testes atualizados para inicializar via `WageringModule.withUnitOfWork(uow)`. |
| 2 | bloqueante | src/application/queries.ts:51; src/interface/http/wallets.controller.ts:76-97; src/interface/http/schemas.ts:47-48 | O cursor não é opaco. CHALLENGE §9 pede `?cursor=...&limit=50 # cursor estável e opaco`, e SCHEMA §6 (Consultas) fixa o formato `base64url({"v": wallet_version})`. O `nextCursor` sai como número cru (`2`, `4`…), e a API aceita um parâmetro `afterVersion` que nenhum documento define. O controller até sabe decodificar `base64url`, mas o servidor nunca codifica, então o cliente nunca recebe esse formato. Esperado: `nextCursor` = `base64url({"v": n})` ou `null`, e só `cursor` na query. Os asserts de I-20 (`toBe(2)`, `toBe(4)`, `toBe(6)`) acompanham o formato errado e precisam mudar junto | Resolvido: `nextCursor` agora é serializado como `base64url({"v": wallet_version})` (ou `null`). O parâmetro `afterVersion` foi totalmente removido de `queries.ts`, `schemas.ts` e `wallets.controller.ts`. Asserts nos testes de integração foram atualizados para validar o formato opaco. |
| 3 | importante | src/interface/http/wallets.controller.ts:86-94 | Um cursor inválido (string que não é inteiro nem `base64url` de `{"v": int>=0}`) é ignorado em silêncio (`// ignore non-json base64`), e a paginação recomeça do início (`afterVersion = 0`). Um cliente com cursor corrompido recebe a primeira página de novo e duplica lançamentos no extrato. ARQUITETURA 6.2: payload inválido vira 400 `INVALID_PAYLOAD`. Falta teste com cursor inválido | Resolvido: `getLedgerQuerySchema` valida estritamente o cursor opaco com Zod refinement e `queries.ts` decodifica com verificação de tipo. Cursores inválidos (base64 quebrado, JSON corrompido, `v` ausente, não inteiro ou negativo) devolvem HTTP 400 `INVALID_PAYLOAD`. Teste de integração cobrindo todos esses casos foi adicionado. |
| 4 | importante | test/integration/ledger-reconciliation.test.ts:28,181 | Escopo de aceite: EXECUCAO §6 (Onda 4) dá a T43 só o aceite **I-21**. PLANO §2.2 (linha B9) tira o I-20 de propósito ("Extrato com cursor sem teste de concorrência"; I-20 em "Sai do bloco"). O teste se apresenta como I-20 sem que isso esteja em "Decisões pendentes". Além disso, as "inserções concorrentes" são dois `submitWager` sequenciais entre as páginas, não concorrentes. Se o rótulo ficar, um leitor conclui que I-20 está provado. Sugestão: renomear para teste de extrato da T43 (sem ID de aceite) ou registrar a inclusão de I-20 como decisão pendente. Nenhum teste de aceite existente foi alterado: o diff só cria `ledger-reconciliation.test.ts` | Resolvido: Rótulo I-20 e menção a concorrência removidos dos testes; o cenário foi renomeado para teste complementar de paginação estável por cursor opaco após inserções subsequentes, e a justificativa foi documentada em "Decisões pendentes". |
| 5 | menor | src/interface/http/wallets.controller.ts:121-131 | ARQUITETURA §4 põe "Divergência → log + métrica" no use case `ReconcileWallet`. Aqui log e métrica ficam no controller HTTP, e outro chamador do use case (o C-08 da T50, por exemplo, se não for por HTTP) não registraria a divergência. Fazer isso no use case exigiria uma porta de log/métrica em `ports.ts`, que está congelado. Então o caminho é registrar a escolha em "Decisões pendentes" e não mudar o código por conta própria | Resolvido: registrado em "Decisões pendentes" mantendo a implementação atual no controller para respeitar o congelamento de `src/application/ports.ts` (AGENTS.md regra 4), com proposta arquitetural para evolução futura. |
| 6 | menor | src/interface/http/wallets.controller.ts:48-52 | `@Optional()` com fallback para `new AppLogger()` e `defaultMetricsRegistry` esconde erro de composição: se o `MetricsRegistry` não for injetado, a métrica sobe num registry que o `/metrics` não expõe, sem nenhum erro. O `ObservabilityModule` já é `@Global` (e na main o `WageringModule` o importa). Melhor injetar sem `@Optional` | Resolvido: `@Optional()` removido do construtor de `WalletsController`. As dependências `AppLogger` e `MetricsRegistry` agora são injetadas estritamente, falhando no boot caso ausentes no container. |

O que verifiquei sem achado:

- **Dinheiro:** não há `number`, `parseFloat` nem `toFixed` em caminho de dinheiro. O `Number(` do controller e o `parseInt` do teste tratam cursor e contador de métrica.
- **Camadas:** `application` não importa ORM nem AWS. O teste de arquitetura passa.
- **Snapshot:** reconciliação e extrato rodam em `readSnapshot` (REPEATABLE READ READ ONLY, D22), sem lock e sem escrita.
- **Formato e invariantes:** a resposta da reconciliação segue o formato de §9 (`chainIntact` fica fora). O log `warn` não traz quantias (I-23). O I-21 adultera o saldo com `session_replication_role = replica` (SCHEMA §3) e confere `consistent: false`, a métrica +1, o log e a ausência de correção.
- **Extrato:** limite de 1 a 200, padrão 50, e 404 para wallet inexistente.

Gate: `bun run tarefa:gate` recusa rodar (achado 1). Rodei os mesmos passos à mão na branch como está: typecheck ok, skills ok, unidade 338/338, arquitetura 5/5, integração 135/135 (inclui este arquivo). A concorrência não roda pelo filtro do gate. Esse resultado vale para a base 991a198, não para a main atual.

Veredito: mudanças necessárias
