import { Inject, Injectable } from '@nestjs/common';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config';

/** Long polling de 20 s e lotes de até 10. */
const WAIT_TIME_SECONDS = 20;
const MAX_BATCH = 10;

/** Mensagem da fila de entrada, sem tipos do SDK, para a camada `interface`. */
export interface InputMessage {
  /** `MessageId` do SQS. Só para log: a inbox usa o `messageId` do envelope. */
  sqsMessageId: string;
  receiptHandle: string;
  body: string;
  /** `ApproximateReceiveCount`: 1 na primeira entrega. */
  receiveCount: number;
  /** `MessageGroupId` do FIFO. Ausente em fila padrão. */
  groupId: string | undefined;
}

/**
 * Adaptador da fila de entrada `SQS_INPUT_QUEUE`. Único
 * ponto do consumidor que conhece o AWS SDK. A DLQ não aparece aqui: a mensagem
 * chega nela pelo redrive, nunca por envio manual.
 */
@Injectable()
export class SqsInputQueue {
  private queueUrl: Promise<string> | undefined;
  private redriveMax: Promise<number | undefined> | undefined;

  constructor(
    private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  get name(): string {
    return this.config.SQS_INPUT_QUEUE;
  }

  async receive(max: number, signal: AbortSignal): Promise<InputMessage[]> {
    const QueueUrl = await this.url();
    const result = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: Math.max(1, Math.min(MAX_BATCH, max)),
        WaitTimeSeconds: WAIT_TIME_SECONDS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
      { abortSignal: signal },
    );
    return (result.Messages ?? []).flatMap((message) => {
      if (!message.ReceiptHandle || message.Body === undefined) return [];
      const count = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? '1', 10);
      return [
        {
          sqsMessageId: message.MessageId ?? '',
          receiptHandle: message.ReceiptHandle,
          body: message.Body,
          receiveCount: Number.isInteger(count) && count > 0 ? count : 1,
          groupId: message.Attributes?.MessageGroupId,
        },
      ];
    });
  }

  /** `DeleteMessage`. Só depois do commit. */
  async ack(message: InputMessage): Promise<void> {
    await this.sqs.send(
      new DeleteMessageCommand({ QueueUrl: await this.url(), ReceiptHandle: message.receiptHandle }),
    );
  }

  /** `ChangeMessageVisibility 0`: volta à fila na hora (permanente rumo à DLQ, ou `SIGTERM`). */
  async releaseNow(message: InputMessage): Promise<void> {
    await this.delay(message, 0);
  }

  /** `ChangeMessageVisibility n`: backoff do retry. */
  async delay(message: InputMessage, seconds: number): Promise<void> {
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.url(),
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }

  /**
   * `maxReceiveCount` da `RedrivePolicy` da fila, lido uma vez: a
   * fila é a fonte da verdade. Sem política, devolve `undefined`.
   */
  maxReceiveCount(): Promise<number | undefined> {
    this.redriveMax ??= this.readRedriveMax().catch((error: unknown) => {
      this.redriveMax = undefined;
      throw error;
    });
    return this.redriveMax;
  }

  private async readRedriveMax(): Promise<number | undefined> {
    const result = await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: await this.url(), AttributeNames: ['RedrivePolicy'] }),
    );
    const raw = result.Attributes?.RedrivePolicy;
    if (!raw) return undefined;
    const policy = JSON.parse(raw) as { maxReceiveCount?: unknown };
    const max = Number.parseInt(String(policy.maxReceiveCount ?? ''), 10);
    return Number.isInteger(max) && max > 0 ? max : undefined;
  }

  private url(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.config.SQS_INPUT_QUEUE }))
      .then((result) => {
        if (!result.QueueUrl) throw new Error(`Fila sem URL: ${this.config.SQS_INPUT_QUEUE}`);
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}
