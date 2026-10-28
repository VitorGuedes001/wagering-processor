# Plano de execução — agentes em paralelo, com domínio humano do código

Como a implementação acontece. Os agentes (Claude Code e Antigravity) escrevem a
maior parte do código, várias tarefas ao mesmo tempo. O humano **entende e aprova
cada mudança antes de ela entrar na `main`**, sabendo o que mudou e por quê.

Este documento não muda o *quê* (está em [MODELAGEM](MODELAGEM.md),
[SCHEMA](SCHEMA.md), [ARQUITETURA](ARQUITETURA.md) e [TESTES](TESTES.md)). Ele
reorganiza o *como* e o *quando* de [PLANO.md](PLANO.md) para trabalho
paralelo.

---

## 1. Princípios

1. **O humano é o integrador.** Só ele faz merge na `main`. Agente nunca commita
   na `main` nem faz merge.
2. **Nenhuma decisão nova em silêncio.** Toda escolha que não está nos `docs/`
   vira uma *decisão pendente* na nota da tarefa. O agente para e pergunta. Se
   aprovada, ganha um número `Dn` no documento de origem.
3. **Mudança pequena e explicada.** Uma tarefa cabe numa revisão de ~20 min: até
   ~400 linhas de diff, excluindo testes. Toda tarefa entrega uma nota que diz
   o que mudou, por quê e em que ordem ler o diff.
4. **Contrato antes de paralelo.** Agentes paralelos codificam contra
   interfaces já aprovadas e mergeadas (onda 0). Ninguém inventa a assinatura
   que outro agente vai consumir.
5. **Dono por arquivo.** Cada tarefa lista os arquivos que pode tocar. Fora da
   lista, só com aprovação. É o que evita conflito entre agentes.
6. **Teste crítico escrito antes ou por outro agente.** Os testes que provam
   eliminatórias (I-02, C-01, C-02, C-02b, C-07b, I-13, I-16) são escritos antes
   da implementação ou por um agente diferente do que implementa. Assim o
   implementador não "acerta o teste" afrouxando o teste.
7. **Revisão cruzada.** O código de uma ferramenta é revisado primeiro pela
   outra (Claude revisa Antigravity e vice-versa), e depois pelo humano. Modelos
   diferentes erram diferente.

## 2. Ciclo de vida de uma tarefa

```
 PROPOSTA ──▶ ABORDAGEM ──▶ IMPLEMENTADA ──▶ TESTADA ──▶ REVISADA ──▶ VALIDADA ──▶ ENTREGUE
  (quadro)   (só 🔒)        (agente)        (agente)    (agente      (humano)      (merge)
                                                         cruzado)
```

| Estado | Quem | Saída | Critério para avançar |
|---|---|---|---|
| Proposta | humano | linha no quadro (seção 7) com briefing | dependências entregues |
| Abordagem (só tarefas 🔒) | agente → humano | seção "Abordagem" da nota: arquivos, assinaturas, ordem | humano aprova em ≤ 10 min |
| Implementada | agente | commits atômicos na branch da tarefa | compila |
| Testada | agente | testes do aceite verdes, `typecheck` limpo, rebase na `main` | gate da seção 5 |
| Revisada | agente da outra ferramenta | comentários na nota (seção "Revisão cruzada") | nenhum achado bloqueante aberto |
| Validada | humano | checklist da seção 4 marcado | humano entende cada arquivo do diff |
| Entregue | humano | `git merge --no-ff`, quadro atualizado | `main` verde depois do merge |

As tarefas 🔒 são as que fixam algo que outras consomem, ou que guardam uma
eliminatória. Nelas, o agente propõe a abordagem **antes** de codar. É o momento
mais barato para corrigir rumo.

## 3. Nota de mudança

Cada tarefa cria `docs/notas/Txx-<slug>.md`. É o principal instrumento de
domínio: o humano lê a nota antes do diff.

