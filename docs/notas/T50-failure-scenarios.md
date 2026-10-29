# T50 — Cenários de falha

> Estado: Testada · Raia: C · Revisor: G · Branch: `t50-failure-scenarios`

## O que muda

- `test/concurrency/failure-scenarios.test.ts` (novo): C-05 (crash depois do
  COMMIT e antes do ack) e C-08 (SIGKILL em duas de três instâncias no meio da
  carga), com processos reais da aplicação.
- `test/support/queues.ts`: `createTestQueues` aceita
  `visibilityTimeoutSeconds` (padrão 30), usado com 3 s nos dois cenários.

## Por quê

- CHALLENGE §13.5 e §13.8, TESTES 4.3 (C-05, C-08) e EXECUCAO §6 (aceite da
  T50: os dois verdes e `test:stress` limpo).
- C-05 prova a restrição 2 (idempotência no banco, não em memória): a
  redelivery cai no replay pela inbox (ARQUITETURA 7.2, D65) e não debita de novo.
- C-08 prova as restrições 3, 4 e 8 com crash real: a fila FIFO não é garantia,
  o outbox reservado por uma instância morta volta pelo lease (D18, D62) e nenhuma
  correção depende de estado em memória. A verificação final usa as invariantes
  D40, a reconciliação HTTP da T43 e um resultado terminal por chave.
- Visibilidade curta (DP-1) e ordem de subida do C-05 (DP-2) seguem as
  decisões aprovadas.

## Abordagem

A linha da T50 em EXECUCAO §6 não lista arquivos, então esta Abordagem espera
aprovação (AGENTS, regra de escopo 1). Escopo: C-05 e C-08 (TESTES 4.3), verdes
e com `test:stress` limpo. É uma tarefa só de testes: nenhum código de `src/`
muda, porque o ponto de falha `consumer.after-commit-before-ack` (T40), o lease
do outbox (T41), o `spawnApp`/`spawnCluster` (T32) e o endpoint de
reconciliação (T43) já existem.

### Arquivos que vou tocar

| # | Arquivo | O quê |
|---|---|---|
| 1 | `test/concurrency/failure-scenarios.test.ts` (novo) | C-05 e C-08 |
| 2 | `test/support/queues.ts` | `createTestQueues` ganha uma opção `visibilityTimeoutSeconds`, com padrão 30, igual ao `init-queues.sh` (DP-1) |
| 3 | `docs/notas/T50-failure-scenarios.md` | esta nota |

Não toco `src/`, `ports.ts`, domínio, `app.module.ts`, `package.json` nem
testes de aceite existentes.

### Assinaturas públicas

- `createTestQueues(customPrefix?: string, options?: { visibilityTimeoutSeconds?: number }): Promise<TestQueues>`.
  É compatível com todas as chamadas atuais.
- Nenhuma assinatura de `src/` muda.

### Como cada teste fica

**C-05, crash depois do commit e antes do ack (§13.5).**

1. Banco e filas próprios, com a fila de entrada em visibilidade curta (DP-1).
   Wallet de 1000.00 criada por HTTP numa instância B com o consumidor
   desligado.
2. Sobe a instância A só com o consumidor (`ENABLE_HTTP=false`) e
   `FAULT_POINT=consumer.after-commit-before-ack` (DP-2).
3. Envia uma `BET` 10.00 por SQS. `await A.exited`: A morreu no ponto de falha.
4. Confere o estado entre a queda e a redelivery: 1 transação `PROCESSED`,
   1 `DEBIT` e inbox com 1 linha processada, com a mensagem ainda em voo
   (`queueDepth = 1`). Isso prova que o commit aconteceu e o ack não.
5. Sobe B2 com o consumidor ligado. Quando a visibilidade expira, B2 recebe a
   redelivery, cai no replay pela inbox e dá ack.
6. Verifica com `eventually`: `queueDepth = 0`, DLQ vazia, ainda 1 transação,
   1 `DEBIT`, saldo 990.00, inbox com 1 linha, e invariantes D40.

**C-08, crash com carga contínua (§13.8).**

1. Banco e filas próprios, com visibilidade curta. `OUTBOX_LEASE_MS` e
   `REFERENCE_POLL_MS` curtos, para que o trabalho de uma instância morta seja
   retomado em segundos.
2. `spawnCluster(3)` com HTTP, consumidor e os dois workers. Cria 10 wallets de
   1000.00 por HTTP.
3. Carga contínua: um produtor manda 300 mensagens por SQS (`BET` 1.00,
   `WIN` 1.00 e `LOSS` 0.00 alternados, `MessageGroupId = walletId`) em lotes,
   sem esperar o processamento. Em paralelo, 60 `BET`s por HTTP espalhadas
   pelo cluster (DP-3).
