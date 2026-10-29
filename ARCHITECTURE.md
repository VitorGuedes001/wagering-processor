# Architecture

Decisões, trade-offs e limitações do Wagering Processor. Cada seção é escrita
quando o bloco correspondente fica pronto ([docs/PLANO.md](docs/PLANO.md)). Até
lá, aponta para o documento de planejamento de origem.

## 1. Visão geral

_A escrever no B12._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §2.

## 2. Modelo de domínio e `Money`

Detalhe em [docs/MODELAGEM.md](docs/MODELAGEM.md). Código em `src/domain/`: TypeScript
puro, sem Nest, ORM, AWS SDK ou zod. O teste de arquitetura A-01 garante isso com uma
lista branca de imports.

### `Money`

- **Representação:** centavos em `bigint` (D8), e não `decimal.js`. A escala é fixa em 2
  casas (§6.1), então um inteiro na unidade mínima é exato, nativo e sem dependência.
- **Sem arredondamento:** mais de 2 casas é rejeitado (D9). Não há multiplicação nem
  divisão no domínio, então nada produz casa extra.
- **Entrada estrita:** regex `^(0|[1-9]\d*)\.\d{2}$`. Rejeita `25`, `25.5`, `1e3`,
  `+5.00`, `-5.00` e **número JSON** (`"amount": 25`), que já chega como `number` depois
  do `JSON.parse`.
- **Parse e formatação só textuais:** `BigInt(inteiro) * 100n + BigInt(centavos)` na ida;
  `/ 100n`, `% 100n` e `padStart` na volta. Nenhum caminho passa por float.
- **Dois construtores:** `from` é o contrato de entrada e rejeita negativo.
  `fromPersistence` lê o banco e aceita negativo, porque a `difference` da reconciliação
  pode ser negativa.
- **Guarda estática (A-03):** um teste varre `src/domain` e `src/infrastructure/persistence`
  e falha com `parseFloat`, `Number(`, `toFixed`, `Math.` ou propriedade de dinheiro
  tipada `number`.

### Entidades e invariantes

| Entidade | Invariante que o desenho torna estrutural |
|---|---|
| `Wallet` (aggregate root) | `debit`/`credit` **devolvem o lançamento**: não existe caminho que muda saldo sem produzir ledger. `version` começa em 1 e só sobe com o saldo, e o `OPENING` não incrementa |
| `WalletLedgerEntry` | sem campos mutáveis e sem métodos de transição. `create` valida `antes ± valor = depois`, moeda única e não-negatividade (D58) |
| `WagerTransaction` | transições explícitas (MODELAGEM 4.3): terminal → qualquer coisa lança `InvalidTransactionStateError`. Guarda o snapshot do saldo no desfecho (D10), para o replay devolver o saldo "daquele momento" (§7.7) |

Todas usam construtor privado com factories (`create`/`open`/`opening`) e `rehydrate`,
que reconstrói do banco sem revalidar transições (§6.0).

### A regra de negócio como função pura

`decideWager(transação, wallet, referência, jáRevertida, backoff)` devolve `APPLY`,
`REJECT` com `failureCode` ou `AWAIT_REFERENCE`. As 10 verificações de §7 rodam numa
**ordem fixa**, e a primeira falha decide: o mesmo caso sempre produz o mesmo código.

- **Por que função pura:** a regra envolve três objetos e não pertence a nenhum deles.
  Sendo pura, HTTP, SQS e o worker de referências usam o mesmo caminho, e cada linha
  de §7 é testável sem banco.
- **Prova da ordem:** a revisão trocou 4 pares de regras vizinhas numa cópia do código,
  e cada troca quebrou de 1 a 5 testes.
- **Decisões que ela fixa:**
  - D1: uma transação é revertida no máximo uma vez, por qualquer kind. Lido ao pé da
    letra, §7.4 permitiria `REFUND` **e** `ROLLBACK` da mesma `BET`.
  - D2: `WIN`/`LOSS` com referência seguem as mesmas verificações de referência.
  - D3: `LOSS` aceita `0.00`.
  - D61: referência ainda pendente quando as tentativas acabam é rejeitada com
    `REFERENCE_NOT_PROCESSED`, e nunca espera além do limite.
