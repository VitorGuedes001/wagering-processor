import type { FailureCode } from '../failure-code';
import type { MoneyProps } from '../money';
import { notImplemented } from '../not-implemented';
import type { SubmittableKind, WagerTransaction } from '../wager-transaction';
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

/** Rejeição por regra de negócio, inclusive referência que não chegou a tempo (§11, §7.1). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return notImplemented('T13', transaction, ctx);
  }
}
