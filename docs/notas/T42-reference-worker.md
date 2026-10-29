# T42 — Worker de referências

> Estado: Testada · Raia: C · Revisor: G · Branch: `t42-reference-worker`

## O que muda

| Arquivo | O quê |
|---|---|
| `src/application/resolve-pending-references.ts` | novo use case `ResolvePendingReferences`, com `claim()` por lease e `resolve(id)` em uma transação por item |
| `src/application/submit-wager-transaction.ts` | extrai `applyWagerDecision` (tabela de MODELAGEM 5) para o worker reusar, e o teto padrão do backoff passa a 5 min |
| `src/interface/workers/pending-reference.worker.ts` | novo `PendingReferenceWorker`: laço `setTimeout`, desligamento que espera o ciclo, métricas e logs |
| `src/interface/wagering.module.ts` | registra o use case e o worker, passa a política de backoff da config ao submit e ao worker, e `withUnitOfWork` desliga o worker (`ENABLE_REFERENCE_WORKER=false`), como a T40 já faz com o consumidor |
| `src/infrastructure/config.ts` | `REFERENCE_BACKOFF_MAX_MS`, `REFERENCE_BATCH`, `REFERENCE_LEASE_MS` e `referenceBackoffFrom` |
| `docs/ARQUITETURA.md` | §11 registra as variáveis novas |
| `test/integration/reference-worker.test.ts` | I-18 e I-19 |
| `test/concurrency/reference-worker.test.ts` | C-07 (por SQS, pelo consumidor da T40) e C-07b (a) e (b) |

## Por quê

| Regra | Onde no código |
|---|---|
| CHALLENGE §7.1, D2, D11 | referência fora de ordem fica `PENDING_REFERENCE` e é resolvida em segundo plano, com até `REFERENCE_MAX_ATTEMPTS` tentativas e backoff exponencial até 5 min |
| D57 | o retry é contado antes de `decideWager`: são exatamente N tentativas (I-19 verifica isso) |
| SCHEMA 4.5, D18 | claim curto com lease e `SKIP LOCKED`, depois uma transação por item. Se o processo morre, outra instância assume quando o lease vence |
| SCHEMA 4.3, restrições 6 e 7 | lock só da wallet do item, depois relê a pendente `FOR UPDATE`. Saldo só muda sob esse lock |
| MODELAGEM 5 | mesmo caminho de aplicação do submit. Retry não emite evento (C-07: "emitidos uma vez") |
| D1 | duas reversões da mesma `BET` se serializam no lock da wallet, e a segunda vê `alreadyReversed` (C-07b) |
| D43 | uma política de backoff só, vinda de env, para a submissão e o worker |
| D28, D32, ARQUITETURA 7.3 | worker ligado por `ENABLE_REFERENCE_WORKER`, com laço simples que drena no shutdown |
| ARQUITETURA 9, EXECUCAO §6 | métricas do registry da T33, sem valor monetário em label nem em log |
| Restrições 4 e 8 | eventos vão para o outbox na mesma transação. Nenhum estado de correção fica em memória |

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

O briefing (EXECUCAO §6, onda 4) não lista arquivos, então esta seção espera
aprovação antes de qualquer código (AGENTS, regra de escopo 1).

### Dependência estrutural: refactor `fix-estrutura-onda3` (29e032b)

A branch local `fix-estrutura-onda3` (commit 29e032b, **não mergeado**) alinha
`src/` à ARQUITETURA 2.1/11. Ela move os use cases de
`src/application/use-cases/` para `src/application/`, apaga
`use-case-handlers.ts`, troca `HttpModule` e `MetricsModule` por
`src/interface/wagering.module.ts` (controllers, use cases **e workers**, §11),
faz o `PersistenceModule` fornecer `UNIT_OF_WORK`, cria `infrastructure/clock.ts`,
`id-generator.ts`, `config.module.ts` e deixa um ALS só em
`observability/request-context.ts`.

**Lista A (recomendada): o refactor entra na `main` antes da T42.** Os caminhos
seguem a ARQUITETURA 2.1 ao pé da letra, e nenhum arquivo de alto conflito é
tocado.
**Lista B: o refactor não entra.** A estrutura de hoje é mantida, e o registro
do worker passa a depender de `app.module.ts`, que vira pedido ao integrador.

