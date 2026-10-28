---
name: revisao-cruzada
description: Revisa a branch de uma tarefa TNN do Wagering Processor feita pela outra ferramenta (Claude revisa Antigravity e vice-versa) contra os docs, as restrições invioláveis e o checklist de revisão. Escreve os achados na nota da tarefa. Use quando pedirem para revisar uma tarefa, uma branch tNN ou fazer a revisão cruzada.
---

# Revisão cruzada

Você revisa, não corrige. **Não altere código da branch.** O único arquivo que
você edita é a nota da tarefa (`docs/notas/TNN-*.md`), seção "Revisão cruzada".

## 1. Contexto

```bash
git log --oneline main..tNN-slug
git diff --stat main...tNN-slug
```

Leia a nota inteira e a linha da tarefa em `docs/EXECUCAO.md` §6. Depois, leia os
docs que a nota cita, **antes** do diff. Assim você compara com a regra, não
com a intenção do autor.

## 2. Rodar

No worktree da tarefa (ou faça `git worktree add` de uma cópia só de leitura):

```bash
bun run tarefa:gate
```

Registre o resultado. Gate vermelho é achado bloqueante.

## 3. Ler o diff na ordem da nota

Para cada arquivo, verifique:

| Item | Pergunta |
|---|---|
| Escopo | o arquivo está nos "Arquivos que vou tocar"? |
| Regra | o código faz o que a seção citada dos docs diz? Procure casos que a regra cobre e o código não |
| Dinheiro | algum `number`, `parseFloat`, `Number(`, `toFixed` ou `Math.` em caminho de dinheiro? |
| Camadas | `domain` importa Nest, ORM, AWS ou zod? `interface` importa ORM ou AWS? |
| Banco | garantia exigida pelo SCHEMA está só no código e não no schema? |
| Concorrência | leitura e escrita de saldo fora do lock da wallet? Evento publicado dentro da transação? |
| Testes | os IDs do aceite existem? Usam infra real? Alguma asserção mais fraca do que o TESTES.md descreve? |
| Decisões | alguma escolha que os docs não fazem e que não está em "Decisões pendentes"? |
| Clareza | o humano entenderia este trecho só com a nota? |

## 4. Escrever

Na tabela "Revisão cruzada" da nota, um achado por linha:

- **Severidade:** `bloqueante` (viola doc, restrição ou teste), `importante`
  (bug provável, caso não coberto) ou `menor` (clareza, nome);
- **Arquivo:linha**;
- **Achado:** o problema e a regra violada, com referência;
- **Resolução:** deixe vazio. O autor preenche.

Feche com `Veredito: aprovado`, `aprovado com ressalvas` ou `mudanças necessárias`.

Não reporte gosto pessoal como achado. Se não há nada a apontar, escreva isso, e
diga o que verificou.