- **Ressalva:** "função pura" vale para a **decisão**. Correção sob concorrência depende
  de ela ser chamada com a wallet travada (`SELECT … FOR UPDATE`), o que é papel do use
  case e da Unit of Work (seções 3 e 5, ondas 2 e 3).

### `payloadHash` e eventos

- **`payloadHash`:** SHA-256 de um JSON canônico (chaves ordenadas, opcionais omitidos)
  dos campos de negócio de MODELAGEM 9.1. Copia só esses campos, então passar o comando
  inteiro, com `idempotencyKey` e `correlationId`, não muda o hash. A mesma operação por
  HTTP ou por SQS gera o mesmo hash.
- **Eventos:** `eventType` e `version` vivem no tipo de cada subclasse, nunca numa string
  no call site, e `data` só leva `MoneyProps`, com string (§11). Um `bigint` que vazasse
  faria o `JSON.stringify` lançar, e não passar calado.

### Cobertura

338 testes de unidade, **sem test double do domínio**: todos montam objetos pelas
factories reais. Duas tarefas chegaram a usar `Money` falso para contornar dependências
ainda não integradas, e isso foi removido na revisão.

## 3. ORM, mapeamento e estratégia transacional

Detalhe em [docs/SCHEMA.md](docs/SCHEMA.md) §5 e §7. Código em `src/infrastructure/persistence/`.

### Records separados do domínio

Cada tabela tem um *record* do MikroORM (`records/*.record.ts`), e cada repositório
converte `record ↔ domínio` à mão, com `rehydrate` na ida e `toJSON().amount` na
volta. O domínio não conhece o ORM (A-01), e o record não tem regra nenhuma.

- **Dinheiro é `string` no record**, com coluna `numeric(19,2)`. Do banco para o
  domínio passa só por `Money.fromPersistence`; nenhum `number` existe no caminho.
- **Sem relações declaradas:** as FKs compostas vivem no schema. Declarar
  `@ManyToOne` traria proxies e reordenaria escritas.
- **Sem `@Property({ version: true })`:** a `version` da wallet é conferida no
  próprio `UPDATE … WHERE version = $esperada`. Zero linhas é bug, não corrida, porque
  quem chega ali já tem o lock (`StaleWalletVersionError`).

### Repositórios executam na hora

Nenhum `persist`/`flush`, nenhum identity map: `insert`, `nativeUpdate` e leituras
com `disableIdentityMap`. A ordem das escritas é a do use case (a FK do ledger exige
a transação antes do lançamento), e o erro aparece na chamada que o causou.

### Unit of Work explícita (D25)

```ts
await uow.run(async (tx) => {
  const wallet = await tx.wallets.lockById(id);   // SELECT … FOR UPDATE (D15)
  ...
});
```

- **`run`:** `READ COMMITTED` e, como primeira query, `lock_timeout` (2 s),
  `statement_timeout` (5 s) e `idle_in_transaction_session_timeout` (10 s) locais à
  transação (D21). Um teste com uma conexão só prova que eles não vazam para a
  transação seguinte.
- **`readSnapshot`:** `REPEATABLE READ READ ONLY` para a reconciliação (D22), sem
  `lock_timeout` porque não trava nada.
- **Repositórios por fábrica:** `RepositoryFactories` monta os cinco repositórios com
  o `EntityManager` da transação. Nenhum repositório é provider do Nest: injetado,
  receberia o `EntityManager` global e escreveria fora da transação, sem erro.
- **Outbox (D62):** o worker faz o claim num `uow.run` curto, publica fora de
  transação e marca cada mensagem no seu próprio `uow.run`.

### Tradução de erro na borda

A UoW traduz o erro do driver uma vez, num `try/catch` que envolve o `work` **e o
COMMIT**. Os triggers *deferred* (D53) só falham no COMMIT, e um tradutor dentro do
repositório nunca os veria.

