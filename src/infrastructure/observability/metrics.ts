import { Injectable, Optional } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';

export const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

@Injectable()
export class MetricsRegistry {
  readonly registry: Registry;

  // HTTP metrics
  readonly httpRequestsTotal: Counter<string>;
  readonly httpRequestDurationSeconds: Histogram<string>;

  // Transaction metrics
  readonly transactionsTotal: Counter<string>;
  readonly transactionsRejectedTotal: Counter<string>;
  readonly lockConflictsTotal: Counter<string>;

  // Messaging / SQS metrics
  readonly sqsMessagesReceivedTotal: Counter<string>;
  readonly sqsMessagesDlqTotal: Counter<string>;
  readonly outboxPublishedTotal: Counter<string>;
  readonly outboxLagSeconds: Gauge<string>;
  readonly pendingReferenceAgeSeconds: Gauge<string>;

  // Reconciliation metrics
  readonly reconciliationInconsistenciesTotal: Counter<string>;

  // Additional ARQUITETURA §9 metrics for full interoperability
  readonly duplicatesTotal: Counter<string>;
  readonly retriesTotal: Counter<string>;
  readonly dlqTotal: Counter<string>;
  readonly processingDurationSeconds: Histogram<string>;
  readonly reconciliationMismatchTotal: Counter<string>;

  constructor(@Optional() customRegistry?: Registry) {
    this.registry = customRegistry ?? new Registry();

    this.httpRequestsTotal = new Counter<string>({
      name: 'wagering_http_requests_total',
      help: 'Total HTTP requests handled',
      labelNames: ['method', 'path', 'status'],
      registers: [this.registry],
    });

    this.httpRequestDurationSeconds = new Histogram<string>({
      name: 'wagering_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'path', 'status'],
      buckets: DEFAULT_HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });

    this.transactionsTotal = new Counter<string>({
      name: 'wagering_transactions_total',
      help: 'Total wagering transactions processed',
      labelNames: ['kind', 'status'],
      registers: [this.registry],
    });

    this.transactionsRejectedTotal = new Counter<string>({
      name: 'wagering_transactions_rejected_total',
      help: 'Total wagering transactions rejected',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.lockConflictsTotal = new Counter<string>({
      name: 'wagering_lock_conflicts_total',
      help: 'Total wallet lock conflicts and lock timeouts',
      registers: [this.registry],
    });

    this.sqsMessagesReceivedTotal = new Counter<string>({
      name: 'wagering_sqs_messages_received_total',
      help: 'Total SQS messages received',
      labelNames: ['queue'],
      registers: [this.registry],
    });

    this.sqsMessagesDlqTotal = new Counter<string>({
      name: 'wagering_sqs_messages_dlq_total',
      help: 'Total SQS messages sent or routed to DLQ',
      labelNames: ['queue', 'reason'],
      registers: [this.registry],
    });

    this.outboxPublishedTotal = new Counter<string>({
      name: 'wagering_outbox_published_total',
      help: 'Total outbox integration events published',
      labelNames: ['eventType'],
      registers: [this.registry],
    });

    this.outboxLagSeconds = new Gauge<string>({
      name: 'wagering_outbox_lag_seconds',
      help: 'Current lag of unpublished outbox events in seconds',
      registers: [this.registry],
    });

    this.pendingReferenceAgeSeconds = new Gauge<string>({
      name: 'wagering_pending_reference_age_seconds',
      help: 'Age of oldest pending reference in seconds',
      registers: [this.registry],
    });

    this.reconciliationInconsistenciesTotal = new Counter<string>({
      name: 'wagering_reconciliation_inconsistencies_total',
      help: 'Total reconciliation inconsistencies found',
      registers: [this.registry],
    });

    this.duplicatesTotal = new Counter<string>({
      name: 'wagering_duplicates_total',
      help: 'Total duplicate requests or messages detected',
      labelNames: ['source'],
      registers: [this.registry],
    });

    this.retriesTotal = new Counter<string>({
      name: 'wagering_retries_total',
      help: 'Total retries by component',
      labelNames: ['component'],
      registers: [this.registry],
    });

    this.dlqTotal = new Counter<string>({
      name: 'wagering_dlq_total',
      help: 'Total messages sent to DLQ',
      registers: [this.registry],
    });

    this.processingDurationSeconds = new Histogram<string>({
      name: 'wagering_processing_duration_seconds',
      help: 'Processing duration in seconds by entry point',
      labelNames: ['entry'],
      buckets: DEFAULT_HISTOGRAM_BUCKETS,
      registers: [this.registry],
    });

    this.reconciliationMismatchTotal = new Counter<string>({
      name: 'wagering_reconciliation_mismatch_total',
      help: 'Total reconciliation mismatches detected',
      registers: [this.registry],
    });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getContentType(): string {
    return this.registry.contentType;
  }

  reset(): void {
    this.registry.resetMetrics();
  }
}

export const defaultMetricsRegistry = new MetricsRegistry();
