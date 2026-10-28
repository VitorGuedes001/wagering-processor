import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import ormConfig from '../src/mikro-orm.config';
import { SmokeBalance } from '../src/entities/smoke-balance.entity';

const results: Array<{ check: string; ok: boolean; detail: string }> = [];

function record(check: string, ok: boolean, detail: string): void {
  results.push({ check, ok, detail });
}

async function checkPostgresDecimal(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);
  try {
    const em = orm.em.fork();

    const row = em.create(SmokeBalance, {
      id: crypto.randomUUID(),
      amount: '1234567890123.45',
      currency: 'BRL',
      createdAt: new Date(),
    });
    em.persist(row);
    await em.flush();

    em.clear();
    const found = await em.findOneOrFail(SmokeBalance, { id: row.id });

    const isString = typeof found.amount === 'string';
    const isExact = found.amount === '1234567890123.45';
    record(
      'decimal volta como string exata',
      isString && isExact,
      `typeof=${typeof found.amount} value=${String(found.amount)}`,
    );

    // A constraint tem que barrar valor negativo no banco, não só no código.
    let blocked = false;
    try {
      await em.getConnection().execute(
        `insert into smoke_balance (id, amount, currency, created_at)
         values (gen_random_uuid(), -1.00, 'BRL', now())`,
      );
    } catch {
      blocked = true;
    }
    record('constraint de não-negatividade ativa', blocked, blocked ? 'insert negativo rejeitado' : 'PASSOU — constraint não existe');

    await em.getConnection().execute(`delete from smoke_balance`);
  } finally {
    await orm.close(true);
  }
}

async function checkSqsRoundTrip(): Promise<void> {
  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  const { QueueUrl } = await sqs.send(
    new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
  );
  record('fila FIFO existe', Boolean(QueueUrl), QueueUrl ?? 'não encontrada');
  if (!QueueUrl) return;

  const body = JSON.stringify({ type: 'SmokeTest', occurredAt: new Date().toISOString() });
  const sent = await sqs.send(
    new SendMessageCommand({
      QueueUrl,
      MessageBody: body,
      MessageGroupId: 'smoke',
    }),
  );
  record('envio na fila', Boolean(sent.MessageId), sent.MessageId ?? 'sem MessageId');

  const received = await sqs.send(
    new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5 }),
  );
  const message = received.Messages?.[0];
  record('recebimento na fila', message?.Body === body, message?.Body ?? 'nenhuma mensagem');

  if (message?.ReceiptHandle) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
  }
}

async function main(): Promise<void> {
  record('runtime Bun', true, Bun.version);

  try {
    await checkPostgresDecimal();
  } catch (error) {
    record('Postgres / MikroORM', false, error instanceof Error ? error.message : String(error));
  }

  try {
    await checkSqsRoundTrip();
  } catch (error) {
    record('SQS / LocalStack', false, error instanceof Error ? error.message : String(error));
  }

  for (const r of results) {
    console.log(`${r.ok ? 'OK  ' : 'FALHA'} ${r.check} — ${r.detail}`);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? '\nStack fechada.' : `\n${failed} verificação(ões) falharam.`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
