# T12 — WagerTransaction 🔒

> Estado: Implementada · Raia: C · Revisor: G · Branch: `t12-wager-transaction`

## O que muda

Uma frase por arquivo tocado.

## Por quê

Regras atendidas, com referência aos docs (ex.: MODELAGEM 4.3; D2).

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

- **Arquivos que vou tocar:** `src/domain/wager-transaction.ts`,
  `test/unit/wager-transaction.test.ts` (novo) e esta nota.
- **Assinaturas públicas:** nenhuma muda. Só os corpos de `notImplemented('T12')`
  no contrato do M0. Helper de backoff fica privado no módulo (não exportado).

### `create`: validações (MODELAGEM 4.2, D3)

Todas lançam `InvalidWagerRequestError`. Ordem fixa: kind, referência, valor.
"Referência presente" = `referenceExternalTransactionId !== undefined`.
`Money` já chega validado por `Money.from` (formato, sinal, moeda: `InvalidMoneyError`).

| Kind | Validação | Erro |
|---|---|---|
| `OPENING` (em runtime, apesar do tipo `SubmittableKind`) | kind vindo de fora | `InvalidWagerRequestError` |
| qualquer kind fora do enum | kind desconhecido | `InvalidWagerRequestError` |
| `BET` | referência presente | `InvalidWagerRequestError` |
| `BET` | `money` zero | `InvalidWagerRequestError` |
| `WIN` | referência = própria `externalTransactionId` | `InvalidWagerRequestError` |
| `WIN` | `money` zero | `InvalidWagerRequestError` |
| `LOSS` | referência = própria `externalTransactionId` | `InvalidWagerRequestError` |
| `LOSS` | `money` zero **aceito** (D3) | — |
| `REFUND` | referência ausente | `InvalidWagerRequestError` |
| `REFUND` | referência = própria `externalTransactionId` | `InvalidWagerRequestError` |
| `REFUND` | `money` zero | `InvalidWagerRequestError` |
| `ROLLBACK` | referência ausente | `InvalidWagerRequestError` |
| `ROLLBACK` | referência = própria `externalTransactionId` | `InvalidWagerRequestError` |
| `ROLLBACK` | `money` zero | `InvalidWagerRequestError` |

"Valor igual à referência" (`REFUND`/`ROLLBACK`) e "kinds referenciáveis" não são
validáveis em `create` (não há referência carregada): são `decideWager` passos 6 e 8
(`REFERENCE_KIND_NOT_ALLOWED`, `REFERENCE_AMOUNT_MISMATCH`), T16.

Estado inicial: `PENDING`, `createdAt = updatedAt = at`, `referenceAttempts = 0`,
demais opcionais `undefined`.

`opening(props)` (D42): `OPENING`, `PROCESSED`, `balanceAfter = money`,
`processedAt = createdAt = updatedAt = at`, campos de provedor `undefined`.
`money` zero lança `InvalidWagerRequestError` (linha `OPENING > 0` de 4.2; ver
decisão pendente 1). `rehydrate(state)` copia o estado sem validar nada (§6.0).

### Transições (MODELAGEM 4.3, D46)

| Método \ origem | `PENDING` | `PENDING_REFERENCE` | `PROCESSED` | `REJECTED` | `FAILED` |
|---|---|---|---|---|---|
| `markProcessed` | → `PROCESSED` | → `PROCESSED` | lança | lança | lança |
| `reject` | → `REJECTED` | → `REJECTED` | lança | lança | lança |
| `fail` | → `FAILED` | → `FAILED` | lança | lança | lança |
| `markPendingReference` | → `PENDING_REFERENCE` | **lança** | lança | lança | lança |
| `scheduleReferenceRetry` | **lança** | fica (`attempts++`) | lança | lança | lança |

"lança" = `InvalidTransactionStateError`. Efeitos, todos com `updatedAt = at/now`:

- `markProcessed(refId, balanceAfter, at)`: grava `referenceTransactionId`,
  `balanceAfter`, `processedAt = at`.
- `reject(code, balanceAfter, at)`: grava `failureCode` e `balanceAfter`
  (snapshot D10). Não grava `processedAt`.
- `fail(code, at)`: grava `failureCode`. Sem snapshot.
- `markPendingReference(now, p)`: `attempts = 0`, `next = now + delay(0)`.
- `scheduleReferenceRetry(now, p)`: `attempts++`, `next = now + delay(attempts)`
  (já incrementado).
- Ao sair de `PENDING_REFERENCE` para terminal, `nextReferenceAttemptAt` vira
  `undefined` (nada mais a agendar; o worker filtra por status de qualquer jeito).

Consultas: `isTerminal()` = status ∈ {`PROCESSED`, `REJECTED`, `FAILED`};
`affectsBalance()` = kind ≠ `LOSS`; `requiresReference()` = kind ∈ {`REFUND`,
`ROLLBACK`}; `matchesPayload(h)` = `payloadHash === h` (`false` no `OPENING`);
`referenceAttemptsExhausted(p)` = `attempts >= p.maxAttempts`.

