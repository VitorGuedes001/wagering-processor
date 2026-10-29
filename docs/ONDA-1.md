# Onda 1 — o que foi entregue e como revisar

Guia para o humano revisar a onda 1 **antes** de fechar os marcos M1 e M2 e de
iniciar a onda 2. Explica o que existe, o que ainda não existe, como testar com as
próprias mãos e o que conferir.

`§N` aponta para [CHALLENGE.md](CHALLENGE.md); `Dn` para as decisões em
MODELAGEM, SCHEMA, ARQUITETURA e TESTES.

---

## 1. Em uma frase

A onda 1 entrega **as regras e as garantias**, mas ainda não o serviço. A regra de
negócio inteira existe como código puro e testado, e o banco já recusa sozinho
qualquer estado financeiro inválido. Nada ainda liga os dois, nem expõe isso por
HTTP ou SQS.

| Camada (ARQUITETURA §2) | Estado depois da onda 1 |
|---|---|
| `domain` | **completa**: nenhum `notImplemented` restou |
| schema (migrations) | **completo**: 5 tabelas, constraints e 8 triggers |
| infra de teste | **completa** para integração: banco por arquivo, invariante, guardas |
| `application` (use cases) | só contratos (`ports.ts`, `contracts.ts`), do M0 |
| `infrastructure` (ORM, SQS) | só config e health. Sem repositórios (onda 2) |
| `interface` (HTTP, fila, workers) | só `/health/live` e `/health/ready` |

**Consequência prática:** você ainda não consegue fazer `POST /wagering/transactions`.
O que dá para exercitar é o domínio (por teste e por script) e o banco (por SQL).

## 2. O que cada peça faz

### 2.1 Domínio (`src/domain`, ~1,7 mil linhas)

| Arquivo | Papel | Tarefa |
|---|---|---|
| `money.ts` | dinheiro em centavos `bigint`, parse e formatação só textuais. Rejeita `25`, `25.5`, `1e3` e negativo na entrada (restrição 5.1, D8, D9) | T10 |
| `payload-hash.ts` | JSON canônico + SHA-256 dos campos de negócio: mesma operação = mesmo hash, por HTTP ou SQS | T10 |
| `wallet.ts` | saldo materializado. `debit`/`credit` **devolvem o lançamento**: não existe caminho que muda saldo sem gerar ledger. `version` só sobe com o saldo | T11 |
| `wallet-ledger-entry.ts` | lançamento imutável, com aritmética validada (`antes ± valor = depois`) e `walletVersion` (D16) | T11 |
| `wager-transaction.ts` | uma operação de provedor: regras por kind (4.2), transições (4.3), snapshot do saldo para o replay (D10), backoff da referência | T12 |
| `decide-wager.ts` | **a regra de §7**: 10 verificações em ordem fixa. Devolve `APPLY`, `REJECT` com `failureCode`, ou `AWAIT_REFERENCE` | T16 |
| `reconcile.ts` | confere o saldo pelo ledger e a cadeia de lançamentos | T16 |
| `inbox-message.ts`, `outbox-message.ts` | dedup do consumidor e evento esperando publicação, com backoff sem limite (D12) | T13 |
| `events/*.ts` | os 4 eventos de §11, com `eventType` e `version` no tipo e `data` só com string de dinheiro | T13 |
| `failure-code.ts`, `errors.ts` | vocabulário de falha (MODELAGEM 10) | T01 |

### 2.2 Schema (`migrations/`, 3 migrations reversíveis)

- **Tabelas:** `wallet`, `wager_transaction`, `wallet_ledger_entry`, `inbox_message` e `outbox_message`.
- **Unicidade no banco:** idempotência por provedor, id externo, uma reversão por referência (D1) e uma `OPENING` por wallet.
- **8 triggers** (SCHEMA §3, D51–D53):

