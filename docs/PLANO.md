# Passo 8 — Plano de trabalho com timebox

Sequência de implementação dos passos 4 a 7. `§N` aponta para
[CHALLENGE.md](CHALLENGE.md); os IDs de teste (`U-`, `I-`, `C-`) são os de
[TESTES.md](TESTES.md).

Três regras organizam a ordem:

1. **Eliminatórias primeiro.** As oito falhas eliminatórias de §14 ficam
   cobertas o mais cedo possível. Um corte de escopo no fim do prazo nunca pode
   tirar uma delas.
2. **Fatia vertical cedo.** Ao fim do B5, uma `BET` passa por HTTP → use case →
   banco, e o cenário obrigatório de §8 já está provado com 3 processos. O resto
   do trabalho é ampliar algo que já funciona de ponta a ponta.
3. **Teste no mesmo bloco do código.** Nenhum bloco é "pronto" sem os testes que
   o provam. Não existe bloco de "escrever testes" no fim.

---

## 1. Blocos

Estimativas em horas de trabalho efetivo. "Pontos" é a área de §14 que o bloco
mais move.

| Bloco | Conteúdo | Testes | Pronto quando | Est. | Pontos |
|---|---|---|---|---|---|
| **B0** Base | remove `smoke_balance` e `decimal.js`. Adiciona `zod` e `prom-client`. Redrive + `wagering-events.fifo` no `init-queues.sh`. Config validada por zod. Pastas de ARQUITETURA 2.1. `ARCHITECTURE.md` com os títulos | `bun run typecheck`, filas com redrive (`get-queue-attributes`) | infra sobe com a DLQ ligada e o projeto compila vazio | 1,5 | — |
| **B1** Domínio | `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`, eventos, `decideWager`, `reconcile`, `payloadHash`, códigos e erros | MODELAGEM 12, U-01 a U-05, A-01 a A-03 | `bun run test` verde, sem Docker | 6 | Correção financeira, Modelagem |
| **B2** Schema | 3 migrations com `down`, triggers de SCHEMA 3. Infra de teste: preload, template, banco por arquivo, `invariants.ts` | I-01, I-02 | cada constraint e trigger tem um teste que a viola | 5 | Correção financeira, Concorrência |
| **B3** Persistência | records MikroORM, repositórios, Unit of Work com timeouts, tradução de erros | I-03 | ida e volta de cada entidade, dinheiro como string | 4 | Modelagem |
| **B4** HTTP | `CreateWallet`, `SubmitWagerTransaction`, queries, schemas zod, mapeamento de status, `AuthGuard` no-op, `X-Correlation-Id` | I-05 a I-11, I-08 | os 5 kinds e cada `failureCode` por HTTP. Replay devolve o saldo original | 6 | Idempotência, Correção financeira |
| **B5** Concorrência | `spawnApp`/`spawnCluster`, portão de lock, `eventually`, `FaultInjector` (só o mecanismo) | C-01, C-02, C-02b, C-03, C-11, I-04 | cenário de §8 exato em 3 processos, 10× seguidas (`test:stress`) | 4 | Concorrência |
| **B6** Consumidor SQS | consumidor com inbox, classificação de erros, visibilidade com backoff, DLQ por redrive | I-12 a I-15 | redelivery não duplica e mensagem inválida chega à DLQ | 4 | Mensageria, Idempotência |
| **B7** Outbox | worker com lease, publisher SQS, backoff, gauge de lag | I-16, I-17, C-06, C-06b | 2 publishers, nada perdido. Nada sai antes do commit | 3,5 | Mensageria |
| **B8** Referências | worker de `PENDING_REFERENCE` com lease e limite de tentativas | I-18, I-19, C-07, C-07b | reversão antes da referência resolve, e estoura com o código certo | 3 | Correção financeira |
| **B9** Leitura | extrato com cursor, reconciliação em snapshot | I-20, I-21 | divergência é sinalizada, não corrigida | 2 | Correção financeira |
| **B10** Observabilidade | logger JSON com ALS, métricas de ARQUITETURA 9, `/metrics`, `ready` com 503 | I-22, I-23 | campos de log presentes e sem valores | 2,5 | Observabilidade |
| **B11** Falhas | Dockerfile, app no Compose, `SIGTERM` gracioso, pontos de falha restantes | C-04, C-05, C-08, C-09, C-10 | crash e restart terminam com reconciliação consistente | 4 | Mensageria, Testes |
| **B12** Entrega | `ARCHITECTURE.md` consolidado dos `docs/`, `README.md` final, limitações conhecidas, revisão das restrições (seção 4) | `test:all` limpo | um avaliador sobe e testa só pelo README | 3 | Documentação |
| | | | **Subtotal** | **48,5** | |
| **Folga** | ~15% para atrito de stack (MikroORM 7, Nest 12 e TS 7 sob Bun) | | | 7 | |
| | | | **Total** | **~55,5** | |
| *B13* Carga (opcional) | `bun run test:load` com p50/p95/p99, throughput, conflitos e lag (§14) | — | relatório honesto no `ARCHITECTURE.md` | *3* | diferencial |

