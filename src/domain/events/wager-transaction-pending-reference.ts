import { InvalidTransactionStateError } from '../errors';
import {
  type SubmittableKind,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: SubmittableKind;
  referenceExternalTransactionId: string;
}

/** Referência ausente na primeira tentativa. Não se repete a cada retry do worker. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      transaction.kind === WagerTransactionKind.Opening ||
      transaction.providerId === undefined ||
      transaction.externalTransactionId === undefined ||
      transaction.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidTransactionStateError(
        `Cannot build WagerTransactionPendingReference from transaction in status ${transaction.status}`,
      );
    }

    return new WagerTransactionPendingReference({
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
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
      },
    });
  }
}
