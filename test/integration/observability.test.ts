import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { Module, ServiceUnavailableException } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { loadConfig, type AppConfig } from '../../src/infrastructure/config';
import { ReadinessProbe } from '../../src/infrastructure/health/readiness-probe';
import { AppLogger } from '../../src/infrastructure/observability/logger';
import {
  runWithRequestContext,
  updateRequestContext,
} from '../../src/infrastructure/observability/request-context';
import {
  MetricsRegistry,
} from '../../src/infrastructure/observability/metrics';
import { ObservabilityModule } from '../../src/infrastructure/observability/observability.module';
import { HealthController } from '../../src/interface/health/health.controller';
import type { UnitOfWork } from '../../src/application/ports';
import { WageringModule } from '../../src/interface/wagering.module';
import { createTestDatabase, type TestDatabase } from '../support/database';
import { assertAllWalletsConsistent } from '../support/invariants';
import { createTestQueues, type TestQueues } from '../support/queues';
import { getTestInfraConfig } from '../support/preload';

describe('I-22 e I-23: Observabilidade base', () => {
  let db: TestDatabase;
  let queues: TestQueues;
  let config: AppConfig;
  let sqsClient: SQSClient;

  beforeAll(async () => {
    db = await createTestDatabase();
    queues = await createTestQueues();

    const infra = getTestInfraConfig();
    config = loadConfig({
      DB_HOST: infra.dbHost,
      DB_PORT: String(infra.dbPort),
      DB_USER: infra.dbUser,
      DB_PASSWORD: infra.dbPassword,
      DB_NAME: db.name,
      SQS_ENDPOINT: infra.sqsEndpoint,
      AWS_REGION: infra.awsRegion,
      SQS_INPUT_QUEUE: queues.input,
      SQS_DLQ: queues.dlq,
      SQS_EVENTS_QUEUE: queues.events,
    });

    sqsClient = new SQSClient({
      endpoint: infra.sqsEndpoint,
      region: infra.awsRegion,
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
    });
  });

  afterAll(async () => {
    sqsClient.destroy();
    await queues.delete();
    await db.drop();
  });

  afterEach(async () => {
    if (db) {
      await assertAllWalletsConsistent(db.sql);
    }
  });

  describe('I-22: Health readiness e métricas', () => {
    test('/health/ready retorna 200 quando Postgres e SQS estão saudáveis', async () => {
      // Mock da EntityManager que executa select 1 no banco real do teste
      const emMock = {
        getConnection: () => ({
          execute: async (query: string) => db.sql.unsafe(query),
        }),
      } as unknown as EntityManager;

      const probe = new ReadinessProbe(emMock, sqsClient, config);
      const controller = new HealthController(probe);

      const result = await controller.ready();
      expect(result.status).toBe('ok');
      expect(result.dependencies.postgres).toBe(true);
      expect(result.dependencies.sqs).toBe(true);
    });

    test('/health/ready retorna 503 quando Postgres está indisponível', async () => {
      const failingEm = {
        getConnection: () => ({
          execute: async () => {
            throw new Error('connection refused / timeout');
          },
        }),
      } as unknown as EntityManager;

      const probe = new ReadinessProbe(failingEm, sqsClient, config);
      const controller = new HealthController(probe);

      try {
        await controller.ready();
        expect.unreachable('Deveria ter lançado ServiceUnavailableException');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const error = err as ServiceUnavailableException;
        expect(error.getStatus()).toBe(503);
        const response = error.getResponse() as { status: string; dependencies: { postgres: boolean; sqs: boolean } };
        expect(response.status).toBe('degraded');
        expect(response.dependencies.postgres).toBe(false);
      }
    });

    test('/health/ready retorna 503 quando SQS está indisponível', async () => {
      const emMock = {
        getConnection: () => ({
          execute: async (query: string) => db.sql.unsafe(query),
        }),
      } as unknown as EntityManager;

      const unreachableSqs = new SQSClient({
        endpoint: 'http://127.0.0.1:54321', // porta não utilizada
        region: 'us-east-1',
        credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
      });

      try {
        const probe = new ReadinessProbe(emMock, unreachableSqs, config);
        const controller = new HealthController(probe);

        await controller.ready();
        expect.unreachable('Deveria ter lançado ServiceUnavailableException');
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableException);
        const error = err as ServiceUnavailableException;
        expect(error.getStatus()).toBe(503);
        const response = error.getResponse() as { status: string; dependencies: { postgres: boolean; sqs: boolean } };
        expect(response.status).toBe('degraded');
        expect(response.dependencies.sqs).toBe(false);
      } finally {
        unreachableSqs.destroy();
      }
    });

    test('MetricsRegistry registra todas as métricas obrigatórias de ARQUITETURA §9', async () => {
      const metrics = new MetricsRegistry();
      const output = await metrics.getMetrics();

      const requiredMetrics = [
        'wagering_http_requests_total',
        'wagering_http_request_duration_seconds',
        'wagering_transactions_total',
        'wagering_transactions_rejected_total',
        'wagering_lock_conflicts_total',
        'wagering_sqs_messages_received_total',
        'wagering_sqs_messages_dlq_total',
        'wagering_outbox_published_total',
        'wagering_outbox_lag_seconds',
        'wagering_pending_reference_age_seconds',
        'wagering_reconciliation_inconsistencies_total',
      ];

      for (const metricName of requiredMetrics) {
        expect(output).toContain(metricName);
      }
    });

    test('MetricsRegistry permite incrementar contadores e atualizar gauges', async () => {
      const metrics = new MetricsRegistry();

      metrics.httpRequestsTotal.inc({ method: 'POST', path: '/wagering/transactions', status: '200' }, 5);
      metrics.transactionsTotal.inc({ kind: 'BET', status: 'PROCESSED' }, 3);
      metrics.transactionsRejectedTotal.inc({ reason: 'INSUFFICIENT_FUNDS' }, 2);
      metrics.lockConflictsTotal.inc(1);
      metrics.outboxLagSeconds.set(3.5);
      metrics.pendingReferenceAgeSeconds.set(12.0);

      const output = await metrics.getMetrics();

      expect(output).toContain('wagering_http_requests_total{method="POST",path="/wagering/transactions",status="200"} 5');
      expect(output).toContain('wagering_transactions_total{kind="BET",status="PROCESSED"} 3');
      expect(output).toContain('wagering_transactions_rejected_total{reason="INSUFFICIENT_FUNDS"} 2');
      expect(output).toContain('wagering_lock_conflicts_total 1');
      expect(output).toContain('wagering_outbox_lag_seconds 3.5');
      expect(output).toContain('wagering_pending_reference_age_seconds 12');
    });

    test('Endpoint HTTP GET /metrics expõe formato Prometheus via servidor Nest', async () => {
      @Module({
        imports: [ObservabilityModule, WageringModule.withUnitOfWork({} as UnitOfWork)],
      })
      class TestObservabilityAppModule {}

      const app: INestApplication = await NestFactory.create(TestObservabilityAppModule, { logger: false });
      await app.listen(0);

      const url = await app.getUrl();
      const response = await fetch(`${url}/metrics`);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain');

      const body = await response.text();
      expect(body).toContain('wagering_http_requests_total');
      expect(body).toContain('wagering_outbox_lag_seconds');
      expect(body).toContain('wagering_transactions_total');

      await app.close();
    });
  });

  describe('I-23: Logger JSON com ALS e restrição 5.1 (sem amount)', () => {
    test('produz linhas JSON com campos timestamp, level, message, correlationId, transactionId, walletId, providerId', async () => {
      const logs: string[] = [];
      const logger = new AppLogger((line) => logs.push(line));

      await runWithRequestContext(
        {
          correlationId: 'corr-uuid-1',
          transactionId: 'tx-uuid-2',
          walletId: 'w-uuid-3',
          providerId: 'provider-casino',
        },
        async () => {
          logger.log('Iniciando processamento de aposta');

          // Sub-rotina assíncrona
          await new Promise((resolve) => setTimeout(resolve, 5));

          updateRequestContext({ kind: 'BET', status: 'PROCESSED' });
          logger.log('Aposta processada com sucesso');
        },
      );

      expect(logs).toHaveLength(2);

      const first = JSON.parse(logs[0]!);
      expect(first.level).toBe('info');
      expect(first.message).toBe('Iniciando processamento de aposta');
      expect(first.correlationId).toBe('corr-uuid-1');
      expect(first.transactionId).toBe('tx-uuid-2');
      expect(first.walletId).toBe('w-uuid-3');
      expect(first.providerId).toBe('provider-casino');
      expect(typeof first.timestamp).toBe('string');

      const second = JSON.parse(logs[1]!);
      expect(second.level).toBe('info');
      expect(second.message).toBe('Aposta processada com sucesso');
      expect(second.correlationId).toBe('corr-uuid-1');
      expect(second.transactionId).toBe('tx-uuid-2');
      expect(second.kind).toBe('BET');
      expect(second.status).toBe('PROCESSED');
    });

    test('HARD CONSTRAINT 5.1 e I-23: NUNCA loga amount nem balance', () => {
      const logs: string[] = [];
      const logger = new AppLogger((line) => logs.push(line));

      runWithRequestContext({ correlationId: 'corr-5.1' }, () => {
        // Objeto com amount e balance
        logger.log('Aposta recebida', {
          amount: '100.00',
          balance: '500.00',
          walletId: 'w-1',
          nested: {
            amount: '20.00',
            balanceBefore: '520.00',
            balanceAfter: '500.00',
            money: 'BRL 100.00',
            okField: 'teste',
          },
        });

        // Mensagem textual com amount
        logger.warn('Tentativa com "amount": "100.00" e amount=50.00');
      });

      expect(logs).toHaveLength(2);

      const first = JSON.parse(logs[0]!);
      expect(first.walletId).toBe('w-1');
      expect(first.correlationId).toBe('corr-5.1');
      // Garante ausência total de propriedades de dinheiro
      expect(first.amount).toBeUndefined();
      expect(first.balance).toBeUndefined();
      expect(first.nested.amount).toBeUndefined();
      expect(first.nested.balanceBefore).toBeUndefined();
      expect(first.nested.balanceAfter).toBeUndefined();
      expect(first.nested.money).toBeUndefined();
      expect(first.nested.okField).toBe('teste');

      // Verifica no texto cru que "amount" monetário não existe
      expect(logs[0]).not.toContain('"amount":"100.00"');
      expect(logs[0]).not.toContain('"balance":"500.00"');

      const second = JSON.parse(logs[1]!);
      expect(second.level).toBe('warn');
      expect(second.message).not.toContain('"amount": "100.00"');
      expect(second.message).not.toContain('amount=50.00');
      expect(second.message).toContain('[REDACTED]');
    });

    test('isola contextos concorrentes executados em paralelo', async () => {
      const logsA: string[] = [];
      const logsB: string[] = [];

      const logger = new AppLogger((line) => {
        const parsed = JSON.parse(line);
        if (parsed.correlationId === 'task-A') logsA.push(line);
        if (parsed.correlationId === 'task-B') logsB.push(line);
      });

      await Promise.all([
        runWithRequestContext({ correlationId: 'task-A', walletId: 'wallet-A' }, async () => {
          logger.log('Passo 1 A');
          await new Promise((r) => setTimeout(r, 10));
          logger.log('Passo 2 A');
        }),
        runWithRequestContext({ correlationId: 'task-B', walletId: 'wallet-B' }, async () => {
          logger.log('Passo 1 B');
          await new Promise((r) => setTimeout(r, 5));
          logger.log('Passo 2 B');
        }),
      ]);

      expect(logsA).toHaveLength(2);
      expect(logsB).toHaveLength(2);

      for (const line of logsA) {
        const parsed = JSON.parse(line);
        expect(parsed.correlationId).toBe('task-A');
        expect(parsed.walletId).toBe('wallet-A');
      }

      for (const line of logsB) {
        const parsed = JSON.parse(line);
        expect(parsed.correlationId).toBe('task-B');
        expect(parsed.walletId).toBe('wallet-B');
      }
    });

    test('trata erros, debug, warn e verbose com formato JSON consistente', () => {
      const logs: string[] = [];
      const logger = new AppLogger((line) => logs.push(line));

      logger.error(new Error('Falha de banco de dados'), 'MikroORM');
      logger.warn('Aviso de degradação', { details: 'alerta' });
      logger.debug('Debug de operação');
      logger.verbose('Verbose de baixo nível');

      expect(logs).toHaveLength(4);

      const errLog = JSON.parse(logs[0]!);
      expect(errLog.level).toBe('error');
      expect(errLog.message).toBe('Falha de banco de dados');
      expect(errLog.context).toBe('MikroORM');

      const warnLog = JSON.parse(logs[1]!);
      expect(warnLog.level).toBe('warn');
      expect(warnLog.details).toBe('alerta');

      const debugLog = JSON.parse(logs[2]!);
      expect(debugLog.level).toBe('debug');
      expect(debugLog.message).toBe('Debug de operação');

      const verboseLog = JSON.parse(logs[3]!);
      expect(verboseLog.level).toBe('verbose');
      expect(verboseLog.message).toBe('Verbose de baixo nível');
    });
  });
});
