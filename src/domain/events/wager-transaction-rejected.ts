import { InvalidTransactionStateError } from '../errors';
import type { FailureCode } from '../failure-code';
import type { MoneyProps } from '../money';
import {
  type SubmittableKind,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  failureCode: FailureCode;
  balanceAfter: MoneyProps;
}

/** Rejeição por regra de negócio, inclusive referência que não chegou a tempo. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      transaction.kind === WagerTransactionKind.Opening ||
      transaction.providerId === undefined ||
      transaction.externalTransactionId === undefined ||
      transaction.failureCode === undefined ||
      transaction.balanceAfter === undefined
    ) {
      throw new InvalidTransactionStateError(
        `Cannot build WagerTransactionRejected from transaction in status ${transaction.status}`,
      );
    }

    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: transaction.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        walletId: transaction.walletId,
        kind: transaction.kind,
        money: transaction.money.toJSON(),
        failureCode: transaction.failureCode,
        balanceAfter: transaction.balanceAfter.toJSON(),
      },
    });
  }
}
