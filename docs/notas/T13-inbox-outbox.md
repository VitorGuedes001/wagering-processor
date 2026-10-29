# T13 — Inbox, Outbox e eventos

> Estado: Testada · Raia: C · Revisor: G · Branch: `t13-inbox-outbox`
>
> Implementação original: Antigravity (raia G), revisada pelo Claude. Retrabalho da revisão cruzada: Claude (raia C), a ser revisado pelo Antigravity.

## O que muda

- `src/domain/inbox-message.ts` — Implementa `InboxMessage.receive`, `rehydrate`, `isProcessed` e `markProcessed`.
- `src/domain/outbox-message.ts` — Implementa `OutboxMessage.enqueue`, `rehydrate`, `isPending`, `isDue`, `markPublished` e `scheduleRetry` com backoff exponencial `min(2^attempts * 1000, 60000)` sem `Math.`. No retrabalho, o atalho `attempts >= 6` saiu: só a comparação com o teto limita o atraso.
- `src/domain/events/integration-event.ts` — Implementa `IntegrationEvent.toJSON()` serializando o envelope com `occurredAt` em ISO-8601 e omitindo `causationId` quando `undefined`.
- `src/domain/events/wager-transaction-processed.ts` — Implementa `WagerTransactionProcessed.from` para transações `PROCESSED` (incluindo `OPENING` sem campos de provedor, D42). No retrabalho, passa a exigir `providerId` e `externalTransactionId` quando o kind não é `OPENING`.
- `src/domain/events/wager-transaction-rejected.ts` — Implementa `WagerTransactionRejected.from` para transações `REJECTED` com `failureCode` e snapshot `balanceAfter`.
- `src/domain/events/wallet-balance-changed.ts` — Implementa `WalletBalanceChanged.from` a partir de `Wallet` e `WalletLedgerEntry` com `aggregateId = wallet.id`. No retrabalho, lança `InvalidTransactionStateError` se `entry.walletId !== wallet.id`.
- `src/domain/events/wager-transaction-pending-reference.ts` — Implementa `WagerTransactionPendingReference.from` para transações em `PENDING_REFERENCE`.
- `test/unit/inbox-outbox.test.ts` — Testes unitários de `InboxMessage` e `OutboxMessage` (incluindo U-05). No retrabalho, o `DummyIntegrationEvent` deu lugar a um `WagerTransactionProcessed` real (de `WagerTransaction.opening`), e há caso novo para `2 ** n = Infinity`.
- `test/unit/events.test.ts` — Testes unitários de serialização do envelope e das 4 subclasses de `IntegrationEvent` (incluindo U-03 e U-04). No retrabalho, os helpers usam só as factories reais (`rehydrate`, `opening`, `Wallet.open` + `debit`), sem `catch` nem `Reflect.construct`, e há casos negativos para todas as guardas.
- `docs/MODELAGEM.md` — Retrabalho: §7 passa a `enqueue(event)` (contrato do M0, CHALLENGE §6.5) e a D12 descreve o backoff real (primeira retentativa em 2 s, teto de 60 s).

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
  - `docs/MODELAGEM.md` (retrabalho: só §7 e a linha da D12)
  - `docs/notas/T13-inbox-outbox.md`
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

Retrabalho (um commit por achado, depois de `dac23a0`):

1. `test(t13): testes de eventos e outbox só com factories reais do domínio` — achado 1. Olhar os helpers `makeWallet`/`makeLedgerEntry`/`makeTransaction` (só `rehydrate`), o `OPENING` via `WagerTransaction.opening`, o caso novo `Wallet.open` + `debit`, e o `makeEvent` real em `inbox-outbox.test.ts`.
2. `fix(t13): WagerTransactionProcessed exige campos de provedor fora do OPENING` — achado 2. A guarda nova e o teste negativo.
3. `fix(t13): WalletBalanceChanged confere que o lançamento é da wallet` — achado 3.
4. "fix(t13): tirar o atalho `attempts >= 6` do backoff do outbox" — achado 4. O U-05 não muda; o teste novo cobre `Infinity`.
5. `test(t13): casos negativos das guardas de evento que não são de status` — achado 6. Cada grupo confere antes que o estado base passa.
6. `docs(t13): alinhar MODELAGEM §7 e D12 ao contrato e ao código do outbox` — achado 5.

