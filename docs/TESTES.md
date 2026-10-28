# Passo 7 — Plano de testes e infraestrutura de concorrência

O que testar, em que nível e com que infraestrutura. Os testes de concorrência e
de falha precisam ser **reais e determinísticos**, e esse é o foco deste passo.
`§N` aponta para [CHALLENGE.md](CHALLENGE.md); `Dn` para as decisões dos passos
4 a 6.

Duas regras inegociáveis vêm do enunciado:

- **PostgreSQL e SQS reais** em todo teste que toca persistência ou fila
  (falha eliminatória de §14). Mock só existe no teste de unidade de domínio, e
  lá não há nada a mockar: o domínio é puro.
- **Paralelismo real** (§13): requisições simultâneas contra processos
  separados, não `await` em sequência.

---

## 1. Decisões deste passo

| # | Decisão | Por quê |
|---|---|---|
| D33 | `bun test` como único runner | Restrição de stack (§4) |
| D34 | **Um banco por arquivo de teste**, criado por `CREATE DATABASE … TEMPLATE wagering_template`. O template recebe as migrations uma vez por execução | Isolamento total sem `TRUNCATE`, que o trigger do ledger bloqueia (SCHEMA 3). Clonar levou 419 ms medidos no Postgres local, contando o `docker exec` |
| D35 | **Filas por arquivo de teste**, com prefixo único (`t<id>-wager-transactions.fifo` etc.), criadas com a mesma redrive policy | Mensagem de um teste nunca chega a outro. Os nomes das filas passam a vir de env |
| D36 | Testes de concorrência e falha sobem a **aplicação real** em processos separados (`Bun.spawn`) | "≥ 3 processos/instâncias" (§13.4) e "worker morto" (§13.5) exigem processo de verdade |
| D37 | **Portão de lock** para forçar contenção: o teste trava a wallet numa conexão própria, dispara as requisições, espera todas aparecerem bloqueadas em `pg_stat_activity` e só então solta | Garante que as N transações disputaram o lock de fato. Sem portão, a disputa depende da sorte do agendamento |
| D38 | **Pontos de falha nomeados** (`FAULT_POINT=<nome>`) que encerram o processo com `SIGKILL` num ponto exato | "Morto depois do commit e antes do ack" precisa acontecer exatamente ali, sempre |
| D39 | Nada de `sleep` em teste. Espera é `eventually(condição, timeout)` com polling curto | Sleep é lento quando sobra tempo e flaky quando falta |
| D40 | Invariante `wallet.balance == Σ ledger` (mais a cadeia) checada no `afterEach` de **todo** teste de integração e concorrência, para todas as wallets do banco do arquivo | §13: "invariante final de todos os testes". Com um banco por arquivo, "todas as wallets" é barato |
| D41 | O suite de concorrência roda também com `--rerun-each 10` (`test:stress`) | Teste de corrida que passa uma vez não prova nada. Dez rodadas pegam o flaky antes do avaliador |

## 2. Níveis

| Nível | Pasta | Infra | Alvo | Tempo-alvo |
|---|---|---|---|---|
| Unidade | `test/unit` | nenhuma | domínio puro (MODELAGEM 12) | < 2 s |
| Arquitetura | `test/architecture` | nenhuma | regra de import (ARQUITETURA 2), guarda 5.1 (ARQUITETURA 8) | < 1 s |
| Integração | `test/integration` | Postgres + LocalStack | schema, repositórios, UoW, inbox, outbox, consumidor, workers, contrato HTTP (app em processo) | < 60 s |
| Concorrência e falha | `test/concurrency` | Postgres + LocalStack + 1 a 3 processos da app | os 8 cenários de §13 | < 120 s |
| Carga (opcional) | `test/load` | idem | §14, diferencial | à parte |

### Scripts

