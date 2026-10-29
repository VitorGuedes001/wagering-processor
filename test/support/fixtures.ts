import { randomUUID } from 'node:crypto';
import type { MoneyProps } from '../../src/domain/money';
import { type SubmittableKind, WagerTransactionKind } from '../../src/domain/wager-transaction';

/** Fixture literal de criação de wallet em CHALLENGE.md §9. */
export const CHALLENGE_WALLET_FIXTURE = {
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  initialBalance: { amount: '1000.00', currency: 'BRL' },
} as const;

/** Fixture literal de resposta de wallet em CHALLENGE.md §9. */
export const CHALLENGE_WALLET_RESPONSE_FIXTURE = {
  id: '0192f291-27dd-7d3f-8071-5f8685deef37',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  balance: { amount: '1000.00', currency: 'BRL' },
  version: 1,
} as const;

/** Fixture literal de submissão HTTP em CHALLENGE.md §9 (TESTES §5: JSON literal independente do enum). */
export const CHALLENGE_WAGER_FIXTURE = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
} as const;

/** Fixture literal de mensagem SQS em CHALLENGE.md §10 (TESTES §5: JSON literal independente do enum). */
export const CHALLENGE_SQS_MESSAGE_FIXTURE = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  },
} as const;

export interface WalletRequestFixture {
  playerId: string;
  initialBalance: MoneyProps;
}

export interface WalletRequestOverrides {
  playerId?: string;
  initialBalance?: MoneyProps;
  amount?: string;
  currency?: string;
}

export interface WagerRequestFixture {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: SubmittableKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerBuilderOverrides extends Partial<WagerRequestFixture> {
  /** Atalho para `money.amount` (ex.: `aBet({ amount: '80.00' })`, TESTES §5). */
  amount?: string;
  /** Atalho para `money.currency`. */
  currency?: string;
}

export interface SqsWagerEnvelopeFixture {
  messageId: string;
  type: string;
  occurredAt: string;
  data: WagerRequestFixture;
}

let seq = 0;
function uniqueSuffix(): string {
  seq += 1;
  return `${seq}-${randomUUID().slice(0, 8)}`;
}

export function aWalletRequest(overrides: WalletRequestOverrides = {}): WalletRequestFixture {
  const currency = overrides.currency ?? overrides.initialBalance?.currency ?? 'BRL';
  const amount = overrides.amount ?? overrides.initialBalance?.amount ?? '1000.00';
  return {
    playerId: overrides.playerId ?? randomUUID(),
    initialBalance: { amount, currency },
  };
}

function buildWager(kind: SubmittableKind, overrides: WagerBuilderOverrides = {}): WagerRequestFixture {
  const suffix = uniqueSuffix();
  const providerId = overrides.providerId ?? CHALLENGE_WAGER_FIXTURE.providerId;
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${suffix}`;
  const idempotencyKey = overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`;
  const currency = overrides.currency ?? overrides.money?.currency ?? 'BRL';
  const amount = overrides.amount ?? overrides.money?.amount ?? '25.00';

  const result: WagerRequestFixture = {
    providerId,
    externalTransactionId,
    idempotencyKey,
    playerId: overrides.playerId ?? CHALLENGE_WAGER_FIXTURE.playerId,
    walletId: overrides.walletId ?? CHALLENGE_WAGER_FIXTURE.walletId,
    roundId: overrides.roundId ?? `round-${suffix}`,
    gameId: overrides.gameId ?? CHALLENGE_WAGER_FIXTURE.gameId,
    kind: overrides.kind ?? kind,
    money: { amount, currency },
  };

  if (overrides.referenceExternalTransactionId !== undefined) {
    result.referenceExternalTransactionId = overrides.referenceExternalTransactionId;
  }

  return result;
}

export function aBet(overrides: WagerBuilderOverrides = {}): WagerRequestFixture {
  return buildWager(WagerTransactionKind.Bet, overrides);
}

export function aWin(overrides: WagerBuilderOverrides = {}): WagerRequestFixture {
  return buildWager(WagerTransactionKind.Win, overrides);
}

export function aLoss(overrides: WagerBuilderOverrides = {}): WagerRequestFixture {
  return buildWager(WagerTransactionKind.Loss, {
    amount: overrides.amount ?? overrides.money?.amount ?? '0.00',
    ...overrides,
  });
}

export function aRefundOf(
  reference: Pick<
    WagerRequestFixture,
    'providerId' | 'playerId' | 'walletId' | 'roundId' | 'gameId' | 'externalTransactionId' | 'money'
  >,
  overrides: WagerBuilderOverrides = {},
): WagerRequestFixture {
  return buildWager(WagerTransactionKind.Refund, {
    providerId: reference.providerId,
    playerId: reference.playerId,
    walletId: reference.walletId,
    roundId: reference.roundId,
    gameId: reference.gameId,
    money: { ...reference.money },
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

export function aRollbackOf(
  reference: Pick<
    WagerRequestFixture,
    'providerId' | 'playerId' | 'walletId' | 'roundId' | 'gameId' | 'externalTransactionId' | 'money'
  >,
  overrides: WagerBuilderOverrides = {},
): WagerRequestFixture {
  return buildWager(WagerTransactionKind.Rollback, {
    providerId: reference.providerId,
    playerId: reference.playerId,
    walletId: reference.walletId,
    roundId: reference.roundId,
    gameId: reference.gameId,
    money: { ...reference.money },
    referenceExternalTransactionId: reference.externalTransactionId,
    ...overrides,
  });
}

export function anSqsEnvelope(
  data: WagerRequestFixture = aBet(),
  overrides: Partial<Omit<SqsWagerEnvelopeFixture, 'data'>> = {},
): SqsWagerEnvelopeFixture {
  const suffix = uniqueSuffix();
  return {
    messageId: overrides.messageId ?? `msg-${suffix}`,
    type: overrides.type ?? CHALLENGE_SQS_MESSAGE_FIXTURE.type,
    occurredAt: overrides.occurredAt ?? CHALLENGE_SQS_MESSAGE_FIXTURE.occurredAt,
    data,
  };
}
