---
name: integrar-tarefa
description: Integra na main uma tarefa TNN já validada pelo humano no Wagering Processor. Faz merge no-ff, atualiza o quadro, roda o gate na main e cria a tag do marco quando ele fecha. Use somente quando o humano pedir explicitamente para integrar, mergear ou entregar uma tarefa. Nunca por iniciativa própria.
---

# Integrar tarefa

**Só com pedido explícito do humano nesta conversa**, nomeando a tarefa. Se o
pedido não está claro, pergunte. Este é o único fluxo que escreve na `main`.

## 1. Pré-condições (todas obrigatórias)

- a nota tem `Veredito: aprovado` (ou `aprovado com ressalvas`, com as ressalvas
  resolvidas);
- o humano disse que validou (checklist de `docs/EXECUCAO.md` §4);
- "Decisões pendentes" vazio, ou cada item aprovado e registrado como `Dn` no doc
  de origem;
- a branch está rebaseada na `main`: `git merge-base --is-ancestor main tNN-slug`.

Se alguma falta, pare e diga qual.

## 2. Pedidos ao integrador

Se a nota pede mudanças em arquivos de alto conflito (`app.module.ts`, config do
ORM, `package.json`), mostre ao humano exatamente o que vai mudar e aplique na
branch, num commit `chore(tNN): pedidos ao integrador`, **antes** do merge.

## 3. Merge

```bash
git switch main
git merge --no-ff tNN-slug -m "TNN — Título" -m "<2 linhas: o que entrega e marcos/IDs de teste>"
```

## 4. Gate na main

```bash
bun run tarefa:gate --tudo
```

Vermelho: **não** siga. Mostre ao humano. Reverter é decisão dele
(`git revert -m 1 <merge>`).

## 5. Quadro e marco

- Em `docs/TAREFAS.md`, mude o estado da tarefa para `Entregue` e preencha a
  coluna Nota com o caminho.
- Se a tarefa fecha um marco (tabela "Marcos"), confirme com o humano, marque o
  marco e crie a tag: `git tag -a m4-fatia-vertical -m "M4 — …"`.
- Commit: `docs: TNN entregue`.

## 6. Limpar

```bash
git worktree remove ../wp-TNN
git branch -d tNN-slug
```

Rode `bun run tarefa:status` e diga ao humano o que ficou liberado.