## Como verificar

```bash
bun run tarefa:gate
bun test test/unit/events.test.ts test/unit/inbox-outbox.test.ts
```

Retrabalho: gate verde (typecheck, skills, unidade 217 pass / 0 fail, arquitetura 1 pass; concorrência sem testes ainda). Os dois arquivos da T13 somam 22 testes. Para conferir que nenhum test double do domínio sobrou: `grep -nE "Reflect|catch|Object.create|Dummy" test/unit/events.test.ts test/unit/inbox-outbox.test.ts` não deve achar nada.

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
| 1 | importante | `test/unit/events.test.ts:41`, `:70`, `:109` | Os helpers `makeWallet`, `makeLedgerEntry` e `makeTransaction` fazem `try { X.rehydrate(state) } catch { Reflect.construct(X, [...]) }`. Nesta branch o `rehydrate` das três ainda é stub (`notImplemented('T11'/'T12')`), então **todos** os testes de eventos rodam sobre objetos montados pelo construtor privado, e não pelo `rehydrate` real. Esses fallbacks precisam sair depois que a T11 e a T12 forem integradas: os helpers passam a chamar só `rehydrate`, como o `makeMoney` depois do `ff73fee`. Além disso, o `catch` não tem condição e esconde erros. Com a T11/T12 na `main`, se o `rehydrate` real recusar um estado do teste (por exemplo, por invariante), o erro some e o teste segue com um objeto que o domínio rejeitaria. O `Reflect.construct` também depende da ordem posicional dos construtores privados, e uma mudança de ordem montaria objetos trocados sem erro de tipo. Até a remoção, o mínimo é relançar tudo que não for o stub (`if (!(e instanceof Error) \|\| !e.message.startsWith('Não implementado')) throw e`). Regras: TESTES (asserção mais fraca que o descrito) e o próprio princípio do `ff73fee`. | Resolvido em `test(t13): testes de eventos e outbox só com factories reais do domínio`. Os helpers chamam só `X.rehydrate(state)`, sem `try`/`catch`, `Reflect.construct` nem `Object.create`. O `OPENING` usa `WagerTransaction.opening`, um caso novo usa o lançamento real de `Wallet.open` + `debit`, e o `DummyIntegrationEvent` de `inbox-outbox.test.ts` virou um `WagerTransactionProcessed` real. Nenhum test double do domínio nos testes da T13. |
| 2 | menor | `src/domain/events/wager-transaction-processed.ts:37` | A guarda só exige `status = PROCESSED`, `balanceAfter` e `processedAt`. Uma transação que não é `OPENING` e está sem `providerId`/`externalTransactionId` gera o evento com as chaves omitidas, sem erro. O tipo diz "ausentes só no `OPENING` (D42)", e os eventos irmãos (`Rejected`, `PendingReference`) lançam `InvalidTransactionStateError` nesse caso. A invariante da `WagerTransaction` deve impedir isso, mas a guarda fica assimétrica. | Resolvido em `fix(t13): WagerTransactionProcessed exige campos de provedor fora do OPENING`. Kind ≠ `OPENING` sem `providerId` ou `externalTransactionId` lança `InvalidTransactionStateError`, como os eventos irmãos. Teste negativo falha sem a guarda (conferido). |
| 3 | menor | `src/domain/events/wallet-balance-changed.ts:26` | `from(wallet, entry)` não confere `entry.walletId === wallet.id`. Um par trocado no use case gera `aggregateId`/`data.walletId` de uma wallet com o lançamento de outra. Os docs não exigem a guarda, e uma checagem com `InvalidTransactionStateError` (MODELAGEM 10.4, bug) custa uma linha. | Resolvido em `fix(t13): WalletBalanceChanged confere que o lançamento é da wallet`. `entry.walletId !== wallet.id` lança `InvalidTransactionStateError` (MODELAGEM 10.4). Teste negativo falha sem a guarda (conferido). |
| 4 | menor | `src/domain/outbox-message.ts:94` | O atalho `this._attempts >= 6 ? OUTBOX_BACKOFF_MAX_MS` usa o número 6 fixo, que só vale porque `2^6 × 1 s > 60 s`. Se `BASE` ou `MAX` mudarem, o atalho passa a dar o atraso errado. O `clamp` da linha seguinte já cobre o teto, inclusive `2 ** n = Infinity`, então o atalho é redundante. | Resolvido em "fix(t13): tirar o atalho `attempts >= 6` do backoff do outbox". O atraso é `2 ** attempts × BASE` limitado pelo teto. U-05 inalterado e teste novo com `attempts = 2000` (`Infinity` → 60 s). |
| 5 | menor | `docs/MODELAGEM.md:258` (doc, fora do escopo da T13) | MODELAGEM 7 escreve `enqueue(event, at)`, mas o contrato congelado e CHALLENGE §6.5 usam `enqueue(event)`. A implementação segue o contrato. Também D12 fala em "backoff de 1 s", e §7 (`attempts++` e depois `2^attempts`) dá 2 s na primeira retentativa. O código e o U-05 seguem §7. Vale o humano alinhar o texto dos docs. | Resolvido em `docs(t13): alinhar MODELAGEM §7 e D12 ao contrato e ao código do outbox`. §7 diz `enqueue(event)`, e a D12 diz primeira retentativa em 2 s e teto de 60 s. O código não mudou. |
| 6 | menor | `test/unit/events.test.ts:268`, `:312`, `:389` | Os testes negativos cobrem só o status errado. Faltam casos para as outras guardas: `PROCESSED` sem `balanceAfter`, `REJECTED` sem `failureCode`, `OPENING` em `Rejected`/`PendingReference` e `PENDING_REFERENCE` sem `referenceExternalTransactionId`. | Resolvido em `test(t13): casos negativos das guardas de evento que não são de status`. Cobre `PROCESSED` sem `balanceAfter`/`processedAt`; `REJECTED` sem `failureCode`/`balanceAfter`, em `OPENING` ou sem campos de provedor; `PENDING_REFERENCE` sem `referenceExternalTransactionId`, em `OPENING` ou sem campos de provedor. |

