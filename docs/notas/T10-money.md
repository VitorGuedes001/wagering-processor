# T10 — Money e payloadHash

> Estado: Testada · Raia: C · Revisor: G · Branch: `claude/t10-money-29fa4e` (criada pelo app, não renomeada)

## O que muda

- `src/domain/money.ts`: corpos de `Money` (parse e formatação textuais, centavos em `bigint`, aritmética e comparação com checagem de moeda). Assinaturas do M0 intactas.
- `src/domain/payload-hash.ts`: corpos de `canonicalJson` e `payloadHash`. Assinaturas do M0 intactas.
- `test/unit/money.test.ts`: casos de MODELAGEM 12 para `Money`, mais U-01 e U-02.
- `test/unit/payload-hash.test.ts`: casos de MODELAGEM 12 para `payloadHash`, mais `canonicalJson`.

## Por quê

- **D8:** centavos em `bigint`. `BigInt(inteiro) * 100n + BigInt(centavos)` depois da regex (ARQUITETURA 8).
- **D9 / MODELAGEM 2.1:** `from` aceita só `^(0|[1-9]\d*)\.\d{2}$`. Nada é arredondado. Cada entrada rejeitada da tabela de 2.1 tem um teste. Também rejeita espaço, `\n` no fim, vírgula, `.50` e dígito não ASCII (JS: `\d` sem a flag `u` é só ASCII, `$` sem `m` é fim da string).
- **Limite:** até 17 dígitos inteiros (`numeric(19,2)`), checado pelo comprimento da string antes do `BigInt`. Vale para `from` e para `fromPersistence`.
- **Restrição 5.1:** sem `parseFloat`, `Number(`, `toFixed` nem `Math.` (nem em comentário, para a guarda A-03 da T15 não acusar falso positivo). Formatação com `/ 100n`, `% 100n` e `padStart`.
- **U-01:** `from` confere `typeof amount === 'string'` em tempo de execução, porque o JSON da borda não respeita o tipo estático. `props` nulo ou sem `amount` também vira `InvalidMoneyError`.
- **`fromPersistence`:** aceita `-` (a `difference` da reconciliação, MODELAGEM 2.1). Continua exigindo 2 casas, 17 dígitos e `currency` `^[A-Z]{3}$`: se o banco devolver outra coisa, é bug e é melhor falhar alto.
- **Moeda divergente:** `add`, `subtract`, `isLessThan` e `equals` lançam `CurrencyMismatchError`. `zero` valida a moeda.
- **MODELAGEM 9.1:** `canonicalJson` ordena chaves em todos os níveis, sem espaços, e omite propriedade `undefined`. `payloadHash` = `sha256` hex via `node:crypto`.
- **HTTP e SQS com o mesmo hash:** `payloadHash` copia só os campos de 9.1 antes de serializar. `WagerCommand` (`application/contracts.ts`) é superconjunto de `PayloadHashInput`, então quem passar o comando inteiro não muda o hash com `idempotencyKey`, `correlationId`, `causationId` ou campos do envelope.

## Abordagem

Tarefa sem 🔒 e com arquivos listados no briefing (EXECUCAO §6). Não houve aprovação prévia.

- Arquivos que vou tocar: `src/domain/money.ts`, `src/domain/payload-hash.ts`, `test/unit/money.test.ts`, `test/unit/payload-hash.test.ts` e esta nota.
- Assinaturas públicas: as do M0 (tag `m0-contratos`), sem mudança. Só funções e constantes privadas do módulo foram criadas (`toCents`, `formatCents`, `checkCurrency` e as regex).
- Alternativas descartadas e motivo:
  - `decimal.js`: D8 tirou essa dependência.
  - `JSON.stringify` com *replacer* de array de chaves para ordenar: só ordena com uma lista global de chaves e não omite `undefined` dentro de arrays de forma explícita. A recursão própria é curta e deixa as regras visíveis.
  - `payloadHash` serializando `input` direto: o hash mudaria com campos extras do comando (ver "Por quê").

**Aprovação do humano:** não se aplica (sem 🔒, arquivos listados no briefing)

## Ordem de leitura do diff

1. `src/domain/money.ts`: as duas regex, `toCents` (limite de 17 dígitos antes do `BigInt`) e `formatCents` (sinal tratado à parte, valor absoluto formatado). Depois `from`: checagem de tipo em runtime (U-01).
2. `test/unit/money.test.ts`: a tabela de rejeitados bate com MODELAGEM 2.1. U-01 e U-02 estão nomeados.
3. `src/domain/payload-hash.ts`: `canonicalJson` (ordem: `toJSON`, array, objeto, primitivo) e a cópia explícita dos campos em `payloadHash`.
4. `test/unit/payload-hash.test.ts`: o caso do JSON canônico literal fixa o formato. Se ele mudar, todo hash já gravado deixa de casar.

## Como verificar

```bash
bun test ./test/unit/money.test.ts ./test/unit/payload-hash.test.ts
bun run tarefa:gate
```

Gate em 2026-10-28, depois de `git rebase main` (já em dia): typecheck, skills,
unidade (77 testes) e arquitetura verdes. Integração e concorrência não rodam:
a branch só toca `src/domain` e `test/unit`.

## Decisões pendentes

- (nenhuma)

Interpretações que tomei dentro do que os docs dizem. O revisor pode contestar:

- `canonicalJson` mantém `null` explícito como `null`. "Nunca `null`" (9.1) é sobre opcional ausente, que é omitido. `PayloadHashInput` não tem campo que aceite `null`.
- `canonicalJson` segue `JSON.stringify` em `toJSON` (um `Money` vira `MoneyProps`) e em `bigint` (lança `TypeError`). Valor sem representação JSON no topo (`undefined`, função) lança `TypeError`.
- O hash usa `money` aninhado (`{"money":{"amount":…,"currency":…}}`), como em `PayloadHashInput` e na notação `money.amount` de 9.1.

## Pedidos ao integrador

- (nenhum)

Observação de processo: o app do Claude criou o worktree da sessão em
`backend-challenge/.claude/worktrees/t10-money-29fa4e`, que pertence ao repositório
externo `backend-challenge` (só tem o README). A branch desta tarefa foi criada no
repositório `wagering-processor`, num worktree aninhado em
`.claude/worktrees/t10-money-29fa4e/wagering-processor`, com o mesmo nome que o app deu.
O worktree aparece em `git worktree list` do `wagering-processor`.

## Fora de escopo / dívida

- Overflow de `add` além de 17 dígitos não é checado no domínio: o `numeric(19,2)` do schema rejeita na gravação (restrição 9).
- Lista ISO-4217 completa fica fora, como MODELAGEM 2.1 documenta.
- Guarda estática A-03 (sem `Math.` etc.) é da T15. Conferi à mão com `grep` que os dois arquivos estão limpos.

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