| Erro | Vira |
|---|---|
| `23505` de constraint conhecida | `UniqueViolationError(constraint)`, que o use case usa para refazer o fluxo ou responder `WALLET_ALREADY_EXISTS` |
| `55P03`, `40P01`, `57014`, `57P01`–`57P03`, `25P03`, classe `08`, socket, conexão perdida | `TransientInfrastructureError`: 503 no HTTP, retry na fila |
| `23514`, `23503`, `23000` de trigger, o resto | passa sem tradução: é bug, e o estado errado não foi gravado |

### Prova

I-03 para as cinco entidades, contra Postgres real: ida e volta com dinheiro como
string, `FOR UPDATE` travando uma segunda conexão, `SKIP LOCKED` e lease nos claims,
corrida da inbox (SCHEMA 4.3), conexão derrubada antes do COMMIT, saldo sem
lançamento recusado no COMMIT e snapshot recusando escrita. As mutações que a revisão
cruzada fez sobreviver (tirar o filtro de status, `SET SESSION` no lugar de `SET
LOCAL`, tradução só no `work`) passaram a quebrar testes.

## 4. Schema e garantias no banco

Detalhe em [docs/SCHEMA.md](docs/SCHEMA.md). São 3 migrations reversíveis em `migrations/`.

**Princípio (restrição 9):** o domínio verifica primeiro, para devolver um `failureCode`
útil. O banco verifica de novo, e é ele que impede o estado errado quando o código tem
bug ou quando alguém mexe por SQL.

### Tabelas

`wallet`, `wager_transaction`, `wallet_ledger_entry`, `inbox_message` e `outbox_message`.
Todo dinheiro é `numeric(19,2)` e chega ao domínio como string exata.

### O que é constraint simples