Veredito: aprovado com ressalvas. Não há bloqueante. O achado 1 tem que ser resolvido no merge da T11/T12 (ou antes, com o `catch` condicionado).

### Revisão do retrabalho

Revisor: Antigravity (raia G), 2026-10-28, sobre os commits `e3758d5..47ecf15` (branch `t13-inbox-outbox`).

Gate (`bun run tarefa:gate`): verde. typecheck ✔, skills ✔, unidade ✔ (217 pass, 0 fail, 543 expects), arquitetura ✔ (1 pass), concorrência sem testes ainda.

O que foi verificado nos 6 itens do retrabalho:

1. **Resolução de cada linha da tabela anterior no código:**
   - **Achado 1 (`e3758d5`) — resolvido:** `makeWallet`, `makeLedgerEntry` e `makeTransaction` em `test/unit/events.test.ts` chamam diretamente `Wallet.rehydrate`, `WalletLedgerEntry.rehydrate` e `WagerTransaction.rehydrate`. O caso `OPENING` usa `WagerTransaction.opening`, há teste com `Wallet.open` + `wallet.debit`, e `test/unit/inbox-outbox.test.ts` usa `WagerTransactionProcessed.from(WagerTransaction.opening(...), ctx)` no lugar de `DummyIntegrationEvent`.
   - **Achado 2 (`6daf740`) — parcialmente resolvido (ver tabela abaixo):** `WagerTransactionProcessed.from` passou a exigir `providerId` e `externalTransactionId` quando `kind !== WagerTransactionKind.Opening`, mas não exige `roundId` nem `gameId`.
   - **Achado 3 (`d57abc1`) — resolvido:** `WalletBalanceChanged.from` valida `entry.walletId !== wallet.id` lançando `InvalidTransactionStateError` (MODELAGEM 10.4), com teste negativo em `test/unit/events.test.ts:341-347`.
   - **Achado 4 (`089a9d8`) — resolvido:** `OutboxMessage.scheduleRetry` removeu o atalho `this._attempts >= 6` e calcula `2 ** this._attempts * OUTBOX_BACKOFF_BASE_MS` limitado por `OUTBOX_BACKOFF_MAX_MS`, com caso de teste para `attempts = 2_000` (`Infinity` → 60 s) em `test/unit/inbox-outbox.test.ts:174-190`.
   - **Achado 5 (`79f2486`) — resolvido:** `docs/MODELAGEM.md` alinhado no §7 (`enqueue(event)`) e na D12 (primeira retentativa em 2 s e teto de 60 s).
   - **Achado 6 (`a80af80`) — resolvido (com a ressalva de `roundId`/`gameId` abaixo):** `test/unit/events.test.ts` adicionou casos negativos para `PROCESSED` sem `balanceAfter`/`processedAt`, `REJECTED` nas guardas não-status (com sanidade prévia do estado base) e `PENDING_REFERENCE` nas guardas não-status (com sanidade prévia do estado base).
