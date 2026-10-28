# T13 — Inbox, Outbox e eventos

> Estado: Testada · Raia: G · Revisor: C · Branch: `t13-inbox-outbox`

## O que muda

- `src/domain/inbox-message.ts` — Implementa `InboxMessage.receive`, `rehydrate`, `isProcessed` e `markProcessed`.
- `src/domain/outbox-message.ts` — Implementa `OutboxMessage.enqueue`, `rehydrate`, `isPending`, `isDue`, `markPublished` e `scheduleRetry` com backoff exponencial `min(2^attempts * 1000, 60000)` sem `Math.`.
- `src/domain/events/integration-event.ts` — Implementa `IntegrationEvent.toJSON()` serializando o envelope com `occurredAt` em ISO-8601 e omitindo `causationId` quando `undefined`.
- `src/domain/events/wager-transaction-processed.ts` — Implementa `WagerTransactionProcessed.from` para transações `PROCESSED` (incluindo `OPENING` sem campos de provedor, D42).
- `src/domain/events/wager-transaction-rejected.ts` — Implementa `WagerTransactionRejected.from` para transações `REJECTED` com `failureCode` e snapshot `balanceAfter`.
- `src/domain/events/wallet-balance-changed.ts` — Implementa `WalletBalanceChanged.from` a partir de `Wallet` e `WalletLedgerEntry` com `aggregateId = wallet.id`.
- `src/domain/events/wager-transaction-pending-reference.ts` — Implementa `WagerTransactionPendingReference.from` para transações em `PENDING_REFERENCE`.
- `test/unit/inbox-outbox.test.ts` — Testes unitários de `InboxMessage` e `OutboxMessage` (incluindo U-05).
- `test/unit/events.test.ts` — Testes unitários de serialização do envelope e das 4 subclasses de `IntegrationEvent` (incluindo U-03 e U-04).

## Por quê

Atende às regras de idempotência de consumidor e publicação transacional (MODELAGEM 7; CHALLENGE §6.5, §11; D12), ao contrato de eventos de integração com `MoneyProps` e datas ISO sem vazamento de `bigint` (MODELAGEM 8; D42; D44; restrição 5.1) e ao catálogo de testes unitários U-03, U-04 e U-05 (TESTES §4.1).

## Abordagem

- Arquivos que vou tocar:
  - `src/domain/inbox-message.ts`
  - `src/domain/outbox-message.ts`
  - `src/domain/events/integration-event.ts`
  - `src/domain/events/wager-transaction-processed.ts`
  - `src/domain/events/wager-transaction-rejected.ts`
  - `src/domain/events/wallet-balance-changed.ts`
  - `src/domain/events/wager-transaction-pending-reference.ts`
  - `test/unit/inbox-outbox.test.ts`
  - `test/unit/events.test.ts`
- Assinaturas públicas: mantidas inalteradas conforme congelado na T01.
- Alternativas descartadas e motivo: uso de `Math.min` / `Math.pow` no cálculo de backoff de `OutboxMessage.scheduleRetry` descartado para respeitar a guarda estática A-03 (restrição 5.1 em `src/domain`).

## Ordem de leitura do diff

1. `src/domain/inbox-message.ts` — Ciclo de vida de deduplicação (`receive`, `rehydrate`, `isProcessed`, `markProcessed`).
2. `src/domain/outbox-message.ts` — Enfileiramento a partir de `IntegrationEvent`, verificação `isDue` e backoff `scheduleRetry` (D12).
3. `src/domain/events/integration-event.ts` — Serialização `toJSON()` do envelope base.
4. `src/domain/events/wager-transaction-processed.ts` — Fábrica `from` validando status `PROCESSED` e omitindo campos opcionais ausentes (`OPENING`, D42).
5. `src/domain/events/wager-transaction-rejected.ts` — Fábrica `from` validando status `REJECTED` e campos obrigatórios de provedor/falha.
6. `src/domain/events/wallet-balance-changed.ts` — Fábrica `from` espelhando o lançamento do ledger e `wallet.id`.
7. `src/domain/events/wager-transaction-pending-reference.ts` — Fábrica `from` validando status `PENDING_REFERENCE`.
8. `test/unit/inbox-outbox.test.ts` — Cobertura de `InboxMessage` e `OutboxMessage` (U-05).
9. `test/unit/events.test.ts` — Cobertura de `IntegrationEvent` e subclasses (U-03, U-04).

## Como verificar

```bash
bun run tarefa:gate
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