| Script | Roda |
|---|---|
| `bun run test` | unidade + arquitetura. Não precisa de Docker |
| `bun run test:integration` | integração |
| `bun run test:concurrency` | concorrência e falha |
| `bun run test:all` | tudo acima, em ordem |
| `bun run test:stress` | concorrência com `--rerun-each 10` |
| `bun run test:load` | carga, se fizer o diferencial |

Os níveis que precisam de infra verificam no preload se Postgres e LocalStack
respondem. Se não respondem, falham com a instrução `bun run infra:up`, em vez
de dar timeout confuso.

## 3. Infraestrutura de teste

```
test/
  support/
    preload.ts         # checa infra, cria/atualiza o template (uma vez por execução)
    database.ts        # createTestDatabase() / dropTestDatabase()
    queues.ts          # createTestQueues(prefix) / deleteTestQueues()
    app-process.ts     # spawnApp(env) / spawnCluster(n, env)
    lock-gate.ts       # holdWalletLock(walletId) → { waitForWaiters(n), release() }
    eventually.ts
    invariants.ts      # assertAllWalletsConsistent(db)
    fixtures.ts        # payloads de CHALLENGE §9/§10 e builders
    http.ts            # cliente fino com Idempotency-Key e X-Correlation-Id
    events.ts          # drena wagering-events, deduplica por eventId
```

### 3.1 Banco por arquivo (D34)

```
preload (uma vez):
  DROP DATABASE IF EXISTS wagering_template
  CREATE DATABASE wagering_template
  migrations up no template, depois fecha todas as conexões nele

beforeAll (por arquivo):
  CREATE DATABASE t_<uuid curto> TEMPLATE wagering_template
afterAll:
  DROP DATABASE t_<…> WITH (FORCE)
```

O teste de migrations (`up → down → up`) usa um banco próprio, não o template.

### 3.2 Processos da aplicação (D36)

```ts
const app = await spawnApp({
  DB_NAME: db.name,
  SQS_INPUT_QUEUE: queues.input, SQS_DLQ: queues.dlq, SQS_EVENTS_QUEUE: queues.events,
  PORT: '0',                 // porta livre, anunciada no log de boot e lida pelo harness
  REFERENCE_POLL_MS: '50', REFERENCE_BACKOFF_BASE_MS: '20',
  OUTBOX_POLL_MS: '50', OUTBOX_LEASE_MS: '1000',
  FAULT_POINT: undefined,
});
// app.url, app.kill('SIGKILL' | 'SIGTERM'), app.exited, app.logs()
```

`spawnApp` espera `/health/ready` responder 200 antes de devolver. `spawnCluster(3)`
sobe três processos contra o mesmo banco e as mesmas filas. O cliente HTTP
distribui as requisições em round-robin entre eles.

Backoffs e leases são reduzidos por env só nos testes. A lógica é a mesma; muda
a escala de tempo.

### 3.3 Portão de lock (D37)

```ts
const gate = await holdWalletLock(walletId);       // BEGIN; SELECT … FOR UPDATE (conexão do teste)
const pending = Promise.all(requests.map(send));  // todas vão bloquear no passo 3 do fluxo
await gate.waitForWaiters(requests.length);         // pg_stat_activity: wait_event_type = 'Lock'
await gate.release();                               // COMMIT
const responses = await pending;
```

Validado no Postgres local: com uma conexão segurando `FOR UPDATE` e três
tentando, `pg_stat_activity` mostrou exatamente 3 com `wait_event_type = 'Lock'`.

O `lock_timeout` de 2 s (D21) precisa ser maior que o tempo do portão. Nos testes
com portão ele sobe para 10 s por env.

Nem todo teste usa o portão. O cenário de 50 requisições idênticas roda **com e
sem** portão: com portão prova o lock, sem portão prova o atalho do passo 2 e os
índices únicos.

### 3.4 Pontos de falha (D38)

Um `FaultInjector` em `infrastructure` com `hit(point)`: se
`process.env.FAULT_POINT === point`, executa `process.kill(process.pid, 'SIGKILL')`.
Fora de teste, a env não existe e o custo é uma comparação de string.