**O humano decide qual das duas.** Até lá eu não codifico.

### Arquivos que vou tocar

Lista A (com o refactor na `main`):

| Arquivo | Novo? | O quê |
|---|---|---|
| `src/application/resolve-pending-references.ts` | novo | use case `ResolvePendingReferences` (ARQUITETURA 4: "1 de claim + 1 por item", SCHEMA 4.5) |
| `src/interface/workers/pending-reference.worker.ts` | novo | laço `setTimeout` preso ao ciclo do Nest (D32), ligado por `ENABLE_REFERENCE_WORKER` (D28). Métricas e logs ficam aqui |
| `src/interface/wagering.module.ts` | edita | registra `ResolvePendingReferences`, `PendingReferenceWorker` e um provider `REFERENCE_BACKOFF` montado da config. Passa esse backoff também para `SubmitWagerTransaction` (D43: os valores vêm de env) |
| `src/application/submit-wager-transaction.ts` | edita | só se a decisão pendente 1 for aprovada: extrai e exporta a aplicação da decisão (tabela de MODELAGEM 5) para o worker reusar |
| `src/infrastructure/config.ts` | edita | só se a decisão pendente 2 for aprovada: `REFERENCE_BATCH`, `REFERENCE_LEASE_MS`, `REFERENCE_BACKOFF_MAX_MS` |
| `test/integration/reference-worker.test.ts` | novo | I-18, I-19 com `spawnApp` (D36), banco e filas próprios (D34/D35), invariantes no `afterEach` (D40) |
| `test/concurrency/reference-worker.test.ts` | novo | C-07 (`spawnCluster(3)`, SQS) e C-07b (portão D37). Arquivo separado de `concurrency.test.ts` para não colidir com T40/T41 |
| `docs/notas/T42-reference-worker.md` | edita | esta nota |

Lista B (sem o refactor): as diferenças são estas.

| Arquivo | Diferença |
|---|---|
| `src/application/use-cases/resolve-pending-references.ts` | no lugar do caminho plano |
| `src/application/use-cases/index.ts` | exporta o novo use case no barrel |
| `src/interface/workers/workers.module.ts` | novo módulo Nest com o use case e o worker, porque não existe `WageringModule`. Precisa ser importado em `app.module.ts` (pedido ao integrador) |
| `src/interface/http/use-case-handlers.ts` | passa o `REFERENCE_BACKOFF` para o `SubmitWagerTransaction` de dentro do `DefaultSubmitWagerHandler` |
| `src/application/use-cases/submit-wager-transaction.ts` | igual à linha da lista A, em outro caminho |

`UNIT_OF_WORK` viria de `interface/http/http.module.ts`, e o relógio e os ids
das classes que hoje estão em `use-case-handlers.ts`. Os demais arquivos são os
mesmos da lista A.

Nenhuma das listas toca `ports.ts` nem assinaturas públicas de `src/domain/`
(regra 4). A porta de que o worker precisa já existe:
`claimDuePendingReferences(now, limit, leaseMs)`, `lockById`, `findById`,
`findByExternalId`, `hasProcessedReversal`, `update`. Testes de aceite já
existentes ficam como estão (regra 5). O I-18 que está em
`use-cases.test.ts` cobre só o 202 da submissão, e o I-18 completo (com o
worker) vai para o arquivo novo.

### Assinaturas públicas

