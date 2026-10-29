# Passo 4 — Modelagem de domínio e códigos de falha

Entidades, invariantes, transições e a taxonomia de `failureCode`. Parte do
mapeamento em [REAPROVEITAMENTO.md](REAPROVEITAMENTO.md) e fecha o que lá ficou
como "decisão própria". `§N` aponta para a seção N de [CHALLENGE.md](CHALLENGE.md).

Fica fora deste passo e vai para o passo 5: tabelas, índices, constraints e
estratégia de lock. Aqui aparecem só as garantias que o schema terá de sustentar.

---

## 1. Decisões

Cada decisão resolve uma ambiguidade do passo 3. Todas são revisáveis e vão para
o `ARCHITECTURE.md` com a justificativa.

| # | Decisão | Por quê |
|---|---|---|
| D1 | Uma transação é revertida **no máximo uma vez, por qualquer kind** (`REFUND` ou `ROLLBACK`). Reversão rejeitada não ocupa a vaga | §7.4, lido ao pé da letra, permite `REFUND` + `ROLLBACK` da mesma `BET`: crédito em dobro, contra §3 |
| D2 | Referência informada é resolvida **igual para todo kind** que aceita referência (`WIN`, `LOSS`, `REFUND`, `ROLLBACK`). Se não existe, vira `PENDING_REFERENCE` | Uma regra só em vez de exceção por kind. §7.8 não restringe a reversões |
| D3 | `LOSS` aceita `amount >= 0.00`. Os demais kinds exigem `> 0.00` | `LOSS` não move saldo. O provedor pode mandar o stake ou zero |
| D4 | Idempotência por `(providerId, idempotencyKey)`, e não global | A key vem do provedor. Global deixa provedores colidirem |
| D5 | Header `Idempotency-Key` ausente é payload inválido. O servidor não preenche o default | "Obrigatório" (§9). O default é o que o provedor deve enviar |
| D6 | Mesmo `(providerId, externalTransactionId)` com outra key é conflito, mesmo com payload idêntico | A key é a fonte da verdade (§9). Duas keys para uma operação é erro do provedor |
| D7 | Mesmo `messageId` na inbox com `payloadHash` diferente vai para a DLQ, com log e métrica | Anomalia do transporte. Não há resposta "certa" para escolher |
| D8 | `Money` usa `bigint` em centavos | Escala fixa de 2 casas (§6.1) torna inteiro em unidade mínima exato e nativo. `decimal.js` sai das dependências |
| D9 | `Money` nunca arredonda: mais de 2 casas é rejeitado | §6.1. Não há multiplicação nem divisão no domínio, então nada produz casa extra |
| D10 | A transação guarda o **saldo resultante** como snapshot | §7.7 exige o saldo daquele momento no replay. `LOSS` e `REJECTED` não têm lançamento de onde tirar |
| D11 | `PENDING_REFERENCE`: 10 tentativas, backoff exponencial de 1 s até no máximo 5 min (~13,5 min no total) | Fora de ordem aqui é reordenação de transporte, resolvida em segundos. Configurável por env |
| D12 | O outbox nunca desiste: backoff exponencial com a primeira retentativa em 2 s e teto de 60 s (fórmula em §7), sem limite de tentativas. Lag vira métrica | §11: "sem perder". Desistir seria perder evento confirmado |
| D13 | `WALLET_NOT_FOUND` não persiste transação | Sem wallet não há FK válida. Reenviar depois de criar a wallet processa normalmente |
| D14 | `FAILED` não emite evento | Nenhum dos eventos mínimos cobre. Visível por consulta e métrica |

Decisões do T01 (contratos, M0), aprovadas em 28/10/2026 — `docs/notas/T01-contratos.md`:

