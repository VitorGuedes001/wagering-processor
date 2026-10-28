#!/bin/sh
set -eu

# DLQ primeiro: a fila de entrada precisa do ARN dela na redrive policy.
awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

# Após 5 recebimentos sem ack, o SQS move a mensagem para a DLQ (docs/ARQUITETURA.md 7.1).
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "{
    \"FifoQueue\": \"true\",
    \"ContentBasedDeduplication\": \"true\",
    \"VisibilityTimeout\": \"30\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"
  }"

# Saída do outbox. Dedup explícita por eventId (MessageDeduplicationId), não por conteúdo.
awslocal sqs create-queue \
  --queue-name wagering-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