```ts
// src/application/resolve-pending-references.ts
export interface ReferenceWorkerSettings {
  batch: number;        // itens por claim
  leaseMs: number;      // lease do claim (D18)
  backoff: BackoffPolicy; // D11/D43, o mesmo objeto do SubmitWagerTransaction
}

export type ResolveOutcome =
  | { type: 'PROCESSED'; transactionId: string; kind: WagerTransactionKind }
  | { type: 'REJECTED'; transactionId: string; kind: WagerTransactionKind; failureCode: FailureCode }
  | { type: 'STILL_PENDING'; transactionId: string; kind: WagerTransactionKind; attempts: number }
  | { type: 'SKIPPED'; transactionId: string };   // já saiu de PENDING_REFERENCE (outro worker / lease vencido)

export class ResolvePendingReferences {
  constructor(uow: UnitOfWork, clock: Clock, ids: IdGenerator, settings: ReferenceWorkerSettings);
  /** Transação curta própria: só o claim por lease com SKIP LOCKED (SCHEMA 4.5, D18). */
  claim(): Promise<string[]>;
  /** Uma transação por item: lê a pendente, trava a wallet, relê a pendente FOR UPDATE (ordem de SCHEMA 4.3),
   *  confere PENDING_REFERENCE, chama scheduleReferenceRetry ANTES de decideWager (D57) e aplica a decisão
   *  pela tabela de MODELAGEM 5. Retry sem desfecho grava só a transação, sem evento. */
  resolve(transactionId: string): Promise<ResolveOutcome>;
}

// src/interface/workers/pending-reference.worker.ts
@Injectable()
export class PendingReferenceWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(useCase: ResolvePendingReferences, config: AppConfig, metrics: MetricsRegistry, logger: AppLogger);
  onApplicationBootstrap(): void;          // não faz nada se ENABLE_REFERENCE_WORKER=false
  onApplicationShutdown(): Promise<void>;  // para de agendar e espera o tick atual (ARQUITETURA 7.3 passo 4)
  /** Um ciclo: claim e depois resolve item a item. Erro de um item não para os outros: ele fica sob
   *  lease e volta sozinho (D18). Público para teste. */
  tick(): Promise<void>;
}
```

Fluxo de `resolve(id)`, dentro de um único `uow.run`:

1. `findById(id)`, sem lock, só para saber o `walletId`. Se não existe ou não é
   `PENDING_REFERENCE`, devolve `SKIPPED`.
2. `wallets.lockById(walletId)`: o `FOR UPDATE` da wallet vem primeiro (SCHEMA 4.3).
3. `transactions.lockById(id)` e confere de novo se ainda é
   `PENDING_REFERENCE`. Se não for, devolve `SKIPPED`. É o que protege contra
   dois workers e contra lease vencido (SCHEMA 4.5).
4. `scheduleReferenceRetry(now, backoff)` (D57).
5. Busca a referência por `(providerId, referenceExternalTransactionId)` e
   chama `hasProcessedReversal`.
6. `decideWager` e, conforme a decisão:
   - `AWAIT` faz `update` da transação e não emite evento;
   - `REJECT` chama `reject(code, wallet.balance, now)` e emite
     `WagerTransactionRejected`;
   - `APPLY` chama `debit`/`credit` + `markProcessed`, faz `update` da
     transação e da wallet `WHERE version`, insere o lançamento e emite
     `Processed` + `BalanceChanged` (no `LOSS`, só `Processed`).

Métricas do worker, todas do registry da T33:

| Métrica | Quando |
|---|---|
| `wagering_transactions_total{kind,status}` | em `PROCESSED` e `REJECTED` |
| `wagering_transactions_rejected_total{reason=failureCode}` | em `REJECTED` |
| `wagering_retries_total{component="reference_worker"}` | em `STILL_PENDING` e em erro transitório de item (SCHEMA 4.6: `reference_attempts`) |
| `wagering_processing_duration_seconds{entry="reference_worker"}` | por item |

Nenhum valor monetário vira label nem observação (ARQUITETURA 8). Os logs levam
`transactionId`, `walletId`, `providerId`, `kind`, status e código, sem `amount`
nem saldo (ARQUITETURA 9).

Testes:

| ID | O quê |
|---|---|
| I-18 | app com worker ligado (`REFERENCE_POLL_MS=50`, `REFERENCE_BACKOFF_BASE_MS=20`). `REFUND` por HTTP dá 202. A `BET` chega, e `eventually` mostra o `REFUND` `PROCESSED`, com crédito no ledger e `Processed` + `BalanceChanged` no outbox |
| I-19 | `REFERENCE_MAX_ATTEMPTS=3`. Depois das 3 tentativas a transação fica `REJECTED` `REFERENCE_NOT_FOUND`, `reference_attempts = 3`, com `Rejected` no outbox e um único `PendingReference` |
| C-07 | `spawnCluster(3)`. `ROLLBACK` da `WIN` e `REFUND` da `BET` são enviados por SQS antes das referências, e as referências chegam depois. Verifica os dois `PROCESSED`, o saldo final exato e exatamente 1 `PendingReference` por transação no outbox. **Precisa do consumidor da T40**: fica `test.skipIf` até a T40 entrar na `main`, como a T32 fez com C-01..C-03 |
| C-07b | `REFUND` e `ROLLBACK` da mesma `BET`, em paralelo, com portão na wallet. Proponho duas rodadas: (a) a `BET` já existe e as duas reversões chegam por HTTP; (b) as duas chegam antes da `BET`, ficam `PENDING_REFERENCE`, a `BET` chega e o portão segura a wallet enquanto os workers de 3 instâncias disputam. Nas duas, 1 `PROCESSED` e 1 `REJECTED` `REFERENCE_ALREADY_REVERSED` (D1) |

