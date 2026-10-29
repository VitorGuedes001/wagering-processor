import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config';
import { EVENT_PUBLISHER, SqsEventPublisher } from './sqs-event-publisher';
import { SqsInputQueue } from './sqs-input-queue';

@Global()
@Module({
  providers: [
    {
      provide: SQSClient,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new SQSClient({
          region: config.AWS_REGION,
          endpoint: config.SQS_ENDPOINT,
          credentials: {
            accessKeyId: config.AWS_ACCESS_KEY_ID,
            secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
          },
        }),
    },
    SqsInputQueue,
    SqsEventPublisher,
    {
      provide: EVENT_PUBLISHER,
      useExisting: SqsEventPublisher,
    },
  ],
  exports: [SQSClient, SqsInputQueue, SqsEventPublisher, EVENT_PUBLISHER],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  /** ARQUITETURA 7.3 passo 5. Roda depois do `beforeApplicationShutdown` do consumidor. */
  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
