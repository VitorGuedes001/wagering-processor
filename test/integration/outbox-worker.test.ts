import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PublishOutbox } from '../../src/application/publish-outbox';
import type { EventContext } from '../../src/domain/events/integration-event';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { Wallet } from '../../src/domain/wallet';
import { SystemClock } from '../../src/infrastructure/clock';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MetricsRegistry } from '../../src/infrastructure/observability/metrics';
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
import { OutboxWorker } from '../../src/interface/workers/outbox.worker';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { buildPostgresUrl } from '../support/preload';
import { createTestQueues, type TestQueues } from '../support/queues';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const WORKER_SCRIPT = resolve(import.meta.dir, '../support/uow-fault-worker.ts');

function makeEventContext(overrides: Partial<EventContext> = {}): EventContext {
  return {
    eventId: overrides.eventId ?? randomUUID(),
    correlationId: overrides.correlationId ?? randomUUID(),
    causationId: overrides.causationId ?? `cause-${randomUUID()}`,
    occurredAt: overrides.occurredAt ?? new Date(),
  };
}

describe('I-16: Outbox Worker Integration (TESTES §4.2; ARQUITETURA §7.3; D18, D20, D62)', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let orm: MikroORM;
  let uow: MikroOrmUnitOfWork;
  let metrics: MetricsRegistry;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues('i16');

    orm = await MikroORM.init(
      defineConfig({
        metadataProvider: ReflectMetadataProvider,
        entities: [
          WalletRecord,
          LedgerEntryRecord,
          WagerTransactionRecord,
          InboxMessageRecord,
          OutboxMessageRecord,
        ],
        clientUrl: buildPostgresUrl(db.name),
        discovery: { warnWhenNoEntities: false },
        pool: { min: 1, max: 5 },
      }),
    );

    uow = new MikroOrmUnitOfWork(
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

    metrics = new MetricsRegistry();
  });

  afterAll(async () => {
    await orm.close(true);
    await queues.delete();
    await db.drop();
  });

  test('I-16 caminho feliz: evento publicado no SQS após commit da UoW, publicado exatamente uma vez com deduplicação por eventId', async () => {
    const config = {
      OUTBOX_POLL_MS: 50,
      OUTBOX_BATCH: 10,
      OUTBOX_LEASE_MS: 30000,
      SHUTDOWN_GRACE_MS: 5000,
      ENABLE_OUTBOX_WORKER: true,
      SQS_EVENTS_QUEUE: queues.events,
    } as any;

    const publisher = new SqsEventPublisher(queues.sqs, config);
    const publishOutbox = new PublishOutbox(uow, publisher, new SystemClock());
    const worker = new OutboxWorker(publishOutbox, config, metrics);

    const walletId = randomUUID();
    const eventId = randomUUID();
    const now = new Date();

    const initialBalance = Money.from({ amount: '200.00', currency: 'BRL' });
    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: randomUUID(),
      initialBalance,
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      at: now,
    });

    const event = WalletBalanceChanged.from(wallet, openingEntry!, {
      ...makeEventContext({ eventId, occurredAt: now }),
    });
    const outboxMessage = OutboxMessage.enqueue(event);

    // 1. Commit da transação persistindo o evento na outbox
    await uow.run(async (tx) => {
      await tx.outbox.enqueue([outboxMessage]);
    });

    // Confere que no banco o evento está pendente
    const [pendingRow] = await db.sql<Array<{ published_at: Date | null }>>`
      SELECT published_at FROM outbox_message WHERE id = ${eventId}
    `;
    expect(pendingRow?.published_at).toBeNull();

    // 2. Executa um tick do worker
    const published = await worker.tick(now);
    expect(published).toBe(1);

    // 3. Confere que no banco o evento foi marcado como publicado
    const [publishedRow] = await db.sql<Array<{ published_at: Date | null }>>`
      SELECT published_at FROM outbox_message WHERE id = ${eventId}
    `;
    expect(publishedRow?.published_at).not.toBeNull();

    // 4. Recebe mensagem do SQS
    const sqsRes = await queues.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventsUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 5,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      }),
    );

    expect(sqsRes.Messages).toBeDefined();
    expect(sqsRes.Messages!.length).toBe(1);

    const received = sqsRes.Messages![0]!;
    const parsedBody = JSON.parse(received.Body!);
    expect(parsedBody.eventId).toBe(eventId);
    expect(parsedBody.eventType).toBe('WalletBalanceChanged');
    expect(parsedBody.aggregateId).toBe(walletId);

    // FIFO attributes (D20)
    expect(received.Attributes?.MessageGroupId).toBe(walletId);
    expect(received.Attributes?.MessageDeduplicationId).toBe(eventId);

    // Remove a mensagem recebida
    await queues.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queues.eventsUrl,
        ReceiptHandle: received.ReceiptHandle!,
      }),
    );

    // 5. Segundo tick não republica o evento (publicado apenas uma vez)
    const publishedAgain = await worker.tick(now);
    expect(publishedAgain).toBe(0);

    const secondSqsRes = await queues.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventsUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    expect(secondSqsRes.Messages ?? []).toHaveLength(0);

    // Lag deve ser 0 após publicação
    const currentLag = await worker.computeLag(now);
    expect(currentLag).toBe(0);
  });

  test('I-16 uow.before-commit: quando a transação morre antes do commit, nada é persistido no outbox e nada sai para o SQS', async () => {
    const walletId = randomUUID();
    const eventId = randomUUID();

    const proc = Bun.spawn(['bun', WORKER_SCRIPT], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DB_NAME: db.name,
        FAULT_POINT: 'uow.before-commit',
        TARGET_WALLET_ID: walletId,
        TARGET_EVENT_ID: eventId,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);

    // Sobe o worker após o crash e roda um tick para provar que nada sai
    const config = {
      OUTBOX_POLL_MS: 50,
      OUTBOX_BATCH: 10,
      OUTBOX_LEASE_MS: 30000,
      SHUTDOWN_GRACE_MS: 5000,
      ENABLE_OUTBOX_WORKER: true,
      SQS_EVENTS_QUEUE: queues.events,
    } as any;
    const publisher = new SqsEventPublisher(queues.sqs, config);
    const publishOutbox = new PublishOutbox(uow, publisher, new SystemClock());
    const worker = new OutboxWorker(publishOutbox, config, metrics);

    const published = await worker.tick();
    expect(published).toBe(0);

    // Verifica que nada persiste na tabela outbox_message
    const [outboxCount] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM outbox_message WHERE id = ${eventId}
    `;
    expect(outboxCount?.count).toBe(0);

    // Verifica que nenhuma mensagem foi enviada ao SQS
    const sqsRes = await queues.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queues.eventsUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
      }),
    );
    expect(sqsRes.Messages ?? []).toHaveLength(0);
  });

  test('Observabilidade e retries: falha na publicação no SQS incrementa wagering_retries_total e agenda retry com backoff', async () => {
    const config = {
      OUTBOX_POLL_MS: 50,
      OUTBOX_BATCH: 10,
      OUTBOX_LEASE_MS: 30000,
      SHUTDOWN_GRACE_MS: 5000,
      ENABLE_OUTBOX_WORKER: true,
      SQS_EVENTS_QUEUE: queues.events,
    } as any;

    // Publisher falho que lança erro de rede simulando indisponibilidade do SQS
    const failingPublisher = {
      publish: async () => {
        throw new Error('Falha simulada de rede no SQS');
      },
    };

    const publishOutbox = new PublishOutbox(uow, failingPublisher, new SystemClock());
    const worker = new OutboxWorker(publishOutbox, config, metrics);

    const eventId = randomUUID();
    const occurredAt = new Date(Date.now() - 5000); // 5 segundos atrás

    const opened = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
      openingTransactionId: randomUUID(),
      openingEntryId: randomUUID(),
      at: occurredAt,
    });

    const event = WalletBalanceChanged.from(opened.wallet, opened.openingEntry!, {
      ...makeEventContext({ eventId, occurredAt }),
    });

    const msg = OutboxMessage.enqueue(event);
    await uow.run(async (tx) => {
      await tx.outbox.enqueue([msg]);
    });

    // Executa tick com publisher falho
    const tickTime = new Date();
    const published = await worker.tick(tickTime);
    expect(published).toBe(0);

    // Verifica que a linha continua sem published_at, mas com attempts = 1 e next_attempt_at calculado com backoff
    const [row] = await db.sql<Array<{ attempts: number; published_at: Date | null; next_attempt_at: Date }>>`
      SELECT attempts, published_at, next_attempt_at FROM outbox_message WHERE id = ${eventId}
    `;
    expect(row?.published_at).toBeNull();
    expect(row?.attempts).toBe(1);
    // Para attempts = 1: base = 1000ms, backoff = 2^1 * 1000 = 2000ms
    expect(row?.next_attempt_at.getTime()).toBeGreaterThanOrEqual(tickTime.getTime() + 1900);

    // Verifica que a métrica wagering_retries_total foi incrementada para o componente outbox
    const metricsOutput = await metrics.registry.metrics();
    expect(metricsOutput).toContain('wagering_retries_total{component="outbox"} 1');
  });
});