| # | Decisão | Por quê |
|---|---|---|
| D42 | A transação `OPENING` é criada por `WagerTransaction.opening(...)`, já `PROCESSED`. O use case `CreateWallet` chama `Wallet.open` e `WagerTransaction.opening` | O lançamento de abertura precisa de uma linha de transação (FK, SCHEMA 2.3), e `Wallet.open` não deve conhecer `WagerTransaction` |
| D43 | `BackoffPolicy { baseMs, maxMs, maxAttempts }` é parâmetro de `markPendingReference`, `scheduleReferenceRetry`, `referenceAttemptsExhausted` e `decideWager` | Os valores vêm de env (D11), e o domínio não lê env |
| D44 | `EventContext` carrega o `eventId`, gerado pelo use case | O domínio não gera id (`IdGenerator` é porta) |
| D45 | Os `*State` usam tipos de domínio (`Money`, `Date`, enums). A conversão de `numeric` acontece no repositório | O domínio nunca vê string de banco. A regra 5.1 fica num lugar só |
| D46 | `markProcessed(referenceTransactionId, balanceAfter, at)`, `reject(code, balanceAfter, at)`, `fail(code, at)`: desvio explícito do esqueleto de §6.3 | Snapshot do saldo exigido por D10. §6 permite adaptar assinaturas |
| D47 | Enums com `enum` do TypeScript | Reuso literal do enunciado |

Decisões da T12 (WagerTransaction), aprovadas em 28/10/2026 — `docs/notas/T12-wager-transaction.md`:

| # | Decisão | Por quê |
|---|---|---|
| D54 | `WagerTransaction.opening` com valor zero lança `InvalidWagerRequestError` | É "valor fora da regra do kind" (4.2). Na prática não acontece: `CreateWallet` só chama `opening` com saldo positivo (§3) |
| D55 | `ledgerDirectionFor` lança `InvalidTransactionStateError` para `LOSS` e para `ROLLBACK` sem referência reversível | É bug de quem chama, não regra de negócio: vira 500 |
| D56 | `markPendingReference` não verifica se a transação tem referência; só a origem (`PENDING`) é restrita, como em 4.3 | Segue 4.3 à risca. Quem garante é o `decideWager`, que só devolve `AWAIT_REFERENCE` quando há referência |
| D57 | O worker de referências (T16, T42) considera a referência esgotada **logo depois** do retry que leva `attempts` a `maxAttempts`, sem esperar mais um ciclo | Com `attempts >= max` checado antes do retry, sairiam 11 tentativas (~18,5 min), e não as 10 de D11 (~13,5 min) |

Decisões da T11 (Wallet e ledger), aprovadas em 28/10/2026 — `docs/notas/T11-wallet.md`:

| # | Decisão | Por quê |
|---|---|---|
| D58 | Guardas além de §3 e §6: `WalletLedgerEntry.create` rejeita `balanceBefore` negativo e `walletVersion` que não seja inteiro `>= 1` (`LedgerArithmeticError`); `Wallet.open` rejeita `initialBalance` negativo (`InvalidMoneyError`) | Repetem no domínio os `CHECK` do schema (SCHEMA 2.1, 2.3) e a D16, para o erro aparecer antes do banco |
| D59 | `debit`/`credit` com valor zero ou negativo lançam `LedgerArithmeticError`, não `InvalidMoneyError` | Chegar ali é bug (`decideWager` filtra antes e `LOSS` não move saldo): tem que virar 500, não um 400 que culpa o cliente (10.4) |

Decisões da T16 (`decideWager` e `reconcile`), aprovadas em 28/10/2026 — `docs/notas/T16-decide-wager.md`:

| # | Decisão | Por quê |
|---|---|---|
| D61 | Referência em `PENDING` ou `PENDING_REFERENCE` só devolve `AWAIT_REFERENCE` no passo 4 enquanto `!transaction.referenceAttemptsExhausted(backoff)`; quando as tentativas acabam, cai no passo 5 e é rejeitada com `REFERENCE_NOT_PROCESSED` | Garante que `decideWager` nunca devolve `AWAIT_REFERENCE` após esgotar as 10 tentativas de D11/D57, e reserva `REFERENCE_NOT_FOUND` para referência inexistente (§7.1) |
| D70 | Eventos emitidos pelo worker de referências levam `correlationId = transaction.id` e `causationId = transaction.idempotencyKey` | A transação não guarda o `correlationId` original, e a seção 8 admite a idempotency key como causa. Fica rastreável sem coluna nova (T42, decisão 5) |

