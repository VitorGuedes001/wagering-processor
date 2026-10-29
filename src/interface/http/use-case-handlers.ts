import { randomUUID } from 'node:crypto';
import type {
  CreateWalletCommand,
  CreateWalletOutcome,
  SubmitOutcome,
  WagerCommand,
} from '../../application/contracts';
import { type UnitOfWork, UniqueViolationError } from '../../application/ports';
import { decideWager } from '../../domain/decide-wager';
import { WagerTransactionPendingReference } from '../../domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { payloadHash } from '../../domain/payload-hash';
import {
  type BackoffPolicy,
  WagerTransaction,
} from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export const CREATE_WALLET_USE_CASE = Symbol('CREATE_WALLET_USE_CASE');
export interface CreateWalletUseCase {
  execute(command: CreateWalletCommand): Promise<CreateWalletOutcome>;
}

export const SUBMIT_WAGER_USE_CASE = Symbol('SUBMIT_WAGER_USE_CASE');
export interface SubmitWagerUseCase {
  execute(command: WagerCommand): Promise<SubmitOutcome>;
}

/**
 * Handler padrão de criação de wallet (CHALLENGE §9, ARQUITETURA §6, TESTES I-05).
 */
export class DefaultCreateWalletHandler implements CreateWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletOutcome> {
    const initialMoney = Money.from(command.initialBalance);
    const walletId = randomUUID();
    const openingTxId = randomUUID();
    const openingEntryId = randomUUID();
    const now = new Date();

    try {
      return await this.uow.run(async (tx) => {
        const opened = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance: initialMoney,
          openingTransactionId: openingTxId,
          openingEntryId: openingEntryId,
          at: now,
        });

        await tx.wallets.insert(opened.wallet);

        if (opened.openingEntry) {
          const openingTx = WagerTransaction.opening({
            id: openingTxId,
            walletId: opened.wallet.id,
            playerId: opened.wallet.playerId,
            money: initialMoney,
            at: now,
          });

          await tx.transactions.insert(openingTx);
          await tx.ledger.insert(opened.openingEntry);

          const evtProcessed = WagerTransactionProcessed.from(openingTx, {
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            causationId: command.correlationId,
          });
          const evtBalance = WalletBalanceChanged.from(opened.wallet, opened.openingEntry, {
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            causationId: command.correlationId,
          });

          await tx.outbox.enqueue([
            OutboxMessage.enqueue(evtProcessed),
            OutboxMessage.enqueue(evtBalance),
          ]);
        }

        return {
          type: 'CREATED',
          view: {
            id: opened.wallet.id,
            playerId: opened.wallet.playerId,
            balance: opened.wallet.balance.toJSON(),
            version: opened.wallet.version,
          },
        };
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallet_player_currency_uq') {
        return { type: 'WALLET_ALREADY_EXISTS' };
      }
      throw error;
    }
  }
}

/**
 * Handler padrão de submissão de apostas conforme o fluxo de SCHEMA 4.2.
 */
export class DefaultSubmitWagerHandler implements SubmitWagerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: WagerCommand): Promise<SubmitOutcome> {
    const money = Money.from(command.money);
    const hash = payloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: { amount: command.money.amount, currency: command.money.currency },
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    // 2. Atalho fora de transação para replays (SCHEMA 4.2)
    const existingQuick = await this.uow.run(async (tx) => {
      return await tx.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    });
    if (existingQuick) {
      if (existingQuick.matchesPayload(hash)) {
        return {
          type: 'RESULT',
          view: {
            transactionId: existingQuick.id,
            status: existingQuick.status,
            balance: existingQuick.balanceAfter?.toJSON(),
            failureCode: existingQuick.failureCode,
          },
          idempotentReplay: true,
        };
      }
      return { type: 'IDEMPOTENCY_CONFLICT' };
    }

