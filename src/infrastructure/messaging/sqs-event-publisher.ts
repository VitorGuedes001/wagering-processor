import { GetQueueUrlCommand, SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import type { EventPublisher } from '../../application/ports';
import type { OutboxMessage } from '../../domain/outbox-message';
import { APP_CONFIG, type AppConfig } from '../config';

export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

/**
 * Publicador de eventos de domínio no SQS FIFO (CHALLENGE §6.5, §11; ARQUITETURA §7.1; D20).
 * Executa SEMPRE FORA de transação do banco (restrição 4, D62).
 * Fila de destino: `SQS_EVENTS_QUEUE` (`wagering-events.fifo` por padrão).
 * Atributos: `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId` (D20).
 */
@Injectable()
export class SqsEventPublisher implements EventPublisher {
  private resolvedQueueUrl?: string;

  constructor(
    private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'SQS_EVENTS_QUEUE'>,
  ) {}

  private async getQueueUrl(): Promise<string> {
    if (this.resolvedQueueUrl) {
      return this.resolvedQueueUrl;
    }

    const queueNameOrUrl = this.config.SQS_EVENTS_QUEUE;
    if (queueNameOrUrl.startsWith('http://') || queueNameOrUrl.startsWith('https://')) {
      this.resolvedQueueUrl = queueNameOrUrl;
      return queueNameOrUrl;
    }

    const res = await this.sqs.send(new GetQueueUrlCommand({ QueueName: queueNameOrUrl }));
    if (!res.QueueUrl) {
      throw new Error(`Falha ao resolver URL da fila SQS: ${queueNameOrUrl}`);
    }

    this.resolvedQueueUrl = res.QueueUrl;
    return this.resolvedQueueUrl;
  }

  async publish(message: OutboxMessage): Promise<void> {
    const queueUrl = await this.getQueueUrl();

    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          eventType: {
            DataType: 'String',
            StringValue: message.eventType,
          },
        },
      }),
    );
  }
}
