import { randomUUID } from 'node:crypto';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { InboxReceiveResult, TxRepositories, UnitOfWork } from '../../src/application/ports';
import type { EventContext } from '../../src/domain/events/integration-event';
import { WagerTransactionPendingReference } from '../../src/domain/events/wager-transaction-pending-reference';
import { WagerTransactionProcessed } from '../../src/domain/events/wager-transaction-processed';
import { WagerTransactionRejected } from '../../src/domain/events/wager-transaction-rejected';
import { WalletBalanceChanged } from '../../src/domain/events/wallet-balance-changed';
import { FailureCode } from '../../src/domain/failure-code';
import { InboxMessage } from '../../src/domain/inbox-message';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import {
  InboxMessageNotProcessedError,
  MikroOrmInboxRepository,
} from '../../src/infrastructure/persistence/inbox-repository';
import { MikroOrmOutboxRepository } from '../../src/infrastructure/persistence/outbox-repository';
import { InboxMessageRecord } from '../../src/infrastructure/persistence/records/inbox-message.record';
import { OutboxMessageRecord } from '../../src/infrastructure/persistence/records/outbox-message.record';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { assertAllWalletsConsistent } from '../support/invariants';
import { getTestInfraConfig } from '../support/preload';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CONSUMER = 'wager-transactions-consumer';

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('esperava erro');
}

function makeEventContext(overrides: Partial<EventContext> = {}): EventContext {
  return {
    eventId: overrides.eventId ?? randomUUID(),
    correlationId: overrides.correlationId ?? randomUUID(),
    causationId: overrides.causationId ?? `cause-${randomUUID()}`,
    occurredAt: overrides.occurredAt ?? new Date('2026-10-28T15:00:00.000Z'),
  };
}

function makeProcessedEvent(
  ctx: EventContext,
  amount = '125.50',
  balanceAfter = '874.50',
): WagerTransactionProcessed {
  const createdAt = new Date(ctx.occurredAt.getTime() - 500);
  const tx = WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    idempotencyKey: `idem-${randomUUID()}`,
    payloadHash: HASH_A,
    walletId: randomUUID(),
    playerId: randomUUID(),
    roundId: 'round-1',
    gameId: 'game-1',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount, currency: 'BRL' }),
    at: createdAt,
  });
  tx.markProcessed(undefined, Money.from({ amount: balanceAfter, currency: 'BRL' }), ctx.occurredAt);
  return WagerTransactionProcessed.from(tx, ctx);
}

