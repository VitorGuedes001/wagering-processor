import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { InboxMessage } from '../../src/domain/inbox-message';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransaction } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { MikroOrmInboxRepository } from '../../src/infrastructure/persistence/inbox-repository';
import { MikroOrmLedgerRepository } from '../../src/infrastructure/persistence/ledger-repository';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/outbox-repository';
import { InboxMessageRecord } from '../../src/infrastructure/persistence/records/inbox-message.record';
import { LedgerEntryRecord } from '../../src/infrastructure/persistence/records/ledger-entry.record';
import { OutboxMessageRecord } from '../../src/infrastructure/persistence/records/outbox-message.record';
import { WagerTransactionRecord } from '../../src/infrastructure/persistence/records/wager-transaction.record';
import { WalletRecord } from '../../src/infrastructure/persistence/records/wallet.record';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { MikroOrmWagerTransactionRepository } from '../../src/infrastructure/persistence/wager-transaction-repository';
import { MikroOrmWalletRepository } from '../../src/infrastructure/persistence/wallet-repository';
import { buildPostgresUrl } from './preload';

async function main(): Promise<void> {
  const dbName = process.env.DB_NAME;
  if (!dbName) {
    throw new Error('DB_NAME não especificado no ambiente do worker');
  }

  const walletId = process.env.TARGET_WALLET_ID ?? randomUUID();
  const txId = process.env.TARGET_TX_ID ?? randomUUID();
  const ledgerId = process.env.TARGET_LEDGER_ID ?? randomUUID();
  const messageId = process.env.TARGET_MESSAGE_ID ?? `msg-${randomUUID()}`;
  const eventId = process.env.TARGET_EVENT_ID ?? randomUUID();
  const playerId = randomUUID();

  const orm = await MikroORM.init(
    defineConfig({
      metadataProvider: ReflectMetadataProvider,
      entities: [
        WalletRecord,
        LedgerEntryRecord,
        WagerTransactionRecord,
        InboxMessageRecord,
        OutboxMessageRecord,
      ],
      clientUrl: buildPostgresUrl(dbName),
      discovery: { warnWhenNoEntities: false },
      pool: { min: 1, max: 2 },
    }),
  );

  const uow = new MikroOrmUnitOfWork(
    orm,
    { DB_LOCK_TIMEOUT_MS: 2000 },
    {
      wallets: (em) => new MikroOrmWalletRepository(em),
      transactions: (em) => new MikroOrmWagerTransactionRepository(em),
      ledger: (em) => new MikroOrmLedgerRepository(em),
      inbox: (em) => new MikroOrmInboxRepository(em),
      outbox: (em) => new MikroOrmOutboxRepository(em),
    },
  );

  try {
    await uow.run(async (tx) => {
      const initialBalance = Money.from({ amount: '100.00', currency: 'BRL' });
      const now = new Date();

      // 1. Wallet.open + LedgerEntry de abertura
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId,
        initialBalance,
        openingTransactionId: txId,
        openingEntryId: ledgerId,
        at: now,
      });
      await tx.wallets.insert(wallet);

      // 2. Transação OPENING (precisa ser inserida antes do ledger por causa da FK ledger_transaction_fk)
      const openingTx = WagerTransaction.opening({
        id: txId,
        walletId,
        playerId,
        money: initialBalance,
        at: now,
      });
      await tx.transactions.insert(openingTx);

      // 3. LedgerEntry de abertura
      if (openingEntry) {
        await tx.ledger.insert(openingEntry);
      }

      // 3. InboxMessage
      const inbox = InboxMessage.receive({
        messageId,
        consumerName: 'test-consumer',
        payloadHash: 'f'.repeat(64),
        at: now,
      });
      await tx.inbox.tryReceive(inbox);

      // 4. OutboxMessage
      const event = WalletBalanceChanged.from(wallet, openingEntry!, {
        eventId,
        correlationId: randomUUID(),
        occurredAt: now,
      });
      const outbox = OutboxMessage.enqueue(event);
      await tx.outbox.enqueue([outbox]);
    });

    console.log(JSON.stringify({ status: 'committed', walletId, txId }));
  } finally {
    await orm.close(true);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