2. **Ausência de test doubles do domínio:** nenhum `Reflect.construct`, `Object.create`, `catch` ou subclasse fake nos testes (`test/unit/events.test.ts` e `test/unit/inbox-outbox.test.ts`); usam exclusivamente `Money.from`, `Wallet.open`/`rehydrate`, `WalletLedgerEntry.rehydrate` (e `create` via `Wallet.open`/`debit`) e `WagerTransaction.opening`/`rehydrate`.
3. **Guardas de `WagerTransactionProcessed.from` (D42) e `WalletBalanceChanged.from`:** `WalletBalanceChanged.from` rejeita lançamento de outra wallet (`entry.walletId !== wallet.id`), mas `WagerTransactionProcessed.from` só exige `providerId` e `externalTransactionId` fora do `OPENING`, deixando `roundId` e `gameId` sem verificação (achado 1 abaixo).
4. **Backoff do outbox (D12):** manteve `min(2^attempts × 1 s, 60 s)`, sem limite de tentativas, sem jitter e sem `Math.` (restrição 5.1 / A-03).
5. **Escopo em `docs/MODELAGEM.md`:** `git diff main...t13-inbox-outbox -- docs/MODELAGEM.md` tocou exclusivamente a linha da D12 e o parágrafo de `OutboxMessage` no §7.
6. **Contratos do M0 intactos:** `git diff main...t13-inbox-outbox -- src/domain` não alterou nenhuma assinatura pública, tipo exportado ou construtor congelado na T01.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | menor | `src/domain/events/wager-transaction-processed.ts:38-40`; `test/unit/events.test.ts:217-224` | Em `WagerTransactionProcessedData`, os quatro campos de provedor (`providerId`, `externalTransactionId`, `roundId` e `gameId`) são opcionais apenas por causa do `OPENING` (D42; em MODELAGEM 8 nenhum dos quatro tem `?`, e em SCHEMA 2.2 `wager_tx_provider_fields_ck` exige todos presentes quando `kind <> 'OPENING'`). Ao contrário de `Rejected` e `PendingReference` (cujos payloads não têm `roundId`/`gameId`), `WagerTransactionProcessed.from` serializa `roundId` e `gameId` (`wager-transaction-processed.ts:66-67`), mas `missingProviderFields` só verifica `providerId === undefined \|\| externalTransactionId === undefined`. Uma transação com `kind !== WagerTransactionKind.Opening` e `roundId === undefined` ou `gameId === undefined` passa sem lançar `InvalidTransactionStateError` e gera o evento sem essas chaves. Falta incluir `transaction.roundId === undefined \|\| transaction.gameId === undefined` na guarda e os dois casos negativos correspondentes em `test/unit/events.test.ts:217-224`. || Resolvido em "fix(t13): WagerTransactionProcessed exige roundId e gameId fora do OPENING". A guarda `missingProviderFields` passa a exigir os quatro campos de provedor (`providerId`, `externalTransactionId`, `roundId`, `gameId`) quando o kind não é `OPENING`, como `wager_tx_provider_fields_ck`. Dois casos negativos novos (`roundId` e `gameId` ausentes) falham sem a guarda (conferido). |

Veredito: aprovado com ressalvas
