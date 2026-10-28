---
name: iniciar-tarefa
description: Começa uma tarefa TNN do plano de execução do Wagering Processor. Verifica dependências na main, prepara worktree, branch e nota, lê o briefing e os docs citados. Use quando pedirem para pegar, começar ou implementar uma tarefa (ex. "comece a T12").
---

# Iniciar tarefa

Siga na ordem. Não pule passos, e não comece a codar antes do passo 5.

## 1. Preparar

Na pasta do repositório:

```bash
bun run tarefa:iniciar TNN          # cria ../wp-TNN, branch e nota
bun run tarefa:iniciar TNN --aqui   # se você já está num worktree próprio
```

O script **recusa** se alguma dependência não está `Entregue` na `main`, ou se
você está na `main`. Se recusar, pare e informe o que falta. Não contorne.

Se criou um worktree novo, todo o trabalho a partir daqui acontece nele.

## 2. Ler o briefing

O briefing é a linha da tarefa nas tabelas de `docs/EXECUCAO.md` §6: conteúdo,
arquivos, aceite. Leia também:

- `AGENTS.md`, sempre;
- cada documento e seção citados na linha (ex.: MODELAGEM 4.2, SCHEMA 2.3);
- os IDs de teste do aceite em `docs/TESTES.md` §4;
- o código já entregue que a tarefa consome. A partir do M0, os contratos estão
  em `src/domain/` e `src/application/ports.ts`.

## 3. Fixar o escopo

Na nota (`docs/notas/TNN-*.md`), seção **Abordagem**, liste os arquivos que vai
tocar:

- se a linha da EXECUCAO traz a coluna "Arquivos", use exatamente essa lista;
- se não traz, proponha a lista. Isso torna a tarefa dependente de aprovação,
  como uma 🔒.

## 4. Abordagem (tarefas 🔒, ou sem lista de arquivos)

Preencha na nota:

- **Arquivos que vou tocar**;
- **Assinaturas públicas** que vai criar ou implementar;
- **Alternativas descartadas** e o motivo, ligado aos docs.

Depois, **pare** e diga ao humano: "Abordagem da TNN pronta para aprovação em
`docs/notas/TNN-….md`". Só continue quando o humano escrever a aprovação (na
conversa ou na linha "Aprovação do humano" da nota).

## 5. Implementar

- Commits atômicos com o porquê no corpo (formato em `AGENTS.md`).
- Escreva a "Ordem de leitura do diff" na nota **enquanto** implementa, não no
  fim.
- Achou algo que os docs não decidem: anote em "Decisões pendentes", proponha e
  **pare**.
- Precisa mexer em arquivo de alto conflito: anote em "Pedidos ao integrador" e
  siga sem mexer.

Para terminar, use a skill `entregar-tarefa`.
