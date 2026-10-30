import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError, InvalidWagerRequestError } from '../../src/domain/errors';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  type BackoffPolicy,
  type CreateWagerTransactionProps,
  type SubmittableKind,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

// `Money` real, nunca dublê.
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const T0 = new Date('2026-10-28T12:00:00.000Z');
const T1 = new Date('2026-10-28T12:00:05.000Z');
const POLICY: BackoffPolicy = { baseMs: 1_000, maxMs: 300_000, maxAttempts: 10 };

const { Opening, Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: '0192f000-0000-7000-8000-000000000001',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'hash-1',
    walletId: '0192f000-0000-7000-8000-0000000000aa',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: Bet,
    money: brl('25.00'),
    at: T0,
    ...overrides,
  };
}

/** Transação de `kind` (com referência quando o kind aceita) já no `status` pedido. */
function inStatus(status: WagerTransactionStatus, kind: WagerTransactionKind = Win): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: '0192f000-0000-7000-8000-000000000002',
    providerId: 'provider-a',
    externalTransactionId: 'ext-2',
    idempotencyKey: 'key-2',
    payloadHash: 'hash-2',
    walletId: '0192f000-0000-7000-8000-0000000000aa',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('10.00'),
    referenceExternalTransactionId: kind === Bet ? undefined : 'ext-1',
    status,
    referenceAttempts: 0,
    createdAt: T0,
    updatedAt: T0,
  });
}

describe('WagerTransaction.create — regras por kind (MODELAGEM 4.2)', () => {
  test('nasce PENDING, sem desfecho e sem tentativas', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.status).toBe(Pending);
    expect(tx.kind).toBe(Bet);
    expect(tx.createdAt).toEqual(T0);
    expect(tx.updatedAt).toEqual(T0);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
  });

  test('OPENING vindo de fora lança', () => {
    const kind = Opening as unknown as SubmittableKind;
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerRequestError);
  });

  test('kind fora do enum lança', () => {
    const kind = 'JACKPOT' as unknown as SubmittableKind;
    expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerRequestError);
  });

  describe('BET', () => {
    test('sem referência e valor > 0 é aceito', () => {
      expect(WagerTransaction.create(props({ kind: Bet })).referenceExternalTransactionId).toBeUndefined();
    });
    test('com referência lança', () => {
      expect(() =>
        WagerTransaction.create(props({ kind: Bet, referenceExternalTransactionId: 'ext-0' })),
      ).toThrow(InvalidWagerRequestError);
    });
    test('valor zero lança', () => {
      expect(() => WagerTransaction.create(props({ kind: Bet, money: brl('0.00') }))).toThrow(
        InvalidWagerRequestError,
      );
    });
  });

  describe.each<SubmittableKind>([Win, Loss])('%s (referência opcional)', (kind) => {
    test('sem referência é aceito', () => {
      expect(WagerTransaction.create(props({ kind })).referenceExternalTransactionId).toBeUndefined();
    });
    test('com referência é aceito', () => {
      const tx = WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext-0' }));
      expect(tx.referenceExternalTransactionId).toBe('ext-0');
    });
    test('referência para a própria externalTransactionId lança', () => {
      expect(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext-1' })),
      ).toThrow(InvalidWagerRequestError);
    });
  });

  test('WIN com valor zero lança', () => {
    expect(() => WagerTransaction.create(props({ kind: Win, money: brl('0.00') }))).toThrow(
      InvalidWagerRequestError,
    );
  });

  test('LOSS com valor zero é aceito (D3)', () => {
    const tx = WagerTransaction.create(props({ kind: Loss, money: brl('0.00') }));
    expect(tx.money.isZero()).toBe(true);
  });

  describe.each<SubmittableKind>([Refund, Rollback])('%s (referência obrigatória)', (kind) => {
    test('com referência e valor > 0 é aceito', () => {
      const tx = WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext-0' }));
      expect(tx.referenceExternalTransactionId).toBe('ext-0');
    });
    test('sem referência lança', () => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(InvalidWagerRequestError);
    });
    test('referência para a própria externalTransactionId lança', () => {
      expect(() =>
        WagerTransaction.create(props({ kind, referenceExternalTransactionId: 'ext-1' })),
      ).toThrow(InvalidWagerRequestError);
    });
    test('valor zero lança', () => {
      expect(() =>
        WagerTransaction.create(
          props({ kind, referenceExternalTransactionId: 'ext-0', money: brl('0.00') }),
        ),
      ).toThrow(InvalidWagerRequestError);
    });
  });
});