```markdown
# T12 — WagerTransaction

## O que muda
Uma frase por arquivo tocado.

## Por quê
Regras atendidas, com link: MODELAGEM 4.2, 4.3; D2, D3.

## Abordagem (tarefas 🔒: escrita antes de codar)
Assinaturas públicas, alternativas descartadas e motivo.

## Ordem de leitura do diff
1. src/domain/wager-transaction.ts — estado e factories
2. … transições
3. test/unit/wager-transaction.test.ts — casos de 4.2 e 4.3

## Como verificar
bun test test/unit/wager-transaction.test.ts

## Decisões pendentes
- (vazio, ou: "X não está nos docs; proponho Y porque Z")

## Fora de escopo / dívida
O que ficou de fora de propósito.

## Revisão cruzada
Achados do agente revisor e como foram resolvidos.
```

O histórico fica legível de dois jeitos:

- `git log --first-parent main` mostra uma linha por tarefa entregue: o merge
  `--no-ff` com o título da tarefa;
- `git log main^1..main^2` mostra os commits atômicos dentro de uma tarefa,
  cada um com o "por quê" no corpo da mensagem.

## 4. Revisão humana (validação)

Ordem fixa, ~20 min por tarefa:

1. Ler a nota: o quê, por quê, decisões pendentes.
2. Rodar o "como verificar" no worktree da tarefa.
3. Ler o diff na ordem que a nota sugere. Para cada trecho que não for óbvio,
   pedir explicação ao agente ("por que `FOR UPDATE` aqui e não no passo 2?").
   Não aprovar o que não entendeu.
4. Marcar o checklist:

| Item | Pergunta |
|---|---|
| Escopo | só tocou os arquivos do briefing? |
| Decisões | toda escolha nova está em "Decisões pendentes" e foi aprovada? |
| Dinheiro (5.1) | nenhum `number`, `parseFloat` ou `Number(` em caminho de dinheiro? |
| Camadas | `domain` sem Nest/ORM/AWS? `interface` sem ORM/AWS? |
| Banco (5.9) | garantia nova no código também está no schema, quando o SCHEMA pede? |
| Testes | os IDs de aceite existem, rodam contra infra real e não foram afrouxados? |
| Eventos (5.4) | nada publicado dentro da transação? |
| Docs | se a tarefa fecha uma seção do `ARCHITECTURE.md`, ela foi escrita? |

Qualquer "não" volta a tarefa para o agente com o motivo escrito na nota.

## 5. Infra para trabalho paralelo

### 5.1 Worktrees e branches

Um worktree por tarefa ativa, fora da pasta principal:

```bash
git worktree add ../wp-T12 -b t12-wager-transaction main
cd ../wp-T12 && bun install --frozen-lockfile
```

| Item | Convenção |
|---|---|
| Branch | `tNN-slug` |
| Commit | `feat(t12): …`, `test(t12): …`, `fix(t12): …`. Corpo com o porquê |
| Merge | só humano: `git merge --no-ff tNN-slug -m "T12 — WagerTransaction"` |
| Depois do merge | `git worktree remove ../wp-T12`, branch apagada |

O Claude Code tem worktree nativo por sessão. No Antigravity, abrir a pasta do
worktree criado acima.

### 5.2 Recursos compartilhados

Todos os agentes usam **o mesmo** Postgres e o mesmo LocalStack do Compose. Isso
funciona porque o plano de testes já isola por arquivo de teste: banco clonado
do template (D34) e filas com prefixo (D35). Até o T15 entregar essa infra, só
rodam testes que não tocam banco.

| Recurso | Regra |
|---|---|
| Banco de desenvolvimento manual | `DB_NAME=wagering_tNN` no `.env` do worktree |
| Porta HTTP manual | `PORT=30NN` (ex.: T31 → 3031) |
| Filas manuais | as padrão só na pasta principal. Worktree usa prefixo `tNN-` |
| `docker compose down -v` | proibido para agentes: derruba o trabalho de todos |
| `taskkill /IM bun.exe` e afins | proibido: matar processo só por PID |

### 5.3 Arquivos de alto conflito

Esses arquivos são tocados por muitas tarefas. Só o **integrador** os edita, no
momento do merge, a partir do pedido escrito na nota da tarefa:

- `src/app.module.ts` (registro de módulos)
- `src/infrastructure/persistence/mikro-orm.config.ts` (lista de records)
- `src/application/ports.ts` depois da onda 0 (mudança de contrato = decisão)
- `package.json`, `bun.lock` (dependência nova = decisão)

### 5.4 Gate de entrega