### Alternativas descartadas e motivo

| Alternativa | Por que não |
|---|---|
| Processar todos os itens do claim numa transação só | SCHEMA 4.5 exige uma transação por item. Pior: seguraria várias wallets ao mesmo tempo, e SCHEMA 4.1/4.3 dizem "no máximo uma wallet por transação" (sem deadlock) |
| Travar a transação pendente antes da wallet | inverte a ordem de SCHEMA 4.3 (wallet → pendente) e abre ciclo de deadlock com o caminho HTTP/SQS |
| Reprocessar chamando `SubmitWagerTransaction` de novo | a transação já existe: o passo 2/4 devolveria replay da pendente. A transição é `scheduleReferenceRetry`/`markProcessed`, não `create` (MODELAGEM 4.3) |
| Checar `referenceAttemptsExhausted` antes do retry | dá 11 tentativas, e não as 10 de D11 (D57) |
| Emitir `PendingReference` a cada retry | MODELAGEM 5: retry do worker não emite evento. C-07: "emitidos uma vez" |
| Métricas e logger dentro do use case | `application` não importa `infrastructure` (ARQUITETURA 2), e logger e métricas ficam sem porta (§3). O use case devolve `ResolveOutcome` e o worker instrumenta |
| `@nestjs/schedule` | D32: laço simples com `setTimeout`, que drena no `SIGTERM` |
| Classe-base de worker compartilhada com a T41 | criaria arquivo comum entre duas tarefas em paralelo. D32 pede laços simples, e cada worker tem o seu |
| Alimentar `wagering_pending_reference_age_seconds` | precisaria de uma consulta nova em `WagerTransactionRepository`, e `ports.ts` está congelado (regra 4). Ver decisão pendente 4 |
| C-07/C-07b dentro de `test/concurrency/concurrency.test.ts` | T40/T41 devem mexer no mesmo arquivo (C-05, C-06). Um arquivo próprio também ganha banco e filas próprios (D34/D35) |

### Sobreposição com T40 e T41 (rodam em paralelo)

| Arquivo | Quem mais mexe | Risco |
|---|---|---|
| `src/interface/wagering.module.ts` (lista A) ou `app.module.ts` (lista B) | T40 (consumidor) e T41 (worker de outbox) registram providers no mesmo lugar | conflito textual trivial na lista de providers. Ordem de merge indiferente |
| `src/infrastructure/config.ts` | T41 pode querer envs de outbox. As de T40 já existem | baixo: linhas diferentes do schema zod |
| `src/application/submit-wager-transaction.ts` | T40 chama o use case com `InboxContext` e, para gravar `FAILED`, talvez mexa nele | médio, se a decisão 1 for extrair helper. A alternativa é duplicar (ver decisão 1) |
| `src/infrastructure/fault-injector.ts` | T40/T41 usam pontos existentes | a T42 **não** adiciona ponto de falha: nenhum aceite dela pede um |
| C-07 | depende do consumidor da T40 | `skipIf` até T40 entrar, depois ativa (mesmo padrão da T32) |
| eventos no outbox | T41 os publica | C-07/I-18/I-19 verificam o **outbox** (tabela), não a fila de eventos: não dependem da T41 |

**Aprovação do humano:** aprovada em 2026-10-29 (na conversa): Abordagem aceita como proposta, com a Lista A (refactor 29e032b já na main, 71dbc44) e todas as decisões pendentes 0 a 7 resolvidas conforme as propostas da nota.

