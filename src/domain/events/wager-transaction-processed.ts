import { InvalidTransactionStateError } from '../errors';
import type { MoneyProps } from '../money';
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

/** Campos de provedor ausentes só no `OPENING`. */
export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId?: string;
  externalTransactionId?: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  /** ISO-8601. */
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive `LOSS` e `OPENING`. `aggregateId` = `transactionId`. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    // Campos de provedor só podem faltar no `OPENING` (`wager_tx_provider_fields_ck`).
    const missingProviderFields =
      transaction.kind !== WagerTransactionKind.Opening &&
      (transaction.providerId === undefined ||
        transaction.externalTransactionId === undefined ||
        transaction.roundId === undefined ||
        transaction.gameId === undefined);
    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      transaction.balanceAfter === undefined ||
      transaction.processedAt === undefined ||
      missingProviderFields
    ) {
      throw new InvalidTransactionStateError(
        `Cannot build WagerTransactionProcessed from transaction in status ${transaction.status}`,
      );
    }

    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        ...(transaction.providerId !== undefined ? { providerId: transaction.providerId } : {}),
        ...(transaction.externalTransactionId !== undefined
          ? { externalTransactionId: transaction.externalTransactionId }
          : {}),
        walletId: transaction.walletId,
        playerId: transaction.playerId,
        ...(transaction.roundId !== undefined ? { roundId: transaction.roundId } : {}),
        ...(transaction.gameId !== undefined ? { gameId: transaction.gameId } : {}),
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        ...(transaction.referenceTransactionId !== undefined
          ? { referenceTransactionId: transaction.referenceTransactionId }
          : {}),
        balanceAfter: transaction.balanceAfter.toJSON(),
        processedAt: transaction.processedAt.toISOString(),
      },
    });
  }
}