Antes de pedir revisão, no worktree e depois de rebase na `main`:

```bash
bun run typecheck && bun run test            # sempre
bun run test:integration                     # se tocou persistência, fila ou HTTP
bun run test:concurrency                     # se tocou o fluxo de submissão, lock ou workers
```

Depois do merge, o integrador roda o mesmo gate na `main`. Vermelho na `main`
bloqueia novos merges até ser resolvido.

### 5.5 Regras, skills e scripts (entregues no T00)

| Arquivo | Lido por | Papel |
|---|---|---|
| `AGENTS.md` | Antigravity (nativo), Claude Code (via `@AGENTS.md` no `CLAUDE.md`) | regras de todos os agentes |
| `CLAUDE.md` | Claude Code | importa o `AGENTS.md` e traz notas específicas |
| `.agents/skills/*/SKILL.md` | Antigravity | **fonte** das skills |
| `.claude/skills/*/SKILL.md` | Claude Code | cópia gerada por `bun run skills:sync`. O teste de arquitetura falha se divergir |
| `.claude/agents/revisor.md` | Claude Code | subagente de revisão cruzada (só lê e escreve na nota) |
| `scripts/tarefas.ts` | os dois | `tarefa:status`, `tarefa:iniciar`, `tarefa:gate` |
| `docs/TAREFAS.md` | os dois (versão da `main`) | quadro |
| `docs/notas/_TEMPLATE.md` | os dois | template da nota de mudança |

Skills: `iniciar-tarefa`, `entregar-tarefa`, `revisao-cruzada`,
`explicar-mudanca` (para o humano), `status-tarefas` e `integrar-tarefa` (só
com pedido do humano).

**Coordenação entre ferramentas.** Claude e Antigravity não conversam entre si.
O único canal é o git:

- uma tarefa termina quando está mergeada na `main` e marcada `Entregue` no
  quadro da `main`;
- os worktrees compartilham o `.git`, então a `main` nova aparece para todos na
  hora;
- `tarefa:iniciar` recusa começar com dependência faltando;
- quem decide o próximo passo é o humano.

O `AGENTS.md` cobre, no mínimo:

- ler o briefing da tarefa, os docs citados nele e a nota (se já existe);
- só tocar os arquivos listados. Pedir antes de tocar outro;
- não decidir o que os docs não decidem: registrar em "Decisões pendentes" e
  parar;
- as 9 restrições invioláveis (CHALLENGE §5) e as regras de camada
  (ARQUITETURA 2);
- não alterar testes de aceite nem constraints do schema para fazer algo passar;
- não usar `docker compose down -v` nem matar processos por nome;
- commits atômicos com o porquê no corpo. Nunca commit na `main`;
- terminar com a nota preenchida e o gate da seção 5.4 verde.

## 6. Ondas e marcos

O grafo do PLANO é reorganizado em ondas. Dentro de uma onda, as tarefas não
dependem umas das outras e rodam em paralelo. No máximo **4 agentes ativos** e
**3 tarefas esperando revisão**: a revisão humana é o gargalo, e acumular fila
só gera rebase.

`C` = Claude Code, `G` = Antigravity (sugestão de raia; o revisor cruzado é a
outra). `🔒` = abordagem aprovada antes de codar.

### Onda 0 — Contratos (sequencial, humano junto)

| Tarefa | Conteúdo | Arquivos | Aceite | Est. |
|---|---|---|---|---|
| T00 ✔ | `AGENTS.md`, `CLAUDE.md`, skills, subagente revisor, `scripts/tarefas.ts`, quadro (seção 7), template de nota, scripts de teste por nível (seção 5.5) | raiz, `docs/`, `scripts/`, `.agents/`, `.claude/` | `bun run test` e `tarefa:gate` verdes | 0,5 h |
| T01 🔒 | **Contratos**: assinaturas públicas de todas as classes de domínio (corpo `throw new Error('not implemented')`), `failure-code.ts`, `errors.ts`, enums, `IntegrationEvent`, `application/ports.ts`, `SubmitOutcome`/`TransactionView` | `src/domain/**`, `src/application/ports.ts` | `typecheck` limpo. Humano revisou linha a linha | 1,5 h |

**Marco M0, contratos congelados.** Tag `m0-contratos`. Daqui em diante, mudar
assinatura pública é decisão (seção 1, princípio 2).

