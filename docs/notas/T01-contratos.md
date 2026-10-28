# T01 — Contratos 🔒

> Estado: Abordagem · Raia: H (em par com C) · Revisor: C · Branch: `t01-contratos`

## O que muda

Preenchido depois da implementação.

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

## Ordem de leitura do diff

Preenchida durante a implementação. Ordem prevista: `failure-code` → `errors` →
`money` → `wallet-ledger-entry` → `wallet` → `wager-transaction` →
`decide-wager` → eventos → inbox/outbox → `reconcile` → `payload-hash` →
`application/contracts` → `application/ports`.

## Como verificar

```bash
bun run tarefa:gate
```

## Pedidos ao integrador

- Depois do merge: marcar T01 `Entregue` e M0 no quadro, e criar a tag
  `m0-contratos`.

## Fora de escopo / dívida

- `not-implemented.ts` sai quando o último stub do domínio for implementado (M1).

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
