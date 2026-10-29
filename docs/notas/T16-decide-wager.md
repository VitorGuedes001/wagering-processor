# T16 — decideWager e reconcile 🔒

> Estado: Testada · Raia: G · Revisor: C · Branch: `t16-decide-wager`

## O que muda

- `src/domain/decide-wager.ts`: implementa a função pura `decideWager(input)` com as 10 verificações na ordem determinística de `MODELAGEM §5` e documenta no JSDoc o contrato de contagem de tentativas com o worker (`D57`) e o esgotamento em referência pendente (`D61`).
- `src/domain/reconcile.ts`: implementa a função pura `reconcile(wallet, entries)` segundo `MODELAGEM §11`, verificando a cadeia de saldos a partir de zero e recalculando `Σ CREDIT − Σ DEBIT` exclusivamente com `Money`.
- `src/domain/failure-code.ts`: amplia o comentário JSDoc de `FailureCode.ReferenceNotProcessed` para incluir referência ainda pendente quando as tentativas acabam (`D61`), sem mudar o valor do enum.
- `docs/MODELAGEM.md`: registra a decisão `D61` em `§1` (tabela "Decisões da T16") e atualiza a linha de `REFERENCE_NOT_PROCESSED` em `§10.1`.
- `test/unit/decide-wager.test.ts`: suíte unitária cobrindo todos os casos de `APPLY`, cada linha da tabela de `MODELAGEM §5` (incluindo `D61`), a prova de precedência quando duas regras falham juntas e o contrato de `D57`, usando apenas factories reais do domínio.
- `test/unit/reconcile.test.ts`: suíte unitária cobrindo `MODELAGEM §11` e `§12` (consistente com e sem `OPENING`, `walletVersion = 2` no primeiro lançamento de wallet aberta com zero, `difference` positiva e negativa, cadeia quebrada no início/meio e lançamento adulterado), usando apenas factories reais do domínio.
- `docs/notas/T16-decide-wager.md`: registro da abordagem, decisão `D61` e ordem de leitura.

## Por quê

- **`decideWager` pura e determinística (`CHALLENGE §7`, `MODELAGEM §5`, `D1`, `D2`, `D3`, `D13`, `D43`, `D55`, `D56`, `D57`):**
  - Centraliza a decisão de negócio fora de banco/fila para que HTTP, consumidor SQS e worker de `PENDING_REFERENCE` executem exatamente a mesma regra e produzam o mesmo `failureCode`.
  - `WALLET_NOT_FOUND` fica no use case antes de `decideWager` (`D13`).
  - `WIN` e `LOSS` com referência informada passam pelas mesmas verificações de existência, status, kind permitido e contexto que `REFUND` e `ROLLBACK` (`D2`), enquanto igualdade de valor (passo 8) e unicidade de reversão (passo 9, `D1`) aplicam-se apenas a `REFUND` e `ROLLBACK`.
  - O contrato com o worker de referências (`D57`) garante exatamente `maxAttempts` (10 tentativas, `D11`): o worker chama `transaction.scheduleReferenceRetry(now, backoff)` **antes** de `decideWager`, de modo que na 10ª tentativa `referenceAttemptsExhausted(backoff)` já é `true` e `decideWager` rejeita sem esperar um 11º ciclo.
- **Reconciliação contábil (`CHALLENGE §9`, `§13`, `MODELAGEM §11`):**
  - Verifica que o extrato começa em `balanceBefore = 0.00`, que cada `balanceBefore` casa com o `balanceAfter` anterior (e cada lançamento fecha `isBalanced()`), sem exigir que o primeiro lançamento tenha `walletVersion = 1` (pois wallets abertas com saldo zero não têm `OPENING` e estreiam em `walletVersion = 2`, `MODELAGEM §3`).
  - Calcula `calculatedBalance = Σ CREDIT − Σ DEBIT`, `difference = storedBalance − calculatedBalance` (podendo ser negativa) e `consistent = chainIntact && storedBalance.equals(calculatedBalance)`.
- **Restrição 5.1 (`CHALLENGE §5.1`, `ARQUITETURA §8`):** nenhuma operação monetária usa `number`, `parseFloat`, `Number(`, `toFixed` ou `Math.`; toda aritmética passa por `Money` (`bigint` em centavos).

## Abordagem

- **Arquivos que vou tocar:**
  - `src/domain/decide-wager.ts`
  - `src/domain/reconcile.ts`
  - `src/domain/failure-code.ts`
  - `docs/MODELAGEM.md`
  - `test/unit/decide-wager.test.ts` (novo)
  - `test/unit/reconcile.test.ts` (novo)
  - `docs/notas/T16-decide-wager.md`
