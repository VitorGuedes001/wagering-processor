import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { checkInfrastructure, getTestInfraConfig } from './preload';

export interface TestQueues {
  readonly prefix: string;
  readonly input: string;
  readonly dlq: string;
  readonly events: string;
  readonly inputUrl: string;
  readonly dlqUrl: string;
  readonly eventsUrl: string;
  readonly sqs: SQSClient;
  delete(): Promise<void>;
}

/**
 * Cria as 3 filas FIFO isoladas por arquivo de teste no LocalStack (TESTES D35, §3.2)
 * com os mesmos atributos e redrive policy de `docker/localstack/init-queues.sh`.
 */
export async function createTestQueues(customPrefix?: string): Promise<TestQueues> {
  await checkInfrastructure();

  const rawPrefix = customPrefix ?? `t${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  const prefix = rawPrefix.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!prefix) {
    throw new Error('Prefixo de fila inválido para createTestQueues.');
  }

  const dlqName = `${prefix}-wager-transactions-dlq.fifo`;
  const inputName = `${prefix}-wager-transactions.fifo`;
  const eventsName = `${prefix}-wagering-events.fifo`;

  const cfg = getTestInfraConfig();
  const sqs = new SQSClient({
    region: cfg.awsRegion,
    endpoint: cfg.sqsEndpoint,
    credentials: {
      accessKeyId: cfg.awsAccessKeyId,
      secretAccessKey: cfg.awsSecretAccessKey,
    },
  });

  // 1. DLQ primeiro (a fila de entrada precisa do ARN dela na redrive policy)
  const dlqRes = await sqs.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
      },
    }),
  );
  const dlqUrl = dlqRes.QueueUrl;
  if (!dlqUrl) {
    sqs.destroy();
    throw new Error(`Falha ao criar fila DLQ de teste: ${dlqName}`);
  }

  const dlqAttrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn;
  if (!dlqArn) {
    sqs.destroy();
    throw new Error(`Não foi possível obter QueueArn da DLQ: ${dlqName}`);
  }

  // 2. Fila de entrada com VisibilityTimeout=30 e RedrivePolicy maxReceiveCount=5
  const inputRes = await sqs.send(
    new CreateQueueCommand({
      QueueName: inputName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: '5',
        }),
      },
    }),
  );
  const inputUrl = inputRes.QueueUrl;
  if (!inputUrl) {
    sqs.destroy();
    throw new Error(`Falha ao criar fila de entrada de teste: ${inputName}`);
  }

  // 3. Fila de saída de eventos (ContentBasedDeduplication=false; dedup por eventId)
  const eventsRes = await sqs.send(
    new CreateQueueCommand({
      QueueName: eventsName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
      },
    }),
  );
  const eventsUrl = eventsRes.QueueUrl;
  if (!eventsUrl) {
    sqs.destroy();
    throw new Error(`Falha ao criar fila de eventos de teste: ${eventsName}`);
  }

  let deleted = false;

  const queues: TestQueues = {
    prefix,
    input: inputName,
    dlq: dlqName,
    events: eventsName,
    inputUrl,
    dlqUrl,
    eventsUrl,
    sqs,
    async delete(): Promise<void> {
      if (deleted) return;
      deleted = true;
      await Promise.allSettled([
        sqs.send(new DeleteQueueCommand({ QueueUrl: inputUrl })),
        sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })),
        sqs.send(new DeleteQueueCommand({ QueueUrl: eventsUrl })),
      ]);
      sqs.destroy();
    },
  };

  return queues;
}

export async function deleteTestQueues(queues: TestQueues): Promise<void> {
  await queues.delete();
}
