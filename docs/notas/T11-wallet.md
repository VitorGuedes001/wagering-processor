# T11 — Wallet e WalletLedgerEntry

> Estado: Testada · Raia: G · Revisor: C · Branch: `t11-wallet`

## O que muda

- `src/domain/wallet-ledger-entry.ts`: implementa `WalletLedgerEntry.create`, `WalletLedgerEntry.rehydrate` e `isBalanced()`, validando aritmética, sinal, versão e moeda com `LedgerArithmeticError`.
- `src/domain/wallet.ts`: implementa `Wallet.open`, `Wallet.rehydrate`, `canDebit`, `debit` e `credit`, garantindo versão inicial `1`, incremento de `version` somente em mudanças de saldo e criação acoplada do `WalletLedgerEntry`.
- `test/unit/wallet-ledger-entry.test.ts`: suíte unitária cobrindo criação válida (`CREDIT`/`DEBIT`), `isBalanced()`, `rehydrate` e todas as violações de `MODELAGEM 6`.
- `test/unit/wallet.test.ts`: suíte unitária cobrindo abertura com e sem saldo inicial, `rehydrate`, `canDebit` (abaixo, no limite exato, acima e moeda divergente), `debit`, `credit` e integridade da cadeia de lançamentos (`MODELAGEM 3` e `MODELAGEM 12`).

## Por quê

- **Imutabilidade e aritmética do ledger (`CHALLENGE §6.4`, `MODELAGEM 6`, `D16`):** cada lançamento é imutável por estrutura, carrega `walletVersion` pós-movimentação e rejeita com `LedgerArithmeticError` valores não positivos, moedas divergentes, saldos negativos, `walletVersion < 1` ou soma/subtração inconsistente (`balanceBefore ± money !== balanceAfter`).
- **Invariantes do aggregate root `Wallet` (`CHALLENGE §6.2`, `MODELAGEM 3`, `D42`, `D45`):**
  - Saldo nunca fica negativo (`canDebit` consulta antes e `debit` lança `InsufficientFundsError` sem mutar o estado se violado).
  - Toda alteração de saldo produz e retorna um `WalletLedgerEntry` (`debit`, `credit` e `open` com `initialBalance > 0`).
  - `open` com `initialBalance` zero inicia em `version = 1` e não gera `openingEntry`.
  - `open` com `initialBalance > 0` inicia em `version = 1` (o `OPENING` não incrementa além de 1) e gera `openingEntry` com `walletVersion = 1` e `balanceBefore = 0.00`.
  - `debit` e `credit` exigem mesma moeda (`CurrencyMismatchError`) e valor estritamente positivo (`InvalidMoneyError`), incrementando `version` a cada mutação de saldo.
- **Restrição 5.1 (`CHALLENGE §5.1`, `ARQUITETURA 8`):** toda aritmética monetária delega a `Money` (centavos em `bigint`), sem `number`, `parseFloat`, `Number(`, `toFixed` ou `Math.`.

## Abordagem

- **Arquivos tocados:**
  - `src/domain/wallet-ledger-entry.ts`
  - `src/domain/wallet.ts`
  - `test/unit/wallet-ledger-entry.test.ts`
  - `test/unit/wallet.test.ts`
  - `docs/notas/T11-wallet.md`
- **Assinaturas públicas:** mantidas exatamente como congeladas no M0 (`T01`).
- **Alternativas descartadas e motivo:**
  - *Derivar o zero com `initialBalance.subtract(initialBalance)`:* usado enquanto a T10 não estava na `main`. Depois do rebase, voltou a ser `Money.zero` (commit `36d7874`).
  - *Deixar a validação de moeda em `WalletLedgerEntry.create` para o `Money.add`/`subtract`:* descartado porque `Money` lança `CurrencyMismatchError`, enquanto `MODELAGEM 6` especifica `LedgerArithmeticError` quando as moedas de `money`, `balanceBefore` e `balanceAfter` diferem no lançamento.

## Ordem de leitura do diff

1. `src/domain/wallet-ledger-entry.ts` — validações de `WalletLedgerEntry.create` (sinal de `money`, igualdade de moedas antes da aritmética, não-negatividade de `balanceBefore`/`balanceAfter`, `walletVersion >= 1` e fechamento contábil por direção), `rehydrate` sem revalidação e `isBalanced()`.
2. `src/domain/wallet.ts` — `Wallet.open` (tratamento de saldo zero vs. positivo com `version = 1`), `rehydrate`, `canDebit`, `debit` e `credit` (guardas de moeda, sinal e saldo antes de mutar `_balance`, `_version` e `_updatedAt`).
3. `test/unit/wallet-ledger-entry.test.ts` — casos válidos e cada violação de invariante de `WalletLedgerEntry`.
4. `test/unit/wallet.test.ts` — casos de `open`, `canDebit` no limite exato, `debit`/`credit`, preservação de estado em erro e cadeia sequencial de `walletVersion` e saldos.

## Como verificar