| Garantia | Como |
|---|---|
| saldo e lançamentos nunca negativos | `CHECK` em `wallet.balance`, `balance_before`, `balance_after` |
| uma wallet por player e moeda | `UNIQUE (player_id, currency)` |
| idempotência por provedor (D4) | `UNIQUE (provider_id, idempotency_key)` e `(provider_id, external_transaction_id)` |
| uma reversão por referência (D1) | índice único parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` |
| no máximo um lançamento por transação | `UNIQUE (transaction_id)` no ledger |
| lost update vira violação | `UNIQUE (wallet_id, wallet_version)` no ledger (D16): dois lançamentos derivados do mesmo saldo colidem |
| ledger, wallet e transação na mesma moeda e wallet | FKs compostas `(wallet_id, currency)` e `(transaction_id, wallet_id, currency)` |
| campos coerentes com o status | `CHECK`s "existe se e somente se": `failure_code` em `REJECTED`/`FAILED`, `balance_after`, `processed_at`, agenda de referência |
| `OPENING` é interno | `num_nulls(campos de provedor) = 6` para `OPENING` e `0` para os outros kinds |

### O que exige trigger

Um `CHECK` olha só uma linha. O que envolve histórico ou mais de uma tabela vai em
trigger. Todos lançam SQLSTATE `23000` com o nome do trigger no campo `constraint` do
erro (D51), para o teste e o log saberem qual garantia disparou.

| Trigger | Garante |
|---|---|
| `ledger_immutable`, `ledger_no_truncate` | ledger append-only (§5.5) |
| `ledger_chain` | cada lançamento continua o saldo do anterior, ou parte de 0 |
| `wallet_version_rule` | saldo mudou ⇔ `version + 1`; identidade da wallet não muda |
| `wallet_ledger_match` + `ledger_wallet_match` (D53) | **deferred**: no commit, o saldo da wallet e o último lançamento batem nos dois sentidos |
| `wallet_no_delete` | wallet não é apagada |
| `wager_tx_guard` | transição só a partir de estado permitido, e transação terminal congelada inteira (D52) |

O par deferred é o que transforma "toda mudança de saldo tem lançamento" (§6.2) numa
garantia do banco. O commit falha tanto para saldo sem lançamento quanto para lançamento
sem saldo.

### Trade-offs

- **Triggers custam leitura por escrita:** uma busca por índice único por commit e uma
  por lançamento. É aceito: a escrita financeira é a operação rara e cara, e o ganho é
  invariante garantido mesmo com bug.
- **`TRUNCATE` bloqueado complica os testes.** Por isso cada arquivo de teste usa um banco
  próprio, clonado de um template por worktree (D34, D60), em vez de limpar tabelas.
- **A primeira wallet sem saldo começa sem lançamento.** O primeiro movimento sai na
  `wallet_version = 2`. A cadeia é conferida por saldo, não por contiguidade de versão.

### Prova

19 testes de integração contra Postgres real (TESTES I-01 e I-02):
- I-01 roda as migrations `up → down → up` e confere que o `down` não deixa função,
  trigger nem índice para trás;
- I-02 viola cada constraint, FK e trigger por SQL cru, conferindo SQLSTATE **e** nome.

A demo [`scripts/demo-schema.sql`](scripts/demo-schema.sql) mostra cinco desses casos
manualmente.

## 5. Concorrência

_A escrever no B5._ Fonte: [docs/SCHEMA.md](docs/SCHEMA.md) §4.

## 6. Idempotência

_A escrever no B4._ Fonte: [docs/MODELAGEM.md](docs/MODELAGEM.md) §9.

## 7. Contrato HTTP e códigos de falha

_A escrever no B4._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §6, [docs/MODELAGEM.md](docs/MODELAGEM.md) §10.

## 8. Mensageria: inbox, outbox, retry e DLQ

_A escrever no B6 e B7._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §7, [docs/SCHEMA.md](docs/SCHEMA.md) §4.4–4.5.

## 9. Referências fora de ordem

_A escrever no B8._ Fonte: [docs/MODELAGEM.md](docs/MODELAGEM.md) D11.

## 10. Observabilidade

_A escrever no B10._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §9.

## 11. Autenticação

_A escrever no B12._ Fonte: [docs/ARQUITETURA.md](docs/ARQUITETURA.md) §10.

## 12. Testes

_A escrever no B12._ Fonte: [docs/TESTES.md](docs/TESTES.md).

## 13. Ambiente e stack sob Bun

- A CLI do MikroORM 7 roda sob Bun (`bunx --bun mikro-orm`). O fallback para
  Node, previsto no passo 1, não foi necessário.
- TypeScript 7 removeu `baseUrl`. O alias `@/*` usa `paths` relativo.
- `prom-client` foi depreciado. O projeto usa o sucessor oficial,
  `@prometheus-io/client`, com a mesma API.
- Entidades são registradas explicitamente com `ReflectMetadataProvider`. Não há
  varredura de pastas, que depende de ts-morph.

## 14. Limitações conhecidas

Orçamento de 36 h ([docs/PLANO.md](docs/PLANO.md) §2):

- sem teste automatizado de desligamento por `SIGTERM`. Não existe no Windows,
  e o teste exige Linux;
- a aplicação roda fora do Compose (`bun run start:dev`). Só a infra está no
  Compose;
- ≥ 3 instâncias é provado pelos cenários de concorrência com três processos,
  não por um cenário misto dedicado;
- sem teste de carga;
- **conexão presa no pool quando a sessão do Postgres morre no meio da transação.**
  O Kysely 0.29.6, usado pelo MikroORM 7, só devolve a conexão ao pool depois de um
  COMMIT ou ROLLBACK bem-sucedido; com o socket morto, os dois falham. O chamador
  recebe `TransientInfrastructureError` corretamente, mas a vaga no pool se perde.
  Acontece só com a sessão morta (restart ou failover do Postgres,
  `pg_terminate_backend`, `idle_in_transaction_session_timeout`), não com lock,
  timeout de statement ou trigger. Algumas quedas seguidas esgotam o pool, e a
  instância precisa reiniciar. Aceito na T20, sem patch da dependência.