4. No meio, quando cerca de 1/3 das transações SQS já existirem no banco,
   aplica `SIGKILL` em duas das três instâncias e sobe duas novas. O produtor
   continua mandando durante a queda.
5. Drena: `eventually` até `queueDepth(input) = 0`, outbox sem
   `published_at IS NULL` e nenhuma referência pendente.
6. Verifica:
   - invariantes D40;
   - `POST /wallets/:id/reconciliation` devolve `consistent: true` nas 10
     wallets, por uma das instâncias novas;
   - toda mensagem enviada tem resultado: para cada `(providerId,
     idempotencyKey)` enviado existe exatamente uma transação, em estado
     terminal (`PROCESSED` ou `REJECTED`), e nenhuma `FAILED`;
   - DLQ vazia;
   - outbox vazio, ou seja, todo evento com `published_at`.

   O teste confere estado terminal, não quem ganhou (TESTES 4.3,
   determinismo). As requisições HTTP que falharem por conexão durante o kill
   são reenviadas com a mesma `Idempotency-Key` a uma instância viva, e o
   reenvio tem de devolver o resultado original ou processar uma vez só.

### Alternativas descartadas

- **Esperar os 30 s de visibilidade reais no C-05 e no C-08.** Cada teste
  levaria mais de 30 s, e o `test:stress` roda a suíte 10×: mais de 10 min só
  nesses dois. Visibilidade curta prova a mesma redelivery (DP-1).
- **Subir A e B juntos no C-05 e torcer para A receber a mensagem.** Se B
  recebe primeiro, A nunca morre e o teste passa sem provar nada. Ligar o
  consumidor de B só depois da morte de A é determinístico (DP-2).
- **Carga só por HTTP no C-08.** Sem SQS, o crash não deixa mensagem em voo, e
  "drena as filas" vira trivial.
- **`docker kill` ou matar processo por nome.** Proibido (AGENTS, infra
  compartilhada). O teste mata só os PIDs que criou, pelo `AppProcess.kill`.
- **Incluir C-10 e I-17.** C-10 depende de `SIGTERM`, que não existe no Windows
  (TESTES 3.4), e I-17 pede `docker pause`, proibido. Os dois ficam fora do
  aceite da T50 (EXECUCAO §6, PLANO linhas B7 e B11).

**Aprovação do humano:** aprovada em 2026-10-29 (na conversa): Abordagem aceita como proposta, com DP-1 a DP-4 resolvidas conforme as propostas.

## Ordem de leitura do diff

1. `test/concurrency/failure-scenarios.test.ts`, bloco C-05: o passo entre a
   morte de A e a subida de B. As asserções ali (1 transação, 1 `DEBIT`, inbox
   processada, `queueDepth = 1`) provam que o commit aconteceu e o ack não.
2. Mesmo arquivo, bloco C-08: o `eventually` que espera 1/3 da carga antes do
   `SIGKILL`, o reenvio HTTP com a mesma `Idempotency-Key` e a drenagem (fila,
   outbox e referências) antes das verificações.
3. Mesmo arquivo, funções SQL no fim: leem o banco direto, sem passar pela
   aplicação (TESTES 3.5).
4. `test/support/queues.ts`: só a opção nova de visibilidade; o padrão segue 30.

## Como verificar

```bash
bun run tarefa:gate
bun test test/concurrency/failure-scenarios.test.ts
bun run test:stress
```

Resultado em 2026-10-29, no Windows: `bun run test:stress` com 160 pass e 0 fail (16 testes de concorrência × 10, 383 s). O `failure-scenarios.test.ts` sozinho leva cerca de 16 s por rodada.

## Decisões pendentes

Nenhuma aberta. DP-1 a DP-4 foram aprovadas pelo humano em 2026-10-29 conforme
as propostas abaixo e implementadas assim. O texto fica como registro.

- **DP-1. Visibilidade curta nas filas de teste do C-05 e do C-08.** TESTES 3.2
  pede para as filas de teste "a mesma redrive policy". A visibilidade de 30 s
  vem do `init-queues.sh`, mas nenhum doc diz que o teste precisa usar 30 s.
  *Proposta:* opção `visibilityTimeoutSeconds` em `createTestQueues`, com
  padrão 30, e 3 s nesses dois testes. A redrive policy fica igual. *Motivo:*
  prova a mesma redelivery e mantém o `test:stress` viável.
- **DP-2. Ordem de subida no C-05.** A linha diz "instância A com o ponto de
  falha, instância B normal", sem dizer se as duas sobem juntas. *Proposta:*
  B só liga o consumidor depois que A morre. *Motivo:* com as duas juntas, o
  resultado depende de quem recebe a mensagem.