### Desvios da Abordagem aprovada

- `applyWagerDecision(tx, idGenerator, input)` recebe `referenceTransactionId`,
  `backoff`, `correlationId` e `causationId` no `input`, e não um
  `eventContext` pronto. Assim a ordem de geração dos ids fica igual à de
  antes: primeiro o evento, depois o lançamento, depois o `BalanceChanged`. O
  refactor é puro.
- Não existe um provider `REFERENCE_BACKOFF` separado. Cada factory do
  `WageringModule` chama `referenceBackoffFrom(config)`, em `config.ts`. A
  política continua sendo uma só, porque é derivada do mesmo `APP_CONFIG`.
- No `WageringModule` e no worker, `APP_CONFIG` é injetado como opcional:
  `http-endpoints.test.ts` e `observability.test.ts` montam o módulo sem
  `ConfigModule`. Sem config, o worker fica desligado e o submit usa o default
  de D11. Não precisei mudar esses testes.
- `docs/ARQUITETURA.md` §11 registra as três variáveis novas, como previa a
  decisão 2. O arquivo não estava na tabela de arquivos.

## Ordem de leitura do diff

1. `src/application/resolve-pending-references.ts`: o fluxo de `resolve`.
   Olhe a ordem leitura sem lock → `wallets.lockById` → `transactions.lockById`
   (SCHEMA 4.3), a dupla checagem de `PENDING_REFERENCE` (SCHEMA 4.5) e o
   `scheduleReferenceRetry` antes de `decideWager` (D57).
2. `src/application/submit-wager-transaction.ts`: o commit
   `refactor(t42): extrai applyWagerDecision` deve ser só um movimento de
   código. No ramo `AWAIT_REFERENCE` com `persist: 'update'`, a função grava e
   não emite evento (MODELAGEM 5). Os retornos antecipados e a inbox ficaram
   intocados (coordenação com a T40). `DEFAULT_REFERENCE_BACKOFF.maxMs` passa a
   300 s (D11).
3. `src/interface/workers/pending-reference.worker.ts`: o laço com
   `setTimeout`, o desligamento (para de agendar e espera o ciclo atual), o
   erro por item que não derruba o ciclo e as métricas de `record`.
4. `src/interface/wagering.module.ts`: a lista de providers, com a mesma
   política de backoff no submit e no use case. Depois do rebase sobre a T40,
   também a config de `withUnitOfWork`, que agora desliga o consumidor **e** o
   worker (D28), para os testes HTTP em processo.
5. `src/infrastructure/config.ts` e `docs/ARQUITETURA.md`: as três variáveis
   novas e `referenceBackoffFrom`.
6. `test/integration/reference-worker.test.ts`: I-18 e I-19. No I-19, veja
   `reference_attempts = REFERENCE_MAX_ATTEMPTS` (D57) e o único
   `PendingReference`.
7. `test/concurrency/reference-worker.test.ts`: o C-07 por SQS (envelope de
   CHALLENGE §10, `MessageGroupId = walletId`), sem `skipIf` desde o rebase, e
   o C-07b (a)/(b) com portão e `REFERENCE_BATCH=1`.

## Como verificar

```bash
bun run tarefa:gate
bun test test/integration/reference-worker.test.ts test/concurrency/reference-worker.test.ts --rerun-each 10
```

Resultado em 2026-10-29, depois do rebase sobre a `main` com a T40
(`63404d9`): gate verde em typecheck, skills, unidade (338), arquitetura (5),
integração (136 pass) e concorrência (12 pass, **0 skip**: o C-07 rodou).
`--rerun-each 10` dos dois arquivos novos deu 50 pass e 0 skip, sem falha.

**C-07:** passa contra o `WagerTransactionConsumer` real, em 3 instâncias.
O envelope de `anSqsEnvelope` passa no `parseEnvelope`
(`wager-transaction.message.ts`): `messageId`, `type` e `occurredAt` ISO, e
`data` com `idempotencyKey`. O `MessageGroupId` é o `walletId`
(ARQUITETURA 7). As duas reversões ficam `PENDING_REFERENCE`, e depois as
duas `PROCESSED`, com saldo final 1000.00 e um único `PendingReference` por
transação.

## Decisões pendentes