- **Assinaturas públicas:** nenhuma muda (contratos congelados no M0, tag `m0-contratos`):
  - `decideWager(input: DecideWagerInput): WagerDecision` em `src/domain/decide-wager.ts`
  - `reconcile(wallet: Wallet, entries: readonly WalletLedgerEntry[]): ReconciliationResult` em `src/domain/reconcile.ts`
  - Em `src/domain/failure-code.ts`, muda apenas o comentário JSDoc de `FailureCode.ReferenceNotProcessed` (valor do enum intacto).
  - Tabelas/helpers auxiliares (como o mapa de kinds de referência permitidos por kind) ficam privados ao módulo.

### 1. `decideWager`: ordem fixa das 10 verificações (`MODELAGEM §5`)

A primeira verificação que falha encerra a função e devolve a decisão correspondente:

| Ordem | Verificação | Condição de falha / disparo | Retorno (`WagerDecision`) |
|---|---|---|---|
| 1 | Wallet pertence ao `playerId` | `wallet.playerId !== transaction.playerId` | `{ type: 'REJECT', code: FailureCode.WalletPlayerMismatch }` |
| 2 | Moeda da operação = moeda da wallet | `transaction.money.currency !== wallet.currency` | `{ type: 'REJECT', code: FailureCode.CurrencyMismatch }` |
| 3 | Referência informada existe *(só quando `hasReference`)* | `reference === undefined` e `!transaction.referenceAttemptsExhausted(backoff)` | `{ type: 'AWAIT_REFERENCE' }` |
| 3b | Referência informada existe, tentativas esgotadas (`D11`, `D43`, `D57`) | `reference === undefined` e `transaction.referenceAttemptsExhausted(backoff)` | `{ type: 'REJECT', code: FailureCode.ReferenceNotFound }` |
| 4 | Referência está `PENDING` ou `PENDING_REFERENCE` *(ver proposta abaixo)* | `reference.status === Pending \|\| reference.status === PendingReference` (e não esgotada, conforme proposta) | `{ type: 'AWAIT_REFERENCE' }` (ou `REJECT` se esgotada — ver seção 2) |
| 5 | Referência está `PROCESSED` | `reference.status !== WagerTransactionStatus.Processed` (`REJECTED`, `FAILED`, ou `PENDING*` esgotada na Opção A) | `{ type: 'REJECT', code: FailureCode.ReferenceNotProcessed }` |
| 6 | Kind da referência é permitido (`MODELAGEM 4.2`) | `WIN`/`LOSS`/`REFUND` com `reference.kind !== BET`; ou `ROLLBACK` com `reference.kind ∉ {BET, WIN, REFUND}` | `{ type: 'REJECT', code: FailureCode.ReferenceKindNotAllowed }` |
| 7 | Mesma wallet, player, moeda e rodada | `reference.walletId !== transaction.walletId \|\| reference.playerId !== transaction.playerId \|\| reference.money.currency !== transaction.money.currency \|\| reference.roundId !== transaction.roundId` | `{ type: 'REJECT', code: FailureCode.ReferenceContextMismatch }` |
| 8 | Valor igual *(só `REFUND`/`ROLLBACK`, i.e., `transaction.requiresReference()`)* | `!transaction.money.equals(reference.money)` | `{ type: 'REJECT', code: FailureCode.ReferenceAmountMismatch }` |
| 9 | Referência ainda não revertida *(só `REFUND`/`ROLLBACK`, `D1`)* | `input.referenceAlreadyReversed === true` | `{ type: 'REJECT', code: FailureCode.ReferenceAlreadyReversed }` |
| 10a | Saldo cobre o débito: `BET` | `direction === DEBIT`, `transaction.kind === Bet` e `!wallet.canDebit(transaction.money)` | `{ type: 'REJECT', code: FailureCode.InsufficientFunds }` |
| 10b | Saldo cobre o débito: `ROLLBACK` de `WIN`/`REFUND` (`§7.9`) | `direction === DEBIT`, `transaction.kind === Rollback` e `!wallet.canDebit(transaction.money)` | `{ type: 'REJECT', code: FailureCode.ReversalInsufficientFunds }` |
| — | Tudo passou (`LOSS`, `!transaction.affectsBalance()`) | `transaction.kind === Loss` | `{ type: 'APPLY', direction: undefined }` |
| — | Tudo passou (demais kinds) | `BET` (`DEBIT`), `WIN` (`CREDIT`), `REFUND` (`CREDIT`), `ROLLBACK` (`transaction.ledgerDirectionFor(reference)`) | `{ type: 'APPLY', direction }` |

