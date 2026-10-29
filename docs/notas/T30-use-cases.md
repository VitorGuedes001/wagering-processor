# T30 — Use cases de wallet e submissão 🔒

> Estado: Testada · Raia: C · Revisor: G · Branch: `t30-use-cases`

## O que muda

- `src/application/use-cases/create-wallet.ts`: implementa o use case `CreateWallet`, criando a wallet no banco, transação `OPENING`, lançamento no ledger e eventos de outbox quando saldo inicial > 0, além de traduzir `UniqueViolationError('wallet_player_currency_uq')` para `{ type: 'WALLET_ALREADY_EXISTS' }`.
- `src/application/use-cases/submit-wager-transaction.ts`: implementa o use case `SubmitWagerTransaction` com o pipeline de SCHEMA §4.2, §4.4, §5: validação prévia de forma e payloadHash, verificação de inbox SQS (duplicata e mismatch), atalho e re-checagem de idempotência e externalId, lock pessimista de wallet (`SELECT ... FOR UPDATE`), verificação de referência e reversões existentes, avaliação pura de regras de negócio (`decideWager`), mutação de saldo com incremento estrito de versão, inserção de transação e lançamento de ledger, enfileiramento transacional na outbox, marcação de inbox processada e retry idempotente em violação `23505`.
- `src/application/use-cases/index.ts`: exporta os use cases `CreateWallet` e `SubmitWagerTransaction`.
- `test/integration/use-cases.test.ts`: suíte de testes de integração contra PostgreSQL real cobrindo I-05, I-06, I-07, I-09, I-10, I-13, I-14, I-18 e verificando invariantes financeiras de saldo e ledger.
- `docs/notas/T30-use-cases.md`: nota de entrega da tarefa.

## Por quê

- **CHALLENGE §5 (Restrições Invioláveis)**: Dinheiro tratado estritamente como string na borda e `Money` no domínio (sem float/number); idempotência garantida no banco de dados; lock pessimista por wallet (`SELECT ... FOR UPDATE`); sem eventos fora da transação (outbox transacional); ledger imutável e append-only; não-negatividade e unicidade garantidas no schema.
- **MODELAGEM §4, §5, §10**: Atende às regras por kind (4.2), transições terminais e pendentes (4.3), decisão pura via `decideWager` (5), e códigos de desfecho / replay (10). Snapshot do saldo preservado em `balanceAfter` para replay idempotente determinístico (D10).
- **SCHEMA §4.2, §4.4, §5**: Implementa os passos 1 a 9 do fluxo de transações tanto para submissão direta quanto para mensagens SQS com deduplicação via `inbox_message` (D7). Trata o re-check após aquisição de lock e o retry seguro em caso de concorrência com violação de unicidade `23505`.
- **ARQUITETURA §2, §3, §4**: Respeita isolamento de camadas em `src/application/use-cases` (depende apenas do domínio e portas da aplicação, sem vazamento de infraestrutura).

## Abordagem

Obrigatória em tarefas 🔒, **antes** de codar. Nas outras, só se o briefing não
lista os arquivos.

- Arquivos que vou tocar:
  - `src/application/use-cases/create-wallet.ts`: use case `CreateWallet` com abertura de wallet, lançamento inicial `OPENING`, eventos transacionais e tratamento de duplicata `wallet_player_currency_uq`.
  - `src/application/use-cases/submit-wager-transaction.ts`: use case `SubmitWagerTransaction` implementando rigorosamente o fluxo de SCHEMA §4.2, §4.4, §5 (inbox, idempotência, lock por wallet, `decideWager`, mutações, outbox, retry em violação de unicidade `23505`).
  - `src/application/use-cases/index.ts`: export dos use cases.
  - `test/integration/use-cases.test.ts`: testes de integração dos use cases contra PostgreSQL real.
  - `docs/notas/T30-use-cases.md`: nota de entrega da tarefa.

- Assinaturas públicas:
  - `class CreateWallet`:
    - `constructor(uow: UnitOfWork, clock: Clock, idGenerator: IdGenerator)`
    - `execute(command: CreateWalletCommand): Promise<CreateWalletOutcome>`
  - `class SubmitWagerTransaction`:
    - `constructor(uow: UnitOfWork, clock: Clock, idGenerator: IdGenerator, backoff?: BackoffPolicy)`
    - `execute(command: WagerCommand, inboxContext?: InboxContext): Promise<SubmitOutcome>`

- Alternativas descartadas e motivo:
  - *Re-executar fluxo financeiro em retry de erro 23505*: descartado; o retry faz lookup (`findByIdempotencyKey` / `findByExternalId`) para devolver replay idempotente ou conflito com segurança, sem arriscar mutações duplicadas (SCHEMA §5).
  - *Adquirir lock de wallet antes de checagem inicial de idempotência*: descartado; o passo 2 de SCHEMA §4.2 serve de atalho para replays sem contenção na linha da wallet.
  - *Gerar IDs dentro de entidades de domínio*: descartado; viola D44 (domínio puro sem gerador de IDs). IDs são injetados pelo use case via `IdGenerator`.
  - *Cálculos monetários com number / float*: descartado; estritamente proibido pela Restrição Inviolável 1 e regra A-03. `Money` é usado em todas as operações de domínio.

**Aprovação do humano:** aprovada (diretiva para tarefas 🔒 na execução da Onda 3)

## Ordem de leitura do diff

1. `src/application/use-cases/create-wallet.ts`: lógica de criação de wallet, abertura com `initialBalance > 0` e outbox.
2. `src/application/use-cases/submit-wager-transaction.ts`: orquestração do pipeline financeiro (inbox, idempotência, lock, decideWager, ledger, outbox e 23505 retry).
3. `src/application/use-cases/index.ts`: barramento de export dos use cases.
4. `test/integration/use-cases.test.ts`: testes de integração validando cada ramo de desfecho e invariantes no banco de dados.
5. `docs/notas/T30-use-cases.md`: documentação da nota e rastreabilidade da tarefa.

## Como verificar

```bash
bun run tarefa:gate
bun test ./test/integration/use-cases.test.ts
```

## Decisões pendentes

- (nenhuma)

## Pedidos ao integrador

- (nenhum)

## Fora de escopo / dívida

- (nenhum)

## Revisão cruzada

Preenchido pelo agente da outra ferramenta.

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|

Veredito: pendente