| Trigger | O que garante |
|---|---|
| `ledger_immutable` / `ledger_no_truncate` | ledger nunca é alterado nem apagado (§5.5) |
| `ledger_chain` | cada lançamento continua o saldo do anterior |
| `wallet_version_rule` | saldo mudou ⇔ `version + 1` (barra lost update) |
| `wallet_ledger_match` / `ledger_wallet_match` | **no commit**, saldo e último lançamento batem nos dois sentidos |
| `wallet_no_delete` | wallet não é apagada |
| `wager_tx_guard` | transação terminal fica congelada inteira (D52) |

### 2.3 Testes (362 no total)

| Nível | Quantidade | O que prova |
|---|---|---|
| Unidade (`test/unit`, 9 arquivos) | 338 | cada regra do domínio, sem banco e **sem test double** |
| Arquitetura (`test/architecture`) | 5 | camadas (A-01, A-02), guarda da 5.1 (A-03) e sincronia das skills |
| Integração (`test/integration`) | 19 | I-01 (migrations up → down → up) e I-02 (cada constraint e trigger violados por SQL cru, conferindo SQLSTATE e nome) |

## 3. Como testar você mesmo

Pré-requisito: `bun run infra:up` (Postgres e LocalStack no ar).

### 3.1 As suítes

```bash
bun run tarefa:gate --tudo
```

Esperado: typecheck, skills, unidade, arquitetura e integração verdes. Concorrência
ainda "sem testes": é a T32, na onda 3.

### 3.2 O domínio funcionando

```bash
bun scripts/demo-onda1.ts
```

Monta uma rodada inteira só com o domínio, do jeito que o use case da T30 vai fazer:

1. `Money` rejeitando `25`, `25.5`, `1e3` e `-5.00`;
2. wallet aberta com 100,00;
3. **o cenário obrigatório de §8**: duas `BET` de 80,00, uma aplicada e outra `INSUFFICIENT_FUNDS`, saldo 20,00;
4. `WIN`, `REFUND` da `BET` e `ROLLBACK` do `WIN`, com saldo e `version` a cada passo e o evento `WalletBalanceChanged` emitido;
5. `REFUND` de uma `BET` que ainda não chegou → `PENDING_REFERENCE`;
6. reconciliação consistente sobre os 5 lançamentos;
7. idempotência pelo `payloadHash`.

O cenário de §8 aqui é **sequencial**. A prova com 3 processos disputando a mesma
wallet só existe a partir da T32.

### 3.3 O banco se defendendo sozinho

```bash
docker exec -i wagering-postgres psql -U wagering -d wagering < scripts/demo-schema.sql
```

Cinco tentativas de gravar estado proibido **por SQL cru**, sem passar pela
aplicação. Cada uma é barrada pela garantia indicada, e nada fica gravado.

| Tentativa | Barrada por |
|---|---|
| saldo negativo | `wallet_balance_non_negative_ck` (23514) |
| mudar saldo sem lançamento | `wallet_ledger_match` (23000, **no COMMIT**) |
| mudar saldo sem subir a `version` | `wallet_version_rule` (23000) |
| reescrever um lançamento | `ledger_immutable` (23000) |
| mesma idempotency key duas vezes | `wager_tx_idempotency_uq` (23505) |

