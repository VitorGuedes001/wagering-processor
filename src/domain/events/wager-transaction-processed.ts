import type { MoneyProps } from '../money';
import { notImplemented } from '../not-implemented';
import type { WagerTransaction, WagerTransactionKind } from '../wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

/** Campos de provedor ausentes só no `OPENING` (D42). */
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

/** Qualquer transação aplicada, inclusive `LOSS` e `OPENING` (§11). `aggregateId` = `transactionId`. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return notImplemented('T13', transaction, ctx);
  }
}
