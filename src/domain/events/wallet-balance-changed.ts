import { InvalidTransactionStateError } from '../errors';
import type { MoneyProps } from '../money';
import type { Wallet } from '../wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet-ledger-entry';
import { type EventContext, IntegrationEvent, type IntegrationEventProps } from './integration-event';

/** Literal de CHALLENGE §11. */
export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. `aggregateId` = `walletId`. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    // Par trocado no use case é bug (MODELAGEM 10.4), não um evento de outra wallet.
    if (entry.walletId !== wallet.id) {
      throw new InvalidTransactionStateError(
        `Ledger entry ${entry.id} belongs to wallet ${entry.walletId}, not ${wallet.id}`,
      );
    }

    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