Essa é a **demo do M2**: a restrição 9 do desafio ("garantias no schema, não só em
código") vista funcionando.

### 3.4 Lendo o código com ajuda

Para entender qualquer peça arquivo por arquivo, peça a um agente:

```
Use a skill explicar-mudanca e me explique a T16 (decideWager), começando pela tabela de verificações.
```

Sugestão de ordem: `money.ts` → `wallet.ts` → `wager-transaction.ts` →
`decide-wager.ts` → migration 02 (ledger e triggers). Essas cinco peças carregam a
correção financeira.

## 4. O que foi decidido durante a onda

Vinte decisões novas, todas aprovadas por você e registradas nos documentos de
origem:

| Faixa | Onde | Do quê |
|---|---|---|
| D42–D47 | MODELAGEM §1 | contratos (T01): `OPENING`, `BackoffPolicy`, `eventId`, State com tipos de domínio, snapshot nas transições, enums |
| D48–D50 | ARQUITETURA §1 | contratos: lease em ms, `contracts.ts`, `RequestErrorCode` |
| D51–D53 | SCHEMA §3 | triggers (T14): SQLSTATE 23000 com nome, terminal congelado, 8º trigger |
| D54–D57 | MODELAGEM §1 | WagerTransaction (T12): erros e a **contagem de 10 tentativas** para o worker |
| D58–D59 | MODELAGEM §1 | Wallet (T11): guardas extras, erro de débito zero como bug |
| D60 | TESTES §1 | template de teste por worktree |
| D61 | MODELAGEM §1 | referência ainda pendente quando as tentativas acabam → `REFERENCE_NOT_PROCESSED` |

## 5. Dívida e limitações conhecidas

Achados menores aceitos sem correção. Estão nas notas de cada tarefa, seção
"Dívida registrada na integração".

- **T15:** a isenção da guarda 5.1 é larga demais, a regex dela tem um falso positivo
  e um caso que escapa, os templates de worktrees removidos se acumulam no Postgres
  e `queues.ts` não tenta de novo um delete que falhou.
- **T16:** `reconcile` lança exceção (em vez de reportar) com moedas misturadas, um
  estado que o schema já impede. Também há três imprecisões pequenas nos testes.

Lições de processo da onda, para levar à onda 2:

- **Test double do domínio escondeu falta de dependência.** T11 e T13 criaram
  `Money` falso para contornar a T10 ainda não integrada. Foi removido, e os
  pedidos passaram a proibir isso.
- **Testes escritos antes da implementação pegaram bug real**, mas só na revisão:
  o I-02 só rodou contra as migrations num teste conjunto de T14 com T15.
- **Revisões com zero achados merecem desconfiança.** A da T01 deixou passar a
  falta do `UniqueViolationError`.
- **As sessões do Claude abriram worktrees no repositório errado** (o clone do
  desafio). A partir da T12, os worktrees são criados pelo `tarefa:iniciar`.

## 6. Checklist da sua revisão

- [ ] `bun run tarefa:gate --tudo` verde na sua máquina
- [ ] `bun scripts/demo-onda1.ts`: o cenário de §8 dá 20,00 e `INSUFFICIENT_FUNDS`
- [ ] `scripts/demo-schema.sql`: as 5 tentativas são barradas e nada é gravado
- [ ] li `decide-wager.ts` e sei dizer por que a ordem das verificações é fixa
- [ ] sei dizer o que acontece se alguém fizer `UPDATE wallet SET balance = …` direto no banco
- [ ] concordo com a dívida da seção 5, ou digo o que vira tarefa
- [ ] **M2 fechado:** tag `m2-schema` e `ARCHITECTURE.md` §4
- [ ] **M1 fechado:** tag `m1-dominio` e `ARCHITECTURE.md` §2

Perguntas para testar o próprio entendimento:

1. Por que `Wallet.debit` devolve o lançamento, em vez de o use case criar o lançamento?
2. Se duas `BET` chegarem ao mesmo tempo em duas instâncias, **o que da onda 1** já impede
   saldo negativo, e o que só a onda 2 ou 3 vai garantir?
3. Por que o `payloadHash` deixa de fora o `idempotencyKey`?
4. O que muda para o provedor entre `REFERENCE_NOT_FOUND` e `REFERENCE_NOT_PROCESSED`?

## 7. O que vem na onda 2 (não iniciada)

Persistência: os repositórios MikroORM e a Unit of Work (T20–T22) ligam o domínio
ao schema. Também liberadas: T32 (harness de concorrência) e T33 (observabilidade).
Só depois delas o primeiro `POST` real (T30–T31, onda 3) passa a existir.