    const runTransaction = async (): Promise<SubmitOutcome> => {
      return await this.uow.run(async (tx) => {
        // 3. SELECT … FROM wallet WHERE id = $walletId FOR UPDATE
        const wallet = await tx.wallets.lockById(command.walletId);
        if (!wallet) {
          return { type: 'WALLET_NOT_FOUND' };
        }

        // 4. Busca de novo (provider_id, idempotency_key) e (provider_id, external_transaction_id)
        const existingByIdem = await tx.transactions.findByIdempotencyKey(
          command.providerId,
          command.idempotencyKey,
        );
        if (existingByIdem) {
          if (existingByIdem.matchesPayload(hash)) {
            return {
              type: 'RESULT',
              view: {
                transactionId: existingByIdem.id,
                status: existingByIdem.status,
                balance: existingByIdem.balanceAfter?.toJSON(),
                failureCode: existingByIdem.failureCode,
              },
              idempotentReplay: true,
            };
          }
          return { type: 'IDEMPOTENCY_CONFLICT' };
        }

        const existingByExt = await tx.transactions.findByExternalId(
          command.providerId,
          command.externalTransactionId,
        );
        if (existingByExt) {
          return { type: 'EXTERNAL_ID_CONFLICT' };
        }

        // 5. Busca a referência por (provider_id, reference_external_transaction_id)
        let reference: WagerTransaction | undefined;
        let referenceAlreadyReversed = false;
        if (command.referenceExternalTransactionId) {
          reference = await tx.transactions.findByExternalId(
            command.providerId,
            command.referenceExternalTransactionId,
          );
          if (reference) {
            referenceAlreadyReversed = await tx.transactions.hasProcessedReversal(reference.id);
          }
        }

        const now = new Date();
        const txId = randomUUID();

        const transaction = WagerTransaction.create({
          id: txId,
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

        const backoff: BackoffPolicy = {
          baseMs: 1000,
          maxAttempts: 10,
          maxMs: 60000,
        };

        // 6. decideWager (função pura de MODELAGEM 5)
        const decision = decideWager({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed,
          backoff,
        });

        const baseCtx = {
          correlationId: command.correlationId,
          occurredAt: now,
          causationId: command.causationId || command.correlationId,
        };

        if (decision.type === 'APPLY') {
          let entry: WalletLedgerEntry | undefined;
          if (decision.direction === LedgerDirection.Debit) {
            entry = wallet.debit(transaction.money, transaction.id, randomUUID(), now);
            transaction.markProcessed(reference?.id, wallet.balance, now);
          } else if (decision.direction === LedgerDirection.Credit) {
            entry = wallet.credit(transaction.money, transaction.id, randomUUID(), now);
            transaction.markProcessed(reference?.id, wallet.balance, now);
          } else {
            // LOSS: sem efeito no saldo nem lançamento no ledger
            transaction.markProcessed(reference?.id, wallet.balance, now);
          }

          // 7. INSERT wager_transaction primeiro (SCHEMA 4.2 / ledger_transaction_fk)
          await tx.transactions.insert(transaction);

          // 8. Se APPLY com direção: INSERT wallet_ledger_entry; UPDATE wallet (SCHEMA 4.2)
          if (entry) {
            await tx.ledger.insert(entry);
            await tx.wallets.update(wallet, wallet.version - 1);
            const evt1 = WagerTransactionProcessed.from(transaction, { ...baseCtx, eventId: randomUUID() });
            const evt2 = WalletBalanceChanged.from(wallet, entry, { ...baseCtx, eventId: randomUUID() });
            await tx.outbox.enqueue([
              OutboxMessage.enqueue(evt1),
              OutboxMessage.enqueue(evt2),
            ]);
          } else {
            const evt = WagerTransactionProcessed.from(transaction, { ...baseCtx, eventId: randomUUID() });
            await tx.outbox.enqueue([OutboxMessage.enqueue(evt)]);
          }

          return {
            type: 'RESULT',
            view: {
              transactionId: transaction.id,
              status: transaction.status,
              balance: wallet.balance.toJSON(),
              failureCode: undefined,
            },
            idempotentReplay: false,
          };
        }

        if (decision.type === 'REJECT') {
          transaction.reject(decision.code, wallet.balance, now);
          await tx.transactions.insert(transaction);
          const evt = WagerTransactionRejected.from(transaction, { ...baseCtx, eventId: randomUUID() });
          await tx.outbox.enqueue([OutboxMessage.enqueue(evt)]);

          return {
            type: 'RESULT',
            view: {
              transactionId: transaction.id,
              status: transaction.status,
              balance: wallet.balance.toJSON(),
              failureCode: decision.code,
            },
            idempotentReplay: false,
          };
        }

        if (decision.type === 'AWAIT_REFERENCE') {
          transaction.markPendingReference(now, backoff);
          await tx.transactions.insert(transaction);
          const evt = WagerTransactionPendingReference.from(transaction, { ...baseCtx, eventId: randomUUID() });
          await tx.outbox.enqueue([OutboxMessage.enqueue(evt)]);

          return {
            type: 'RESULT',
            view: {
              transactionId: transaction.id,
              status: transaction.status,
              balance: undefined,
              failureCode: undefined,
            },
            idempotentReplay: false,
          };
        }

        throw new Error('Desfecho não suportado de decideWager');
      });
    };

    try {
      return await runTransaction();
    } catch (error) {
      if (
        error instanceof UniqueViolationError &&
        (error.constraint === 'wager_tx_idempotency_uq' || error.constraint === 'wager_tx_external_uq')
      ) {
        // Refaz uma vez sob concorrência (SCHEMA 4.2 / SCHEMA 5)
        return await runTransaction();
      }
      throw error;
    }
  }
}
