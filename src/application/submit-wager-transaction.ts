import type { Clock, IdGenerator, TxRepositories, UnitOfWork } from './ports';
import { UniqueViolationError } from './ports';
import type { InboxContext, SubmitOutcome, TransactionView, WagerCommand } from './contracts';
import { Money } from '../domain/money';
import { payloadHash } from '../domain/payload-hash';
import {
  type BackoffPolicy,
  WagerTransaction,
} from '../domain/wager-transaction';
import { decideWager, type WagerDecision } from '../domain/decide-wager';
import type { Wallet } from '../domain/wallet';
import { InboxMessage } from '../domain/inbox-message';
import { OutboxMessage } from '../domain/outbox-message';
import { LedgerDirection } from '../domain/wallet-ledger-entry';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';

export const DEFAULT_REFERENCE_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 300_000, // D11: teto de 5 min
  maxAttempts: 10,
};

function toTransactionView(transaction: WagerTransaction): TransactionView {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.balanceAfter ? transaction.balanceAfter.toJSON() : undefined,
    ...(transaction.failureCode !== undefined ? { failureCode: transaction.failureCode } : {}),
  };
}

export interface ApplyWagerDecisionInput {
  transaction: WagerTransaction;
  /** Já travada com `FOR UPDATE` pelo chamador (D15). */
  wallet: Wallet;
  referenceTransactionId: string | undefined;
  decision: WagerDecision;
  now: Date;
  backoff: BackoffPolicy;
  correlationId: string;
  causationId?: string;
  /**
   * `insert`: transação nova (submissão HTTP/SQS). `update`: transação que já
   * existe em `PENDING_REFERENCE` (worker, T42), cujo `scheduleReferenceRetry`
   * o chamador já fez antes de `decideWager` (D57).
   */
  persist: 'insert' | 'update';
}

/**
 * Tabela de aplicação de MODELAGEM 5, dentro da transação SQL e com a wallet
 * travada. Uma só para a submissão e o worker de referências ("o mesmo
 * caminho"). `AWAIT_REFERENCE` com `update` é o retry do worker: grava só a
 * transação, sem evento.
 */
export async function applyWagerDecision(
  tx: TxRepositories,
  idGenerator: IdGenerator,
  input: ApplyWagerDecisionInput,
): Promise<void> {
  const { transaction, wallet, referenceTransactionId, decision, now, backoff, persist } = input;
  const persistTransaction = (): Promise<void> =>
    persist === 'insert' ? tx.transactions.insert(transaction) : tx.transactions.update(transaction);

  const eventContext = {
    eventId: idGenerator.next(),
    correlationId: input.correlationId,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
    occurredAt: now,
  };

  if (decision.type === 'AWAIT_REFERENCE') {
    if (persist === 'update') {
      await persistTransaction();
      return;
    }
    transaction.markPendingReference(now, backoff);
    await persistTransaction();

    const event = WagerTransactionPendingReference.from(transaction, eventContext);
    await tx.outbox.enqueue([OutboxMessage.enqueue(event)]);
  } else if (decision.type === 'REJECT') {
    transaction.reject(decision.code, wallet.balance, now);
    await persistTransaction();

    const event = WagerTransactionRejected.from(transaction, eventContext);
    await tx.outbox.enqueue([OutboxMessage.enqueue(event)]);
  } else {
    // APPLY
    if (decision.direction === undefined) {
      // LOSS não move saldo nem cria lançamento no ledger
      transaction.markProcessed(referenceTransactionId, wallet.balance, now);
      await persistTransaction();

      const event = WagerTransactionProcessed.from(transaction, eventContext);
      await tx.outbox.enqueue([OutboxMessage.enqueue(event)]);
    } else {
      // CREDIT ou DEBIT
      const expectedVersion = wallet.version;
      const entryId = idGenerator.next();
      const entry =
        decision.direction === LedgerDirection.Debit
          ? wallet.debit(transaction.money, transaction.id, entryId, now)
          : wallet.credit(transaction.money, transaction.id, entryId, now);

      transaction.markProcessed(referenceTransactionId, wallet.balance, now);
      await persistTransaction();
      await tx.ledger.insert(entry);
      await tx.wallets.update(wallet, expectedVersion);

      const processedEvent = WagerTransactionProcessed.from(transaction, eventContext);
      const balanceChangedEvent = WalletBalanceChanged.from(wallet, entry, {
        eventId: idGenerator.next(),
        correlationId: input.correlationId,
        ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
        occurredAt: now,
      });

      await tx.outbox.enqueue([
        OutboxMessage.enqueue(processedEvent),
        OutboxMessage.enqueue(balanceChangedEvent),
      ]);
    }
  }
}