Nenhuma aberta. As decisões 0 a 7 abaixo foram aprovadas como propostas e
ficam aqui como registro.

0. **Lista A ou B?** Depende de 29e032b (`fix-estrutura-onda3`) entrar na
   `main`. *Proposta:* integrar o refactor antes e usar a lista A. *Motivo:* a
   ARQUITETURA 2.1/11 já põe os workers em `WageringModule` e os use cases
   planos em `application/`. Pela lista B eu criaria `workers.module.ts` e
   mexeria em `app.module.ts` para depois o refactor desfazer.
1. **Reuso da aplicação da decisão.** Hoje a tabela de MODELAGEM 5 está inline
   em `SubmitWagerTransaction.execute`, com `insert`, e o worker precisa da mesma
   tabela com `update`. *Proposta:* extrair para uma função exportada no mesmo
   arquivo, `applyWagerDecision(tx, { transaction, wallet, reference, decision, now, eventContext, ids, persist: 'insert' | 'update' })`,
   para os dois use cases chamarem. *Motivo:* MODELAGEM 5 diz que HTTP, SQS e
   worker "chamam o mesmo caminho", e duplicar abre divergência. *Custo:* toca
   um arquivo de T30 que a T40 também usa. A alternativa é duplicar o trecho em
   `resolve-pending-references.ts` e deixar o refactor para depois. Os testes de
   T30 seguem como estão nas duas opções.
2. **Batch, lease e teto do backoff do worker.** ARQUITETURA 11 só lista
   `REFERENCE_POLL_MS`, `REFERENCE_MAX_ATTEMPTS` e `REFERENCE_BACKOFF_BASE_MS`.
   *Proposta:* adicionar `REFERENCE_BATCH` (50), `REFERENCE_LEASE_MS` (30000) e
   `REFERENCE_BACKOFF_MAX_MS` (300000) a `config.ts`, e registrar na
   ARQUITETURA 11. *Motivo:* SCHEMA 4.5 diz que reserva "do mesmo jeito" que o
   outbox, que tem `OUTBOX_BATCH`/`OUTBOX_LEASE_MS`; D11 diz "configurável por
   env" e fixa o teto em 5 min. A alternativa sem env é usar constantes no
   worker com esses mesmos valores.
3. **Teto do backoff divergente de D11.** `DEFAULT_REFERENCE_BACKOFF` em
   `submit-wager-transaction.ts` usa `maxMs: 60_000`, e D11 diz "no máximo
   5 min". Hoje o `SubmitWagerTransaction` é montado sem backoff e fica com esse
   default. *Proposta:* o módulo passa a montar um único `REFERENCE_BACKOFF` da
   config e injetá-lo no submit e no worker, e o default vira
   `maxMs: 300_000`. *Motivo:* D43 diz que a política é a mesma e vem de env, e
   com políticas diferentes a primeira tentativa e as seguintes seguiriam regras
   distintas.
4. **`wagering_pending_reference_age_seconds`.** O gauge existe no registry da
   T33, mas não aparece em ARQUITETURA 9, e alimentá-lo pede uma consulta nova
   (`min(created_at)` das `PENDING_REFERENCE`), que não existe em `ports.ts`
   (congelado). *Proposta:* não alimentar na T42 e registrar como dívida.
5. **`correlationId`/`causationId` dos eventos emitidos pelo worker.** MODELAGEM
   8 só define isso para header HTTP e `messageId` da fila, e a transação não
   guarda o `correlationId` original. *Proposta:* `correlationId =
   transaction.id` e `causationId = transaction.idempotencyKey` (MODELAGEM 8
   admite a idempotency key como causa). *Motivo:* é rastreável sem coluna nova
   nem mudança de schema. A alternativa é ler o `correlationId` do evento
   `PendingReference` gravado no outbox, o que pede porta nova.
6. **`wagering_lock_conflicts_total` no worker.** A aplicação só enxerga
   `TransientInfrastructureError`, sem o SQLSTATE (que a infraestrutura
   encapsula em `cause`). *Proposta:* a T42 conta falha transitória de item em
   `wagering_retries_total{component="reference_worker"}` e não alimenta o
   contador de lock. Separar `55P03`/`40P01` exige uma subclasse ou um campo
   novo em `ports.ts` (congelado). Fica para quem fizer C-11.
