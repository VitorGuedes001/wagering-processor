# T13 — Inbox, Outbox e eventos

> Estado: Testada · Raia: G · Revisor: C · Branch: `t13-inbox-outbox`

## O que muda

- `src/domain/inbox-message.ts` — Implementa `InboxMessage.receive`, `rehydrate`, `isProcessed` e `markProcessed`.
- `src/domain/outbox-message.ts` — Implementa `OutboxMessage.enqueue`, `rehydrate`, `isPending`, `isDue`, `markPublished` e `scheduleRetry` com backoff exponencial `min(2^attempts * 1000, 60000)` sem `Math.`.
- `src/domain/events/integration-event.ts` — Implementa `IntegrationEvent.toJSON()` serializando o envelope com `occurredAt` em ISO-8601 e omitindo `causationId` quando `undefined`.
- `src/domain/events/wager-transaction-processed.ts` — Implementa `WagerTransactionProcessed.from` para transações `PROCESSED` (incluindo `OPENING` sem campos de provedor, D42).
- `src/domain/events/wager-transaction-rejected.ts` — Implementa `WagerTransactionRejected.from` para transações `REJECTED` com `failureCode` e snapshot `balanceAfter`.
- `src/domain/events/wallet-balance-changed.ts` — Implementa `WalletBalanceChanged.from` a partir de `Wallet` e `WalletLedgerEntry` com `aggregateId = wallet.id`.
- `src/domain/events/wager-transaction-pending-reference.ts` — Implementa `WagerTransactionPendingReference.from` para transações em `PENDING_REFERENCE`.
- `test/unit/inbox-outbox.test.ts` — Testes unitários de `InboxMessage` e `OutboxMessage` (incluindo U-05).
- `test/unit/events.test.ts` — Testes unitários de serialização do envelope e das 4 subclasses de `IntegrationEvent` (incluindo U-03 e U-04).

## Por quê

Atende às regras de idempotência de consumidor e publicação transacional (MODELAGEM 7; CHALLENGE §6.5, §11; D12), ao contrato de eventos de integração com `MoneyProps` e datas ISO sem vazamento de `bigint` (MODELAGEM 8; D42; D44; restrição 5.1) e ao catálogo de testes unitários U-03, U-04 e U-05 (TESTES §4.1).

## Abordagem

- Arquivos que vou tocar:
  - `src/domain/inbox-message.ts`
  - `src/domain/outbox-message.ts`
  - `src/domain/events/integration-event.ts`
  - `src/domain/events/wager-transaction-processed.ts`
  - `src/domain/events/wager-transaction-rejected.ts`
  - `src/domain/events/wallet-balance-changed.ts`
  - `src/domain/events/wager-transaction-pending-reference.ts`
  - `test/unit/inbox-outbox.test.ts`
  - `test/unit/events.test.ts`
- Assinaturas públicas: mantidas inalteradas conforme congelado na T01.
- Alternativas descartadas e motivo: uso de `Math.min` / `Math.pow` no cálculo de backoff de `OutboxMessage.scheduleRetry` descartado para respeitar a guarda estática A-03 (restrição 5.1 em `src/domain`).

## Ordem de leitura do diff

1. `src/domain/inbox-message.ts` — Ciclo de vida de deduplicação (`receive`, `rehydrate`, `isProcessed`, `markProcessed`).
2. `src/domain/outbox-message.ts` — Enfileiramento a partir de `IntegrationEvent`, verificação `isDue` e backoff `scheduleRetry` (D12).
3. `src/domain/events/integration-event.ts` — Serialização `toJSON()` do envelope base.
4. `src/domain/events/wager-transaction-processed.ts` — Fábrica `from` validando status `PROCESSED` e omitindo campos opcionais ausentes (`OPENING`, D42).
5. `src/domain/events/wager-transaction-rejected.ts` — Fábrica `from` validando status `REJECTED` e campos obrigatórios de provedor/falha.
6. `src/domain/events/wallet-balance-changed.ts` — Fábrica `from` espelhando o lançamento do ledger e `wallet.id`.
7. `src/domain/events/wager-transaction-pending-reference.ts` — Fábrica `from` validando status `PENDING_REFERENCE`.
8. `test/unit/inbox-outbox.test.ts` — Cobertura de `InboxMessage` e `OutboxMessage` (U-05).
9. `test/unit/events.test.ts` — Cobertura de `IntegrationEvent` e subclasses (U-03, U-04).