## 2. Value objects

### 2.1 Money

```ts
class Money {
  private constructor(
    private readonly cents: bigint,   // D8
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: rejeita negativo. */
  static from(props: MoneyProps): Money;
  /** Leitura do banco: aceita o que o schema já validou. */
  static fromPersistence(amount: string, currency: string): Money;
  static zero(currency: string): Money;

  add(other: Money): Money;
  subtract(other: Money): Money;   // pode ficar negativo (diferença de reconciliação)
  negate(): Money;
  // isZero, isPositive, isNegative, isLessThan, equals, toJSON, toString como §6.1
}
```

| Regra | Implementação |
|---|---|
| `amount` | regex `^(0|[1-9]\d*)\.\d{2}$`, com exatamente 2 casas na entrada |
| Rejeitados | vazio, `NaN`, `Infinity`, `1e3`, `+5.00`, `05.00`, `5`, `5.0`, `5.000`, `-5.00` |
| Limite | até 17 dígitos inteiros, para caber em `numeric(19,2)` |
| `currency` | regex `^[A-Z]{3}$`. Lista ISO completa fica fora de escopo, documentado |
| Moedas diferentes | `add`, `subtract`, `isLessThan` e `equals` lançam `CurrencyMismatchError` |
| Serialização | `toJSON()` → `{ amount: "25.00", currency: "BRL" }`, com sinal `-` quando negativo |

`from` rejeita negativo porque §6.1 proíbe negativo **em contrato de entrada**. A
aritmética interna aceita negativo, porque a `difference` da reconciliação pode
ser negativa.

### 2.2 Identificadores

IDs internos são UUIDv7, gerados pela aplicação (as fixtures de §9 já são v7).
`providerId`, `externalTransactionId`, `roundId` e `gameId` são strings opacas do
provedor, não vazias, com no máximo 128 caracteres.

## 3. Wallet (aggregate root)

```ts
class Wallet {
  static open(props: {
    id: string; playerId: string; initialBalance: Money;
    openingTransactionId: string; at: Date;
  }): { wallet: Wallet; openingEntry?: WalletLedgerEntry };

  static rehydrate(state: WalletState): Wallet;

  canDebit(money: Money): boolean;
  debit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry;
  credit(money: Money, transactionId: string, entryId: string, at: Date): WalletLedgerEntry;
}
```

| Invariante | Onde é garantida |
|---|---|
| Saldo nunca negativo | `debit` lança `InsufficientFundsError`. A regra de negócio consulta `canDebit` antes, então a exceção indica bug. O schema repete com `CHECK` |
| Toda alteração de saldo tem lançamento | `debit`/`credit` **retornam** o `WalletLedgerEntry`: não existe caminho que altera saldo sem produzir lançamento |
| Moeda da operação = moeda da wallet | `CurrencyMismatchError` em `debit`/`credit` |
| `version` começa em 1 e só sobe quando o saldo muda | `open` cria com `version = 1`, já com o saldo inicial. `debit`/`credit` fazem `version++` |
| Valor movimentado > 0 | `debit`/`credit` rejeitam zero |
| Uma wallet por `playerId` + `currency` | Só o schema garante (unicidade). O domínio não enxerga outras wallets |

`open` com `initialBalance` zero não gera `OPENING` nem lançamento.

## 4. WagerTransaction

### 4.1 Estado

Os campos de §6.3, mais três (D10 e D11):

| Campo novo | Tipo | Para quê |
|---|---|---|
| `_balanceAfter` | `Money \| undefined` | snapshot do saldo no momento do desfecho, para o replay |
| `_referenceAttempts` | `number` | tentativas de resolver a referência |
| `_nextReferenceAttemptAt` | `Date \| undefined` | quando o worker tenta de novo |