### Dependências

```
B0 → B1 → B2 → B3 → B4 → B5 ─┬→ B6 → B11
                             ├→ B7 ─┘
                             ├→ B8
                             ├→ B9
                             └→ B10
B12 por último. B13 só se sobrar folga.
```

Depois do B5, os blocos B6 a B10 são independentes entre si e podem mudar de
ordem. B6 e B7 vêm antes porque cobrem eliminatórias (idempotência só em memória
e evento antes do commit).

## 2. Orçamento escolhido: 36 h

Escolha registrada em 28/10/2026. As estimativas da seção 1 somam 48,5 h, então
para caber em 36 h cada bloco perde escopo, e **nenhum é removido inteiro**:
§7.1 e §13.7 (referência fora de ordem) são requisitos, e cortar o B8 deixaria um
buraco obrigatório. Não há folga. O atrito de stack consome a ordem de corte da
seção 2.2.

| Bloco | Est. | Escopo em 36 h | Sai do bloco |
|---|---|---|---|
| B0 | 1,5 | completo | — |
| B1 | 5 | completo | testes de unidade só por regra, sem combinatória |
| B2 | 4,5 | completo | — |
| B3 | 3,5 | completo | — |
| B4 | 5 | completo | — |
| B5 | 3,5 | C-01, C-02, C-02b, C-03, I-04 | C-11 (`lock_timeout`) |
| B6 | 3,5 | consumidor, inbox, DLQ por redrive, `SIGTERM` básico (para de ler e devolve visibilidade). I-12 a I-14, I-15 só a parte da DLQ | I-15 com `docker pause` |
| B7 | 3 | worker, publisher, lag. I-16, C-06, C-06b | I-17 (`docker pause`) |
| B8 | 2 | worker de referência. I-18, I-19, C-07, C-07b | — |
| B9 | 1 | reconciliação (I-21). Extrato com cursor sem teste de concorrência | I-20 |
| B10 | 1,5 | logs JSON com contexto, métricas de ARQUITETURA 9, `ready` com 503. I-22 | I-23 (assert de campos de log) |
| B11 | 1 | C-05 e C-08 com o harness do B5 | Dockerfile, app no Compose, C-04, C-09, C-10 |
| B12 | 1,5 | `ARCHITECTURE.md` consolidado, README final, limitações | — |
| **Total** | **36** | | B13 (carga) |

Fica registrado como limitação conhecida:

- sem teste automatizado de `SIGTERM`, porque não existe no Windows e o C-10
  precisa de Linux;
- a aplicação roda fora do Compose: `bun run start:dev`, com a infra no Compose;
- §13.4 (≥ 3 instâncias) é provado por C-01 a C-03 com `spawnCluster(3)`, e não
  por um cenário misto dedicado (C-04).