## Como verificar

```bash
bun run tarefa:gate
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

- (nenhum)

## Fora de escopo / dívida

- (nenhum)

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

Revisor: Claude (raia C), 2026-10-28, sobre `ff73fee` (branch rebaseada na `main` com o `Money` real da T10).

Gate (`bun run tarefa:gate`): verde. typecheck ✔, skills ✔, unidade ✔ (92 pass, 0 fail, 188 expects), arquitetura ✔ (1 pass), concorrência sem testes ainda.

O que verifiquei, sem achado:

- **Contratos do M0:** `git diff main...t13-inbox-outbox -- src/domain` só troca corpos de `notImplemented` e imports. Nenhuma assinatura pública, tipo exportado ou parâmetro de construtor mudou (regra de escopo 4).
- **Escopo:** os 9 arquivos tocados são os listados em "Arquivos que vou tocar", e todos estão dentro de `domain/inbox-*`, `outbox-*`, `domain/events/**` e dos testes (EXECUCAO §6).
- **`toJSON` (CHALLENGE §11):** `occurredAt` sai com `toISOString()`, `causationId` é omitido quando ausente (não vira `undefined`; U-04 confere com `'causationId' in json`), e `eventType`/`version` vêm do tipo de cada subclasse (literais `readonly`, `version = 1`, MODELAGEM 8).
- **`data` x MODELAGEM 8:** os quatro eventos batem campo a campo, inclusive `WalletBalanceChanged` com o exemplo de §11 (`walletId, transactionId, direction, money, balanceBefore, balanceAfter, walletVersion`). Todo `Money` sai por `toJSON()` (`MoneyProps`), `processedAt` sai em ISO, e nenhum `bigint` nem `Date` fica em `data`.
- **`OPENING` (D42):** `WagerTransactionProcessed.from` omite `providerId`, `externalTransactionId`, `roundId`, `gameId` e `referenceTransactionId` quando ausentes, e há teste que confere a ausência das chaves. `Rejected` e `PendingReference` recusam `OPENING`.
- **`OutboxMessage.enqueue` (MODELAGEM 7, D18):** `id = eventId`, copia `aggregateId`, `eventType` e `occurredAt`, `attempts = 0`, `nextAttemptAt = occurredAt` (`NOT NULL`, também lease do D18) e `payload = event.toJSON()`.
- **`scheduleRetry` (D12, U-05):** `attempts++` e depois `now + min(2^attempts × 1 s, 60 s)`, sem limite de tentativas, sem jitter e com relógio injetado. U-05 confere 10 tentativas seguidas (2, 4, 8, 16, 32 e depois 60 s).
- **Inbox (MODELAGEM 7):** `receive` nasce sem `processedAt`, `isProcessed()` é `processedAt !== undefined` e `markProcessed(at)` grava o instante. `rehydrate` preserva os dois estados.
- **Restrição 5.1 e camadas:** nenhum `Math.`, `Number(`, `parseFloat` nem `toFixed` nos arquivos tocados (o backoff usa `**` e comparação, e é tempo, não dinheiro). O domínio só importa módulos de `src/domain`. A-03 está verde.
- **Commit `ff73fee` (integrador):** trocou o `makeMoney` falso, que engolia erro de `Money.from` e montava `Money` pelo construtor privado com `toJSON` sobrescrito, por `Money.from` direto. Está correto: agora um bug do `Money` quebra estes testes em vez de passar calado. O commit não mexe em código de produção.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | importante | `test/unit/events.test.ts:41`, `:70`, `:109` | Os helpers `makeWallet`, `makeLedgerEntry` e `makeTransaction` fazem `try { X.rehydrate(state) } catch { Reflect.construct(X, [...]) }`. Nesta branch o `rehydrate` das três ainda é stub (`notImplemented('T11'/'T12')`), então **todos** os testes de eventos rodam sobre objetos montados pelo construtor privado, e não pelo `rehydrate` real. Esses fallbacks precisam sair depois que a T11 e a T12 forem integradas: os helpers passam a chamar só `rehydrate`, como o `makeMoney` depois do `ff73fee`. Além disso, o `catch` não tem condição e esconde erros. Com a T11/T12 na `main`, se o `rehydrate` real recusar um estado do teste (por exemplo, por invariante), o erro some e o teste segue com um objeto que o domínio rejeitaria. O `Reflect.construct` também depende da ordem posicional dos construtores privados, e uma mudança de ordem montaria objetos trocados sem erro de tipo. Até a remoção, o mínimo é relançar tudo que não for o stub (`if (!(e instanceof Error) \|\| !e.message.startsWith('Não implementado')) throw e`). Regras: TESTES (asserção mais fraca que o descrito) e o próprio princípio do `ff73fee`. | |
| 2 | menor | `src/domain/events/wager-transaction-processed.ts:37` | A guarda só exige `status = PROCESSED`, `balanceAfter` e `processedAt`. Uma transação que não é `OPENING` e está sem `providerId`/`externalTransactionId` gera o evento com as chaves omitidas, sem erro. O tipo diz "ausentes só no `OPENING` (D42)", e os eventos irmãos (`Rejected`, `PendingReference`) lançam `InvalidTransactionStateError` nesse caso. A invariante da `WagerTransaction` deve impedir isso, mas a guarda fica assimétrica. | |
| 3 | menor | `src/domain/events/wallet-balance-changed.ts:26` | `from(wallet, entry)` não confere `entry.walletId === wallet.id`. Um par trocado no use case gera `aggregateId`/`data.walletId` de uma wallet com o lançamento de outra. Os docs não exigem a guarda, e uma checagem com `InvalidTransactionStateError` (MODELAGEM 10.4, bug) custa uma linha. | |
| 4 | menor | `src/domain/outbox-message.ts:94` | O atalho `this._attempts >= 6 ? OUTBOX_BACKOFF_MAX_MS` usa o número 6 fixo, que só vale porque `2^6 × 1 s > 60 s`. Se `BASE` ou `MAX` mudarem, o atalho passa a dar o atraso errado. O `clamp` da linha seguinte já cobre o teto, inclusive `2 ** n = Infinity`, então o atalho é redundante. | |
| 5 | menor | `docs/MODELAGEM.md:258` (doc, fora do escopo da T13) | MODELAGEM 7 escreve `enqueue(event, at)`, mas o contrato congelado e CHALLENGE §6.5 usam `enqueue(event)`. A implementação segue o contrato. Também D12 fala em "backoff de 1 s", e §7 (`attempts++` e depois `2^attempts`) dá 2 s na primeira retentativa. O código e o U-05 seguem §7. Vale o humano alinhar o texto dos docs. | |
| 6 | menor | `test/unit/events.test.ts:268`, `:312`, `:389` | Os testes negativos cobrem só o status errado. Faltam casos para as outras guardas: `PROCESSED` sem `balanceAfter`, `REJECTED` sem `failureCode`, `OPENING` em `Rejected`/`PendingReference` e `PENDING_REFERENCE` sem `referenceExternalTransactionId`. | |

Veredito: aprovado com ressalvas. Não há bloqueante. O achado 1 tem que ser resolvido no merge da T11/T12 (ou antes, com o `catch` condicionado).
