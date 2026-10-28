# T01 — Contratos 🔒

> Estado: Testada · Raia: H (em par com C) · Revisor: G (ver "Revisão cruzada") · Branch: `t01-contratos`

## O que muda

Só contratos: nenhuma regra de negócio implementada. Todo corpo de método lança
`notImplemented('Txx')`.

| Arquivo | O que define |
|---|---|
| `src/domain/not-implemented.ts` | stub que falha alto, com a tarefa dona |
| `src/domain/failure-code.ts` | **completo**: os 11 `FailureCode` de MODELAGEM 10.1, documentados |
| `src/domain/errors.ts` | **completo**: `DomainError` e as 6 exceções de MODELAGEM 10.4 |
| `src/domain/money.ts` | `MoneyProps`; `Money` com `cents: bigint` privado e a API de §6.1 + `fromPersistence` |
| `src/domain/wallet-ledger-entry.ts` | `LedgerDirection`; entrada imutável com `walletVersion` (D16) |
| `src/domain/wallet.ts` | `Wallet` com `open → OpenedWallet`, `canDebit`, `debit`/`credit` devolvendo o lançamento |
| `src/domain/wager-transaction.ts` | kinds, status, `SubmittableKind`, `BackoffPolicy` (D43), `opening` (D42), transições com snapshot (D46) |
| `src/domain/events/*.ts` | envelope abstrato (construtor completo) e os 4 eventos com `eventType`/`version` no tipo |
| `src/domain/inbox-message.ts`, `outbox-message.ts` | como §6.5, com as constantes de backoff do outbox (D12) |
| `src/domain/decide-wager.ts` | `WagerDecision` e a função pura de MODELAGEM 5 |
| `src/domain/reconcile.ts` | `ReconciliationResult` e a função de MODELAGEM 11 |
| `src/domain/payload-hash.ts` | `PayloadHashInput`, `canonicalJson`, `payloadHash` |
| `src/application/contracts.ts` | comandos, views, `SubmitOutcome`, `RequestErrorCode` (D49, D50) |
| `src/application/ports.ts` | UoW, 5 repositórios, publisher, relógio, ids, identidade, `TransientInfrastructureError` |
| `docs/MODELAGEM.md`, `docs/ARQUITETURA.md` | D42–D50 registradas |

O diff é grande (cerca de 1,3 mil linhas), mas a maior parte é comentário de
documentação. Não há lógica para revisar, só forma e nomes.

## Por quê

O M0 congela a superfície pública que **todos** os agentes das ondas 1 a 4 vão
consumir (EXECUCAO §6, onda 0). Sem isso, agentes paralelos inventam assinaturas
diferentes para a mesma coisa. Fontes: MODELAGEM 2–9, ARQUITETURA 3–4,
CHALLENGE §6 e §11.

## Abordagem

### Regra de implementação

- **Só contratos:** tipos, enums, interfaces, classes com construtor `private`,
  factories e métodos públicos. Todo corpo é `throw notImplemented('T12')`,
  apontando qual tarefa o implementa. Enums, interfaces, tipos e constantes do
  domínio (ex.: o backoff do outbox, D12) são completos já aqui, porque não têm
  corpo.
- `src/domain` não importa nada além de `node:crypto` (para o `payloadHash`).
- Nenhum teste nesta tarefa. O aceite é `typecheck` limpo mais a sua revisão
  linha a linha.

### Arquivos que vou tocar