7. **C-07b com o worker.** A linha de TESTES 4.3 não diz se as reversões estão
   pendentes. *Proposta:* rodar as duas variantes descritas na Abordagem, (a)
   por HTTP e (b) pelo worker. *Motivo:* (a) já é coberto pelo submit da T30;
   só (b) exercita o código da T42.

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- Lista A: nenhum. `wagering.module.ts` não é de alto conflito, mas T40 e T41
  também registram providers nele, e o conflito é textual na lista de providers.
- Lista B: `src/app.module.ts` precisa importar `WorkersModule` de
  `./interface/workers/workers.module`.
- Sem dependência nova: `package.json` e `bun.lock` ficam como estão.
- `mikro-orm.config.ts`: nada.

## Fora de escopo / dívida

- `wagering_pending_reference_age_seconds` não é alimentado (decisão 4):
  precisa de uma consulta nova em `WagerTransactionRepository`.
- `wagering_lock_conflicts_total` não é alimentado pelo worker (decisão 6).
- O rebase sobre a T40 está feito. Conflitou só `wagering.module.ts`, nos
  imports, na lista de providers e em `withUnitOfWork`.
  `submit-wager-transaction.ts` mesclou sem conflito: a extração continua
  refactor puro, e a marcação da inbox nos retornos antecipados da T40 (D65)
  ficou intacta.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

Revisor: Antigravity, 29/10/2026, sobre `316f471` (base `71dbc44`).

**Gate.** `bun run tarefa:gate` executado no worktree `wp-T42`: 100% verde (typecheck, skills, unidade, arquitetura, integração [inclui I-18 e I-19], concorrência [11 pass, 1 skip C-07]).

O que verifiquei sem achado:
- **Escopo:** Os 9 arquivos tocados batem perfeitamente com a Lista A da Abordagem aprovada.
- **Camadas e contratos:** Contratos de `src/domain/` e `src/application/ports.ts` mantidos 100% congelados. O use case `ResolvePendingReferences` foi posicionado em `src/application/` respeitando a convenção consolidada em `29e032b`. O worker em `src/interface/workers/` gerencia apenas o laço de agendamento e ciclo de vida do Nest (D32, ARQUITETURA §7.3).
- **Dinheiro (restrição 5.1):** Preservado estritamente como string nas bordas e BigInt no domínio. Nenhuma operação numérica em dinheiro.
- **Concorrência e isolamento (D18, SCHEMA §4.3, §4.5):** O claim de itens pendentes é feito em transação curta com lease e `FOR UPDATE SKIP LOCKED`. Cada item reclamado é resolvido em sua própria transação, adquirindo `wallets.lockById` primeiro e re-verificando `PENDING_REFERENCE` sob `transactions.lockById`.
- **Serialização de reversões (D1, C-07b):** Duas reversões (`REFUND` e `ROLLBACK`) sobre a mesma `BET` disputando resolução concorrente se serializam corretamente no lock da wallet, com a segunda transição resultando em `REFERENCE_ALREADY_REVERSED`.
- **Decisões:** Decisões 1 a 7 documentadas e justificadas.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | menor | `test/concurrency/reference-worker.test.ts:26-29` | O teste C-07 está condicionado a `skipIf(!CONSUMER_AVAILABLE)`. Como a T40 e a T42 foram desenvolvidas em paralelo, a execução efetiva de C-07 deve ocorrer após o rebase da branch sobre a T40 integrada na `main`. A nota já documenta esta condição na seção "Fora de escopo / dívida". | Resolvido. Rebase sobre a `main` com a T40 (`63404d9`). O `skipIf` saiu e o C-07 roda contra o consumidor real: `test:concurrency` 12 pass, 0 skip; `--rerun-each 10` 50 pass. Envelope e `MessageGroupId` conferidos com `wager-transaction.message.ts` |

Resolução do achado 1 (Claude, após o rebase sobre `63404d9`): o C-07
rodou e passou. O `skipIf` foi removido (`test(t42): ativa o C-07…`), porque
um skip amarrado ao caminho de um arquivo esconderia o teste de aceite em
silêncio se o arquivo mudasse de lugar.

Veredito: aprovado com ressalvas