describe('I-03: Repositórios e Records de Inbox e Outbox (SCHEMA 2.4, 2.5, 4.3, 4.4, 4.5, 7; D7, D12, D18, D25, D62)', () => {
  let db: TestDatabase;
  let orm: MikroORM;
  let inboxRepo: MikroOrmInboxRepository;
  let outboxRepo: MikroOrmOutboxRepository;

  beforeAll(async () => {
    db = await createTestDatabase();
    const cfg = getTestInfraConfig();

    orm = await MikroORM.init(
      defineConfig({
        host: cfg.dbHost,
        port: cfg.dbPort,
        user: cfg.dbUser,
        password: cfg.dbPassword,
        dbName: db.name,
        entities: [InboxMessageRecord, OutboxMessageRecord],
        metadataProvider: ReflectMetadataProvider,
        discovery: { warnWhenNoEntities: false },
        debug: false,
        forceUtcTimezone: true,
      }),
    );
  });

  beforeEach(async () => {
    await db.reset();
    const em = orm.em.fork();
    inboxRepo = new MikroOrmInboxRepository(em);
    outboxRepo = new MikroOrmOutboxRepository(em);
  });

  afterEach(async () => {
    await assertAllWalletsConsistent(db);
  });

  afterAll(async () => {
    if (orm) {
      await orm.close(true);
    }
    if (db) {
      await db.drop();
    }
  });

  describe('I-03 (inbox): ida e volta domínio → record → banco → record → domínio e deduplicação', () => {
    test('ida e volta via InboxMessageRecord e EntityManager (pendente e processada)', async () => {
      const receivedAt = new Date('2026-10-28T12:00:00.123Z');
      const processedAt = new Date('2026-10-28T12:00:01.456Z');

      const pendingDomain = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'msg-record-pending',
        payloadHash: HASH_A,
        at: receivedAt,
      });

      const pendingRecord = InboxMessageRecord.fromDomain(pendingDomain);
      const emWrite = orm.em.fork();
      emWrite.persist(pendingRecord);
      await emWrite.flush();

      const emRead = orm.em.fork();
      const loadedPendingRecord = await emRead.findOneOrFail(InboxMessageRecord, {
        consumerName: CONSUMER,
        messageId: 'msg-record-pending',
      });
      const rehydratedPending = loadedPendingRecord.toDomain();

      expect(rehydratedPending.consumerName).toBe(CONSUMER);
      expect(rehydratedPending.messageId).toBe('msg-record-pending');
      expect(rehydratedPending.payloadHash).toBe(HASH_A);
      expect(rehydratedPending.receivedAt.toISOString()).toBe(receivedAt.toISOString());
      expect(rehydratedPending.processedAt).toBeUndefined();
      expect(rehydratedPending.isProcessed()).toBe(false);

      // Agora com processedAt preenchido
      const processedDomain = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'msg-record-processed',
        payloadHash: HASH_B,
        at: receivedAt,
      });
      processedDomain.markProcessed(processedAt);

      const processedRecord = InboxMessageRecord.fromDomain(processedDomain);
      const emWrite2 = orm.em.fork();
      emWrite2.persist(processedRecord);
      await emWrite2.flush();

      const emRead2 = orm.em.fork();
      const loadedProcessedRecord = await emRead2.findOneOrFail(InboxMessageRecord, {
        consumerName: CONSUMER,
        messageId: 'msg-record-processed',
      });
      const rehydratedProcessed = InboxMessageRecord.toDomain(loadedProcessedRecord);

      expect(rehydratedProcessed.consumerName).toBe(CONSUMER);
      expect(rehydratedProcessed.messageId).toBe('msg-record-processed');
      expect(rehydratedProcessed.payloadHash).toBe(HASH_B);
      expect(rehydratedProcessed.receivedAt.toISOString()).toBe(receivedAt.toISOString());
      expect(rehydratedProcessed.processedAt?.toISOString()).toBe(processedAt.toISOString());
      expect(rehydratedProcessed.isProcessed()).toBe(true);
    });

    test('tryReceive insere na 1ª entrega e devolve storedPayloadHash em entregas repetidas (mesmo hash ou D7 divergente)', async () => {
      const t1 = new Date('2026-10-28T13:00:00.000Z');
      const t2 = new Date('2026-10-28T13:00:05.000Z');
      const t3 = new Date('2026-10-28T13:00:10.000Z');

      const first = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'sqs-msg-001',
        payloadHash: HASH_A,
        at: t1,
      });

      const res1 = await inboxRepo.tryReceive(first);
      expect(res1).toEqual({ accepted: true });

      // Redelivery com mesmo messageId e mesmo payloadHash
      const duplicateSameHash = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'sqs-msg-001',
        payloadHash: HASH_A,
        at: t2,
      });
      const res2 = await inboxRepo.tryReceive(duplicateSameHash);
      expect(res2).toEqual({ accepted: false, storedPayloadHash: HASH_A });

      // Redelivery com mesmo messageId e payloadHash diferente (D7)
      const duplicateDifferentHash = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'sqs-msg-001',
        payloadHash: HASH_B,
        at: t3,
      });
      const res3 = await inboxRepo.tryReceive(duplicateDifferentHash);
      expect(res3).toEqual({ accepted: false, storedPayloadHash: HASH_A });

      // Confere que a linha original não foi sobrescrita por nenhuma das tentativas
      const stored = await inboxRepo.findByKey(CONSUMER, 'sqs-msg-001');
      expect(stored).toBeDefined();
      expect(stored!.payloadHash).toBe(HASH_A);
      expect(stored!.receivedAt.toISOString()).toBe(t1.toISOString());
      expect(stored!.processedAt).toBeUndefined();

      // Mesmo messageId em outro consumerName é aceito (PK composta)
      const otherConsumerMsg = InboxMessage.receive({
        consumerName: 'other-consumer',
        messageId: 'sqs-msg-001',
        payloadHash: HASH_B,
        at: t2,
      });
      const resOther = await inboxRepo.tryReceive(otherConsumerMsg);
      expect(resOther).toEqual({ accepted: true });
    });

    test('corrida de SCHEMA 4.3: duas transações concorrentes com o mesmo messageId — a 2ª aguarda a 1ª e recebe accepted:false (hash da 1ª) no commit ou accepted:true no rollback', async () => {
      const t1 = new Date('2026-10-28T13:05:00.000Z');
      const t2 = new Date('2026-10-28T13:05:01.000Z');

      // 1. Primeira transação faz COMMIT -> segunda recebe accepted:false com o hash da primeira
      let markTx1Inserted!: () => void;
      const tx1Inserted = new Promise<void>((resolve) => {
        markTx1Inserted = resolve;
      });
      let releaseTx1Commit!: () => void;
      const tx1MayCommit = new Promise<void>((resolve) => {
        releaseTx1Commit = resolve;
      });

      const tx1CommitPromise = orm.em.fork().transactional(async (txEm1) => {
        const repo1 = new MikroOrmInboxRepository(txEm1);
        const res = await repo1.tryReceive(
          InboxMessage.receive({
            consumerName: CONSUMER,
            messageId: 'race-commit-msg',
            payloadHash: HASH_A,
            at: t1,
          }),
        );
        expect(res).toEqual({ accepted: true });
        markTx1Inserted();
        await tx1MayCommit;
      });

      await tx1Inserted;

      let tx2CommitFinished = false;
      const tx2CommitPromise: Promise<InboxReceiveResult> = orm.em
        .fork()
        .transactional(async (txEm2) => {
          const repo2 = new MikroOrmInboxRepository(txEm2);
          const res = await repo2.tryReceive(
            InboxMessage.receive({
              consumerName: CONSUMER,
              messageId: 'race-commit-msg',
              payloadHash: HASH_B,
              at: t2,
            }),
          );
          tx2CommitFinished = true;
          return res;
        });

      // Aguarda até o Postgres registrar a 2ª transação bloqueada no lock da 1ª (sem sleep)
      await eventually(async () => {
        const waiting = await db.sql<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count
            FROM pg_stat_activity
           WHERE datname = ${db.name}
             AND wait_event_type = 'Lock'
             AND state = 'active'
        `;
        expect(waiting[0]?.count).toBe(1);
      });
      expect(tx2CommitFinished).toBe(false);

      releaseTx1Commit();
      await tx1CommitPromise;
      const resAfterCommit = await tx2CommitPromise;

      expect(resAfterCommit).toEqual({ accepted: false, storedPayloadHash: HASH_A });

      // 2. Primeira transação faz ROLLBACK -> segunda é desbloqueada e recebe accepted:true
      let markTx1RollbackInserted!: () => void;
      const tx1RollbackInserted = new Promise<void>((resolve) => {
        markTx1RollbackInserted = resolve;
      });
      let releaseTx1Rollback!: () => void;
      const tx1MayRollback = new Promise<void>((resolve) => {
        releaseTx1Rollback = resolve;
      });

      const tx1RollbackPromise = caught(() =>
        orm.em.fork().transactional(async (txEm1) => {
          const repo1 = new MikroOrmInboxRepository(txEm1);
          const res = await repo1.tryReceive(
            InboxMessage.receive({
              consumerName: CONSUMER,
              messageId: 'race-rollback-msg',
              payloadHash: HASH_A,
              at: t1,
            }),
          );
          expect(res).toEqual({ accepted: true });
          markTx1RollbackInserted();
          await tx1MayRollback;
          throw new Error('rollback da 1ª transação');
        }),
      );

      await tx1RollbackInserted;

      let tx2RollbackFinished = false;
      const tx2RollbackPromise: Promise<InboxReceiveResult> = orm.em
        .fork()
        .transactional(async (txEm2) => {
          const repo2 = new MikroOrmInboxRepository(txEm2);
          const res = await repo2.tryReceive(
            InboxMessage.receive({
              consumerName: CONSUMER,
              messageId: 'race-rollback-msg',
              payloadHash: HASH_B,
              at: t2,
            }),
          );
          tx2RollbackFinished = true;
          return res;
        });

      await eventually(async () => {
        const waiting = await db.sql<Array<{ count: number }>>`
          SELECT COUNT(*)::int AS count
            FROM pg_stat_activity
           WHERE datname = ${db.name}
             AND wait_event_type = 'Lock'
             AND state = 'active'
        `;
        expect(waiting[0]?.count).toBe(1);
      });
      expect(tx2RollbackFinished).toBe(false);

      releaseTx1Rollback();
      const rollbackErr = await tx1RollbackPromise;
      expect((rollbackErr as Error).message).toBe('rollback da 1ª transação');

      const resAfterRollback = await tx2RollbackPromise;
      expect(resAfterRollback).toEqual({ accepted: true });

      const winnerInDb = await inboxRepo.findByKey(CONSUMER, 'race-rollback-msg');
      expect(winnerInDb?.payloadHash).toBe(HASH_B);
    });

    test('markProcessed grava processed_at e valida estado/existência da mensagem com erro próprio da infraestrutura', async () => {
      const receivedAt = new Date('2026-10-28T13:10:00.000Z');
      const processedAt = new Date('2026-10-28T13:10:00.350Z');

      const msg = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'sqs-msg-002',
        payloadHash: HASH_A,
        at: receivedAt,
      });

      await inboxRepo.tryReceive(msg);

      // Chamar markProcessed no repositório sem antes chamar msg.markProcessed(at) lança erro de infraestrutura
      await expect(inboxRepo.markProcessed(msg)).rejects.toBeInstanceOf(
        InboxMessageNotProcessedError,
      );

      msg.markProcessed(processedAt);
      await inboxRepo.markProcessed(msg);

      const loaded = await inboxRepo.findByKey(CONSUMER, 'sqs-msg-002');
      expect(loaded).toBeDefined();
      expect(loaded!.isProcessed()).toBe(true);
      expect(loaded!.processedAt?.toISOString()).toBe(processedAt.toISOString());

      // Chamar markProcessed para mensagem inexistente no banco lança erro
      const ghost = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'non-existent-msg',
        payloadHash: HASH_A,
        at: receivedAt,
      });
      ghost.markProcessed(processedAt);
      await expect(inboxRepo.markProcessed(ghost)).rejects.toThrow(/InboxMessage não encontrada/);
    });
  });

  describe('I-03 (outbox): ida e volta domínio → record → banco → record → domínio e restrição 5.1', () => {
    test('enqueue e leitura reconstroem os 4 eventos de domínio preservando valores monetários como string no jsonb (5.1)', async () => {
      const occurredAt = new Date('2026-10-28T14:00:00.000Z');
      const walletId = randomUUID();
      const playerId = randomUUID();
      const openingTxId = randomUUID();
      const openingEntryId = randomUUID();

      // 1. Wallet.open + WagerTransaction.opening -> WagerTransactionProcessed + WalletBalanceChanged
      const initialBalance = Money.from({ amount: '99999999999999999.99', currency: 'BRL' });
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId,
        initialBalance,
        openingTransactionId: openingTxId,
        openingEntryId,
        at: occurredAt,
      });
      const openingTx = WagerTransaction.opening({
        id: openingTxId,
        walletId,
        playerId,
        money: initialBalance,
        at: occurredAt,
      });

      const processedEvt = WagerTransactionProcessed.from(
        openingTx,
        makeEventContext({ occurredAt }),
      );
      const balanceChangedEvt = WalletBalanceChanged.from(
        wallet,
        openingEntry!,
        makeEventContext({ occurredAt }),
      );

      // 2. WagerTransactionRejected
      const rejectedTx = WagerTransaction.create({
        id: randomUUID(),
        providerId: 'provider-a',
        externalTransactionId: 'ext-rej-1',
        idempotencyKey: 'idem-rej-1',
        payloadHash: HASH_A,
        walletId,
        playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Bet,
        money: Money.from({ amount: '0.01', currency: 'BRL' }),
        at: occurredAt,
      });
      rejectedTx.reject(
        FailureCode.InsufficientFunds,
        Money.from({ amount: '0.00', currency: 'BRL' }),
        occurredAt,
      );
      const rejectedEvt = WagerTransactionRejected.from(
        rejectedTx,
        makeEventContext({ occurredAt }),
      );

      // 3. WagerTransactionPendingReference
      const pendingRefTx = WagerTransaction.create({
        id: randomUUID(),
        providerId: 'provider-a',
        externalTransactionId: 'ext-pref-1',
        idempotencyKey: 'idem-pref-1',
        payloadHash: HASH_B,
        walletId,
        playerId,
        roundId: 'round-1',
        gameId: 'game-1',
        kind: WagerTransactionKind.Refund,
        money: Money.from({ amount: '25.00', currency: 'BRL' }),
        referenceExternalTransactionId: 'ext-bet-missing',
        at: occurredAt,
      });
      pendingRefTx.markPendingReference(occurredAt, {
        baseMs: 1_000,
        maxMs: 300_000,
        maxAttempts: 10,
      });
      const pendingRefEvt = WagerTransactionPendingReference.from(
        pendingRefTx,
        makeEventContext({ occurredAt }),
      );

      const outboxMessages = [
        OutboxMessage.enqueue(processedEvt),
        OutboxMessage.enqueue(balanceChangedEvt),
        OutboxMessage.enqueue(rejectedEvt),
        OutboxMessage.enqueue(pendingRefEvt),
      ];

      await outboxRepo.enqueue(outboxMessages);

      // Verifica cada mensagem lida pelo repositório e pelo Record
      for (const original of outboxMessages) {
        const loaded = await outboxRepo.findById(original.id);
        expect(loaded).toBeDefined();
        expect(loaded!.id).toBe(original.id);
        expect(loaded!.aggregateId).toBe(original.aggregateId);
        expect(loaded!.eventType).toBe(original.eventType);
        expect(loaded!.occurredAt.toISOString()).toBe(original.occurredAt.toISOString());
        expect(loaded!.attempts).toBe(0);
        expect(loaded!.nextAttemptAt.toISOString()).toBe(original.nextAttemptAt.toISOString());
        expect(loaded!.publishedAt).toBeUndefined();
        expect(loaded!.isPending()).toBe(true);
        expect(loaded!.payload).toEqual(original.payload);
      }

      // Verificação explícita da restrição 5.1 nos payloads lidos do jsonb
      const loadedProcessed = (await outboxRepo.findById(processedEvt.eventId))!;
      const processedData = loadedProcessed.payload.data as Record<string, unknown>;
      const processedMoney = processedData.money as { amount: unknown; currency: unknown };
      const processedBalanceAfter = processedData.balanceAfter as {
        amount: unknown;
        currency: unknown;
      };
      expect(typeof processedMoney.amount).toBe('string');
      expect(processedMoney.amount).toBe('99999999999999999.99');
      expect(typeof processedBalanceAfter.amount).toBe('string');
      expect(processedBalanceAfter.amount).toBe('99999999999999999.99');

      const loadedBalanceChanged = (await outboxRepo.findById(balanceChangedEvt.eventId))!;
      const balanceData = loadedBalanceChanged.payload.data as Record<string, unknown>;
      const entryMoney = balanceData.money as { amount: unknown };
      const balanceBefore = balanceData.balanceBefore as { amount: unknown };
      const balanceAfter = balanceData.balanceAfter as { amount: unknown };
      expect(typeof entryMoney.amount).toBe('string');
      expect(entryMoney.amount).toBe('99999999999999999.99');
      expect(typeof balanceBefore.amount).toBe('string');
      expect(balanceBefore.amount).toBe('0.00');
      expect(typeof balanceAfter.amount).toBe('string');
      expect(balanceAfter.amount).toBe('99999999999999999.99');

      const loadedRejected = (await outboxRepo.findById(rejectedEvt.eventId))!;
      const rejectedData = loadedRejected.payload.data as Record<string, unknown>;
      const rejectedMoney = rejectedData.money as { amount: unknown };
      const rejectedBalanceAfter = rejectedData.balanceAfter as { amount: unknown };
      expect(typeof rejectedMoney.amount).toBe('string');
      expect(rejectedMoney.amount).toBe('0.01');
      expect(typeof rejectedBalanceAfter.amount).toBe('string');
      expect(rejectedBalanceAfter.amount).toBe('0.00');
    });

    test('enqueue de lista vazia é no-op', async () => {
      await outboxRepo.enqueue([]);
      const rows = await db.sql<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count FROM outbox_message
      `;
      expect(rows[0]?.count).toBe(0);
    });
  });

  describe('OutboxRepository: claimDue com lease, FOR UPDATE SKIP LOCKED, markPublished e scheduleRetry (SCHEMA 4.5, D12, D18)', () => {
    test('claimDue reserva apenas pendentes vencidas até o limit, avança next_attempt_at pelo leaseMs e reentrega se o lease expirar', async () => {
      const baseTime = new Date('2026-10-28T16:00:00.000Z');
      const due1Time = new Date(baseTime.getTime() - 2_000);
      const due2Time = new Date(baseTime.getTime() - 1_000);
      const futureTime = new Date(baseTime.getTime() + 60_000);

      const msgDue1 = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: due1Time })),
      );
      const msgDue2 = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: due2Time })),
      );
      const msgFuture = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: futureTime })),
      );
      const msgAlreadyPublished = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: due1Time })),
      );
      msgAlreadyPublished.markPublished(baseTime);

      await outboxRepo.enqueue([msgDue2, msgFuture, msgDue1, msgAlreadyPublished]);

      // limit <= 0 não reserva nada
      expect(await outboxRepo.claimDue(baseTime, 0, 30_000)).toEqual([]);

      // Reserva com limit = 1: pega a mais antiga (msgDue1) e empurra lease por 30s
      const leaseMs = 30_000;
      const expectedLeaseUntil = new Date(baseTime.getTime() + leaseMs);
      const batch1 = await outboxRepo.claimDue(baseTime, 1, leaseMs);

      expect(batch1).toHaveLength(1);
      expect(batch1[0]!.id).toBe(msgDue1.id);
      expect(batch1[0]!.nextAttemptAt.toISOString()).toBe(expectedLeaseUntil.toISOString());

      // Nova chamada no mesmo instante pega apenas msgDue2 (msgDue1 está em lease, msgFuture no futuro, msgAlreadyPublished publicada)
      const batch2 = await outboxRepo.claimDue(baseTime, 10, leaseMs);
      expect(batch2).toHaveLength(1);
      expect(batch2[0]!.id).toBe(msgDue2.id);
      expect(batch2[0]!.nextAttemptAt.toISOString()).toBe(expectedLeaseUntil.toISOString());

      // Terceira chamada antes do lease expirar devolve vazio
      const batch3 = await outboxRepo.claimDue(
        new Date(expectedLeaseUntil.getTime() - 1),
        10,
        leaseMs,
      );
      expect(batch3).toEqual([]);

      // Se o worker morreu sem publicar e o lease de 30s expira, outra instância reclama msgDue1 e msgDue2 (msgFuture ainda está em +60s)
      const afterLease = new Date(expectedLeaseUntil.getTime());
      const batchAfterExpiry = await outboxRepo.claimDue(afterLease, 10, leaseMs);
      expect(batchAfterExpiry.map((m) => m.id)).toEqual([msgDue1.id, msgDue2.id]);

      // Em +60s (futureTime), tanto o novo lease de msgDue1/msgDue2 quanto msgFuture vencem
      const batchAtFuture = await outboxRepo.claimDue(futureTime, 10, leaseMs);
      expect(batchAtFuture.map((m) => m.id)).toEqual([
        msgDue1.id,
        msgDue2.id,
        msgFuture.id,
      ]);
    });

    test('claimDue usa FOR UPDATE SKIP LOCKED: pula linha travada por outra transação sem bloquear', async () => {
      const now = new Date('2026-10-28T16:30:00.000Z');
      const msg1 = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: new Date(now.getTime() - 3_000) })),
      );
      const msg2 = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: new Date(now.getTime() - 2_000) })),
      );
      const msg3 = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: new Date(now.getTime() - 1_000) })),
      );

      await outboxRepo.enqueue([msg1, msg2, msg3]);

      // Conexão concorrente trava msg1 com FOR UPDATE mantendo a transação aberta
      const lockConn = await db.connect();
      await lockConn.unsafe('BEGIN');
      try {
        await lockConn`SELECT id FROM outbox_message WHERE id = ${msg1.id} FOR UPDATE`;

        // Enquanto msg1 está travada, claimDue(limit = 2) deve pular msg1 imediatamente e reservar msg2 e msg3
        const claimedWhileLocked = await outboxRepo.claimDue(now, 2, 30_000);
        expect(claimedWhileLocked.map((m) => m.id)).toEqual([msg2.id, msg3.id]);
      } finally {
        await lockConn.unsafe('ROLLBACK');
      }

      // Depois que a conexão solta o lock em msg1, um novo claimDue pega msg1 (msg2 e msg3 seguem em lease)
      const claimedAfterRelease = await outboxRepo.claimDue(now, 10, 30_000);
      expect(claimedAfterRelease.map((m) => m.id)).toEqual([msg1.id]);
    });

    test('markPublished e scheduleRetry atualizam o banco (attempts = attempts + 1 com published_at IS NULL) e lançam erro para id inexistente ou já publicada', async () => {
      const occurredAt = new Date('2026-10-28T17:00:00.000Z');
      const msgSuccess = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt })),
      );
      const msgRetry = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt })),
      );

      await outboxRepo.enqueue([msgSuccess, msgRetry]);

      // Claim das duas mensagens
      const claimed = await outboxRepo.claimDue(occurredAt, 10, 30_000);
      expect(claimed).toHaveLength(2);

      // 1. Sucesso em msgSuccess
      const publishedAt = new Date(occurredAt.getTime() + 250);
      await outboxRepo.markPublished(msgSuccess.id, publishedAt);

      const loadedSuccess = await outboxRepo.findById(msgSuccess.id);
      expect(loadedSuccess?.isPending()).toBe(false);
      expect(loadedSuccess?.publishedAt?.toISOString()).toBe(publishedAt.toISOString());

      // scheduleRetry em mensagem já publicada (published_at IS NOT NULL) falha por WHERE published_at IS NULL
      msgSuccess.scheduleRetry(publishedAt);
      await expect(outboxRepo.scheduleRetry(msgSuccess)).rejects.toThrow(
        /OutboxMessage pendente não encontrada para scheduleRetry/,
      );

      // 2. Falha em msgRetry -> scheduleRetry no domínio (attempts = 1, +2s) e persiste no banco via attempts = attempts + 1
      const retryBaseNow = new Date(occurredAt.getTime() + 500);
      msgRetry.scheduleRetry(retryBaseNow);
      await outboxRepo.scheduleRetry(msgRetry);

      const loadedRetry = await outboxRepo.findById(msgRetry.id);
      expect(loadedRetry?.attempts).toBe(1);
      expect(loadedRetry?.nextAttemptAt.toISOString()).toBe(
        new Date(retryBaseNow.getTime() + 2_000).toISOString(),
      );
      expect(loadedRetry?.publishedAt).toBeUndefined();

      // Antes de retryBaseNow + 2s, claimDue não pega msgRetry nem msgSuccess
      expect(
        await outboxRepo.claimDue(new Date(retryBaseNow.getTime() + 1_999), 10, 30_000),
      ).toEqual([]);

      // Em retryBaseNow + 2s, claimDue pega apenas msgRetry com attempts = 1
      const reclaimed = await outboxRepo.claimDue(
        new Date(retryBaseNow.getTime() + 2_000),
        10,
        30_000,
      );
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.id).toBe(msgRetry.id);
      expect(reclaimed[0]!.attempts).toBe(1);

      // Erros quando o id não existe
      const missingId = randomUUID();
      await expect(outboxRepo.markPublished(missingId, publishedAt)).rejects.toThrow(
        /OutboxMessage não encontrada/,
      );

      const ghostOutbox = OutboxMessage.rehydrate({
        id: missingId,
        aggregateId: randomUUID(),
        eventType: 'WagerTransactionProcessed',
        payload: { eventId: missingId },
        occurredAt,
        attempts: 1,
        nextAttemptAt: publishedAt,
      });
      await expect(outboxRepo.scheduleRetry(ghostOutbox)).rejects.toThrow(
        /OutboxMessage pendente não encontrada/,
      );
    });
  });

  describe('Integração com a porta UnitOfWork e propagação de SQLSTATE (SCHEMA 5, EXECUCAO §6)', () => {
    test('inbox e outbox participam atomicamente da mesma transação via interface UnitOfWork (commit e rollback)', async () => {
      // Adaptador mínimo da interface UnitOfWork (EXECUCAO §6: T22 usa UnitOfWork só pela interface até o merge da T20)
      const uow: UnitOfWork = {
        async run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T> {
          return orm.em.fork().transactional(async (txEm) => {
            const txRepos = {
              inbox: new MikroOrmInboxRepository(txEm),
              outbox: new MikroOrmOutboxRepository(txEm),
            } as unknown as TxRepositories;
            return work(txRepos);
          });
        },
        async readSnapshot<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T> {
          return this.run(work);
        },
      };

      const now = new Date('2026-10-28T18:00:00.000Z');
      const committedInbox = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'uow-commit-msg',
        payloadHash: HASH_A,
        at: now,
      });
      const committedOutbox = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: now })),
      );

      await uow.run(async (tx) => {
        const res = await tx.inbox.tryReceive(committedInbox);
        expect(res).toEqual({ accepted: true });
        await tx.outbox.enqueue([committedOutbox]);
        committedInbox.markProcessed(new Date(now.getTime() + 100));
        await tx.inbox.markProcessed(committedInbox);
      });

      expect((await inboxRepo.findByKey(CONSUMER, 'uow-commit-msg'))?.isProcessed()).toBe(true);
      expect(await outboxRepo.findById(committedOutbox.id)).toBeDefined();

      // Caso de rollback: falha após tryReceive + enqueue reverte tanto inbox quanto outbox
      const rolledBackInbox = InboxMessage.receive({
        consumerName: CONSUMER,
        messageId: 'uow-rollback-msg',
        payloadHash: HASH_B,
        at: now,
      });
      const rolledBackOutbox = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: now })),
      );

      await expect(
        uow.run(async (tx) => {
          await tx.inbox.tryReceive(rolledBackInbox);
          await tx.outbox.enqueue([rolledBackOutbox]);
          throw new Error('Falha simulada antes do commit');
        }),
      ).rejects.toThrow('Falha simulada antes do commit');

      expect(await inboxRepo.findByKey(CONSUMER, 'uow-rollback-msg')).toBeUndefined();
      expect(await outboxRepo.findById(rolledBackOutbox.id)).toBeUndefined();
    });

    test('lock_timeout (55P03) sobe do driver sem alteração para tradução na UoW da T20', async () => {
      const now = new Date('2026-10-28T18:30:00.000Z');
      const outboxMsg = OutboxMessage.enqueue(
        makeProcessedEvent(makeEventContext({ occurredAt: now })),
      );
      await outboxRepo.enqueue([outboxMsg]);

      const lockConn = await db.connect();
      await lockConn.unsafe('BEGIN');
      try {
        await lockConn`SELECT id FROM outbox_message WHERE id = ${outboxMsg.id} FOR UPDATE`;

        const lockErr = await caught(() =>
          orm.em.fork().transactional(async (txEm) => {
            await txEm.execute(`SET LOCAL lock_timeout = '100ms'`);
            const txOutbox = new MikroOrmOutboxRepository(txEm);
            await txOutbox.markPublished(outboxMsg.id, now);
          }),
        );
        expect((lockErr as { code?: string }).code).toBe('55P03');
      } finally {
        await lockConn.unsafe('ROLLBACK');
      }
    });
  });
});