### 4.2 Regras por kind

| Kind | Referência | Kinds referenciáveis | Valor | Direção no ledger |
|---|---|---|---|---|
| `OPENING` | proibida | — | `> 0` | `CREDIT` |
| `BET` | proibida | — | `> 0` | `DEBIT` |
| `WIN` | opcional | `BET` | `> 0`, livre | `CREDIT` |
| `LOSS` | opcional | `BET` | `>= 0` (D3) | nenhuma |
| `REFUND` | obrigatória | `BET` | igual à referência | `CREDIT` |
| `ROLLBACK` | obrigatória | `BET`, `WIN`, `REFUND` | igual à referência | inversa da referência |

`ledgerDirectionFor(reference)` para `ROLLBACK` devolve o oposto de
`reference.ledgerDirectionFor()`: `BET` vira `CREDIT`; `WIN` e `REFUND` viram
`DEBIT`. Para `LOSS`, lança erro, porque não há direção (`affectsBalance()` é
`false`).

`create` valida a forma e lança `InvalidWagerRequestError`, que vira payload
inválido e não cria transação, quando:

- o kind é `OPENING` vindo de fora;
- falta referência em `REFUND`/`ROLLBACK`;
- há referência em `BET`;
- a referência aponta para a própria `externalTransactionId`;
- o valor está fora da regra do kind.

### 4.3 Transições

```
             ┌──────────── markProcessed ────────────▶ PROCESSED
             ├──────────── reject(code) ─────────────▶ REJECTED
 PENDING ────┼──────────── fail(code) ───────────────▶ FAILED
             └── markPendingReference ──▶ PENDING_REFERENCE
                                              │  scheduleReferenceRetry (fica)
                                              ├── markProcessed ──▶ PROCESSED
                                              ├── reject(code) ───▶ REJECTED
                                              └── fail(code) ─────▶ FAILED
```

| Método | Origem permitida | Efeito |
|---|---|---|
| `markProcessed(referenceTransactionId, balanceAfter, at)` | `PENDING`, `PENDING_REFERENCE` | grava referência resolvida, snapshot e `processedAt` |
| `reject(code, balanceAfter, at)` | `PENDING`, `PENDING_REFERENCE` | grava código e snapshot |
| `fail(code, at)` | `PENDING`, `PENDING_REFERENCE` | grava código. Sem snapshot |
| `markPendingReference(now)` | `PENDING` | `attempts = 0`, agenda a primeira tentativa |
| `scheduleReferenceRetry(now)` | `PENDING_REFERENCE` | `attempts++`, recalcula `nextReferenceAttemptAt`. Não muda status |
| `referenceAttemptsExhausted()` | — | consulta, `attempts >= limite` (D11) |

Origem terminal → `InvalidTransactionStateError`, que é bug e nunca vira
`failureCode` (§6.3).

## 5. Regra de negócio: `decideWager`

A decisão fica numa **função pura** do domínio, separada da aplicação do efeito.
Todos os casos de §7 ficam testáveis em unidade sem banco, e HTTP e SQS chamam o
mesmo caminho.

```ts
type WagerDecision =
  | { type: 'APPLY'; direction: LedgerDirection | undefined }  // undefined = LOSS
  | { type: 'REJECT'; code: FailureCode }
  | { type: 'AWAIT_REFERENCE' };

function decideWager(input: {
  transaction: WagerTransaction;
  wallet: Wallet;
  reference: WagerTransaction | undefined;   // buscada por (providerId, referenceExternalTransactionId)
  referenceAlreadyReversed: boolean;          // D1
}): WagerDecision;
```

Ordem das verificações. A primeira que falha decide, e a ordem é fixa para o
`failureCode` ser determinístico:

| # | Verificação | Falha → |
|---|---|---|
| 1 | wallet pertence ao `playerId` | `WALLET_PLAYER_MISMATCH` |
| 2 | moeda da operação = moeda da wallet | `CURRENCY_MISMATCH` |
| 3 | referência informada existe | `AWAIT_REFERENCE` (ou `REFERENCE_NOT_FOUND` se as tentativas acabaram) |
| 4 | referência está `PENDING` ou `PENDING_REFERENCE` | `AWAIT_REFERENCE` (ou, com as tentativas esgotadas, segue para o 5 e vira `REFERENCE_NOT_PROCESSED`, D61) |
| 5 | referência está `PROCESSED` | `REFERENCE_NOT_PROCESSED` |
| 6 | kind da referência é permitido (4.2) | `REFERENCE_KIND_NOT_ALLOWED` |
| 7 | mesma wallet, player, moeda e rodada | `REFERENCE_CONTEXT_MISMATCH` |
| 8 | valor igual (só `REFUND`/`ROLLBACK`) | `REFERENCE_AMOUNT_MISMATCH` |
| 9 | referência ainda não revertida (só `REFUND`/`ROLLBACK`) | `REFERENCE_ALREADY_REVERSED` |
| 10 | saldo cobre o débito: `BET` | `INSUFFICIENT_FUNDS` |
| 10 | saldo cobre o débito: `ROLLBACK` de `WIN`/`REFUND` | `REVERSAL_INSUFFICIENT_FUNDS` |
| — | tudo passou | `APPLY` |

O provider da referência é sempre o mesmo, porque a busca já é por
`(providerId, …)` (§7.2). `WALLET_NOT_FOUND` é verificado antes, pelo use case
(D13).

Aplicação, já dentro da transação SQL e com a wallet travada (passo 5):

| Decisão | Wallet | Ledger | Transação | Eventos |
|---|---|---|---|---|
| `APPLY` + direção | `debit`/`credit` | 1 lançamento | `markProcessed` | `WagerTransactionProcessed` + `WalletBalanceChanged` |
| `APPLY` sem direção (`LOSS`) | — | — | `markProcessed` | `WagerTransactionProcessed` |
| `REJECT` | — | — | `reject` | `WagerTransactionRejected` |
| `AWAIT_REFERENCE`, 1ª vez | — | — | `markPendingReference` | `WagerTransactionPendingReference` |
| `AWAIT_REFERENCE`, retry do worker | — | — | `scheduleReferenceRetry` | nenhum |

`OPENING` não passa por `decideWager`: nasce `PROCESSED` dentro de `Wallet.open`,
com `WagerTransactionProcessed` + `WalletBalanceChanged`.

## 6. WalletLedgerEntry

`create({ id, walletId, transactionId, walletVersion, direction, money, balanceBefore, balanceAfter, at })`
lança `LedgerArithmeticError` se:

- `money` não for positivo;
- as moedas de `money`, `balanceBefore` e `balanceAfter` diferirem;
- `balanceBefore ± money !== balanceAfter`;
- `balanceAfter` for negativo.

Sem métodos de mutação. Só `Wallet.debit`/`credit` (e `Wallet.open`) chamam
`create`, então o lançamento nasce junto com a mudança de saldo.

`walletVersion` é a `version` da wallet **depois** do lançamento: o `OPENING`
fica com 1, e cada `debit`/`credit` com a nova versão. O campo não está em §6.4.
Ele existe porque o schema usa `UNIQUE(wallet_id, wallet_version)` para barrar
lost update e ordenar o extrato ([SCHEMA.md](SCHEMA.md), D16).

## 7. Inbox e Outbox

**InboxMessage:** `receive({ messageId, consumerName, payloadHash, at })` e
`markProcessed(at)`. Mensagem rejeitada por negócio também fica `processed`: o
processamento terminou, o desfecho está na transação. `payloadHash` divergente
no mesmo `messageId` segue D7.

**OutboxMessage:** `enqueue(event)` copia `eventId`, `eventType`, `aggregateId`
e `occurredAt` do evento, grava `payload = event.toJSON()` e agenda a primeira
tentativa para `occurredAt`: o instante vem do evento, sem parâmetro à parte. Já
`scheduleRetry(now)` faz `attempts++` e calcula
`next = now + min(2^attempts s, 60 s)`, sem limite (D12). O relógio é injetado,
sem jitter no domínio, para os testes serem determinísticos.

