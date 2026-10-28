import { Global, Module } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { APP_CONFIG, type AppConfig } from '../config';

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
  ],
  exports: [SQSClient],
})
export class MessagingModule {}