| Ponto | Onde | Cenário |
|---|---|---|
| `consumer.after-commit-before-ack` | consumidor, depois do `COMMIT`, antes do `DeleteMessage` | §13.5 |
| `outbox.after-claim-before-publish` | worker de outbox | lease expira, outra instância publica |
| `outbox.after-publish-before-mark` | worker de outbox | publicação duplicada (§11.5) |
| `http.after-commit-before-response` | use case HTTP | cliente não recebe resposta, reenvia, recebe replay |
| `uow.before-commit` | dentro da transação, depois do outbox | nada persiste (atomicidade, §13) |

No Windows, `SIGKILL` via `Bun.spawn` vira `TerminateProcess`, que dá o mesmo
efeito. `SIGTERM` gracioso **não existe** no Windows: o teste de desligamento
(C10) roda só em Linux (`skipIf(process.platform === 'win32')`), via
`docker compose run` ou no CI.

### 3.5 Invariantes (D40)

`assertAllWalletsConsistent(db)` roda em SQL, independente da aplicação:

1. para cada wallet, `balance = Σ(CREDIT) − Σ(DEBIT)` do ledger;
2. a cadeia `balance_before = lag(balance_after)` não tem buraco;
3. o último `wallet_version` do ledger é igual a `wallet.version`, salvo wallet
   nova com saldo zero;
4. nenhuma transação `REFUND`/`ROLLBACK` `PROCESSED` duplicada por referência;
5. toda transação `PROCESSED` que move saldo tem exatamente um lançamento, e
   nenhuma outra tem.

Ela é independente de propósito: se a aplicação e a invariante compartilhassem
código, um bug nas duas passaria.

## 4. Catálogo

`U` = unidade, `A` = arquitetura, `I` = integração, `C` = concorrência e falha.

### 4.1 Unidade e arquitetura

Os alvos estão em MODELAGEM 12: `Money`, `Wallet`, `WagerTransaction`,
`decideWager` (cada linha e a ordem), `WalletLedgerEntry`, `payloadHash` e
`reconcile`. Somam-se:

| ID | Teste |
|---|---|
| U-01 | `Money.from` com `amount` numérico (`25`) lança `InvalidMoneyError` (5.1) |
| U-02 | `Money` ida e volta string → `bigint` → string para `0.00`, `0.01`, `99999999999999999.99` |
| U-03 | `JSON.stringify` de algo com `bigint` cru lança (garante que nada vaza) |
| U-04 | eventos: `toJSON()` de cada subclasse tem `eventType`/`version` da classe e só `MoneyProps` em `data` |
| U-05 | `OutboxMessage.scheduleRetry` segue `min(2^n, 60) s` com relógio fixo |
| A-01 | `src/domain` não importa Nest, MikroORM, AWS SDK nem zod |
| A-02 | `src/application` não importa MikroORM nem AWS SDK |
| A-03 | guarda 5.1: sem `parseFloat`, `Number(`, `toFixed`, `Math.` em domínio/persistência, e sem `number` em propriedade de dinheiro |

### 4.2 Integração

