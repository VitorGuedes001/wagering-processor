@AGENTS.md

## Específico do Claude Code

- As skills do projeto estão em `.claude/skills/`, que é **cópia gerada** de
  `.agents/skills/`. Edite só em `.agents/skills/` e rode `bun run skills:sync`.
  Um teste de arquitetura falha se as duas pastas divergirem.
- Sessão do Claude desktop que já roda num worktree próprio: use
  `bun run tarefa:iniciar TNN --aqui`, que não cria outro worktree.
- O subagente `revisor` (`.claude/agents/revisor.md`) faz a revisão cruzada de
  uma branch do Antigravity. Ele lê, roda testes e escreve só na nota da tarefa.