O T01 é feito em par (humano + sessão principal do Claude). É o arquivo que o
humano mais precisa dominar, porque todos os agentes vão codificar contra ele.

### Onda 1 — Domínio e schema (paralelo, 4 agentes)

| Tarefa | Raia | Conteúdo | Arquivos | Aceite | Est. |
|---|---|---|---|---|---|
| T10 | C | `Money`, `payloadHash` | `domain/money.ts`, `payload-hash.ts` | U `Money`, U-01, U-02, U `payloadHash` | 1,5 h |
| T11 | G | `Wallet`, `WalletLedgerEntry` | `domain/wallet.ts`, `wallet-ledger-entry.ts` | U `Wallet`, U `WalletLedgerEntry` | 1,5 h |
| T12 🔒 | C | `WagerTransaction`: `create`, transições, `ledgerDirectionFor` | `domain/wager-transaction.ts` | U `WagerTransaction` | 1,5 h |
| T13 | G | `InboxMessage`, `OutboxMessage`, eventos | `domain/inbox-*.ts`, `outbox-*.ts`, `domain/events/**` | U-03, U-04, U-05 | 1,5 h |
| T14 🔒 | C | migrations 01–03 com tabelas e triggers | `migrations/**` | I-01, I-02 (escritos no T15) | 3 h |
| T15 | G | infra de teste: preload, template, banco por arquivo, `invariants.ts`, `eventually`; testes A-01 a A-03; **testes I-01 e I-02** (antes do T14 terminar) | `test/support/**`, `test/architecture/**`, `test/integration/schema*.test.ts` | rodam e falham pelo motivo certo até o T14 entrar | 2,5 h |

T11 a T13 compilam contra o contrato do `Money` (T01). Os testes deles ficam
verdes quando o T10 entra, por isso o T10 é o primeiro a ser revisado na onda.

Onda 1b, quando T10 a T12 entram:

| Tarefa | Raia | Conteúdo | Aceite | Est. |
|---|---|---|---|---|
| T16 🔒 | G (revisa C) | `decideWager`, `reconcile` | U `decideWager` (cada linha e a ordem), U `reconcile` | 1,5 h |

**Marco M1, domínio verde.** `bun run test` verde, sem Docker. Tag
`m1-dominio`. O `ARCHITECTURE.md` §2 é escrito. Demo: rodar os testes de
`decideWager` e ler a tabela de casos.

**Marco M2, schema provado.** I-01 e I-02 verdes: cada constraint e trigger
tem um teste que a viola por SQL cru. Tag `m2-schema`. `ARCHITECTURE.md` §4.
Demo: tentar, à mão no `psql`, debitar sem lançamento e ver o commit falhar.

### Onda 2 — Persistência (paralelo, 3 agentes)

| Tarefa | Raia | Conteúdo | Arquivos | Aceite | Est. |
|---|---|---|---|---|---|
| T20 🔒 | C | Unit of Work (timeouts D21, snapshot), `db-errors`, records + repositórios de `wallet` e ledger | `persistence/unit-of-work.ts`, `db-errors.ts`, `records/wallet*`, `records/ledger*`, `wallet-repository.ts`, `ledger-repository.ts` | I-03 (wallet, ledger) | 2 h |
| T21 | G | record + repositório de `wager_transaction`, incluindo claim com `SKIP LOCKED` | `records/wager-transaction*`, `wager-transaction-repository.ts` | I-03 (transação) | 1,5 h |
| T22 | G | records + repositórios de inbox e outbox, com claim com lease | `records/inbox*`, `records/outbox*`, `*-repository.ts` | I-03 (inbox, outbox) | 1,5 h |

T21 e T22 implementam as portas do T01 e usam o `UnitOfWork` só pela interface.
A integração com o UoW real é testada depois do merge do T20.

**Marco M3, persistência.** Ida e volta de toda entidade, com dinheiro como
string. Tag `m3-persistencia`. `ARCHITECTURE.md` §3.

### Onda 3 — Fatia vertical e harness (paralelo, 4 agentes)