describe('WagerTransaction.opening (D42)', () => {
  const opening = (amount: string) =>
    WagerTransaction.opening({
      id: '0192f000-0000-7000-8000-000000000003',
      walletId: '0192f000-0000-7000-8000-0000000000aa',
      playerId: 'player-1',
      money: brl(amount),
      at: T0,
    });

  test('nasce PROCESSED, com snapshot igual ao valor e sem campos de provedor', () => {
    const tx = opening('100.00');
    expect(tx.kind).toBe(Opening);
    expect(tx.status).toBe(Processed);
    expect(tx.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(tx.processedAt).toEqual(T0);
    expect(tx.providerId).toBeUndefined();
    expect(tx.externalTransactionId).toBeUndefined();
    expect(tx.idempotencyKey).toBeUndefined();
    expect(tx.payloadHash).toBeUndefined();
    expect(tx.roundId).toBeUndefined();
    expect(tx.gameId).toBeUndefined();
    expect(tx.isTerminal()).toBe(true);
    expect(tx.matchesPayload('hash-1')).toBe(false);
  });

  test('valor zero lança (OPENING > 0)', () => {
    expect(() => opening('0.00')).toThrow(InvalidWagerRequestError);
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('reconstrói estado terminal sem revalidar', () => {
    const tx = inStatus(Rejected);
    expect(tx.status).toBe(Rejected);
    expect(tx.isTerminal()).toBe(true);
  });
});

describe('transições (MODELAGEM 4.3)', () => {
  type Transition = (tx: WagerTransaction) => void;
  const transitions: Record<string, Transition> = {
    markProcessed: (tx) => tx.markProcessed('ref-id', brl('90.00'), T1),
    reject: (tx) => tx.reject(FailureCode.InsufficientFunds, brl('90.00'), T1),
    fail: (tx) => tx.fail(FailureCode.ProcessingFailed, T1),
    markPendingReference: (tx) => tx.markPendingReference(T1, POLICY),
    scheduleReferenceRetry: (tx) => tx.scheduleReferenceRetry(T1, POLICY),
  };

  // [método, origem, destino | 'lança']
  const matrix: [string, WagerTransactionStatus, WagerTransactionStatus | 'lança'][] = [
    ['markProcessed', Pending, Processed],
    ['markProcessed', PendingReference, Processed],
    ['markProcessed', Processed, 'lança'],
    ['markProcessed', Rejected, 'lança'],
    ['markProcessed', Failed, 'lança'],
    ['reject', Pending, Rejected],
    ['reject', PendingReference, Rejected],
    ['reject', Processed, 'lança'],
    ['reject', Rejected, 'lança'],
    ['reject', Failed, 'lança'],
    ['fail', Pending, Failed],
    ['fail', PendingReference, Failed],
    ['fail', Processed, 'lança'],
    ['fail', Rejected, 'lança'],
    ['fail', Failed, 'lança'],
    ['markPendingReference', Pending, PendingReference],
    ['markPendingReference', PendingReference, 'lança'],
    ['markPendingReference', Processed, 'lança'],
    ['markPendingReference', Rejected, 'lança'],
    ['markPendingReference', Failed, 'lança'],
    ['scheduleReferenceRetry', Pending, 'lança'],
    ['scheduleReferenceRetry', PendingReference, PendingReference],
    ['scheduleReferenceRetry', Processed, 'lança'],
    ['scheduleReferenceRetry', Rejected, 'lança'],
    ['scheduleReferenceRetry', Failed, 'lança'],
  ];

  test.each(matrix)('%s a partir de %s → %s', (method, from, to) => {
    const tx = inStatus(from);
    const run = transitions[method] as Transition;
    if (to === 'lança') {
      expect(() => run(tx)).toThrow(InvalidTransactionStateError);
      expect(tx.status).toBe(from);
      expect(tx.updatedAt).toEqual(T0);
    } else {
      run(tx);
      expect(tx.status).toBe(to);
      expect(tx.updatedAt).toEqual(T1);
    }
  });

  test('markProcessed grava referência resolvida, snapshot e processedAt', () => {
    const tx = inStatus(PendingReference);
    tx.markProcessed('ref-id', brl('90.00'), T1);
    expect(tx.referenceTransactionId).toBe('ref-id');
    expect(tx.balanceAfter?.equals(brl('90.00'))).toBe(true);
    expect(tx.processedAt).toEqual(T1);
    expect(tx.failureCode).toBeUndefined();
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test('markProcessed sem referência (BET) deixa referenceTransactionId vazio', () => {
    const tx = inStatus(Pending, Bet);
    tx.markProcessed(undefined, brl('90.00'), T1);
    expect(tx.referenceTransactionId).toBeUndefined();
  });

  test('reject grava código e snapshot, sem processedAt', () => {
    const tx = inStatus(Pending);
    tx.reject(FailureCode.InsufficientFunds, brl('5.00'), T1);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceAfter?.equals(brl('5.00'))).toBe(true);
    expect(tx.processedAt).toBeUndefined();
  });

  test('fail grava código, sem snapshot', () => {
    const tx = inStatus(PendingReference);
    tx.fail(FailureCode.ProcessingFailed, T1);
    expect(tx.failureCode).toBe(FailureCode.ProcessingFailed);
    expect(tx.balanceAfter).toBeUndefined();
    expect(tx.processedAt).toBeUndefined();
  });

  test('desfecho terminal limpa o agendamento da referência', () => {
    const tx = inStatus(Pending);
    tx.markPendingReference(T0, POLICY);
    tx.reject(FailureCode.ReferenceNotFound, brl('10.00'), T1);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test.each([Processed, Rejected, Failed])('%s é terminal', (status) => {
    expect(inStatus(status).isTerminal()).toBe(true);
  });

  test.each([Pending, PendingReference])('%s não é terminal', (status) => {
    expect(inStatus(status).isTerminal()).toBe(false);
  });
});

describe('backoff da referência (D11, D43)', () => {
  const at = (ms: number) => new Date(T0.getTime() + ms);

  test('markPendingReference zera tentativas e agenda now + baseMs', () => {
    const tx = inStatus(Pending);
    tx.markPendingReference(T0, POLICY);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt).toEqual(at(1_000));
  });

  test('scheduleReferenceRetry segue min(baseMs × 2^attempts, maxMs)', () => {
    const tx = inStatus(Pending);
    tx.markPendingReference(T0, POLICY);
    const expectedSeconds = [2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300];
    for (const [i, seconds] of expectedSeconds.entries()) {
      tx.scheduleReferenceRetry(T0, POLICY);
      expect(tx.referenceAttempts).toBe(i + 1);
      expect(tx.nextReferenceAttemptAt).toEqual(at(seconds * 1_000));
      expect(tx.status).toBe(PendingReference);
    }
  });

  test('os 10 primeiros atrasos somam ~13,5 min (811 s)', () => {
    const tx = inStatus(Pending);
    tx.markPendingReference(T0, POLICY);
    let totalMs = (tx.nextReferenceAttemptAt as Date).getTime() - T0.getTime();
    for (let i = 1; i < 10; i++) {
      tx.scheduleReferenceRetry(T0, POLICY);
      totalMs += (tx.nextReferenceAttemptAt as Date).getTime() - T0.getTime();
    }
    expect(totalMs).toBe(811_000);
  });

  test('expoente alto não estoura: fica em maxMs', () => {
    const tx = WagerTransaction.rehydrate({
      ...stateOf(inStatus(PendingReference)),
      referenceAttempts: 5_000,
    });
    tx.scheduleReferenceRetry(T0, POLICY);
    expect(tx.nextReferenceAttemptAt).toEqual(at(300_000));
  });

  test('referenceAttemptsExhausted é attempts >= maxAttempts', () => {
    const tx = inStatus(Pending);
    tx.markPendingReference(T0, POLICY);
    for (let i = 0; i < 9; i++) tx.scheduleReferenceRetry(T0, POLICY);
    expect(tx.referenceAttempts).toBe(9);
    expect(tx.referenceAttemptsExhausted(POLICY)).toBe(false);
    tx.scheduleReferenceRetry(T0, POLICY);
    expect(tx.referenceAttempts).toBe(10);
    expect(tx.referenceAttemptsExhausted(POLICY)).toBe(true);
  });
});

describe('consultas', () => {
  test.each([
    [Bet, true],
    [Win, true],
    [Loss, false],
    [Refund, true],
    [Rollback, true],
  ] as const)('affectsBalance de %s é %p', (kind, expected) => {
    expect(inStatus(Pending, kind).affectsBalance()).toBe(expected);
  });

  test.each([
    [Bet, false],
    [Win, false],
    [Loss, false],
    [Refund, true],
    [Rollback, true],
  ] as const)('requiresReference de %s é %p', (kind, expected) => {
    expect(inStatus(Pending, kind).requiresReference()).toBe(expected);
  });

  test('matchesPayload compara o payloadHash', () => {
    const tx = inStatus(Pending);
    expect(tx.matchesPayload('hash-2')).toBe(true);
    expect(tx.matchesPayload('outro')).toBe(false);
  });
});

describe('ledgerDirectionFor (MODELAGEM 4.2)', () => {
  test.each([
    [Bet, LedgerDirection.Debit],
    [Win, LedgerDirection.Credit],
    [Refund, LedgerDirection.Credit],
  ] as const)('%s → %s', (kind, direction) => {
    expect(inStatus(Pending, kind).ledgerDirectionFor()).toBe(direction);
  });

  test('OPENING → CREDIT', () => {
    const tx = WagerTransaction.opening({
      id: '0192f000-0000-7000-8000-000000000003',
      walletId: '0192f000-0000-7000-8000-0000000000aa',
      playerId: 'player-1',
      money: brl('100.00'),
      at: T0,
    });
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('LOSS lança: não tem direção', () => {
    expect(() => inStatus(Pending, Loss).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test.each([
    [Bet, LedgerDirection.Credit],
    [Win, LedgerDirection.Debit],
    [Refund, LedgerDirection.Debit],
  ] as const)('ROLLBACK de %s → %s (inversa da referência)', (referenceKind, direction) => {
    const rollback = inStatus(Pending, Rollback);
    expect(rollback.ledgerDirectionFor(inStatus(Processed, referenceKind))).toBe(direction);
  });

  test('ROLLBACK sem referência lança', () => {
    expect(() => inStatus(Pending, Rollback).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test.each([Loss, Rollback])('ROLLBACK de %s lança (kind não referenciável)', (referenceKind) => {
    const rollback = inStatus(Pending, Rollback);
    expect(() => rollback.ledgerDirectionFor(inStatus(Processed, referenceKind))).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('ROLLBACK de OPENING lança (kind não referenciável)', () => {
    const opening = WagerTransaction.opening({
      id: '0192f000-0000-7000-8000-000000000003',
      walletId: '0192f000-0000-7000-8000-0000000000aa',
      playerId: 'player-1',
      money: brl('100.00'),
      at: T0,
    });
    expect(() => inStatus(Pending, Rollback).ledgerDirectionFor(opening)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

/** Estado atual de uma transação, para rehidratar uma variação dela. */
function stateOf(tx: WagerTransaction) {
  return {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money,
    referenceExternalTransactionId: tx.referenceExternalTransactionId,
    status: tx.status,
    referenceTransactionId: tx.referenceTransactionId,
    failureCode: tx.failureCode,
    balanceAfter: tx.balanceAfter,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt,
    processedAt: tx.processedAt,
  };
}