## 8. Eventos

Todos com `version = 1`. `correlationId` vem do header `X-Correlation-Id` ou do
`messageId` da fila. `causationId` é o `messageId` ou a idempotency key.

| Evento | `aggregateId` | `data` |
|---|---|---|
| `WagerTransactionProcessed` | `transactionId` | `transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId, kind, money, referenceTransactionId?, balanceAfter, processedAt` |
| `WagerTransactionRejected` | `transactionId` | `transactionId, providerId, externalTransactionId, walletId, kind, money, failureCode, balanceAfter` |
| `WalletBalanceChanged` | `walletId` | igual a §11 |
| `WagerTransactionPendingReference` | `transactionId` | `transactionId, providerId, externalTransactionId, walletId, kind, referenceExternalTransactionId` |

Todo `Money` sai como `MoneyProps`, e datas saem em ISO-8601.

## 9. Idempotência

### 9.1 payloadHash

`sha256(canonicalJson(campos))` em hex, com os campos:

```
providerId, externalTransactionId, playerId, walletId, roundId, gameId,
kind, money.amount, money.currency, referenceExternalTransactionId (se houver)
```

- Chaves ordenadas em todos os níveis, sem espaços e com campos opcionais
  ausentes **omitidos** (nunca `null`).
- Ficam fora: o header, `idempotencyKey`, `messageId`, `type` e `occurredAt`
  do envelope SQS.
- HTTP e SQS geram o mesmo hash para a mesma operação. Por isso a mesma operação
  chegando pelos dois caminhos é replay, e não duplicata.

### 9.2 Resolução

| Busca | Resultado | Resposta |
|---|---|---|
| `(providerId, idempotencyKey)` encontrada, mesmo hash | replay | resposta original + `idempotentReplay: true` |
| `(providerId, idempotencyKey)` encontrada, hash diferente | conflito | `IDEMPOTENCY_CONFLICT` |
| key nova, mas `(providerId, externalTransactionId)` já existe | conflito (D6) | `EXTERNAL_ID_CONFLICT` |
| nada encontrado | processa | — |

A resposta do replay é montada da transação persistida: `status`,
`failureCode` e o snapshot `balanceAfter` (D10). Por isso o replay devolve o
saldo daquele momento, não o atual. A corrida entre duas requisições novas
iguais é resolvida pela unicidade no schema (passo 5).

## 10. Códigos

### 10.1 `failureCode`, gravados na transação

| Código | Status | Situação | Ação do provedor |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | `REJECTED` | `BET` maior que o saldo | não reenviar |
| `REVERSAL_INSUFFICIENT_FUNDS` | `REJECTED` | `ROLLBACK` de `WIN`/`REFUND` negativaria o saldo (§7.9) | escalar, caso operacional |
| `CURRENCY_MISMATCH` | `REJECTED` | moeda ≠ wallet | corrigir, novo `externalTransactionId` |
| `WALLET_PLAYER_MISMATCH` | `REJECTED` | wallet de outro player | corrigir, novo `externalTransactionId` |
| `REFERENCE_NOT_FOUND` | `REJECTED` | referência não apareceu até o limite (D11) | investigar a referência |
| `REFERENCE_NOT_PROCESSED` | `REJECTED` | referência `REJECTED`/`FAILED`, ou ainda pendente quando as tentativas acabaram (D61) | não reenviar |
| `REFERENCE_KIND_NOT_ALLOWED` | `REJECTED` | ex.: `REFUND` de `WIN`, `ROLLBACK` de `LOSS` | corrigir |
| `REFERENCE_CONTEXT_MISMATCH` | `REJECTED` | wallet, player, moeda ou rodada diferentes | corrigir |
| `REFERENCE_AMOUNT_MISMATCH` | `REJECTED` | valor ≠ referência (reversão parcial fora de escopo) | corrigir |
| `REFERENCE_ALREADY_REVERSED` | `REJECTED` | referência já tem reversão `PROCESSED` (D1) | não reenviar |
| `PROCESSING_FAILED` | `FAILED` | erro permanente de infraestrutura após o limite de tentativas | contatar a operação |