| Tarefa | Raia | Conteúdo | Aceite | Est. |
|---|---|---|---|---|
| T30 🔒 | C | use cases `CreateWallet` e `SubmitWagerTransaction` (fluxo SCHEMA 4.2, refaz em `23505`) | testes de use case contra banco real | 2,5 h |
| T31 | G | HTTP: schemas zod, controllers, mapeamento de status, `AuthGuard` no-op, `X-Correlation-Id`, queries | I-05 a I-11 | 2,5 h |
| T32 🔒 | C | harness: `spawnApp`, `spawnCluster`, portão de lock, `FaultInjector`. **Escreve C-01, C-02, C-02b, C-03 e I-04** antes do T30/T31 entrarem | os testes rodam e falham pelo motivo certo | 2,5 h |
| T33 | G | observabilidade base: logger JSON com ALS, registry de métricas com todos os nomes de ARQUITETURA 9, `/metrics` | I-22 | 1,5 h |

O T31 programa contra o `SubmitOutcome` do contrato. Os testes I-05 a I-11 ficam
verdes quando o T30 entra.

**Marco M4, fatia vertical.** Uma `BET` atravessa HTTP → use case → banco, com
replay, conflito e cada `failureCode`. Tag `m4-fatia-vertical`.
`ARCHITECTURE.md` §6 e §7. Demo: `curl` da fixture de §9 duas vezes, a segunda
com `idempotentReplay: true` e o saldo da primeira.

**Marco M5, concorrência provada.** C-01, C-02, C-02b e C-03 verdes com 3
processos, e `test:stress` 10× sem falha. Tag `m5-concorrencia`.
`ARCHITECTURE.md` §5. Demo: rodar o C-02 e ler no log as duas transações
disputando o lock. **A partir daqui, 6 das 8 eliminatórias estão provadas.**
Faltam evento antes do commit (M6) e o ledger auditável completo, que tem a
imutabilidade no M2 e a reconciliação no M7.

### Onda 4 — Mensageria e completude (paralelo, 4 agentes)

| Tarefa | Raia | Conteúdo | Aceite | Est. |
|---|---|---|---|---|
| T40 🔒 | C | consumidor SQS, inbox, classificação de erros, DLQ, `SIGTERM` básico | I-12 a I-15 | 3 h |
| T41 | G | worker de outbox, publisher, lag | I-16, C-06, C-06b | 2,5 h |
| T42 | C | worker de `PENDING_REFERENCE` | I-18, I-19, C-07, C-07b | 2 h |
| T43 | G | extrato com cursor, endpoint de reconciliação | I-21 | 1 h |

Cada tarefa instrumenta as próprias métricas, usando o registry do T33.

**Marco M6, mensageria.** I-12 a I-16 e C-06 verdes. Tag `m6-mensageria`.
`ARCHITECTURE.md` §8. Evento antes do commit fica provado: 7 das 8.

**Marco M7, funcionalidade completa.** Todas as rotas e workers prontos. T42 e
T43 entregues. Com a reconciliação (I-21), **as 8 eliminatórias estão provadas**
(PLANO 4). Tag `m7-completo`. `ARCHITECTURE.md` §9 e §10.

### Onda 5 — Falhas e entrega

| Tarefa | Raia | Conteúdo | Aceite | Est. |
|---|---|---|---|---|
| T50 | C | C-05 e C-08 (crash depois do commit, crash com carga) | os dois verdes, `test:stress` limpo | 1 h |
| T51 | humano + C | `ARCHITECTURE.md` consolidado, README final, limitações, revisão das 9 restrições | um clone limpo sobe e testa só pelo README | 1,5 h |

**Marco M8, entrega.** Clone novo → `bootstrap.ps1` → `bun run test:all` verde.
Tag `v1.0.0`.

### Resumo dos marcos

| Marco | Prova | Eliminatórias cobertas | Tag |
|---|---|---|---|
| M0 | contratos compilam, revisados linha a linha | — | `m0-contratos` |
| M1 | domínio verde sem Docker | `number` para dinheiro (parcial) | `m1-dominio` |
| M2 | cada constraint/trigger violada em teste | ledger auditável (parcial) | `m2-schema` |
| M3 | ida e volta de toda entidade | `number` para dinheiro | `m3-persistencia` |
| M4 | fatia vertical HTTP | débito duplicado (sequencial), idempotência persistente | `m4-fatia-vertical` |
| M5 | §8 exato em 3 processos, 10× | saldo negativo por race, débito duplicado, uma instância só, testes com infra real | `m5-concorrencia` |
| M6 | inbox, outbox, DLQ | evento antes do commit | `m6-mensageria` |
| M7 | referências, extrato, reconciliação, métricas | ledger auditável (completa) | `m7-completo` |
| M8 | clone limpo → tudo verde | revisão final das 8 | `v1.0.0` |