export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly backoff: BackoffPolicy = DEFAULT_REFERENCE_BACKOFF,
  ) {}

  async execute(command: WagerCommand, inboxContext?: InboxContext): Promise<SubmitOutcome> {
    const money = Money.from(command.money);
    const hash = payloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    const receivedAt = this.clock.now();
    const transactionId = this.idGenerator.next();

    // 1. Valida a forma do comando antes da transação (MODELAGEM 4.2, SCHEMA 4.2 passo 1).
    WagerTransaction.create({
      id: transactionId,
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      at: receivedAt,
    });

    const inboxMessage = inboxContext
      ? InboxMessage.receive({
          messageId: inboxContext.messageId,
          consumerName: inboxContext.consumerName,
          payloadHash: hash,
          at: receivedAt,
        })
      : undefined;

    try {
      return await this.uow.run(async (tx) => {
        // 1. Inbox check (quando via SQS — SCHEMA 4.4)
        if (inboxMessage) {
          const inboxResult = await tx.inbox.tryReceive(inboxMessage);
          if (!inboxResult.accepted) {
            if (inboxResult.storedPayloadHash === hash) {
              return { type: 'DUPLICATE_MESSAGE' };
            }
            return { type: 'MESSAGE_PAYLOAD_MISMATCH' };
          }
        }

        // Desfecho que retorna antes do fim também encerra a mensagem: o processamento
        // terminou e o resultado está na transação (MODELAGEM 7, SCHEMA 4.4).
        const closeInbox = async (outcome: SubmitOutcome): Promise<SubmitOutcome> => {
          if (inboxMessage) {
            inboxMessage.markProcessed(this.clock.now());
            await tx.inbox.markProcessed(inboxMessage);
          }
          return outcome;
        };

        // 2. Atalho para replays antes do lock da wallet (SCHEMA 4.2 passo 2: busca apenas idempotency_key)
        const fastTx = await tx.transactions.findByIdempotencyKey(
          command.providerId,
          command.idempotencyKey,
        );
        if (fastTx) {
          if (fastTx.matchesPayload(hash)) {
            return closeInbox({
              type: 'RESULT',
              view: toTransactionView(fastTx),
              idempotentReplay: true,
            });
          }
          return closeInbox({ type: 'IDEMPOTENCY_CONFLICT' });
        }

        // 3. SELECT ... FOR UPDATE na wallet (D15, SCHEMA 4.2 passo 3)
        const wallet = await tx.wallets.lockById(command.walletId);
        if (!wallet) {
          return closeInbox({ type: 'WALLET_NOT_FOUND' });
        }

        // 4. Re-checagem sob o lock da wallet (SCHEMA 4.2 passo 4)
        const lockedTx = await tx.transactions.findByIdempotencyKey(
          command.providerId,
          command.idempotencyKey,
        );
        if (lockedTx) {
          if (lockedTx.matchesPayload(hash)) {
            return closeInbox({
              type: 'RESULT',
              view: toTransactionView(lockedTx),
              idempotentReplay: true,
            });
          }
          return closeInbox({ type: 'IDEMPOTENCY_CONFLICT' });
        }

        const lockedExt = await tx.transactions.findByExternalId(
          command.providerId,
          command.externalTransactionId,
        );
        if (lockedExt) {
          return closeInbox({ type: 'EXTERNAL_ID_CONFLICT' });
        }

        // 5. Busca referência e verifica se já foi revertida (SCHEMA 4.2 passo 5)
        let reference: WagerTransaction | undefined;
        let referenceAlreadyReversed = false;
        if (command.referenceExternalTransactionId !== undefined) {
          reference = await tx.transactions.findByExternalId(
            command.providerId,
            command.referenceExternalTransactionId,
          );
          if (reference) {
            referenceAlreadyReversed = await tx.transactions.hasProcessedReversal(reference.id);
          }
        }

        // Captura o instante sob o lock da wallet para preservar a ordem temporal estrita com wallet_version
        const now = this.clock.now();
        const transaction = WagerTransaction.create({
          id: transactionId,
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash: hash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          at: now,
        });

        // 6. Decisão pura de negócio (MODELAGEM 5)
        const decision = decideWager({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed,
          backoff: this.backoff,
        });

        // 7. Aplicação da decisão (MODELAGEM 5, tabela de aplicação)
        await applyWagerDecision(tx, this.idGenerator, {
          transaction,
          wallet,
          referenceTransactionId: reference?.id,
          decision,
          now,
          backoff: this.backoff,
          correlationId: command.correlationId,
          ...(command.causationId !== undefined ? { causationId: command.causationId } : {}),
          persist: 'insert',
        });

        // 8. Se inboxContext, marca inbox como processada
        if (inboxMessage) {
          inboxMessage.markProcessed(now);
          await tx.inbox.markProcessed(inboxMessage);
        }

        return {
          type: 'RESULT',
          view: toTransactionView(transaction),
          idempotentReplay: false,
        };
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) {
        if (error.constraint === 'wager_tx_idempotency_uq') {
          const retryTx = await this.uow.run(async (tx) =>
            tx.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey),
          );
          if (retryTx) {
            if (retryTx.matchesPayload(hash)) {
              return {
                type: 'RESULT',
                view: toTransactionView(retryTx),
                idempotentReplay: true,
              };
            }
            return { type: 'IDEMPOTENCY_CONFLICT' };
          }
        }

        if (error.constraint === 'wager_tx_external_uq') {
          const retryExt = await this.uow.run(async (tx) =>
            tx.transactions.findByExternalId(command.providerId, command.externalTransactionId),
          );
          if (retryExt) {
            if (retryExt.idempotencyKey === command.idempotencyKey && retryExt.matchesPayload(hash)) {
              return {
                type: 'RESULT',
                view: toTransactionView(retryExt),
                idempotentReplay: true,
              };
            }
            return { type: 'EXTERNAL_ID_CONFLICT' };
          }
        }
      }

      throw error;
    }
  }
}