| Arquivo | Conteúdo | Implementado em |
|---|---|---|
| `src/domain/not-implemented.ts` | `notImplemented(task)`, auxiliar de stub. Apagado no M1 | — |
| `src/domain/money.ts` | `MoneyProps`, `Money` | T10 |
| `src/domain/payload-hash.ts` | `PayloadHashInput`, `payloadHash()`, `canonicalJson()` | T10 |
| `src/domain/failure-code.ts` | enum `FailureCode` (MODELAGEM 10.1, 11 códigos) | completo aqui |
| `src/domain/errors.ts` | `DomainError` e as 6 exceções de MODELAGEM 10.4 | completo aqui |
| `src/domain/wallet.ts` | `WalletState`, `Wallet` | T11 |
| `src/domain/wallet-ledger-entry.ts` | `LedgerDirection`, `CreateLedgerEntryProps`, `LedgerEntryState`, `WalletLedgerEntry` | T11 |
| `src/domain/wager-transaction.ts` | `WagerTransactionKind`, `SubmittableKind`, `WagerTransactionStatus`, `CreateWagerTransactionProps`, `WagerTransactionState`, `WagerTransaction` | T12 |
| `src/domain/inbox-message.ts` | `ReceiveInboxProps`, `InboxMessageState`, `InboxMessage` | T13 |
| `src/domain/outbox-message.ts` | `OutboxMessageState`, `OutboxMessage`, constantes de backoff (D12) | T13 |
| `src/domain/events/integration-event.ts` | `IntegrationEventProps<T>`, `IntegrationEvent<T>`, `EventContext`, `IntegrationEventJson<T>` | T13 |
| `src/domain/events/wager-transaction-processed.ts` | `…Data`, classe com `from(...)` | T13 |
| `src/domain/events/wager-transaction-rejected.ts` | idem | T13 |
| `src/domain/events/wallet-balance-changed.ts` | idem (CHALLENGE §11) | T13 |
| `src/domain/events/wager-transaction-pending-reference.ts` | idem | T13 |
| `src/domain/decide-wager.ts` | `WagerDecision`, `DecideWagerInput`, `decideWager()` | T16 |
| `src/domain/reconcile.ts` | `ReconciliationResult`, `reconcile()` | T16 |
| `src/application/ports.ts` | `UnitOfWork`, `TxRepositories`, os 5 repositórios, `EventPublisher`, `Clock`, `IdGenerator`, `ProviderIdentityPort`, `CallerIdentity` | T20–T22, T31 |
| `src/application/contracts.ts` | `WagerCommand`, `TransactionView`, `SubmitOutcome`, `RequestErrorCode` (MODELAGEM 10.2) | T30 |
| `docs/notas/T01-contratos.md` | esta nota | — |

`contracts.ts` separa os tipos de entrada e saída dos use cases das portas de
infraestrutura. A ARQUITETURA 4.1 os define no use case, mas o T31 (HTTP) precisa
deles antes do T30 existir. Ver P8.

### Assinaturas: o que vem direto dos docs

Sem decisão nova; transcrição de MODELAGEM 2–9 e ARQUITETURA 3–4.1:

- `Money`: `from`, `fromPersistence`, `zero`, `add`, `subtract`, `negate`,
  `isZero`, `isPositive`, `isNegative`, `isLessThan`, `equals`, `toJSON`,
  `toString`, e `cents: bigint` privado.
- `Wallet`: `open`, `rehydrate`, `canDebit`, `debit`, `credit`, e os getters
  `balance`, `version` e `updatedAt`.
- `WagerTransaction`: `create`, `rehydrate`, as transições de MODELAGEM 4.3, e
  `isTerminal`, `affectsBalance`, `requiresReference`, `matchesPayload`,
  `ledgerDirectionFor`.
- `WalletLedgerEntry`: `create` (com `walletVersion`), `rehydrate`,
  `isBalanced`.
- `InboxMessage` e `OutboxMessage`: como CHALLENGE §6.5.
- Portas: exatamente ARQUITETURA 3, salvo P5.

### Decisões pendentes (preciso da sua resposta antes de codar)

São lacunas: lugares onde os docs usam algo sem fechar a assinatura. Cada uma
traz a minha proposta.

