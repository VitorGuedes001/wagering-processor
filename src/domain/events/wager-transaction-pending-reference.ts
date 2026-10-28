import { notImplemented } from '../not-implemented';
import type { SubmittableKind, WagerTransaction } from '../wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: SubmittableKind;
  referenceExternalTransactionId: string;
}

/** Referência ausente na primeira tentativa. Não se repete a cada retry do worker (MODELAGEM 5). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return notImplemented('T13', transaction, ctx);
  }
}
