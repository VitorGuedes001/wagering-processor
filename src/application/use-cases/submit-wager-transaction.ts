import type { Clock, IdGenerator, UnitOfWork } from '../ports';
import { UniqueViolationError } from '../ports';
import type { InboxContext, SubmitOutcome, TransactionView, WagerCommand } from '../contracts';
import { Money } from '../../domain/money';
import { payloadHash } from '../../domain/payload-hash';
import {
  type BackoffPolicy,
  WagerTransaction,
} from '../../domain/wager-transaction';
import { decideWager } from '../../domain/decide-wager';
import { InboxMessage } from '../../domain/inbox-message';
import { OutboxMessage } from '../../domain/outbox-message';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';

export const DEFAULT_REFERENCE_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  maxMs: 60_000,
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

    const now = this.clock.now();
    const transactionId = this.idGenerator.next();

    // Valida a forma do comando antes da transação (MODELAGEM 4.2). Lança InvalidWagerRequestError se inválido.
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

    const inboxMessage = inboxContext
      ? InboxMessage.receive({
          messageId: inboxContext.messageId,
          consumerName: inboxContext.consumerName,
          payloadHash: hash,
          at: now,
        })
      : undefined;

    try {
      return await this.uow.run(async (tx) => {
        // 1. Inbox check (quando via SQS)
        if (inboxMessage) {
          const inboxResult = await tx.inbox.tryReceive(inboxMessage);
          if (!inboxResult.accepted) {
            if (inboxResult.storedPayloadHash === hash) {
              return { type: 'DUPLICATE_MESSAGE' };
            }
            return { type: 'MESSAGE_PAYLOAD_MISMATCH' };
          }
        }

        // 2. Atalho para replays e conflitos antes do lock da wallet (SCHEMA 4.2)
        const fastTx = await tx.transactions.findByIdempotencyKey(
          command.providerId,
          command.idempotencyKey,
        );
        if (fastTx) {
          if (fastTx.matchesPayload(hash)) {
            return {
              type: 'RESULT',
              view: toTransactionView(fastTx),
              idempotentReplay: true,
            };
          }
          return { type: 'IDEMPOTENCY_CONFLICT' };
        }

        const fastExt = await tx.transactions.findByExternalId(
          command.providerId,
          command.externalTransactionId,
        );
        if (fastExt) {
          return { type: 'EXTERNAL_ID_CONFLICT' };
        }

        // 3. SELECT ... FOR UPDATE na wallet (D15)
        const wallet = await tx.wallets.lockById(command.walletId);
        if (!wallet) {
          return { type: 'WALLET_NOT_FOUND' };
        }

        // 4. Re-checagem sob o lock da wallet (SCHEMA 4.2 passo 4)
        const lockedTx = await tx.transactions.findByIdempotencyKey(
          command.providerId,
          command.idempotencyKey,
        );
        if (lockedTx) {
          if (lockedTx.matchesPayload(hash)) {
            return {
              type: 'RESULT',
              view: toTransactionView(lockedTx),
              idempotentReplay: true,
            };
          }
          return { type: 'IDEMPOTENCY_CONFLICT' };
        }

        const lockedExt = await tx.transactions.findByExternalId(
          command.providerId,
          command.externalTransactionId,
        );
        if (lockedExt) {
          return { type: 'EXTERNAL_ID_CONFLICT' };
        }

        // 5. Busca referência e verifica se já foi revertida
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

        // 6. Decisão pura de negócio (MODELAGEM 5)
        const decision = decideWager({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed,
          backoff: this.backoff,
        });

        // 7. Aplicação da decisão
        const eventContext = {
          eventId: this.idGenerator.next(),
          correlationId: command.correlationId,
          ...(command.causationId !== undefined ? { causationId: command.causationId } : {}),
          occurredAt: now,
        };

        if (decision.type === 'AWAIT_REFERENCE') {
          transaction.markPendingReference(now, this.backoff);
          await tx.transactions.insert(transaction);

          const event = WagerTransactionPendingReference.from(transaction, eventContext);
          await tx.outbox.enqueue([OutboxMessage.enqueue(event)]);
        } else if (decision.type === 'REJECT') {
          transaction.reject(decision.code, wallet.balance, now);
          await tx.transactions.insert(transaction);

          const event = WagerTransactionRejected.from(transaction, eventContext);
          await tx.outbox.enqueue([OutboxMessage.enqueue(event)]);
        } else {
          // APPLY
          if (decision.direction === undefined) {
            // LOSS não move saldo nem cria lançamento no ledger
            transaction.markProcessed(reference?.id, wallet.balance, now);
            await tx.transactions.insert(transaction);

            const event = WagerTransactionProcessed.from(transaction, eventContext);
            await tx.outbox.enqueue([OutboxMessage.enqueue(event)]);
          } else {
            // CREDIT ou DEBIT
            const expectedVersion = wallet.version;
            const entryId = this.idGenerator.next();
            const entry =
              decision.direction === LedgerDirection.Debit
                ? wallet.debit(transaction.money, transaction.id, entryId, now)
                : wallet.credit(transaction.money, transaction.id, entryId, now);

            transaction.markProcessed(reference?.id, wallet.balance, now);
            await tx.transactions.insert(transaction);
            await tx.ledger.insert(entry);
            await tx.wallets.update(wallet, expectedVersion);

            const processedEvent = WagerTransactionProcessed.from(transaction, eventContext);
            const balanceChangedEvent = WalletBalanceChanged.from(wallet, entry, {
              eventId: this.idGenerator.next(),
              correlationId: command.correlationId,
              ...(command.causationId !== undefined ? { causationId: command.causationId } : {}),
              occurredAt: now,
            });

            await tx.outbox.enqueue([
              OutboxMessage.enqueue(processedEvent),
              OutboxMessage.enqueue(balanceChangedEvent),
            ]);
          }
        }

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
            return { type: 'EXTERNAL_ID_CONFLICT' };
          }
        }
      }

      throw error;
    }
  }
}
