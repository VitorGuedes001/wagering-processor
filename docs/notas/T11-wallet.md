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
  - *Chamar `Money.zero(currency)` dentro de `Wallet.open`:* substituído por `props.initialBalance.subtract(props.initialBalance)` para derivar o zero na mesma moeda exclusivamente via método de instância do `Money` recebido.
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

- O helper `money(...)` nos testes unitários delega para `Money.from` / `Money.fromPersistence` e possui fallback local caso `T10` ainda não esteja mergeada na `main`. Assim que `T10` estiver na `main`, o caminho real de `Money` é exercitado automaticamente.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