```bash
bun run tarefa:gate
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

- (nenhum)

## Fora de escopo / dívida

- (nenhum). O `Money` falso que os testes usavam antes da T10 foi removido no commit `36d7874`: os testes usam só o `Money` real.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| 1 | menor | `docs/notas/T11-wallet.md:33`, `:59` | Nota desatualizada após `36d7874`. "Alternativas descartadas" ainda diz que `Money.zero` foi substituído por `initialBalance.subtract(initialBalance)`, mas o código voltou a usar `Money.zero` (`wallet.ts:69`). "Fora de escopo / dívida" ainda cita o fallback local do helper `money(...)`, que o mesmo commit removeu. O humano lê a nota para entender o diff (EXECUCAO, clareza). | Corrigido: as duas passagens agora descrevem o estado pós-rebase. |
| 2 | menor | `src/domain/wallet-ledger-entry.ts:68`, `:71`; `src/domain/wallet.ts:51` | Há guardas além do que MODELAGEM 6 e 3 listam: `balanceBefore` negativo, `walletVersion` inteiro `>= 1` (ambos lançam `LedgerArithmeticError`) e `initialBalance` negativo em `open` (lança `InvalidMoneyError`). Elas são coerentes com o `CHECK` do schema e com D16, mas são escolhas que os docs não fazem e que não estão em "Decisões pendentes" nem em "Por quê" (AGENTS, escopo 2). Proposta: registrar na nota ou na MODELAGEM 6. | Aceito pelo humano e registrado como D58 na MODELAGEM. |
| 3 | menor | `src/domain/wallet.ts:123-125`, `:156-158` | Quando `debit`/`credit` recebem zero ou valor negativo, lançam `InvalidMoneyError`. Pela MODELAGEM 10.4, esse erro vira `INVALID_PAYLOAD` (400) na borda. Chegar aqui com valor não positivo, porém, é bug, porque `decideWager` filtra antes e `LOSS` não move saldo. Se escapar até a borda, o bug fica mascarado como erro do cliente, em vez de virar 500. O tipo do erro não está fixado nos docs: MODELAGEM 3 diz só "rejeitam zero", e o JSDoc diz "ou erro". Sugestão: confirmar a escolha ou registrá-la como decisão. | Humano decidiu por `LedgerArithmeticError` (bug → 500), D59. `debit`/`credit` e os dois testes trocados. `open` com saldo negativo continua `InvalidMoneyError` (D58). |

Verificado sem achado:

- **Gate** (`bun run tarefa:gate`, 28/10/2026): typecheck ok, skills ok, unidade 107 pass / 0 fail, arquitetura 1 pass.
- **Contratos M0:** `git diff main...t11-wallet -- src/domain` só troca corpos `notImplemented` e imports (`import type` → valor). Nenhuma assinatura pública, `*State` ou `*Props` mudou.
- **`version`:** começa em 1 com e sem saldo inicial, e o `OPENING` não incrementa (`openingEntry.walletVersion = 1`). Só `debit`/`credit` fazem `+1`. Em erro (saldo, valor, moeda), `version`, `balance` e `updatedAt` ficam intactos, porque a mutação vem depois de `WalletLedgerEntry.create`.
- **Lançamento:** `debit`/`credit` sempre devolvem o lançamento, com `walletVersion` igual à nova versão. A cadeia 1→4 e `balanceBefore == balanceAfter anterior` estão testadas.
- **Guardas de `debit`:** acima do saldo lança `InsufficientFundsError`, e o limite exato é permitido. Zero ou negativo é rejeitado. Moeda divergente lança `CurrencyMismatchError` em `canDebit`, `debit` e `credit`.
- **`WalletLedgerEntry.create`:** lança `LedgerArithmeticError` em cada caso de MODELAGEM 6 (valor zero/negativo, cada uma das 3 combinações de moeda, aritmética de CREDIT e de DEBIT, direção invertida, `balanceAfter` negativo). A moeda é checada antes da aritmética, então não vaza `CurrencyMismatchError` do `Money`. `rehydrate` não revalida, e `isBalanced()` devolve `false` para dado adulterado.
- **Restrição 5.1:** nenhum `parseFloat`, `Number(`, `toFixed` ou `Math.` no diff. Toda a aritmética de dinheiro passa por `Money` (`bigint`). O único `%` é em `walletVersion`, que não é dinheiro.
- **Camadas:** `domain` importa só `./errors`, `./money` e `./wallet-ledger-entry`.
- **Test doubles:** nenhum. O commit `36d7874` removeu o `Money` falso, e os testes usam `Money.from`/`fromPersistence` reais, sem mock, spy ou stub.
- **Commit do integrador `36d7874`:** correto. `Money.zero(initialBalance.currency)` é equivalente ao `subtract` anterior e mais claro. `import { Money }` como valor é necessário. O helper de teste segue a MODELAGEM 2.1, já que negativo só existe via `fromPersistence`.
- **MODELAGEM 12:** `Wallet` (open com e sem saldo, `version`, `canDebit` no limite exato, debit além do saldo, moeda divergente) e `WalletLedgerEntry` (aritmética válida e cada violação) estão todos cobertos. Não falta caso.

Veredito: aprovado com ressalvas