- **DP-3. Mistura e tamanho da carga do C-08.** A linha diz "carga contínua"
  sem número. *Proposta:* 300 mensagens SQS mais 60 `BET`s HTTP em 10 wallets,
  com o kill quando cerca de 1/3 das transações SQS existirem. Se o
  `test:stress` ficar lento demais no Windows, reduzo para 150 + 30 e registro
  aqui. *Motivo:* bastante trabalho em voo no momento do kill sem passar de
  cerca de 30 s por rodada.
- **DP-4. Dívida da T40: `FAILED` na última entrega sem teste.** A nota da T40
  sugeria cobrir junto com C-05 e C-10, mas isso não está no aceite da T50.
  *Proposta:* não incluir e manter como dívida (AGENTS, regra de escopo 2). Se
  você quiser, entra como um teste extra no mesmo arquivo.

## Pedidos ao integrador

Mudanças em arquivos de alto conflito (`app.module.ts`, config do ORM,
`package.json`) que o humano aplica no merge.

- (nenhum)

## Fora de escopo / dívida

- C-10 (`SIGTERM`, só Linux) e I-17 (`docker pause`, proibido na infra
  compartilhada): fora do aceite da T50.
- `FAILED` na última entrega sem teste (dívida da T40, DP-4).

## Revisão cruzada

Preenchido por Antigravity em 2026-10-29.

### Verificações realizadas

1. **Escopo:** Alterações restritas a `test/concurrency/failure-scenarios.test.ts`, `test/support/queues.ts` e esta nota. Nenhum arquivo de `src/`, contratos de `ports.ts` ou infraestrutura compartilhada foram tocados.
2. **C-05 (CHALLENGE §13.5, TESTES §4.3):**
   - Testa a instância A abortando deterministicamente via `FAULT_POINT=consumer.after-commit-before-ack`.
   - Verifica o estado intermediário antes da redelivery: commit concluído (1 transação `PROCESSED`, 1 lançamento `DEBIT`, 1 linha na inbox com `processed = true`), mensagem mantida em voo na fila (`queueDepth = 1`).
   - Após subida da instância B com consumidor habilitado e expiração do `visibilityTimeoutSeconds` (3 s), a mensagem é redelivered, dedupada pela inbox e acked, sem débito duplicado e com saldo exato de `990.00`. DLQ permanece vazia e invariantes contábeis D40 são satisfeitas.
3. **C-08 (CHALLENGE §13.8, TESTES §4.3):**
   - Cluster de 3 instâncias com 10 wallets, submetendo 300 mensagens SQS (BET, WIN, LOSS com `MessageGroupId = walletId`) e 60 requisições HTTP em paralelo.
   - Aplica `SIGKILL` em 2 das 3 instâncias no meio da carga (ao registrar 1/3 das mensagens SQS) e sobe 2 novas instâncias.
   - Requisições HTTP com conexão interrompida pelo kill são reenviadas com a mesma `Idempotency-Key` e tratadas com replay ou efeito único.
   - Valida drenagem completa da fila de entrada, outbox e referências pendentes; DLQ vazia; zero transações em estado `FAILED`; exatamente 1 transação terminal (`PROCESSED` ou `REJECTED`) para cada uma das 360 mensagens submetidas.
   - Endpoint `POST /wallets/:id/reconciliation` executado em uma das novas instâncias valida `consistent: true` para todas as 10 wallets, além do cheque contábil D40 via SQL direto.
4. **Restrições Invioláveis e Concorrência:**
   - Dinheiro tratado estritamente como string decimal (`'1000.00'`, `'10.00'`, `'1.00'`, `'0.00'`); sem uso de `number`, `parseFloat` ou `Math.` em caminhos monetários.
   - Encerramento de processos realizado estritamente por PID via `AppProcess.kill` / `Bun.spawn`, sem comandos globais proibidos de SO (`taskkill /IM`, `pkill bun`) ou manipulação indevida de containers.
   - Testes utilizam PostgreSQL e LocalStack SQS reais em bancos e filas com prefixos isolados por arquivo de teste.
5. **Gate e Suíte de Concorrência:**
   - `bun run tarefa:gate` 100% verde (typecheck, skills, unidade, arquitetura, integração e concorrência).
   - Teste `test/concurrency/failure-scenarios.test.ts` executou com sucesso (2 pass, 0 fail, 763 asserções).

| # | Severidade | Arquivo:linha | Achado | Resolução |
|---|---|---|---|---|
| — | — | — | Nenhum achado. Implementação e testes em estrita conformidade com os documentos e restrições. | — |

Veredito: aprovado