Cada marco termina com: tag na `main`, seção do `ARCHITECTURE.md` escrita, e
uma **demo de 5 minutos que o humano roda sozinho**, sem o agente. Se não
consegue explicar a demo, o marco não fechou.

## 7. Quadro de tarefas

`docs/TAREFAS.md`, criado no T00 e atualizado pelo humano a cada mudança de
estado:

```markdown
| Tarefa | Onda | Raia | Estado | Branch | Revisor | Nota | Bloqueios |
|---|---|---|---|---|---|---|---|
| T10 Money | 1 | C | Revisada | t10-money | G | notas/T10-money.md | — |
| T12 WagerTransaction 🔒 | 1 | C | Abordagem | t12-wager-transaction | G | notas/T12-…md | aguardando OK |
```

### Briefing de tarefa (o que se cola no agente)

```
Tarefa T12 — WagerTransaction (🔒)
Leia: AGENTS.md; docs/MODELAGEM.md §4; src/domain/wager-transaction.ts (contrato T01).
Arquivos permitidos: src/domain/wager-transaction.ts, test/unit/wager-transaction.test.ts, docs/notas/T12-wager-transaction.md.
Aceite: testes de MODELAGEM 12 para WagerTransaction (cada linha de 4.2, cada transição de 4.3).
Antes de codar: preencha "Abordagem" na nota e pare para aprovação.
Ao terminar: gate da seção 5.4 de docs/EXECUCAO.md, nota completa.
```

O mesmo briefing serve para Claude Code e Antigravity. As duas ferramentas
recebem o mesmo contexto, então a diferença de resultado vem da ferramenta, não
da instrução.

## 8. Tempo

O orçamento de 36 h do PLANO era de esforço de implementação. Com agentes, a
digitação sai do caminho crítico, e o tempo humano vai para:

| Atividade | Estimativa |
|---|---|
| Onda 0 em par (T00, T01) | 2 h |
| Aprovar abordagens 🔒 (8 × ~10 min) | 1,5 h |
| Revisões humanas (22 tarefas × ~20 min) | 7,5 h |
| Integração: merges, conflitos, gate na `main` | 3 h |
| Demos de marco (9 × ~10 min) e seções do `ARCHITECTURE.md` | 3 h |
| Consolidação final (T51) | 1,5 h |
| **Total humano** | **~18,5 h** |

Esforço dos agentes, somando as estimativas das tarefas: ~40 h, distribuídas em
paralelo.

A diferença para as 36 h é folga: retrabalho de agente, atrito de stack e o que
estiver na ordem de corte do PLANO 2.2. O prazo de calendário depende de quantas
ondas cabem por dia. Com 4 agentes, cada onda leva o tempo da tarefa mais longa
dela, mais a fila de revisão.

## 9. Riscos do trabalho paralelo

| Risco | Mitigação |
|---|---|
| Dois agentes interpretam o mesmo doc de jeitos diferentes | contrato congelado no M0. Divergência vira decisão pendente, não código |
| Conflito de merge | dono por arquivo (5.1), arquivos de alto conflito só no integrador (5.3), rebase antes de pedir revisão |
| Agente "conserta" teste afrouxando a asserção | teste crítico escrito antes ou por outro agente (princípio 6). Checklist "Testes" na revisão |
| Helpers duplicados entre agentes | `test/support` é dono do T15. Utilitário novo de domínio vira pedido ao dono do arquivo |
| Fila de revisão cresce e o humano perde o fio | limite de 3 tarefas esperando revisão. Agente ocioso faz revisão cruzada |
| Agente derruba infra compartilhada | proibições em 5.2 no `AGENTS.md` |
| Humano aprova sem entender | regra da revisão: não aprovar o que não entendeu. A demo de marco é feita sem o agente |