### 2.1 Outros orçamentos (referência)

| Orçamento | Entra | Fica de fora |
|---|---|---|
| ~45 h | B0 a B12, folga reduzida | C-10, I-17, B13 |
| ~55 h | tudo de B0 a B12 com folga | B13 |
| > 58 h | tudo + B13 | — |

### 2.2 Ordem de corte se estourar

Sem folga, o estouro de qualquer bloco sai desta lista, de cima para baixo, até
compensar. Cada item cortado vira limitação no `ARCHITECTURE.md`.

1. C-08 (crash com carga contínua)
2. métricas além de transações por status, duplicatas, DLQ e lag
3. C-06b (lease expirado no outbox)
4. extrato com cursor (fica só a reconciliação)
5. C-07b (reversões paralelas da mesma referência; o índice único continua
   provado no I-02)

**Nunca saem:** B1 a B7 e os testes da seção 4. É ali que moram as oito
eliminatórias.

## 3. Disciplina de timebox

- **Estouro de 50%** num bloco: parar e escolher entre (a) cortar escopo do bloco
  e registrar a limitação, ou (b) consumir folga explicitamente. Não seguir "só
  mais um pouco" sem decidir.
- **Atrito de stack** (MikroORM, Nest ou TS sob Bun) com mais de 1 h sem
  progresso: aplicar o fallback e anotar no `ARCHITECTURE.md`. Por exemplo,
  SQL direto pelo `em.getConnection().execute` no lugar da API do ORM, ou rodar a
  CLI com Node.
- **Fim de bloco:** `test:all` verde até ali, um commit por bloco
  (`feat(b4): …`), e a seção correspondente do `ARCHITECTURE.md` atualizada a
  partir do `docs/` do passo de origem.
- **Teste flaky** em `test:stress`: bloqueia o próximo bloco. Corrida
  intermitente em sistema financeiro é bug, não ruído.

## 4. Eliminatórias × blocos

| Falha eliminatória (§14) | Coberta em | Prova |
|---|---|---|
| `number` para dinheiro | B1, B3, B4 | U-01, U-02, A-03, I-03, I-11 |
| saldo negativo por race | B2, B5 | I-02 (`CHECK`), C-02, C-02b |
| débito/crédito duplicado | B2, B4, B5, B6 | I-09, C-01, C-07b, I-13 |
| idempotência só em memória | B2, B4, B6 | I-12, C-01 entre processos, C-05 |
| correto só com uma instância | B5 | C-01 a C-03 com `spawnCluster(3)` |
| evento antes do commit | B7 | I-04, I-16 |
| sem ledger auditável | B2, B9 | I-02 (imutabilidade), I-21 |
| testes que mockam Postgres e SQS | B2, B5 | toda a infra de TESTES 3 usa containers reais |

Com o B7 concluído, todas as linhas estão cobertas, por volta de 34 h no
cronograma.

## 5. Riscos

| Risco | Bloco | Mitigação |
|---|---|---|
| MikroORM 7 sob Bun: `LockMode`, `SKIP LOCKED` ou deferred constraints se comportam diferente | B3 | SQL direto nos pontos críticos (lock, claim). O ORM fica para mapeamento |
| Nest 12 / TS 7: decorators ou metadata | B4 | já compila e sobe no passo 1. Se quebrar, `@Inject(token)` explícito |
| LocalStack 3: redrive e `ChangeMessageVisibility` em FIFO | B6 | validar no B0 (fila com redrive) e no começo do B6, antes do consumidor |
| `SIGTERM` no Windows | B11 | C-10 só em Linux, via Compose |
| `docker pause` nos testes deixa container pausado se o teste cair | B6, B7 | `unpause` no `finally` e no preload |
| Escopo cresce com "melhorias" | todos | só entra o que está em `docs/`. Ideia nova vai para limitações/próximos passos |