**P1 — Quem cria a transação `OPENING`?** MODELAGEM 5 diz que o `OPENING` "nasce
`PROCESSED` dentro de `Wallet.open`", mas `Wallet.open` devolve só
`{ wallet, openingEntry? }`. Falta a linha de `wager_transaction` que o
lançamento referencia (FK, SCHEMA 2.3).
Proposta: factory interna `WagerTransaction.opening({ id, walletId, playerId, money, at })`,
que já nasce `PROCESSED` com `balanceAfter = money`. O use case `CreateWallet`
chama as duas. `Wallet.open` continua sem conhecer `WagerTransaction`.

**P2 — Parâmetros de backoff da referência.** `markPendingReference(now)` e
`scheduleReferenceRetry(now)` precisam da base, do teto (D11: 1 s a 5 min) e do
limite de tentativas, que vêm de env (`REFERENCE_BACKOFF_BASE_MS`,
`REFERENCE_MAX_ATTEMPTS`). O domínio não lê env.
Proposta: `interface BackoffPolicy { baseMs: number; maxMs: number; maxAttempts: number }`,
recebida por `markPendingReference(now, policy)`,
`scheduleReferenceRetry(now, policy)` e `referenceAttemptsExhausted(policy)`.
São `number` de tempo, não de dinheiro.

**P3 — Quem gera o `eventId`.** O domínio não gera id (`IdGenerator` é porta), mas
os `from(...)` dos eventos precisam de um.
Proposta: `EventContext { eventId, correlationId, causationId?, occurredAt }`. O
use case gera o id e passa no contexto. Um use case que emite dois eventos chama
`IdGenerator` duas vezes.

**P4 — Forma dos `*State`.** Os `rehydrate` recebem o quê?
Proposta: os State usam tipos de domínio (`Money`, `Date`, enums), não strings
cruas. A conversão `numeric` → `Money.fromPersistence` acontece no repositório
(T20–T22). Assim o domínio nunca vê string de banco, e a regra 5.1 fica num só
lugar.

**P5 — Tipo do lease nas portas.** A ARQUITETURA 3 usa `lease: Duration`, um tipo
que não existe.
Proposta: `leaseMs: number`.

**P6 — `reject` e `markProcessed` com snapshot.** O CHALLENGE §6.3 tem
`reject(code)` e `markProcessed(refId, at)`. A MODELAGEM 4.3 acrescentou o
snapshot do saldo (D10) e o `at`.
Proposta: seguir a MODELAGEM, com `markProcessed(referenceTransactionId, balanceAfter, at)`,
`reject(code, balanceAfter, at)` e `fail(code, at)`. O enunciado permite adaptar
assinaturas (§6). Só confirme que quer o desvio explícito do esqueleto.

**P7 — Enums.** Proposta: `enum` do TypeScript, como no CHALLENGE (reuso
literal). Alternativa: union de strings + `as const`, mais idiomático em TS
moderno. Com o enum, o call site fica igual ao enunciado.

**P8 — `contracts.ts` separado de `ports.ts`.** Proposta: sim (motivo acima).
Alternativa: tudo em `ports.ts`, como diz a linha do T01 na EXECUCAO.

**P9 — Erros de requisição.** Proposta: `RequestErrorCode` em
`application/contracts.ts` (não em `domain`), porque `IDEMPOTENCY_CONFLICT`,
`WALLET_NOT_FOUND` etc. nascem no use case, não numa regra de entidade.
`FailureCode` fica em `domain`, porque é gravado na transação.

### Alternativas descartadas

- **Um arquivo `domain/index.ts` reexportando tudo:** esconde de onde cada coisa
  vem e aumenta o conflito entre agentes. Cada um importa do arquivo dono.
- **Classes abstratas ou interfaces para as entidades** (ex.: `IWallet`): não
  existe segunda implementação. O contrato é a própria classe com construtor
  privado (§6.0).
- **Stub que devolve valor falso em vez de lançar:** um teste "verde por
  acidente" passaria. Lançar `notImplemented` falha alto.

**Aprovação do humano:** aprovado como proposto em 28/10/2026. P1–P9 viraram
D42–D47 (MODELAGEM §1) e D48–D50 (ARQUITETURA §1).

