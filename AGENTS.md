# Regras para agentes — Wagering Processor

Vale para qualquer agente neste repositório: Claude Code (lê este arquivo via
`CLAUDE.md`) e Antigravity (lê este arquivo direto). Em conflito com o pedido de
uma tarefa, **este arquivo vence**. Na dúvida, pare e pergunte.

## O projeto

Serviço financeiro que processa apostas (`BET`, `WIN`, `LOSS`, `REFUND`,
`ROLLBACK`) com wallet materializada e ledger imutável. Stack: Bun, TypeScript
estrito, NestJS, MikroORM, PostgreSQL e SQS (LocalStack).

Tudo o que o código precisa fazer já está decidido em `docs/`. Leia o que a
tarefa citar antes de escrever código:

| Documento | Conteúdo |
|---|---|
| `docs/CHALLENGE.md` | enunciado. `§N` nos docs aponta para cá |
| `docs/MODELAGEM.md` | entidades, invariantes, transições, `failureCode`. Decisões D1–D14 |
| `docs/SCHEMA.md` | tabelas, constraints, triggers, concorrência. D15–D22 |
| `docs/ARQUITETURA.md` | camadas, portas, use cases, HTTP, SQS. D23–D32 |
| `docs/TESTES.md` | testes por ID (`U-`, `I-`, `C-`) e infra de teste. D33–D41 |
| `docs/EXECUCAO.md` | como as tarefas são feitas, revisadas e entregues |
| `docs/TAREFAS.md` | quadro: estado de cada tarefa (a versão da `main` é a que vale) |

## Como uma tarefa anda

`Proposta → Abordagem (só 🔒) → Implementada → Testada → Revisada → Validada → Entregue`

- Você trabalha **uma tarefa por vez**, numa branch `tNN-slug`, num worktree
  próprio. Nunca na `main`.
- Comece com a skill `iniciar-tarefa` (ou `bun run tarefa:iniciar TNN`). Ela
  recusa começar se as dependências não estão entregues na `main`.
- Tarefa marcada 🔒: escreva a seção **Abordagem** da nota e **pare**. Só codifique
  depois que o humano aprovar.
- Termine com a skill `entregar-tarefa` (gate + nota completa).
- **Só o humano** faz merge na `main`, atualiza `docs/TAREFAS.md` e cria tags.

Uma tarefa é "terminada" quando está mergeada na `main`. Nada mais conta. Para
saber o que está liberado: `bun run tarefa:status`.

## Regras de escopo

1. Toque **só os arquivos permitidos** pelo briefing. Se o briefing não lista
   arquivos, proponha a lista na seção Abordagem da nota e espere aprovação.
2. **Não decida o que os docs não decidem.** Registre em "Decisões pendentes" na
   nota, com a sua proposta e o motivo, e pare.
3. Não edite `src/app.module.ts`, `src/infrastructure/persistence/mikro-orm.config.ts`,
   `package.json` nem `bun.lock`. Se precisar, escreva o pedido na nota: quem
   aplica é o integrador.
4. Depois do marco M0, `src/application/ports.ts` e as assinaturas públicas de
   `src/domain/` estão congeladas. Mudá-las é decisão pendente.
5. **Não altere testes de aceite** (os IDs de `docs/TESTES.md`) nem constraints do
   schema para fazer algo passar. Se o teste parece errado, é decisão pendente.

## Restrições invioláveis (CHALLENGE §5)

1. Dinheiro nunca é `number`, `float` ou `double`. Nada de `parseFloat`,
   `Number(`, `toFixed` ou `Math.` em caminho de dinheiro. `amount` é string na
   borda, `bigint` em centavos no domínio e `numeric(19,2)` no banco.
2. Idempotência nunca em memória: está no banco (índices únicos e inbox).
3. SQS FIFO é otimização, não garantia.
4. Nenhum evento é publicado dentro da transação: vai para o outbox.
5. Ledger não é atualizado nem apagado.
6. Nada de lock global: o lock é por wallet (`SELECT … FOR UPDATE`).
7. Saldo nunca como `read → calculate → update` sem o lock da wallet.
8. Tem que funcionar com várias instâncias: nada de estado de correção em memória.
9. Unicidade, imutabilidade e não-negatividade vivem **no schema**.

## Camadas (ARQUITETURA §2)

- `src/domain`: só TypeScript puro. Sem Nest, MikroORM, AWS SDK nem zod.
- `src/application`: use cases e portas. Sem MikroORM nem AWS SDK.
- `src/infrastructure`: adaptadores (ORM, SQS, relógio, ids, métricas).
- `src/interface`: HTTP, consumidor SQS, workers, health. Sem MikroORM nem AWS SDK
  direto.

## Testes

- Postgres e LocalStack **reais**. Não mocke banco nem fila.
- Cada arquivo de teste usa banco e filas próprios (TESTES D34/D35). Nunca use o
  banco `wagering` nem as filas padrão em teste.
- Sem `sleep`: use `eventually()`.
- Rode o gate antes de pedir revisão: `bun run tarefa:gate`.

## Infra compartilhada: proibido

- `docker compose down`, `docker compose down -v`, recriar ou parar containers
  (outros agentes usam a mesma infra);
- matar processo por nome (`taskkill /IM`, `pkill bun`). Só por PID, e só o que
  você criou;
- apagar bancos ou filas que não foram criados pelo seu teste.

## Commits

- Commits atômicos na branch da tarefa: `feat(t12): …`, `test(t12): …`,
  `fix(t12): …`, `docs(t12): …`.
- O corpo diz **por quê**, citando a regra (ex.: "MODELAGEM 4.3: terminal não
  transiciona").
- Termine as mensagens com `Co-Authored-By` da sua ferramenta, se ela usar.
- Nunca `--no-verify`, nunca commit na `main`, nunca `push`.

## Skills deste projeto

Em `.agents/skills/` (Antigravity) e `.claude/skills/` (Claude Code, cópia gerada
por `bun run skills:sync`; edite só em `.agents/skills/`).

| Skill | Quem usa |
|---|---|
| `iniciar-tarefa` | agente, no começo de uma tarefa |
| `entregar-tarefa` | agente, ao terminar |
| `revisao-cruzada` | agente da outra ferramenta, revisando a branch |
| `explicar-mudanca` | humano, para entender um diff |
| `status-tarefas` | qualquer um, só leitura |
| `integrar-tarefa` | **só o humano** pede: merge, quadro e tag |

## Comandos

```bash
bun run tarefa:status            # o que está liberado, em andamento, bloqueado
bun run tarefa:iniciar T12       # worktree + branch + nota (recusa se dependência faltar)
bun run tarefa:iniciar T12 --aqui  # idem, no worktree atual (sessão que já tem worktree)
bun run tarefa:gate              # typecheck + testes pelo que a branch tocou
bun run typecheck
bun run test                     # unidade + arquitetura (sem Docker)
bun run test:integration
bun run test:concurrency
```