Notas de contrato em `decideWager`:
- `hasReference`: `transaction.referenceExternalTransactionId !== undefined || transaction.requiresReference()`. Se `false` (`BET`, ou `WIN`/`LOSS` sem referência), os passos 3 a 9 não rodam e `decideWager` nunca devolve `AWAIT_REFERENCE` (`D56`).
- `D55`: `transaction.ledgerDirectionFor(reference)` só é chamado quando `transaction.affectsBalance()` é `true` (exclui `LOSS`) e depois dos passos 3–6 (garante que todo `ROLLBACK` tem `reference` `PROCESSED` com kind em `{BET, WIN, REFUND}`), nunca disparando `InvalidTransactionStateError` em fluxo válido.
- `D57` (documentado no JSDoc): na submissão inicial (`status = PENDING`, `referenceAttempts = 0`), `referenceAttemptsExhausted(backoff)` é `false` (para `maxAttempts >= 1`) e a falta de referência devolve `AWAIT_REFERENCE`, levando o use case a chamar `markPendingReference`. No worker (`T42`), cada tentativa chama `transaction.scheduleReferenceRetry(now, backoff)` **antes** de `decideWager`; assim, na 10ª tentativa (`referenceAttempts === maxAttempts === 10`), `referenceAttemptsExhausted` já retorna `true` e `decideWager` rejeita na hora, totalizando exatamente 10 tentativas (~13,5 min de `D11`).

### 2. Proposta para referência `PENDING` ou `PENDING_REFERENCE` com tentativas esgotadas (passo 4)

Os documentos especificam o esgotamento no passo 3 (`MODELAGEM §5`: *"referência informada existe → `AWAIT_REFERENCE` (ou `REFERENCE_NOT_FOUND` se as tentativas acabaram)"*), mas a linha 4 da tabela traz apenas *"referência está `PENDING` ou `PENDING_REFERENCE` → `AWAIT_REFERENCE`"*.

Esse caso ocorre se uma transação `T2` (ex.: `ROLLBACK` de um `WIN`) referenciar uma `T1` (`WIN` que por sua vez referencia um `BET` ausente) e `T1` tiver chegado depois de `T2`, de modo que `T2` atinge sua 10ª tentativa (`referenceAttemptsExhausted(backoff) === true`) enquanto `T1` ainda está em `PENDING_REFERENCE`.

Apresento 3 opções (com recomendação pela **Opção A**):

- **Opção A (Recomendada) — Esgotamento também encerra a espera no passo 4, caindo no passo 5 (`REFERENCE_NOT_PROCESSED`):**
  - Passo 4: `if ((reference.status === Pending || reference.status === PendingReference) && !transaction.referenceAttemptsExhausted(backoff)) return { type: 'AWAIT_REFERENCE' };`
  - Quando `referenceAttemptsExhausted(backoff)` é `true`, o passo 4 não aguarda mais e cai naturalmente no passo 5 (`reference.status !== Processed`), que devolve `{ type: 'REJECT', code: FailureCode.ReferenceNotProcessed }`.
  - *Por quê:*
    1. Garante a invariante **`decideWager` nunca devolve `AWAIT_REFERENCE` quando `transaction.referenceAttemptsExhausted(backoff)` é `true`**, evitando que o worker (`T42`) continue reagendando `T2` além de `maxAttempts` (`D11`/`D57`).
    2. Mantém `REFERENCE_NOT_FOUND` fiel à definição de `CHALLENGE §7.1` (*"identifique a referência inexistente"*) e `MODELAGEM §10.1` (*"Referência não apareceu até o limite"*): aqui a referência **existe** no banco (passou pelo passo 3), mas não chegou ao estado `PROCESSED` dentro do limite de tentativas (exatamente a condição `reference.status !== Processed` do passo 5).
- **Opção B — Esgotamento no passo 4 devolve `REFERENCE_NOT_FOUND`:**
  - Passo 4 devolve `AWAIT_REFERENCE` enquanto `!transaction.referenceAttemptsExhausted(backoff)` e `{ type: 'REJECT', code: FailureCode.ReferenceNotFound }` quando esgotado (tratando "referência ausente" e "referência ainda pendente ao fim do backoff" com o mesmo código).
- **Opção C — Sem esgotamento no passo 4 (leitura literal da tabela de `MODELAGEM §5`):**
  - Passo 4 devolve sempre `{ type: 'AWAIT_REFERENCE' }` quando `reference.status` é `PENDING` ou `PENDING_REFERENCE`, ignorando `referenceAttemptsExhausted(backoff)`.

### 3. `reconcile`: algoritmo (`MODELAGEM §11`)

```ts
export function reconcile(wallet: Wallet, entries: readonly WalletLedgerEntry[]): ReconciliationResult {
  const zero = Money.zero(wallet.currency);
  let calculatedBalance = zero;
  let expectedBefore = zero;
  let chainIntact = true;

  for (const entry of entries) {
    if (!entry.balanceBefore.equals(expectedBefore) || !entry.isBalanced()) {
      chainIntact = false;
    }
    expectedBefore = entry.balanceAfter;
    calculatedBalance =
      entry.direction === LedgerDirection.Credit
        ? calculatedBalance.add(entry.money)
        : calculatedBalance.subtract(entry.money);
  }

  const storedBalance = wallet.balance;
  const difference = storedBalance.subtract(calculatedBalance);
  const consistent = chainIntact && storedBalance.equals(calculatedBalance);

  return {
    walletId: wallet.id,
    storedBalance,
    calculatedBalance,
    difference,
    consistent,
    chainIntact,
    checkedEntries: entries.length,
  };
}
```