### Backoff (D11, D43)

```
delay(attempts) = min(baseMs × 2^attempts, maxMs)
nextReferenceAttemptAt = new Date(now.getTime() + delay(attempts))
```

Não é caminho de dinheiro, então `number` e `Math.min` são permitidos. `2^attempts`
estoura para `Infinity` acima de ~1023 e o `min` devolve `maxMs`, sem caso especial.
Com `base = 1000`, `max = 300000`: atrasos para `attempts = 0..9` são 1, 2, 4, …,
256, 300 s, soma 811 s ≈ 13,5 min, que bate com D11.

### `ledgerDirectionFor(reference?)` (4.2)

| Kind | Resultado |
|---|---|
| `OPENING`, `WIN`, `REFUND` | `CREDIT` (ignora `reference`) |
| `BET` | `DEBIT` |
| `LOSS` | lança `InvalidTransactionStateError` |
| `ROLLBACK` de `BET` | `CREDIT` |
| `ROLLBACK` de `WIN` / `REFUND` | `DEBIT` |
| `ROLLBACK` sem `reference` | lança `InvalidTransactionStateError` |
| `ROLLBACK` de `LOSS`/`ROLLBACK`/`OPENING` | lança `InvalidTransactionStateError` (kind não referenciável; `decideWager` rejeita antes) |

### Testes (`test/unit/wager-transaction.test.ts`)

Uma linha de teste por linha das tabelas acima (create por kind, matriz de
transição completa 5×5 incluindo terminal → tudo lançando, backoff com relógio
fixo, `ledgerDirectionFor` por kind e por referência). `Money` real via
`Money.from`, sem dublê. Enquanto a T10 não estiver na `main`, os testes falham
com "Não implementado: T10" e ficam verdes depois do merge dela.

### Alternativas descartadas

- **Validar "valor igual à referência" e "kind referenciável" em `create`**:
  exigiria carregar a referência no domínio de criação; MODELAGEM 5 já põe isso
  em `decideWager` com `failureCode` próprio (rejeição persistida, não 400).
- **Validar tamanho/vazio de `providerId`, ids e `roundId` (MODELAGEM 2.2) em
  `create`**: é forma da borda (zod no HTTP/SQS). Duplicar aqui criaria duas
  fontes de verdade. Fica fora, salvo decisão contrária.
- **Tabela de transições como mapa genérico `from → to[]`**: 5 métodos com
  efeitos diferentes; um guard `assertFrom(...allowed)` por método é mais legível
  e o erro diz o método e o estado.
- **`ledgerDirectionFor` de `LOSS` devolver `undefined`**: o contrato devolve
  `LedgerDirection` e manda lançar (4.2). `decideWager` usa `affectsBalance()`
  antes.
- **Erro genérico `Error` para `LOSS`/`ROLLBACK` sem referência**: a lista de
  10.4 é fechada; `InvalidTransactionStateError` é a que significa "bug do chamador".
- **`Money` falso nos testes**: proibido pelo briefing; usa o `Money` real da T10.

**Aprovação do humano:** aprovada em 28/10/2026, com as propostas das decisões
pendentes 1, 2 e 3. A 4 fica registrada para a T16.

## Ordem de leitura do diff

1. `arquivo` — o que olhar nele

## Como verificar

```bash
bun run tarefa:gate
```

## Decisões pendentes

Todas resolvidas pelo humano em 28/10/2026: 1, 2 e 3 como propostas. A 4 fica
registrada para a T16.

1. **Erro de `opening` com `money` zero.** 4.2 diz `OPENING > 0`, mas não diz o
   erro; `CreateWallet` nem chama `opening` com saldo zero (MODELAGEM 3).
   Proposta: `InvalidWagerRequestError` (é "valor fora da regra do kind").
2. **Erro de `ledgerDirectionFor` para `LOSS` e `ROLLBACK` sem referência válida.**
   4.2 diz só "lança". Proposta: `InvalidTransactionStateError` (bug do chamador,
   vira 500).
3. **Guardas não escritas em 4.3**: `markPendingReference` numa transação sem
   `referenceExternalTransactionId` (ex.: `BET`) é bug, mas 4.3 só restringe a
   origem. Proposta: **não** adicionar guarda (sigo 4.3 à risca); `decideWager`
   só devolve `AWAIT_REFERENCE` quando há referência.
4. **Contagem de tentativas (para a T16).** Com `exhausted = attempts >= max`, e
   `decideWager` checando antes de `scheduleReferenceRetry`, o worker faz 11
   tentativas (attempts 0..10) e espera 1 111 s, não os ~13,5 min de D11. Fica
   exato se a T16 considerar esgotado logo após o retry que leva `attempts` a
   `max`. Não muda a T12 (sigo `attempts >= max` de 4.3); só registro para a T16.

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- (nenhum)

## Fora de escopo / dívida

- (nenhum)

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
