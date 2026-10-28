---
name: status-tarefas
description: Mostra o andamento das tarefas do Wagering Processor a partir do quadro na main e do git, incluindo o que está liberado, em andamento, esperando revisão e bloqueado, e qual o próximo marco. Somente leitura. Use quando perguntarem o status, o que falta, o que dá para começar ou o que a outra raia terminou.
---

# Status das tarefas

Somente leitura: não edite nada, não crie branch nem worktree.

```bash
bun run tarefa:status
```

O script lê `docs/TAREFAS.md` **da `main`**, a mesma para todos os worktrees e
ferramentas, e cruza com o git. Responda com:

1. **Liberadas agora:** tarefas `Proposta` com todas as dependências entregues.
   Indique a raia sugerida e se é 🔒.
2. **Em andamento:** por estado. Destaque o que está esperando o humano:
   `Abordagem` e `Validada`.
3. **Bloqueadas:** cada uma com as dependências que faltam.
4. **Alertas** que o script reportar: limite de agentes ativos, fila de revisão
   maior que 3, inconsistências entre o quadro e o git.
5. **Próximo marco:** qual é e o que falta para ele.

Se o humano perguntar "o que a outra raia terminou", a resposta é o que está
`Entregue` na `main`. Trabalho só numa branch ainda não terminou.