### Ajustes derivados (decorrem dos docs, mas confira)

Não são decisões novas: são consequências diretas dos docs aprovados. Ficam
listados para a revisão não deixá-los passar em silêncio.

1. `Wallet.open` recebe `openingEntryId`. O lançamento precisa de id, como em
   `debit`/`credit`.
2. Os 6 campos de provedor da `WagerTransaction` são `string | undefined`, por
   causa do `OPENING` (SCHEMA 2.2, `wager_tx_provider_fields_ck`). Com isso, o
   `WagerTransactionProcessedData` também os tem opcionais. `Rejected` e
   `PendingReference` nunca são `OPENING` e os mantêm obrigatórios.
3. A `WagerTransaction` ganha `updatedAt` (coluna `updated_at` do SCHEMA), para o
   `at` de `reject`/`fail`/`markPendingReference` ter destino.
4. `OutboxMessage.enqueue(event)` sem `at`, como em §6.5: agenda para
   `event.occurredAt`. A MODELAGEM 7 tinha `enqueue(event, at)`, redundante.
5. `nextAttemptAt` do outbox é obrigatório (`NOT NULL`, é o lease, SCHEMA 2.5), e
   não opcional como no esqueleto.
6. `decideWager` recebe a `BackoffPolicy` (consequência de D43).
7. Helpers privados, como o `assertSameCurrency` do esqueleto, ficam fora do
   contrato: são detalhe de implementação.
8. `CreateWalletCommand`, `WalletView` e `CreateWalletOutcome` foram criados (o
   `CreateWallet` precisa deles), com os formatos de CHALLENGE §9.
9. Datas dentro de `data` dos eventos são string ISO, como `occurredAt` no
   envelope (JSON estável, §11).

## Ordem de leitura do diff

1. `docs/notas/T01-contratos.md` — abordagem e ajustes derivados (esta nota)
2. `src/domain/failure-code.ts`, `errors.ts` — vocabulário de falha, completo
3. `src/domain/money.ts` — `bigint` privado e os dois caminhos de entrada (`from` vs `fromPersistence`)
4. `src/domain/wallet-ledger-entry.ts` → `wallet.ts` — o lançamento nasce de `debit`/`credit`
5. `src/domain/wager-transaction.ts` — o contrato mais denso: estados, transições (D46), `opening` (D42)
6. `src/domain/decide-wager.ts` — onde a regra de §7 vai morar (T16)
7. `src/domain/events/integration-event.ts` → os 4 eventos — o que cada um carrega
8. `src/domain/inbox-message.ts`, `outbox-message.ts`
9. `src/domain/reconcile.ts`, `payload-hash.ts`
10. `src/application/contracts.ts` — o que HTTP e SQS enxergam
11. `src/application/ports.ts` — o que a infraestrutura precisa implementar

## Como verificar

```bash
bun run tarefa:gate
```

Resultado: typecheck ✔, skills ✔, arquitetura ✔. Unidade, integração e
concorrência ainda não têm testes. Checagens manuais: nenhum import de Nest,
MikroORM, AWS SDK ou zod em `src/domain` ou `src/application`, e nenhum
`parseFloat`, `Number(`, `toFixed`, `Math.` ou propriedade de dinheiro tipada
`number`.

## Pedidos ao integrador

- Depois do merge: marcar T01 `Entregue` e M0 no quadro, e criar a tag
  `m0-contratos`.

## Fora de escopo / dívida

- `not-implemented.ts` sai quando o último stub do domínio for implementado (M1).
- Os tipos das **consultas** (extrato paginado, transação completa) não estão
  congelados: ficam com T31/T43, que definem o formato de ARQUITETURA 6.3 sobre
  os repositórios.
- A revisão cruzada deve ser feita no **Antigravity**: a implementação foi do
  Claude, e o quadro dizia "revisor C" só porque a raia era H.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