| ID | Teste | Verifica |
|---|---|---|
| I-01 | migrations `up → down → up` em banco vazio | reversibilidade (§4) |
| I-02 | violação por SQL cru de cada constraint e trigger (SCHEMA 9) | restrição 9 |
| I-03 | repositórios: ida e volta `domínio → record → domínio` de cada entidade, com valores como string | mapeamento e 5.1 |
| I-04 | `FAULT_POINT=uow.before-commit` em processo: nada de wallet, transação, ledger, inbox ou outbox persiste | atomicidade (§11) |
| I-05 | `CreateWallet` com saldo: `OPENING`, lançamento `wallet_version = 1`, dois eventos no outbox. Sem saldo: nada disso | §9 |
| I-06 | HTTP, cada kind: `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK` (`BET`/`WIN`/`REFUND`) com saldo, ledger e eventos esperados | §7 |
| I-07 | HTTP, cada `failureCode` de MODELAGEM 10.1 produzido por um payload real, com 422 e corpo esperado | §7.2 |
| I-08 | contrato de status: cada linha de ARQUITETURA 6.2 | §9 |
| I-09 | replay: mesma requisição duas vezes devolve corpo idêntico e `idempotentReplay: true`, **com o saldo da primeira**, mesmo depois de outras operações. Vale para `PROCESSED`, `REJECTED` e `LOSS` | §7.7, D10 |
| I-10 | mesma key, payload diferente → 409 `IDEMPOTENCY_CONFLICT`. Mesmo id externo, outra key → 409 `EXTERNAL_ID_CONFLICT` | §9, D6 |
| I-11 | `amount: 25` (número) via HTTP → 400. Via SQS → DLQ | 5.1 |
| I-12 | mesma operação via HTTP e depois via SQS → a segunda é replay, sem segundo débito | D24, payloadHash |
| I-13 | inbox: a mesma mensagem enviada 3× (`messageId` igual) → 1 efeito, 3 acks | §10 |
| I-14 | inbox: mesmo `messageId`, payload diferente → DLQ | D7 |
| I-15 | retry e DLQ: mensagem inválida chega à DLQ após 5 recebimentos. Com falha transitória simulada (Postgres pausado com `docker pause`), a mensagem é reprocessada com sucesso depois de `unpause` | §10, §13 |
| I-16 | outbox: evento publicado só depois do commit (com `uow.before-commit`, nada sai). Publicado uma vez no caminho feliz | restrição 4 |
| I-17 | outbox: SQS indisponível (`docker pause` do LocalStack) → `attempts` sobe e o lag cresce. Depois de `unpause`, tudo é publicado | §11 |
| I-18 | `PENDING_REFERENCE`: `REFUND` antes da `BET` → 202. A `BET` chega, o worker processa e o `REFUND` vira `PROCESSED`, com eventos | §7.1 |
| I-19 | `PENDING_REFERENCE` sem a referência: depois de `REFERENCE_MAX_ATTEMPTS`, vira `REJECTED` `REFERENCE_NOT_FOUND`, com evento | §7.1 |
| I-20 | extrato: paginação por cursor estável com inserções concorrentes entre páginas | §9 |
| I-21 | reconciliação consistente. Inconsistente (saldo adulterado por SQL com triggers desligados) → `consistent: false`, log e métrica, sem correção | §9 |
| I-22 | `/health/ready` com Postgres pausado → 503. `/metrics` expõe os contadores de ARQUITETURA 9 | §12 |
| I-23 | logs: uma requisição gera linhas JSON com `correlationId`, `transactionId`, `walletId`, `providerId`, e **sem** `amount` | §12 |

`docker pause`/`unpause` simula indisponibilidade sem perder estado e roda nos
containers do Compose. Esses testes ficam num arquivo próprio e restauram o
container no `finally`.

### 4.3 Concorrência e falha (§13, numeração do enunciado)