Pontos-chave de `reconcile`:
- **Cadeia de saldos vs. `walletVersion`:** uma wallet aberta com `initialBalance = 0.00` nasce em `version = 1` sem lançamento `OPENING` (`MODELAGEM §3`); o primeiro `credit` ou `debit` gera um lançamento com `walletVersion = 2` e `balanceBefore = 0.00`. Por isso `reconcile` verifica `entry.balanceBefore.equals(expectedBefore)` (partindo de `0.00`) e `entry.isBalanced()`, e **não** exige `entries[0].walletVersion === 1` nem contiguidade de `walletVersion`.
- **`entry.isBalanced()`:** se um lançamento reidratado do banco tiver `balanceAfter` adulterado (ex.: `balanceBefore = 0.00`, `CREDIT 50.00`, `balanceAfter = 99.00` num único lançamento em que `wallet.balance = 50.00`), `!entry.isBalanced()` detecta a quebra na cadeia.
- **`difference = stored − calculated`:** usa `Money.subtract`, podendo resultar em `Money` negativo (ex.: `stored = 70.00`, `calculated = 100.00` → `difference = -30.00`).

### 4. Matriz de testes

Nenhum test double do domínio será usado (apenas `Money.from`/`fromPersistence`/`zero`, `Wallet.open`/`rehydrate`, `WagerTransaction.create`/`opening`/`rehydrate`, `WalletLedgerEntry.create`/`rehydrate`; sem `Reflect.construct` nem `Object.create`).

#### 4.1 `test/unit/decide-wager.test.ts`

1. **Caminhos `APPLY` por kind:**
   - `BET` com saldo maior que a aposta e com saldo exatamente igual (`canDebit` no limite) → `{ type: 'APPLY', direction: DEBIT }`.
   - `WIN` sem referência → `{ type: 'APPLY', direction: CREDIT }`.
   - `WIN` com referência `BET` `PROCESSED` (mesmo valor e valor diferente do `BET`) → `{ type: 'APPLY', direction: CREDIT }`.
   - `LOSS` sem referência com valor `> 0` e com valor `0.00` (`D3`) → `{ type: 'APPLY', direction: undefined }`.
   - `LOSS` com referência `BET` `PROCESSED` (valor `0.00` e valor diferente do `BET`) → `{ type: 'APPLY', direction: undefined }`.
   - `REFUND` de `BET` `PROCESSED` (mesmo valor, mesmo contexto, `referenceAlreadyReversed = false`, mesmo com `wallet.balance = 0.00`) → `{ type: 'APPLY', direction: CREDIT }`.
   - `ROLLBACK` de `BET` `PROCESSED` (mesmo com `wallet.balance = 0.00`) → `{ type: 'APPLY', direction: CREDIT }`.
   - `ROLLBACK` de `WIN` `PROCESSED` (saldo maior e saldo igual ao valor) → `{ type: 'APPLY', direction: DEBIT }`.
   - `ROLLBACK` de `REFUND` `PROCESSED` (saldo maior e saldo igual ao valor) → `{ type: 'APPLY', direction: DEBIT }`.