Rejeição é terminal: reenviar com a mesma key devolve a mesma rejeição como
replay. Corrigir exige um novo `externalTransactionId`.

### 10.2 Erros de requisição, sem transação persistida

| Código | Situação |
|---|---|
| `INVALID_PAYLOAD` | forma inválida, `Money` inválido, regras de `create` (4.2), header ausente (D5) |
| `IDEMPOTENCY_CONFLICT` | mesma key, payload diferente |
| `EXTERNAL_ID_CONFLICT` | mesmo id externo com outra key (D6) |
| `WALLET_NOT_FOUND` | wallet inexistente (D13) |
| `WALLET_ALREADY_EXISTS` | `POST /wallets` duplicado para `playerId` + `currency` |
| `SERVICE_UNAVAILABLE` | falha transitória (Postgres ou SQS indisponível, conflito de lock esgotado) |

### 10.3 Status HTTP (proposta, fecha no passo 6)

| Situação | HTTP |
|---|---|
| `PROCESSED` | 200 (201 em `POST /wallets`) |
| `PENDING_REFERENCE` | 202 |
| `REJECTED` (qualquer `failureCode`) | 422 |
| `INVALID_PAYLOAD` | 400 |
| `WALLET_NOT_FOUND` | 404 |
| `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `WALLET_ALREADY_EXISTS` | 409 |
| `SERVICE_UNAVAILABLE` | 503 |

Replay usa o mesmo status do original: um `REJECTED` repetido continua 422,
agora com `idempotentReplay: true`. O corpo de erro sempre traz `code`, o que
permite ao provedor decidir sem ler mensagem.

Na fila, os mesmos casos viram: 422/404 → ack; 400 e D7 → DLQ; 503 → retry com
backoff.

### 10.4 Exceções de domínio (bugs ou validação, nunca `failureCode`)

`InvalidMoneyError` · `CurrencyMismatchError` · `InvalidWagerRequestError` ·
`InvalidTransactionStateError` · `InsufficientFundsError` (guarda da `Wallet`) ·
`LedgerArithmeticError`.

As três primeiras viram `INVALID_PAYLOAD` quando ocorrem na borda. As outras
indicam bug e viram 500 com log de erro.

## 11. Reconciliação

`reconcile(wallet, entries)` percorre os lançamentos em ordem e verifica:

1. o primeiro `balanceBefore` é zero;
2. cada `balanceBefore` é igual ao `balanceAfter` anterior (cadeia sem buraco);
3. `calculatedBalance = Σ CREDIT − Σ DEBIT`;
4. `consistent = calculatedBalance == wallet.balance` **e** a cadeia está íntegra.

Resultado no formato de §9, com `difference = stored − calculated` (pode ser
negativa) e `checkedEntries`. Divergência é logada, contada em métrica e
devolvida, nunca corrigida.

## 12. Cobertura em testes de unidade

| Alvo | Casos |
|---|---|
| `Money` | cada entrada rejeitada de 2.1, `0.00`, limite de 17 dígitos, aritmética, moeda divergente, `toJSON` de negativo |
| `Wallet` | `open` com e sem saldo, `version`, `canDebit` no limite exato, `debit` além do saldo lança, moeda divergente |
| `WagerTransaction` | cada linha de 4.2 em `create`, cada transição de 4.3, terminal lança, `ledgerDirectionFor` por kind e por referência |
| `decideWager` | cada linha da tabela de 5, incluindo a ordem quando duas regras falham juntas |
| `WalletLedgerEntry` | aritmética válida e cada violação |
| `payloadHash` | ordem de chaves irrelevante, opcional omitido ≠ presente, HTTP e SQS geram o mesmo hash |
| `reconcile` | consistente, saldo divergente, cadeia quebrada |
