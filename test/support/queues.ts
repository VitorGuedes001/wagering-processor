import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
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

function isNonExistentQueueError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err && typeof err.name === 'string' ? err.name : '';
  const code = 'Code' in err && typeof err.Code === 'string' ? err.Code : '';
  const msg = 'message' in err && typeof err.message === 'string' ? err.message : '';
  return (
    name.includes('QueueDoesNotExist') ||
    name.includes('NonExistentQueue') ||
    code.includes('NonExistentQueue') ||
    msg.includes('NonExistentQueue') ||
    msg.includes('QueueDoesNotExist')
  );
}

/**
 * Cria as 3 filas FIFO isoladas por arquivo de teste no LocalStack (TESTES D35, §3.2)
 * com os mesmos atributos e redrive policy de `docker/localstack/init-queues.sh`.
 * `visibilityTimeoutSeconds` encurta a visibilidade da fila de entrada para os
 * cenários de crash (C-05, C-08), sem mudar a redrive policy (T50, DP-1).
 */
export interface CreateTestQueuesOptions {
  /** Padrão 30, igual ao `init-queues.sh`. */
  visibilityTimeoutSeconds?: number;
}

export async function createTestQueues(
  customPrefix?: string,
  options: CreateTestQueuesOptions = {},
): Promise<TestQueues> {
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

  const createdUrls: string[] = [];

  try {
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
      throw new Error(`Falha ao criar fila DLQ de teste: ${dlqName}`);
    }
    createdUrls.push(dlqUrl);

    const dlqAttrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['QueueArn'],
      }),
    );
    const dlqArn = dlqAttrs.Attributes?.QueueArn;
    if (!dlqArn) {
      throw new Error(`Não foi possível obter QueueArn da DLQ: ${dlqName}`);
    }

    // 2. Fila de entrada com VisibilityTimeout (padrão 30) e RedrivePolicy maxReceiveCount=5
    const inputRes = await sqs.send(
      new CreateQueueCommand({
        QueueName: inputName,
        Attributes: {
          FifoQueue: 'true',
          ContentBasedDeduplication: 'true',
          VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 30),
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: dlqArn,
            maxReceiveCount: '5',
          }),
        },
      }),
    );
    const inputUrl = inputRes.QueueUrl;
    if (!inputUrl) {
      throw new Error(`Falha ao criar fila de entrada de teste: ${inputName}`);
    }
    createdUrls.push(inputUrl);

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
      throw new Error(`Falha ao criar fila de eventos de teste: ${eventsName}`);
    }
    createdUrls.push(eventsUrl);

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
        const results = await Promise.allSettled(
          [inputUrl, dlqUrl, eventsUrl].map((url) =>
            sqs.send(new DeleteQueueCommand({ QueueUrl: url })),
          ),
        );
        sqs.destroy();

        const failures = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected' && !isNonExistentQueueError(r.reason),
        );
        if (failures.length > 0) {
          throw new Error(
            `Falha ao remover filas de teste (${prefix}): ${failures
              .map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason)))
              .join('; ')}`,
          );
        }
      },
    };

    return queues;
  } catch (err) {
    // Limpa filas parcialmente criadas antes de propagar a falha
    await Promise.allSettled(
      createdUrls.map((url) => sqs.send(new DeleteQueueCommand({ QueueUrl: url }))),
    );
    sqs.destroy();
    throw err;
  }
}

export async function deleteTestQueues(queues: TestQueues): Promise<void> {
  await queues.delete();
}

export interface SendEnvelopeOptions {
  /** `MessageGroupId` do FIFO. Padrão: `walletId` do envelope, como ARQUITETURA 7.2 recomenda ao produtor. */
  groupId?: string;
  /**
   * `MessageDeduplicationId`. Padrão: aleatório, para que o mesmo envelope
   * enviado de novo chegue de fato ao consumidor (a fila usa
   * `ContentBasedDeduplication` e engoliria cópias idênticas por 5 min).
   */
  deduplicationId?: string;
}

/** Envia um envelope (objeto ou corpo cru) para a fila de entrada do teste. */
export async function sendEnvelope(
  queues: TestQueues,
  envelope: unknown,
  options: SendEnvelopeOptions = {},
): Promise<void> {
  const body = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  const walletId = (envelope as { data?: { walletId?: unknown } } | null)?.data?.walletId;
  const groupId = options.groupId ?? (typeof walletId === 'string' ? walletId : randomUUID());
  await queues.sqs.send(
    new SendMessageCommand({
      QueueUrl: queues.inputUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: options.deduplicationId ?? randomUUID(),
    }),
  );
}

/** Visíveis + em voo. Zero na fila de entrada = toda mensagem recebeu ack ou foi para a DLQ. */
export async function queueDepth(queues: TestQueues, queueUrl: string): Promise<number> {
  const result = await queues.sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  const visible = Number.parseInt(result.Attributes?.ApproximateNumberOfMessages ?? '0', 10);
  const inFlight = Number.parseInt(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10);
  return visible + inFlight;
}

/**
 * Lê (sem apagar) os corpos das mensagens visíveis numa fila, com visibilidade
 * curta para não esconder a mensagem de leituras seguintes. Para inspecionar a DLQ.
 */
export async function peekBodies(queues: TestQueues, queueUrl: string): Promise<string[]> {
  const result = await queues.sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 0,
      VisibilityTimeout: 0,
    }),
  );
  return (result.Messages ?? []).flatMap((m) => (m.Body === undefined ? [] : [m.Body]));
}