| ID | §13 | Montagem | Verificação |
|---|---|---|---|
| C-01 | 1 | wallet 1000.00. A mesma `BET` 10.00 50× em paralelo, distribuída em 3 instâncias. Uma rodada com portão, outra sem | exatamente 1 transação, 1 `DEBIT`, saldo 990.00. 50 respostas com o mesmo `transactionId`, 49 com `idempotentReplay: true` |
| C-02 | 2 | wallet 100.00, duas `BET` 80.00 (ids diferentes) com portão | 1 `PROCESSED`, 1 `REJECTED` `INSUFFICIENT_FUNDS`, saldo 20.00, 1 `DEBIT`. Reenviar as duas → replays, nada muda (§8) |
| C-02b | 2 | wallet 1000.00, 100 `BET`s de 15.00 com portão | exatamente 66 `PROCESSED` e 34 `REJECTED`, saldo 10.00 |
| C-03 | 3 | 20 wallets, 20 `BET`s em cada, em paralelo. Portão em **uma** wallet só | as outras 19 terminam enquanto a travada espera: o lock não é global (restrição 6) |
| C-04 | 4 | `spawnCluster(3)`, 300 operações mistas (`BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`) em 10 wallets, por HTTP **e** SQS ao mesmo tempo | invariantes D40. Cada `externalTransactionId` com no máximo 1 transação. Cada instância processou alguma coisa (pelo log) |
| C-05 | 5 | instância A com `FAULT_POINT=consumer.after-commit-before-ack`, instância B normal. Uma mensagem `BET` | A morre. B recebe a redelivery quando a visibilidade expira e dá ack pela inbox. 1 débito, inbox com 1 linha |
| C-06 | 6 | 1000 eventos no outbox, 2 instâncias só com o worker de outbox | todos publicados, nenhum perdido (conjunto de `eventId` completo). Duplicatas registradas, não falhas |
| C-06b | 6 | instância A com `FAULT_POINT=outbox.after-claim-before-publish` | depois do lease, B publica tudo. Nenhum evento fica preso |
| C-07 | 7 | `ROLLBACK` de uma `WIN` e `REFUND` de uma `BET`, enviados **antes** das referências, por SQS, em 3 instâncias | ambos `PROCESSED` depois que as referências chegam. Saldo final correto. Eventos `PendingReference` emitidos uma vez |
| C-07b | 7 | `REFUND` e `ROLLBACK` da **mesma** `BET`, em paralelo, com portão | um `PROCESSED`, outro `REJECTED` `REFERENCE_ALREADY_REVERSED` (D1) |
| C-08 | 8 | carga contínua em 3 instâncias. `SIGKILL` em duas no meio. Sobe duas novas. Drena as filas | invariantes D40. Reconciliação `consistent: true` em todas as wallets. Toda mensagem enviada tem resultado. Outbox vazio |
| C-09 | — | `http.after-commit-before-response`: o cliente recebe erro de conexão e reenvia para outra instância | replay com o resultado original, 1 efeito |
| C-10 | — | `SIGTERM` com mensagens em andamento (só Linux) | o processo termina dentro do `SHUTDOWN_GRACE_MS`. Mensagens concluídas recebem ack, as não iniciadas voltam à fila. Nenhuma perdida |
| C-11 | — | `lock_timeout`: portão segurando mais que o limite | requisição recebe 503 e `wagering_lock_conflicts_total` sobe. Depois de soltar, o reenvio funciona |

**Determinismo:** os resultados dos cenários são **exatos** (66 e 34, não "por
volta de"). Eles dependem só da ordem de aquisição do lock, que o portão
garante que existiu, e não de qual requisição ganha. Por isso o teste não
verifica *quem* ganhou, só *quantos* ganharam.

## 5. Fixtures

Os JSONs de CHALLENGE §9/§10 ficam em `test/support/fixtures.ts`, como estão.
Builders derivam variações (`aBet({ amount: '80.00' })`, `aRefundOf(bet)`), e os
ids gerados são únicos por teste para não haver colisão de idempotência entre
casos.

## 6. Mudanças que este plano pede ao código

| Mudança | Onde |
|---|---|
| Nomes das filas por env: `SQS_INPUT_QUEUE`, `SQS_DLQ`, `SQS_EVENTS_QUEUE` | config (ARQUITETURA 11) |
| `REFERENCE_BACKOFF_BASE_MS`, `DB_LOCK_TIMEOUT_MS` por env | config |
| `PORT=0` aceito, com a porta real no log de boot | `main.ts` |
| `FaultInjector` com os pontos de 3.4 | `infrastructure` |
| Dockerfile da aplicação (para C-10 e para o Compose) | raiz |

## 7. Fora do plano, de propósito

- **Cobertura percentual como meta.** A métrica de qualidade aqui é o catálogo
  acima, não o número.
- **Teste de contrato com provedores reais.**
- **Chaos aleatório.** Toda falha é injetada num ponto nomeado, para o teste
  ser reproduzível.
- **Mutation testing.**
