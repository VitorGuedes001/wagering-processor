import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  DeleteMessageBatchCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppCluster, spawnApp, spawnCluster } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { eventually } from '../support/eventually';
import { createTestQueues, type TestQueues } from '../support/queues';

const ROOT_DIR = resolve(import.meta.dir, '../..');

describe('C-06 e C-06b: Concorrência e Tolerância a Falhas no Outbox Worker (TESTES §4.3; CHALLENGE §13.6)', () => {
  let db: TestDatabase;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues('c06');
  });

  afterAll(async () => {
    await queues.delete();
    await db.drop();
  });

  test('C-06: 1000 eventos no outbox, 2 instâncias de worker. Todos publicados sem perda, conjunto de eventId completo', async () => {
    const totalEvents = 1000;
    const expectedEventIds = new Set<string>();
    const aggregateId = randomUUID();
    const now = new Date();

    // Inserção em lotes de 200 para rapidez e sem estourar limites de parâmetros SQL
    const batchSize = 200;
    for (let i = 0; i < totalEvents; i += batchSize) {
      const currentBatchCount = Math.min(batchSize, totalEvents - i);
      const rows: Array<{
        id: string;
        aggregate_id: string;
        event_type: string;
        payload: string;
        occurred_at: Date;
        attempts: number;
        next_attempt_at: Date;
      }> = [];

      for (let j = 0; j < currentBatchCount; j++) {
        const eventId = randomUUID();
        expectedEventIds.add(eventId);

        const payload = JSON.stringify({
          eventId,
          eventType: 'WagerTransactionProcessed',
          aggregateId,
          occurredAt: now.toISOString(),
          version: 1,
          data: {
            index: i + j,
            status: 'PROCESSED',
          },
        });

        rows.push({
          id: eventId,
          aggregate_id: aggregateId,
          event_type: 'WagerTransactionProcessed',
          payload,
          occurred_at: now,
          attempts: 0,
          next_attempt_at: now,
        });
      }

      await db.sql`
        INSERT INTO outbox_message ${db.sql(
          rows,
          'id',
          'aggregate_id',
          'event_type',
          'payload',
          'occurred_at',
          'attempts',
          'next_attempt_at',
        )}
      `;
    }

    // Confere que os 1000 eventos foram inseridos como pendentes
    const [inserted] = await db.sql<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count FROM outbox_message WHERE published_at IS NULL
    `;
    expect(inserted?.count).toBe(totalEvents);

    // Sobe 2 instâncias só com o worker de outbox (sem HTTP) conforme C-06
    const cluster: AppCluster = await spawnCluster(2, {
      DB_NAME: db.name,
      SQS_EVENTS_QUEUE: queues.events,
      ENABLE_HTTP: 'false',
      ENABLE_CONSUMER: 'false',
      ENABLE_OUTBOX_WORKER: 'true',
      ENABLE_REFERENCE_WORKER: 'false',
      OUTBOX_POLL_MS: '20',
      OUTBOX_BATCH: '50',
      OUTBOX_LEASE_MS: '15000',
    });

    try {
      // Aguarda todos os 1000 eventos serem marcados como publicados
      await eventually(
        async () => {
          const [row] = await db.sql<Array<{ remaining: number }>>`
            SELECT COUNT(*)::int AS remaining FROM outbox_message WHERE published_at IS NULL
          `;
          expect(row?.remaining).toBe(0);
        },
        { timeoutMs: 30000, intervalMs: 250 },
      );

      // Drena a fila do SQS e contabiliza entregas e duplicatas (TESTES §4)
      const receivedEventIds = new Set<string>();
      const duplicateEventIds = new Set<string>();
      let totalDeliveries = 0;
      let duplicateCount = 0;
      let emptyCount = 0;

      while (emptyCount < 3) {
        const sqsRes = await queues.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queues.eventsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );

        const msgs = sqsRes.Messages ?? [];
        if (msgs.length === 0) {
          emptyCount++;
          continue;
        }

        emptyCount = 0;
        for (const msg of msgs) {
          totalDeliveries++;
          const body = JSON.parse(msg.Body!);
          if (receivedEventIds.has(body.eventId)) {
            duplicateCount++;
            duplicateEventIds.add(body.eventId);
          } else {
            receivedEventIds.add(body.eventId);
          }
        }

        // Ack em lote
        await queues.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queues.eventsUrl,
            Entries: msgs.map((m) => ({
              Id: m.MessageId!,
              ReceiptHandle: m.ReceiptHandle!,
            })),
          }),
        );
      }

      // Verificação C-06: todos os 1000 eventos foram publicados, nenhum foi perdido
      expect(receivedEventIds.size).toBe(totalEvents);
      for (const expectedId of expectedEventIds) {
        expect(receivedEventIds.has(expectedId)).toBe(true);
      }

      // Registra e valida contagem de duplicatas (TESTES §4: duplicatas registradas, não falhas)
      console.log(
        JSON.stringify({
          msg: 'C-06 estatísticas de entrega SQS',
          totalDeliveries,
          uniqueEvents: receivedEventIds.size,
          duplicates: duplicateCount,
        }),
      );
      expect(totalDeliveries).toBeGreaterThanOrEqual(totalEvents);
      expect(totalDeliveries).toBe(totalEvents + duplicateCount);
    } finally {
      await cluster.killAll('SIGTERM');
    }
  }, 45000);

  test('C-06b: instância A falha em FAULT_POINT=outbox.after-claim-before-publish; instância B recupera após expiração do lease e publica tudo', async () => {
    const eventCount = 10;
    const expectedIds = new Set<string>();
    const aggregateId = randomUUID();
    const now = new Date();

    const rows: Array<{
      id: string;
      aggregate_id: string;
      event_type: string;
      payload: string;
      occurred_at: Date;
      attempts: number;
      next_attempt_at: Date;
    }> = [];

    for (let i = 0; i < eventCount; i++) {
      const eventId = randomUUID();
      expectedIds.add(eventId);

      rows.push({
        id: eventId,
        aggregate_id: aggregateId,
        event_type: 'WagerTransactionProcessed',
        payload: JSON.stringify({ eventId, eventType: 'WagerTransactionProcessed', aggregateId }),
        occurred_at: now,
        attempts: 0,
        next_attempt_at: now,
      });
    }

    await db.sql`
      INSERT INTO outbox_message ${db.sql(
        rows,
        'id',
        'aggregate_id',
        'event_type',
        'payload',
        'occurred_at',
        'attempts',
        'next_attempt_at',
      )}
    `;

    // 1. Instância A com FAULT_POINT morre logo após o claim e antes da publicação
    const leaseMs = 2000; // lease curto de 2 segundos
    const procA = Bun.spawn(['bun', 'src/main.ts'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DB_NAME: db.name,
        SQS_EVENTS_QUEUE: queues.events,
        ENABLE_HTTP: 'false',
        ENABLE_CONSUMER: 'false',
        ENABLE_OUTBOX_WORKER: 'true',
        ENABLE_REFERENCE_WORKER: 'false',
        FAULT_POINT: 'outbox.after-claim-before-publish',
        OUTBOX_LEASE_MS: String(leaseMs),
        OUTBOX_POLL_MS: '20',
        OUTBOX_BATCH: '50',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const exitCodeA = await procA.exited;
    expect(exitCodeA).not.toBe(0);

    // Confere que no banco as mensagens foram reservadas (next_attempt_at empurrado pelo lease)
    // mas NENHUMA foi marcada como publicada
    const claimedRows = await db.sql<Array<{ id: string; published_at: Date | null; next_attempt_at: Date }>>`
      SELECT id, published_at, next_attempt_at
        FROM outbox_message
       WHERE id IN ${db.sql(Array.from(expectedIds))}
    `;
    expect(claimedRows).toHaveLength(eventCount);
    for (const r of claimedRows) {
      expect(r.published_at).toBeNull();
      // O lease foi empurrado para o futuro
      expect(r.next_attempt_at.getTime()).toBeGreaterThan(now.getTime());
    }

    // 2. Sobe a Instância B normal só com worker de outbox (sem HTTP)
    const appB = await spawnApp({
      DB_NAME: db.name,
      SQS_EVENTS_QUEUE: queues.events,
      ENABLE_HTTP: 'false',
      ENABLE_CONSUMER: 'false',
      ENABLE_OUTBOX_WORKER: 'true',
      ENABLE_REFERENCE_WORKER: 'false',
      OUTBOX_LEASE_MS: '2000',
      OUTBOX_POLL_MS: '50',
      OUTBOX_BATCH: '50',
    });

    try {
      // Quando o lease expirar (~2s), a Instância B assume e publica todas as mensagens
      await eventually(
        async () => {
          const [row] = await db.sql<Array<{ remaining: number }>>`
            SELECT COUNT(*)::int AS remaining
              FROM outbox_message
             WHERE id IN ${db.sql(Array.from(expectedIds))}
               AND published_at IS NULL
          `;
          expect(row?.remaining).toBe(0);
        },
        { timeoutMs: 15000, intervalMs: 200 },
      );

      // Drena a fila e garante que todos os 10 eventos foram entregues
      const receivedIds = new Set<string>();
      let emptyTries = 0;

      while (emptyTries < 3 && receivedIds.size < eventCount) {
        const sqsRes = await queues.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queues.eventsUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          }),
        );

        const msgs = sqsRes.Messages ?? [];
        if (msgs.length === 0) {
          emptyTries++;
          continue;
        }

        emptyTries = 0;
        for (const msg of msgs) {
          const body = JSON.parse(msg.Body!);
          receivedIds.add(body.eventId);
        }

        await queues.sqs.send(
          new DeleteMessageBatchCommand({
            QueueUrl: queues.eventsUrl,
            Entries: msgs.map((m) => ({
              Id: m.MessageId!,
              ReceiptHandle: m.ReceiptHandle!,
            })),
          }),
        );
      }

      expect(receivedIds.size).toBe(eventCount);
      for (const expectedId of expectedIds) {
        expect(receivedIds.has(expectedId)).toBe(true);
      }
    } finally {
      await appB.stop();
    }
  }, 30000);
});
