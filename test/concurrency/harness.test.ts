import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnApp, spawnCluster } from '../support/app-process';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { FaultInjector, FaultPoint } from '../support/fault-injector';
import { holdWalletLock } from '../support/lock-gate';
import { createTestQueues, deleteTestQueues, type TestQueues } from '../support/queues';

describe('Harness de Concorrência e Processos (TESTES D36, D37, D38)', () => {
  let db: TestDatabase;
  let queues: TestQueues;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues('harness');
  });

  afterAll(async () => {
    await deleteTestQueues(queues);
    await db.drop();
  });

  test('spawnApp: aloca porta livre (PORT=0), aguarda /health/ready e finaliza graciosamente', async () => {
    const app = await spawnApp({
      DB_NAME: db.name,
      SQS_INPUT_QUEUE: queues.input,
      SQS_DLQ: queues.dlq,
      SQS_EVENTS_QUEUE: queues.events,
      PORT: '0',
    });

    expect(app.pid).toBeGreaterThan(0);
    expect(app.port).toBeGreaterThan(0);
    expect(app.url).toBe(`http://127.0.0.1:${app.port}`);

    // Verifica que /health/ready responde 200
    const res = await fetch(`${app.url}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; dependencies: { postgres: boolean; sqs: boolean } };
    expect(body.status).toBe('ok');
    expect(body.dependencies.postgres).toBe(true);
    expect(body.dependencies.sqs).toBe(true);

    // Logs capturados
    expect(app.logs()).toContain('listening');

    // Shutdown
    await app.kill('SIGTERM');
    const exitCode = await app.exited;
    expect(exitCode).toBeDefined();
  });

  test('spawnCluster(3): sobe 3 instâncias com portas distintas e round-robin via nextUrl()', async () => {
    const cluster = await spawnCluster(3, {
      DB_NAME: db.name,
      SQS_INPUT_QUEUE: queues.input,
      SQS_DLQ: queues.dlq,
      SQS_EVENTS_QUEUE: queues.events,
      PORT: '0',
    });

    try {
      expect(cluster.apps.length).toBe(3);
      expect(cluster.urls.length).toBe(3);

      const ports = cluster.apps.map((a) => a.port);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(3);

      // Round-robin
      const url1 = cluster.nextUrl();
      const url2 = cluster.nextUrl();
      const url3 = cluster.nextUrl();
      const url4 = cluster.nextUrl();

      expect(url1).toBe(cluster.urls[0]!);
      expect(url2).toBe(cluster.urls[1]!);
      expect(url3).toBe(cluster.urls[2]!);
      expect(url4).toBe(cluster.urls[0]!);

      // Todas as instâncias prontas
      for (const url of cluster.urls) {
        const res = await fetch(`${url}/health/ready`);
        expect(res.status).toBe(200);
      }
    } finally {
      await cluster.killAll('SIGTERM');
    }
  });

  test('holdWalletLock: segura FOR UPDATE em conexão dedicada, detecta bloqueados em pg_stat_activity e libera', async () => {
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Insere wallet com saldo 0.00 diretamente para testar o portão (satisfaz wallet_ledger_match)
    await db.sql`
      INSERT INTO wallet (id, player_id, currency, balance, version, created_at, updated_at)
      VALUES (${walletId}, ${playerId}, 'BRL', 0.00, 1, NOW(), NOW())
    `;

    const gate = await holdWalletLock(db, walletId);

    // Abre uma segunda conexão e tenta travar a mesma wallet com lock_timeout 5s
    const conn2 = await db.connect();
    let conn2Completed = false;
    let conn2Error: unknown = null;

    const waiterPromise = (async () => {
      try {
        await conn2.unsafe('BEGIN');
        await conn2.unsafe("SET LOCAL lock_timeout = '5s'");
        await conn2.unsafe('SELECT id FROM wallet WHERE id = $1 FOR UPDATE', [walletId]);
        conn2Completed = true;
        await conn2.unsafe('COMMIT');
      } catch (err) {
        conn2Error = err;
        await conn2.unsafe('ROLLBACK').catch(() => {});
      } finally {
        await conn2.close().catch(() => {});
      }
    })();

    // Aguarda o segundo lock aparecer bloqueado no pg_stat_activity
    const waiters = await gate.waitForWaiters(1, { timeoutMs: 4_000 });
    expect(waiters).toBeGreaterThanOrEqual(1);
    expect(conn2Completed).toBe(false);

    // Libera o portão
    await gate.release();

    // Agora a segunda conexão deve ser desfeita / completada com sucesso
    await waiterPromise;
    expect(conn2Completed).toBe(true);
    expect(conn2Error).toBeNull();
  });

  test('FaultInjector: hit() sem a env correspondente não encerra o processo', () => {
    expect(() => {
      FaultInjector.hit('ponto-inexistente');
      FaultInjector.hit(FaultPoint.ConsumerAfterCommitBeforeAck);
    }).not.toThrow();
  });
});
