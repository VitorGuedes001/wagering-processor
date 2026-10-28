import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config';

const CHECK_TIMEOUT_MS = 2000;

export interface Readiness {
  postgres: boolean;
  sqs: boolean;
}

@Injectable()
export class ReadinessProbe {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async check(): Promise<Readiness> {
    const [postgres, sqs] = await Promise.all([
      withTimeout(this.em.getConnection().execute('select 1')),
      withTimeout(this.inputQueueReachable()),
    ]);
    return { postgres, sqs };
  }

  private async inputQueueReachable(): Promise<void> {
    const { QueueUrl } = await this.sqs.send(
      new GetQueueUrlCommand({ QueueName: this.config.SQS_INPUT_QUEUE }),
    );
    await this.sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
    );
  }
}

async function withTimeout(check: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
