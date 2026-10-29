import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { UniqueViolationError } from './ports';
import type { CreateWalletCommand, CreateWalletOutcome } from './contracts';
import { Money } from '../domain/money';
import { Wallet } from '../domain/wallet';
import { WagerTransaction } from '../domain/wager-transaction';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';

export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletOutcome> {
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    const walletId = this.idGenerator.next();
    const openingTransactionId = this.idGenerator.next();
    const openingEntryId = this.idGenerator.next();

    try {
      return await this.uow.run(async (tx) => {
        const opened = Wallet.open({
          id: walletId,
          playerId: command.playerId,
          initialBalance,
          openingTransactionId,
          openingEntryId,
          at: now,
        });

        await tx.wallets.insert(opened.wallet);

        if (opened.openingEntry) {
          const openingTx = WagerTransaction.opening({
            id: openingTransactionId,
            walletId: opened.wallet.id,
            playerId: command.playerId,
            money: initialBalance,
            at: now,
          });

          await tx.transactions.insert(openingTx);
          await tx.ledger.insert(opened.openingEntry);

          const processedEvent = WagerTransactionProcessed.from(openingTx, {
            eventId: this.idGenerator.next(),
            correlationId: command.correlationId,
            occurredAt: now,
          });

          const balanceChangedEvent = WalletBalanceChanged.from(opened.wallet, opened.openingEntry, {
            eventId: this.idGenerator.next(),
            correlationId: command.correlationId,
            occurredAt: now,
          });

          await tx.outbox.enqueue([
            OutboxMessage.enqueue(processedEvent),
            OutboxMessage.enqueue(balanceChangedEvent),
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