2. **Cada linha da tabela de `MODELAGEM §5` isoladamente:**
   - **#1 (`WALLET_PLAYER_MISMATCH`):** `wallet.playerId !== transaction.playerId` em `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`.
   - **#2 (`CURRENCY_MISMATCH`):** `wallet` em `BRL` e `transaction` em `USD`.
   - **#3 (`AWAIT_REFERENCE` / `REFERENCE_NOT_FOUND`):** `reference === undefined` para `REFUND`, `ROLLBACK`, `WIN` com referência e `LOSS` com referência (`D2`):
     - `referenceAttempts = 0` (1ª submissão) e `referenceAttempts = maxAttempts - 1` (9ª tentativa) → `AWAIT_REFERENCE`.
     - `referenceAttempts = maxAttempts` (10ª tentativa após `scheduleReferenceRetry`, `D57`) e `> maxAttempts` → `REJECT` com `REFERENCE_NOT_FOUND`.
   - **#4 (`AWAIT_REFERENCE` / esgotamento em `PENDING` e `PENDING_REFERENCE`):** `reference` em `PENDING` e em `PENDING_REFERENCE` para `REFUND`, `ROLLBACK`, `WIN` e `LOSS` → `AWAIT_REFERENCE` enquanto não esgotado, e o comportamento aprovado na decisão da seção 2 quando `referenceAttemptsExhausted(backoff)` é `true`.
   - **#5 (`REFERENCE_NOT_PROCESSED`):** `reference` em `REJECTED` e em `FAILED`.
   - **#6 (`REFERENCE_KIND_NOT_ALLOWED`):** matriz completa de kinds proibidos de `MODELAGEM 4.2`:
     - `WIN` referenciando `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, `OPENING`.
     - `LOSS` referenciando `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, `OPENING`.
     - `REFUND` referenciando `WIN`, `LOSS`, `REFUND`, `ROLLBACK`, `OPENING`.
     - `ROLLBACK` referenciando `LOSS`, `ROLLBACK`, `OPENING`.
   - **#7 (`REFERENCE_CONTEXT_MISMATCH`):** cada um dos 4 campos divergindo isoladamente (`reference.walletId !== tx.walletId`, `reference.playerId !== tx.playerId`, `reference.money.currency !== tx.money.currency`, `reference.roundId !== tx.roundId`), tanto para `REFUND`/`ROLLBACK` quanto para `WIN`/`LOSS` com referência (`D2`).
   - **#8 (`REFERENCE_AMOUNT_MISMATCH`):** `REFUND` e `ROLLBACK` com valor menor ou maior que `reference.money` → `REJECT` `REFERENCE_AMOUNT_MISMATCH`; `WIN` e `LOSS` com valor diferente de `reference.money` → `APPLY` (passo 8 é só para `REFUND`/`ROLLBACK`).
   - **#9 (`REFERENCE_ALREADY_REVERSED`):** `REFUND` e `ROLLBACK` com `referenceAlreadyReversed: true` → `REJECT` `REFERENCE_ALREADY_REVERSED` (`D1`); `WIN` e `LOSS` com referência e `referenceAlreadyReversed: true` → `APPLY` (passo 9 é só para `REFUND`/`ROLLBACK`).
   - **#10a (`INSUFFICIENT_FUNDS`):** `BET` de `100.01` em wallet com `100.00`.
   - **#10b (`REVERSAL_INSUFFICIENT_FUNDS`):** `ROLLBACK` de `WIN` e `ROLLBACK` de `REFUND` de `100.01` em wallet com `100.00` (`§7.9`).
3. **Prova da ordem fixa (duas ou mais regras falhando juntas):**
   - **#1 antes de #2:** player diferente + moeda diferente → `WALLET_PLAYER_MISMATCH`.
   - **#2 antes de #3:** moeda diferente + referência ausente (com tentativas restantes e com tentativas esgotadas) → `CURRENCY_MISMATCH`.
   - **#3 antes de #9/#10:** referência ausente + `referenceAlreadyReversed: true` + saldo insuficiente → `AWAIT_REFERENCE` (ou `REFERENCE_NOT_FOUND` se esgotado).
   - **#4 antes de #6/#7/#8/#9/#10:** referência `PENDING_REFERENCE` + kind inválido (`LOSS`) + outra rodada + valor diferente + `referenceAlreadyReversed: true` + sem saldo → `AWAIT_REFERENCE`.
   - **#5 antes de #6:** referência `REJECTED` + kind inválido (`LOSS`) → `REFERENCE_NOT_PROCESSED`.
   - **#6 antes de #7:** referência `PROCESSED` de kind inválido (`WIN` para `REFUND`) + outra rodada/wallet → `REFERENCE_KIND_NOT_ALLOWED`.
   - **#7 antes de #8:** referência `BET` `PROCESSED` de outra rodada + valor diferente → `REFERENCE_CONTEXT_MISMATCH`.
   - **#8 antes de #9:** valor diferente + `referenceAlreadyReversed: true` → `REFERENCE_AMOUNT_MISMATCH`.
   - **#9 antes de #10:** `ROLLBACK` de `WIN` com `referenceAlreadyReversed: true` + saldo insuficiente na wallet → `REFERENCE_ALREADY_REVERSED`.
   - **Tudo falhando ao mesmo tempo (#1 a #10):** devolve `WALLET_PLAYER_MISMATCH`.
4. **Pureza e ciclo de 10 tentativas (`D57`):**
   - Simulação do ciclo completo: 1ª chamada em `PENDING` (`attempts = 0`) → `AWAIT_REFERENCE` → `markPendingReference`; tentativas 1 a 9 (`scheduleReferenceRetry` → `decideWager`) → `AWAIT_REFERENCE`; 10ª tentativa (`scheduleReferenceRetry` leva `attempts` a `10` → `decideWager`) → `REJECT` `REFERENCE_NOT_FOUND`.
   - Verifica que `decideWager` não muta `transaction`, `wallet` nem `reference`.

#### 4.2 `test/unit/reconcile.test.ts`

1. **Consistente sem lançamentos:** wallet aberta com `0.00` e `entries = []` → `consistent: true`, `chainIntact: true`, `storedBalance: 0.00`, `calculatedBalance: 0.00`, `difference: 0.00`, `checkedEntries: 0`.
2. **Consistente com abertura zero e primeiro lançamento em `walletVersion = 2`:** `Wallet.open` com `0.00` (sem `openingEntry`), seguido de `credit` (`walletVersion = 2`, `balanceBefore = 0.00`), `debit` (`walletVersion = 3`) e `credit` (`walletVersion = 4`) → `consistent: true`, `chainIntact: true`, `difference: 0.00`, `checkedEntries: 3`.
3. **Consistente com `OPENING` (`walletVersion = 1`):** `Wallet.open` com `100.00` + créditos e débitos até `0.00` e de volta a saldo positivo → `consistent: true`, `chainIntact: true`, `difference: 0.00`.
4. **Saldo divergente positivo (`stored > calculated`):** wallet reidratada com `150.00` e ledger somando `100.00` (cadeia íntegra) → `consistent: false`, `chainIntact: true`, `difference: 50.00`.
5. **Saldo divergente negativo (`stored < calculated`):** wallet reidratada com `70.00` e ledger somando `100.00` (cadeia íntegra) → `consistent: false`, `chainIntact: true`, `difference: -30.00` (`difference.isNegative() === true`, `toJSON().amount === '-30.00'`).
6. **Wallet com saldo positivo mas sem lançamentos (`entries = []`):** `consistent: false`, `chainIntact: true`, `calculatedBalance: 0.00`, `difference: storedBalance`.
7. **Cadeia quebrada no primeiro lançamento (`entries[0].balanceBefore > 0`):** primeiro lançamento não parte de zero (mesmo que `storedBalance == calculatedBalance`) → `chainIntact: false`, `consistent: false`.
8. **Cadeia quebrada entre lançamentos consecutivos (`entries[i].balanceBefore !== entries[i-1].balanceAfter`):** buraco entre `balanceAfter` do lançamento 1 e `balanceBefore` do lançamento 2 (tanto com `stored != calculated` quanto com `stored == calculated`) → `chainIntact: false`, `consistent: false`.
9. **Lançamento reidratado com aritmética interna corrompida (`!entry.isBalanced()`):** único lançamento `CREDIT 50.00` com `balanceBefore = 0.00` e `balanceAfter = 80.00`, mesmo com `wallet.balance = 50.00` (`stored == calculated`) → `chainIntact: false`, `consistent: false`.

### 5. Alternativas descartadas e motivo

- **Tratar `WALLET_NOT_FOUND` dentro de `decideWager` (recebendo `wallet: Wallet | undefined`):** descartado porque o contrato `DecideWagerInput` do M0 exige `wallet: Wallet` não nula e `D13` define que `WALLET_NOT_FOUND` não persiste transação e é tratado antes pelo use case (`SCHEMA §4.2`, passo 3).
- **Checar `referenceAttemptsExhausted` depois de `scheduleReferenceRetry` no próprio `decideWager` (mutando `transaction`):** descartado porque `decideWager` é função pura (`MODELAGEM §5`), não recebe `now: Date` e não pode mutar `transaction`. O incremento antes da chamada no worker é responsabilidade do chamador (`D57`).
- **Exigir `entries[0].walletVersion === 1` e `entry[i].walletVersion === entry[i-1].walletVersion + 1` em `reconcile`:** descartado porque uma wallet aberta com saldo zero não gera lançamento `OPENING` (`MODELAGEM §3`), então o primeiro lançamento real tem `walletVersion = 2`. Além disso, `MODELAGEM §11` define a integridade da cadeia pelos saldos (`balanceBefore = 0` no primeiro e `balanceBefore = balanceAfter` anterior).
- **Calcular `calculatedBalance` tomando apenas o último `balanceAfter`:** descartado porque `MODELAGEM §11` exige explicitamente `calculatedBalance = Σ CREDIT − Σ DEBIT`; se houver um salto na cadeia, o último `balanceAfter` divergiria da soma real dos lançamentos.
- **Usar `Reflect.construct`, `Object.create` ou dublês nos testes para estados específicos:** descartado pelo briefing; `Wallet.rehydrate`, `WagerTransaction.rehydrate` e `WalletLedgerEntry.rehydrate` já são as factories oficiais (`CHALLENGE §6.0`) para reconstruir qualquer estado persistido.

**Aprovação do humano:** aprovada em 28/10/2026 (Opção A da decisão pendente, registrada como D61)

## Ordem de leitura do diff

1. `src/domain/decide-wager.ts` — JSDoc do contrato de tentativas (`D57`, `D61`), as 10 verificações na ordem fixa de `MODELAGEM §5`, o filtro `hasReference` (`D2`, `D56`), `isAllowedReferenceKind` (`MODELAGEM §4.2`) e a distinção `INSUFFICIENT_FUNDS` vs. `REVERSAL_INSUFFICIENT_FUNDS` (`§7.9`).
2. `src/domain/reconcile.ts` — cálculo de `calculatedBalance = Σ CREDIT − Σ DEBIT` com `Money`, verificação da cadeia de saldos (`balanceBefore` partindo de zero e `isBalanced()`) sem exigir `walletVersion` contígua, e `difference = storedBalance − calculatedBalance`.
3. `src/domain/failure-code.ts` e `docs/MODELAGEM.md` — registro de `D61` em `§1` e atualização da descrição de `REFERENCE_NOT_PROCESSED` em `§10.1` e no JSDoc do enum.
4. `test/unit/decide-wager.test.ts` — 112 testes cobrindo `APPLY` por kind, cada linha isolada da tabela de `MODELAGEM §5`, prova da ordem quando duas regras falham juntas, ciclo de 10 tentativas (`D57`, `D61`) e pureza, usando apenas factories reais.
5. `test/unit/reconcile.test.ts` — 9 testes cobrindo `MODELAGEM §11` e `§12` (consistente sem e com `OPENING`, primeiro lançamento em `walletVersion = 2`, `difference` positiva e negativa, cadeia quebrada no início/meio e lançamento corrompido).

## Como verificar

```bash
bun test ./test/unit/decide-wager.test.ts ./test/unit/reconcile.test.ts
bun run tarefa:gate
```

## Decisões pendentes

Resolvida pelo humano em 28/10/2026 (aprovada a Opção A, registrada como `D61` em `docs/MODELAGEM.md`):

1. **Referência em `PENDING` ou `PENDING_REFERENCE` quando `transaction.referenceAttemptsExhausted(backoff)` é `true` (passo 4 de `decideWager`) → D61.**
   - *Contexto:* `MODELAGEM §5` especifica o fallback de esgotamento na linha 3 (`referência informada existe → AWAIT_REFERENCE (ou REFERENCE_NOT_FOUND se as tentativas acabaram)`), mas na linha 4 dizia apenas `referência está PENDING ou PENDING_REFERENCE → AWAIT_REFERENCE`.
   - *Decisão aprovada (Opção A / D61):* aplicar `!transaction.referenceAttemptsExhausted(backoff)` também na espera do passo 4; quando esgotado, deixar cair no passo 5 (`reference.status !== Processed`), que devolve `{ type: 'REJECT', code: FailureCode.ReferenceNotProcessed }`.

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- (nenhum)

## Fora de escopo / dívida

- Implementação do worker de `PENDING_REFERENCE` (`ResolvePendingReferences`): pertence à `T42`, que consumirá `decideWager` respeitando o contrato `D57`.
- Endpoint e use case de reconciliação (`ReconcileWallet`, log e métrica `wagering_reconciliation_mismatch_total`): pertencem à `T43`.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

Revisor: Claude (raia C), 28/10/2026, worktree `wp-T16`, branch `t16-decide-wager` em `5e8fc56`.

**Gate:** `bun run tarefa:gate` verde: typecheck ✔, skills ✔, unidade ✔ (316 pass, 0 fail; 112 em `decide-wager.test.ts`, 9 em `reconcile.test.ts`), arquitetura ✔ (1 pass).

**O que conferi:**

- **Ordem (MODELAGEM §5):** `decide-wager.ts:50-130` segue a tabela linha a linha, com retorno antecipado em cada passo. Mutação de ordem numa **cópia temporária** fora do worktree (`scratchpad/t16swap`), rodando `decide-wager.test.ts` a cada troca:
  - #1↔#2: 2 testes falham (`#1 vence #2` e "todas as regras");
  - #6↔#7: 5 testes falham (`#6 vence #7` e as 4 linhas de referência `OPENING`, que não tem `roundId`);
  - #8↔#9: 1 falha (`#8 vence #9`);
  - #9↔#10 (reversão checada depois do saldo): 1 falha (`#9 vence #10`).
  - Por raciocínio: #4↔#5 é pego pelas 8 linhas "tentativas restantes → AWAIT_REFERENCE" do bloco 4, que passariam a devolver `REFERENCE_NOT_PROCESSED`. #2↔#3 é pego por `#2 vence #3`, no caso esgotado. #3 e #4 não falham juntos, porque `reference` ausente e presente se excluem.
- **D57:** `decideWager` só lê `referenceAttemptsExhausted(backoff)` (`:65`) e nunca chama `scheduleReferenceRetry`. O JSDoc (`:36-45`) documenta que o worker incrementa antes. Os dois testes de ciclo checam `referenceAttempts === attempt` depois de cada retry, então um incremento dentro de `decideWager` quebraria a contagem.
- **D61:** `:75-86`: `PENDING`/`PENDING_REFERENCE` esgotada cai no passo 5 e devolve `REFERENCE_NOT_PROCESSED`, e nunca `AWAIT_REFERENCE`. Está coberto para os 4 kinds × 2 status e no ciclo de 10 tentativas.
- **D2/D56:** `hasReference` (`:61-62`) filtra os passos 3–9. Sem referência, `WIN`/`LOSS` nunca chegam a `AWAIT_REFERENCE` (há testes `APPLY` para os dois). Com referência, passam por 3–7. Os passos 8–9 ficam dentro de `requiresReference()` (`:103`), e há testes de `WIN`/`LOSS` com valor diferente e com `referenceAlreadyReversed = true` devolvendo `APPLY`.
- **Saldo (§7.9):** o passo 10 só roda quando `direction === DEBIT`, o que só acontece para `BET` e para `ROLLBACK` de `WIN`/`REFUND`. `REFUND` e `ROLLBACK` de `BET` são `CREDIT` e têm teste com wallet zerada. O ternário `:125-128` separa `INSUFFICIENT_FUNDS` de `REVERSAL_INSUFFICIENT_FUNDS`.
- **D55:** `ledgerDirectionFor` só é chamado depois de `affectsBalance()` (exclui `LOSS`) e dos passos 3–6. Assim, todo `ROLLBACK` chega com referência `PROCESSED` de kind reversível.
- **Exceções de `Money`:** `money.equals` (`:105`) só roda depois do passo 7, que garante a mesma moeda. `canDebit` só roda depois do passo 2. Nenhum caminho válido lança `CurrencyMismatchError`.
- **Pureza:** sem I/O, sem `Date`, sem `now`, e nenhum método mutador é chamado. Os imports são só de `src/domain`.
- **reconcile (MODELAGEM §11):** a cadeia parte de `Money.zero` e não exige `walletVersion = 1`, e o primeiro lançamento em `walletVersion = 2` tem teste. `calculated = Σ CREDIT − Σ DEBIT`. `difference = stored − calculated` usa `subtract` e tem teste negativo (`-30.00`). `consistent = chainIntact && equals`. Os casos de §12 (consistente, divergente e cadeia quebrada no início, no meio e por `!isBalanced`) estão cobertos.
- **Mistura de moedas em `reconcile`:** **lança** `CurrencyMismatchError` em vez de reportar (`Money.equals`/`add`/`subtract` em `reconcile.ts:34,40-41`). Ver achado 4.
- **Restrição 5.1:** não há `number`, `parseFloat`, `Number(`, `toFixed` nem `Math.` em caminho de dinheiro. `referenceAttempts` é contador, não dinheiro.
- **Contratos M0:** `git diff main...t16-decide-wager -- src/domain` não muda assinatura pública. `DecideWagerInput`, `WagerDecision`, `ReconciliationResult` e as duas funções estão idênticos. `failure-code.ts` só mudou o JSDoc de `ReferenceNotProcessed`. `MODELAGEM.md` só ganhou a tabela D61 e a linha de §10.1.
- **Escopo:** os 7 arquivos do diff são exatamente os "Arquivos que vou tocar".
- **Testes:** não há test double, `mock`, `spyOn`, `Reflect.construct` nem `Object.create`. Os testes usam só `Money.from`/`fromPersistence`, `Wallet.open`, `WagerTransaction.create`/`rehydrate` e `WalletLedgerEntry.rehydrate`.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | menor | `docs/MODELAGEM.md:228` | A linha 4 da tabela de §5 ainda diz só `AWAIT_REFERENCE`, sem citar D61. Quem lê §5 isolado (por exemplo, a T42) não vê que, com as tentativas esgotadas, a resposta é `REFERENCE_NOT_PROCESSED` no passo 5. Sugestão: acrescentar "(enquanto não esgotou, D61)" na célula. Fica a critério do humano, porque o escopo aprovado só citava D61 e §10.1 | |
| 2 | menor | `test/unit/decide-wager.test.ts:871` | O teste `#2 vence #3` diz "com e sem tentativas", mas só exercita o caso esgotado (`REFERENCE_NOT_FOUND`). Falta o caso com tentativas restantes, em que `CURRENCY_MISMATCH` vence `AWAIT_REFERENCE`. A ordem já é provada pelo caso que existe, então é só o nome que promete mais do que o teste faz | |
| 3 | menor | `test/unit/decide-wager.test.ts:383` | A matriz da nota (§4.1, linha #3) promete `referenceAttempts = maxAttempts` **e `> maxAttempts`**, mas só `= maxAttempts` foi testado. O `>=` de `referenceAttemptsExhausted` não tem caso acima do limite nesta suíte | |
| 4 | menor | `src/domain/reconcile.ts:34` | Com um lançamento em moeda diferente da wallet, `reconcile` **lança** `CurrencyMismatchError` (vindo de `Money.equals`/`add`/`subtract`) em vez de reportar `chainIntact = false`. O schema impede esse estado (`ledger_wallet_fk` em `(wallet_id, currency)`, SCHEMA 2.3), então só acontece por bug de quem chama, e o 500 é coerente com MODELAGEM 10.4. Mas o JSDoc não diz isso e não há teste fixando o comportamento. O mesmo vale para `entry.walletId ≠ wallet.id`, que não é conferido. Sugestão: uma linha no JSDoc e um teste com `toThrow` | |
| 5 | menor | `test/unit/decide-wager.test.ts:1255` | O teste de pureza só cobre o caminho `APPLY` de `REFUND`. Não cobre `AWAIT_REFERENCE` nem `REJECT`, e não confere `referenceAttempts`/`updatedAt`. O código é puro por inspeção, então o achado é só de cobertura | |

Veredito: aprovado com ressalvas
