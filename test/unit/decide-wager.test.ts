import { describe, expect, test } from 'bun:test';
import { decideWager } from '../../src/domain/decide-wager';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  type BackoffPolicy,
  type CreateWagerTransactionProps,
  type SubmittableKind,
  WagerTransaction,
  WagerTransactionKind,
  type WagerTransactionState,
  WagerTransactionStatus,
} from '../../src/domain/wager-transaction';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

const { Opening, Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } = WagerTransactionStatus;

const T0 = new Date('2026-10-28T12:00:00.000Z');
const T1 = new Date('2026-10-28T12:00:01.000Z');
const BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 300_000, maxAttempts: 10 };

const WALLET_ID = '0192f000-0000-7000-8000-0000000000aa';
const PLAYER_ID = '0192f000-0000-7000-8000-0000000000bb';
const PROVIDER_ID = 'provider-a';
const ROUND_ID = 'round-1';
const GAME_ID = 'fortune-chimp';

const money = (amount: string, currency = 'BRL'): Money => Money.from({ amount, currency });

function openWallet(balance = '100.00', currency = 'BRL', playerId = PLAYER_ID, id = WALLET_ID): Wallet {
  return Wallet.open({
    id,
    playerId,
    initialBalance: money(balance, currency),
    openingTransactionId: '0192f000-0000-7000-8000-000000000000',
    openingEntryId: '0192f000-0000-7000-8000-000000000001',
    at: T0,
  }).wallet;
}

function createTx(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const kind = overrides.kind ?? Bet;
  const defaultRef = kind === Refund || kind === Rollback ? 'ext-ref-1' : undefined;
  return WagerTransaction.create({
    id: '0192f000-0000-7000-8000-000000000010',
    providerId: PROVIDER_ID,
    externalTransactionId: 'ext-tx-1',
    idempotencyKey: 'idem-tx-1',
    payloadHash: 'a'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: ROUND_ID,
    gameId: GAME_ID,
    kind,
    money: money('25.00'),
    referenceExternalTransactionId: defaultRef,
    at: T0,
    ...overrides,
  });
}

function rehydrateTx(overrides: Partial<WagerTransactionState> = {}): WagerTransaction {
  const kind = overrides.kind ?? Bet;
  const status = overrides.status ?? Processed;
  const txMoney = overrides.money ?? money('25.00');
  return WagerTransaction.rehydrate({
    id: '0192f000-0000-7000-8000-000000000020',
    providerId: kind === Opening ? undefined : PROVIDER_ID,
    externalTransactionId: kind === Opening ? undefined : 'ext-ref-1',
    idempotencyKey: kind === Opening ? undefined : 'idem-ref-1',
    payloadHash: kind === Opening ? undefined : 'b'.repeat(64),
    walletId: WALLET_ID,
    playerId: PLAYER_ID,
    roundId: kind === Opening ? undefined : ROUND_ID,
    gameId: kind === Opening ? undefined : GAME_ID,
    kind,
    money: txMoney,
    referenceExternalTransactionId:
      kind === Refund || kind === Rollback ? 'ext-older-1' : undefined,
    status,
    referenceTransactionId:
      status === Processed && (kind === Refund || kind === Rollback)
        ? '0192f000-0000-7000-8000-000000000099'
        : undefined,
    failureCode:
      status === Rejected
        ? FailureCode.InsufficientFunds
        : status === Failed
          ? FailureCode.ProcessingFailed
          : undefined,
    balanceAfter: status === Processed || status === Rejected ? money('100.00') : undefined,
    referenceAttempts: 0,
    nextReferenceAttemptAt: status === PendingReference ? T1 : undefined,
    createdAt: T0,
    updatedAt: T0,
    processedAt: status === Processed ? T0 : undefined,
    ...overrides,
  });
}

describe('decideWager — caminhos APPLY por kind (MODELAGEM §5, §4.2)', () => {
  test('BET com saldo maior que a aposta → APPLY DEBIT', () => {
    const wallet = openWallet('100.00');
    const transaction = createTx({ kind: Bet, money: money('25.00') });

    const decision = decideWager({
      transaction,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  test('BET no limite exato do saldo (canDebit = true) → APPLY DEBIT', () => {
    const wallet = openWallet('25.00');
    const transaction = createTx({ kind: Bet, money: money('25.00') });

    const decision = decideWager({
      transaction,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  test('WIN sem referência → APPLY CREDIT (mesmo com wallet zerada)', () => {
    const wallet = openWallet('0.00');
    const transaction = createTx({ kind: Win, money: money('80.00') });

    const decision = decideWager({
      transaction,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  test('WIN com referência BET PROCESSED (inclusive com valor diferente do BET) → APPLY CREDIT', () => {
    const wallet = openWallet('10.00');
    const reference = rehydrateTx({ kind: Bet, status: Processed, money: money('25.00') });
    const transaction = createTx({
      kind: Win,
      money: money('250.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });

    const decision = decideWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  test('LOSS sem referência (valor > 0 e valor 0.00 de D3) → APPLY com direction undefined', () => {
    const wallet = openWallet('0.00');

    const lossPositive = createTx({ kind: Loss, money: money('25.00') });
    expect(
      decideWager({
        transaction: lossPositive,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
        backoff: BACKOFF,
      }),
    ).toEqual({ type: 'APPLY', direction: undefined });

    const lossZero = createTx({ kind: Loss, money: money('0.00') });
    expect(
      decideWager({
        transaction: lossZero,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
        backoff: BACKOFF,
      }),
    ).toEqual({ type: 'APPLY', direction: undefined });
  });

  test('LOSS com referência BET PROCESSED (valor 0.00 e valor livre) → APPLY com direction undefined', () => {
    const wallet = openWallet('0.00');
    const reference = rehydrateTx({ kind: Bet, status: Processed, money: money('25.00') });
    const transaction = createTx({
      kind: Loss,
      money: money('0.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });

    const decision = decideWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: undefined });
  });

  test('REFUND de BET PROCESSED → APPLY CREDIT (mesmo com wallet zerada)', () => {
    const wallet = openWallet('0.00');
    const reference = rehydrateTx({ kind: Bet, status: Processed, money: money('25.00') });
    const transaction = createTx({
      kind: Refund,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });

    const decision = decideWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  test('ROLLBACK de BET PROCESSED → APPLY CREDIT (mesmo com wallet zerada)', () => {
    const wallet = openWallet('0.00');
    const reference = rehydrateTx({ kind: Bet, status: Processed, money: money('25.00') });
    const transaction = createTx({
      kind: Rollback,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });

    const decision = decideWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
  });

  test('ROLLBACK de WIN PROCESSED com saldo no limite exato → APPLY DEBIT', () => {
    const wallet = openWallet('40.00');
    const reference = rehydrateTx({ kind: Win, status: Processed, money: money('40.00') });
    const transaction = createTx({
      kind: Rollback,
      money: money('40.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });

    const decision = decideWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });

  test('ROLLBACK de REFUND PROCESSED com saldo no limite exato → APPLY DEBIT', () => {
    const wallet = openWallet('25.00');
    const reference = rehydrateTx({ kind: Refund, status: Processed, money: money('25.00') });
    const transaction = createTx({
      kind: Rollback,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });

    const decision = decideWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Debit });
  });
});

describe('decideWager — cada linha da tabela de MODELAGEM §5 isoladamente', () => {
  describe('1. wallet pertence ao playerId → WALLET_PLAYER_MISMATCH', () => {
    test.each<SubmittableKind>([Bet, Win, Loss, Refund, Rollback])(
      'rejeita %s quando wallet.playerId !== transaction.playerId',
      (kind) => {
        const wallet = openWallet('100.00', 'BRL', 'outro-player');
        const transaction = createTx({ kind, playerId: PLAYER_ID });

        const decision = decideWager({
          transaction,
          wallet,
          reference: rehydrateTx({ kind: Bet, status: Processed }),
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        });

        expect(decision).toEqual({
          type: 'REJECT',
          code: FailureCode.WalletPlayerMismatch,
        });
      },
    );
  });

  describe('2. moeda da operação = moeda da wallet → CURRENCY_MISMATCH', () => {
    test.each<SubmittableKind>([Bet, Win, Loss, Refund, Rollback])(
      'rejeita %s quando transaction.money.currency !== wallet.currency',
      (kind) => {
        const wallet = openWallet('100.00', 'BRL');
        const transaction = createTx({ kind, money: money('25.00', 'USD') });

        const decision = decideWager({
          transaction,
          wallet,
          reference: rehydrateTx({ kind: Bet, status: Processed, money: money('25.00', 'USD') }),
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        });

        expect(decision).toEqual({
          type: 'REJECT',
          code: FailureCode.CurrencyMismatch,
        });
      },
    );
  });

  describe('3. referência informada existe → AWAIT_REFERENCE ou REFERENCE_NOT_FOUND (D2, D11, D43, D57)', () => {
    test.each<SubmittableKind>([Win, Loss, Refund, Rollback])(
      '%s com referência ausente e tentativas restantes (0 e maxAttempts - 1) → AWAIT_REFERENCE',
      (kind) => {
        const wallet = openWallet('100.00');
        const firstAttemptTx = createTx({
          kind,
          referenceExternalTransactionId: 'ext-missing',
        });

        expect(
          decideWager({
            transaction: firstAttemptTx,
            wallet,
            reference: undefined,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({ type: 'AWAIT_REFERENCE' });

        const ninthAttemptTx = rehydrateTx({
          kind,
          status: PendingReference,
          referenceExternalTransactionId: 'ext-missing',
          referenceAttempts: BACKOFF.maxAttempts - 1,
        });

        expect(
          decideWager({
            transaction: ninthAttemptTx,
            wallet,
            reference: undefined,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({ type: 'AWAIT_REFERENCE' });
      },
    );

    test.each<SubmittableKind>([Win, Loss, Refund, Rollback])(
      '%s com referência ausente e tentativas esgotadas (maxAttempts = 10) → REJECT REFERENCE_NOT_FOUND',
      (kind) => {
        const wallet = openWallet('100.00');
        const exhaustedTx = rehydrateTx({
          kind,
          status: PendingReference,
          referenceExternalTransactionId: 'ext-missing',
          referenceAttempts: BACKOFF.maxAttempts,
        });

        expect(
          decideWager({
            transaction: exhaustedTx,
            wallet,
            reference: undefined,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceNotFound,
        });
      },
    );
  });

  describe('4. referência está PENDING ou PENDING_REFERENCE → AWAIT_REFERENCE ou REFERENCE_NOT_PROCESSED ao esgotar (D61)', () => {
    test.each([
      [Win, Pending],
      [Win, PendingReference],
      [Loss, Pending],
      [Loss, PendingReference],
      [Refund, Pending],
      [Refund, PendingReference],
      [Rollback, Pending],
      [Rollback, PendingReference],
    ] as const)(
      '%s com referência em %s e tentativas restantes → AWAIT_REFERENCE',
      (kind, refStatus) => {
        const wallet = openWallet('100.00');
        const transaction = rehydrateTx({
          id: '0192f000-0000-7000-8000-000000000010',
          kind,
          status: PendingReference,
          referenceExternalTransactionId: 'ext-ref-1',
          referenceAttempts: BACKOFF.maxAttempts - 1,
        });
        const reference = rehydrateTx({ kind: Bet, status: refStatus });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({ type: 'AWAIT_REFERENCE' });
      },
    );

    test.each([
      [Win, Pending],
      [Win, PendingReference],
      [Loss, Pending],
      [Loss, PendingReference],
      [Refund, Pending],
      [Refund, PendingReference],
      [Rollback, Pending],
      [Rollback, PendingReference],
    ] as const)(
      '%s com referência em %s e tentativas esgotadas (D61) → cai no passo 5 e devolve REJECT REFERENCE_NOT_PROCESSED',
      (kind, refStatus) => {
        const wallet = openWallet('100.00');
        const transaction = rehydrateTx({
          id: '0192f000-0000-7000-8000-000000000010',
          kind,
          status: PendingReference,
          referenceExternalTransactionId: 'ext-ref-1',
          referenceAttempts: BACKOFF.maxAttempts,
        });
        const reference = rehydrateTx({ kind: Bet, status: refStatus });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceNotProcessed,
        });
      },
    );
  });

  describe('5. referência está PROCESSED → REFERENCE_NOT_PROCESSED', () => {
    test.each([
      [Win, Rejected],
      [Win, Failed],
      [Loss, Rejected],
      [Loss, Failed],
      [Refund, Rejected],
      [Refund, Failed],
      [Rollback, Rejected],
      [Rollback, Failed],
    ] as const)('%s com referência em %s → REJECT REFERENCE_NOT_PROCESSED', (kind, refStatus) => {
      const wallet = openWallet('100.00');
      const transaction = createTx({ kind, referenceExternalTransactionId: 'ext-ref-1' });
      const reference = rehydrateTx({ kind: Bet, status: refStatus });

      expect(
        decideWager({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        }),
      ).toEqual({
        type: 'REJECT',
        code: FailureCode.ReferenceNotProcessed,
      });
    });
  });

  describe('6. kind da referência é permitido (MODELAGEM 4.2) → REFERENCE_KIND_NOT_ALLOWED', () => {
    test.each([
      // WIN só pode referenciar BET
      [Win, Win],
      [Win, Loss],
      [Win, Refund],
      [Win, Rollback],
      [Win, Opening],
      // LOSS só pode referenciar BET
      [Loss, Win],
      [Loss, Loss],
      [Loss, Refund],
      [Loss, Rollback],
      [Loss, Opening],
      // REFUND só pode referenciar BET
      [Refund, Win],
      [Refund, Loss],
      [Refund, Refund],
      [Refund, Rollback],
      [Refund, Opening],
      // ROLLBACK só pode referenciar BET, WIN ou REFUND
      [Rollback, Loss],
      [Rollback, Rollback],
      [Rollback, Opening],
    ] as const)('%s referenciando %s → REJECT REFERENCE_KIND_NOT_ALLOWED', (kind, refKind) => {
      const wallet = openWallet('100.00');
      const transaction = createTx({ kind, referenceExternalTransactionId: 'ext-ref-1' });
      const reference =
        refKind === Opening
          ? WagerTransaction.opening({
              id: '0192f000-0000-7000-8000-000000000030',
              walletId: WALLET_ID,
              playerId: PLAYER_ID,
              money: money('25.00'),
              at: T0,
            })
          : rehydrateTx({ kind: refKind, status: Processed });

      expect(
        decideWager({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        }),
      ).toEqual({
        type: 'REJECT',
        code: FailureCode.ReferenceKindNotAllowed,
      });
    });
  });

  describe('7. mesma wallet, player, moeda e rodada → REFERENCE_CONTEXT_MISMATCH', () => {
    test.each<SubmittableKind>([Win, Loss, Refund, Rollback])(
      '%s com reference.walletId diferente → REJECT REFERENCE_CONTEXT_MISMATCH',
      (kind) => {
        const wallet = openWallet('100.00');
        const transaction = createTx({ kind, referenceExternalTransactionId: 'ext-ref-1' });
        const reference = rehydrateTx({
          kind: Bet,
          status: Processed,
          walletId: '0192f000-0000-7000-8000-0000000000ff',
        });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceContextMismatch,
        });
      },
    );

    test.each<SubmittableKind>([Win, Loss, Refund, Rollback])(
      '%s com reference.playerId diferente → REJECT REFERENCE_CONTEXT_MISMATCH',
      (kind) => {
        const wallet = openWallet('100.00');
        const transaction = createTx({ kind, referenceExternalTransactionId: 'ext-ref-1' });
        const reference = rehydrateTx({
          kind: Bet,
          status: Processed,
          playerId: 'outro-player',
        });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceContextMismatch,
        });
      },
    );

    test.each<SubmittableKind>([Win, Loss, Refund, Rollback])(
      '%s com reference.money.currency diferente → REJECT REFERENCE_CONTEXT_MISMATCH',
      (kind) => {
        const wallet = openWallet('100.00', 'BRL');
        const transaction = createTx({ kind, referenceExternalTransactionId: 'ext-ref-1' });
        const reference = rehydrateTx({
          kind: Bet,
          status: Processed,
          money: money('25.00', 'EUR'),
        });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceContextMismatch,
        });
      },
    );

    test.each<SubmittableKind>([Win, Loss, Refund, Rollback])(
      '%s com reference.roundId diferente → REJECT REFERENCE_CONTEXT_MISMATCH',
      (kind) => {
        const wallet = openWallet('100.00');
        const transaction = createTx({ kind, referenceExternalTransactionId: 'ext-ref-1' });
        const reference = rehydrateTx({
          kind: Bet,
          status: Processed,
          roundId: 'outra-rodada',
        });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceContextMismatch,
        });
      },
    );
  });

  describe('8. valor igual (só REFUND/ROLLBACK) → REFERENCE_AMOUNT_MISMATCH', () => {
    test.each([
      [Refund, Bet, '24.99'],
      [Refund, Bet, '25.01'],
      [Rollback, Bet, '10.00'],
      [Rollback, Win, '50.00'],
      [Rollback, Refund, '50.00'],
    ] as const)(
      '%s de %s (25.00) com valor %s → REJECT REFERENCE_AMOUNT_MISMATCH',
      (kind, refKind, amount) => {
        const wallet = openWallet('100.00');
        const transaction = createTx({
          kind,
          money: money(amount),
          referenceExternalTransactionId: 'ext-ref-1',
        });
        const reference = rehydrateTx({
          kind: refKind,
          status: Processed,
          money: money('25.00'),
        });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: false,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceAmountMismatch,
        });
      },
    );
  });

  describe('9. referência ainda não revertida (só REFUND/ROLLBACK, D1) → REFERENCE_ALREADY_REVERSED', () => {
    test.each([
      [Refund, Bet],
      [Rollback, Bet],
      [Rollback, Win],
      [Rollback, Refund],
    ] as const)(
      '%s de %s com referenceAlreadyReversed = true → REJECT REFERENCE_ALREADY_REVERSED',
      (kind, refKind) => {
        const wallet = openWallet('100.00');
        const transaction = createTx({
          kind,
          money: money('25.00'),
          referenceExternalTransactionId: 'ext-ref-1',
        });
        const reference = rehydrateTx({
          kind: refKind,
          status: Processed,
          money: money('25.00'),
        });

        expect(
          decideWager({
            transaction,
            wallet,
            reference,
            referenceAlreadyReversed: true,
            backoff: BACKOFF,
          }),
        ).toEqual({
          type: 'REJECT',
          code: FailureCode.ReferenceAlreadyReversed,
        });
      },
    );

    test('WIN e LOSS com referência ignoram referenceAlreadyReversed = true', () => {
      const wallet = openWallet('100.00');
      const reference = rehydrateTx({ kind: Bet, status: Processed, money: money('25.00') });

      const winTx = createTx({
        kind: Win,
        money: money('50.00'),
        referenceExternalTransactionId: 'ext-ref-1',
      });
      expect(
        decideWager({
          transaction: winTx,
          wallet,
          reference,
          referenceAlreadyReversed: true,
          backoff: BACKOFF,
        }),
      ).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });

      const lossTx = createTx({
        kind: Loss,
        money: money('0.00'),
        referenceExternalTransactionId: 'ext-ref-1',
      });
      expect(
        decideWager({
          transaction: lossTx,
          wallet,
          reference,
          referenceAlreadyReversed: true,
          backoff: BACKOFF,
        }),
      ).toEqual({ type: 'APPLY', direction: undefined });
    });
  });

  describe('10. saldo cobre o débito → INSUFFICIENT_FUNDS vs REVERSAL_INSUFFICIENT_FUNDS (§7.9)', () => {
    test('BET maior que o saldo → REJECT INSUFFICIENT_FUNDS', () => {
      const wallet = openWallet('25.00');
      const transaction = createTx({ kind: Bet, money: money('25.01') });

      expect(
        decideWager({
          transaction,
          wallet,
          reference: undefined,
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        }),
      ).toEqual({
        type: 'REJECT',
        code: FailureCode.InsufficientFunds,
      });
    });

    test('ROLLBACK de WIN maior que o saldo → REJECT REVERSAL_INSUFFICIENT_FUNDS', () => {
      const wallet = openWallet('25.00');
      const reference = rehydrateTx({ kind: Win, status: Processed, money: money('25.01') });
      const transaction = createTx({
        kind: Rollback,
        money: money('25.01'),
        referenceExternalTransactionId: 'ext-ref-1',
      });

      expect(
        decideWager({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        }),
      ).toEqual({
        type: 'REJECT',
        code: FailureCode.ReversalInsufficientFunds,
      });
    });

    test('ROLLBACK de REFUND maior que o saldo → REJECT REVERSAL_INSUFFICIENT_FUNDS', () => {
      const wallet = openWallet('25.00');
      const reference = rehydrateTx({ kind: Refund, status: Processed, money: money('25.01') });
      const transaction = createTx({
        kind: Rollback,
        money: money('25.01'),
        referenceExternalTransactionId: 'ext-ref-1',
      });

      expect(
        decideWager({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        }),
      ).toEqual({
        type: 'REJECT',
        code: FailureCode.ReversalInsufficientFunds,
      });
    });
  });
});

describe('decideWager — prova da ordem determinística quando duas regras falham juntas', () => {
  test('#1 vence #2: player divergente + moeda divergente → WALLET_PLAYER_MISMATCH', () => {
    const wallet = openWallet('100.00', 'BRL', 'outro-player');
    const transaction = createTx({
      kind: Bet,
      playerId: PLAYER_ID,
      money: money('10.00', 'USD'),
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.WalletPlayerMismatch,
    });
  });

  test('#2 vence #3: moeda divergente + referência ausente (com e sem tentativas) → CURRENCY_MISMATCH', () => {
    const wallet = openWallet('100.00', 'BRL');
    const exhaustedTx = rehydrateTx({
      kind: Refund,
      status: PendingReference,
      money: money('25.00', 'USD'),
      referenceExternalTransactionId: 'ext-missing',
      referenceAttempts: BACKOFF.maxAttempts,
    });

    expect(
      decideWager({
        transaction: exhaustedTx,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.CurrencyMismatch,
    });
  });

  test('#3 vence #9 e #10: referência ausente + referenceAlreadyReversed + sem saldo → AWAIT_REFERENCE ou REFERENCE_NOT_FOUND', () => {
    const wallet = openWallet('0.00');
    const pendingTx = createTx({
      kind: Rollback,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-missing',
    });

    expect(
      decideWager({
        transaction: pendingTx,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({ type: 'AWAIT_REFERENCE' });

    const exhaustedTx = rehydrateTx({
      kind: Rollback,
      status: PendingReference,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-missing',
      referenceAttempts: BACKOFF.maxAttempts,
    });

    expect(
      decideWager({
        transaction: exhaustedTx,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceNotFound,
    });
  });

  test('#4 vence #6, #7, #8, #9 e #10: referência PENDING_REFERENCE com kind/contexto/valor inválidos → AWAIT_REFERENCE (ou #5 REFERENCE_NOT_PROCESSED ao esgotar, D61)', () => {
    const wallet = openWallet('0.00');
    const badPendingRef = rehydrateTx({
      kind: Loss, // inválido para ROLLBACK (#6)
      status: PendingReference, // pendente (#4)
      roundId: 'outra-rodada', // contexto inválido (#7)
      money: money('99.00'), // valor diferente (#8)
    });

    const activeTx = rehydrateTx({
      id: '0192f000-0000-7000-8000-000000000010',
      kind: Rollback,
      status: PendingReference,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
      referenceAttempts: BACKOFF.maxAttempts - 1,
    });

    expect(
      decideWager({
        transaction: activeTx,
        wallet,
        reference: badPendingRef,
        referenceAlreadyReversed: true, // #9
        backoff: BACKOFF,
      }),
    ).toEqual({ type: 'AWAIT_REFERENCE' });

    const exhaustedTx = rehydrateTx({
      id: '0192f000-0000-7000-8000-000000000010',
      kind: Rollback,
      status: PendingReference,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
      referenceAttempts: BACKOFF.maxAttempts,
    });

    expect(
      decideWager({
        transaction: exhaustedTx,
        wallet,
        reference: badPendingRef,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test('#5 vence #6: referência REJECTED + kind inválido (LOSS) → REFERENCE_NOT_PROCESSED', () => {
    const wallet = openWallet('100.00');
    const transaction = createTx({ kind: Refund, referenceExternalTransactionId: 'ext-ref-1' });
    const reference = rehydrateTx({
      kind: Loss,
      status: Rejected,
      roundId: 'outra-rodada',
      money: money('99.00'),
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test('#6 vence #7: referência PROCESSED de kind inválido (WIN em REFUND) + outra rodada → REFERENCE_KIND_NOT_ALLOWED', () => {
    const wallet = openWallet('100.00');
    const transaction = createTx({ kind: Refund, referenceExternalTransactionId: 'ext-ref-1' });
    const reference = rehydrateTx({
      kind: Win,
      status: Processed,
      roundId: 'outra-rodada',
      money: money('99.00'),
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceKindNotAllowed,
    });
  });

  test('#7 vence #8: referência BET PROCESSED de outra rodada + valor diferente → REFERENCE_CONTEXT_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const transaction = createTx({
      kind: Refund,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });
    const reference = rehydrateTx({
      kind: Bet,
      status: Processed,
      roundId: 'outra-rodada',
      money: money('99.00'),
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceContextMismatch,
    });
  });

  test('#8 vence #9: valor diferente + referenceAlreadyReversed = true → REFERENCE_AMOUNT_MISMATCH', () => {
    const wallet = openWallet('0.00');
    const transaction = createTx({
      kind: Rollback,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });
    const reference = rehydrateTx({
      kind: Win,
      status: Processed,
      money: money('30.00'),
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceAmountMismatch,
    });
  });

  test('#9 vence #10: ROLLBACK de WIN já revertido + saldo insuficiente → REFERENCE_ALREADY_REVERSED', () => {
    const wallet = openWallet('0.00');
    const transaction = createTx({
      kind: Rollback,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });
    const reference = rehydrateTx({
      kind: Win,
      status: Processed,
      money: money('25.00'),
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test('todas as regras (#1 a #10) falhando ao mesmo tempo → devolve #1 WALLET_PLAYER_MISMATCH', () => {
    const wallet = openWallet('0.00', 'BRL', 'outro-player');
    const transaction = createTx({
      kind: Rollback,
      playerId: PLAYER_ID,
      money: money('25.00', 'USD'),
      referenceExternalTransactionId: 'ext-ref-1',
    });
    const reference = rehydrateTx({
      kind: Loss,
      status: Rejected,
      walletId: '0192f000-0000-7000-8000-0000000000ff',
      playerId: 'terceiro-player',
      roundId: 'outra-rodada',
      money: money('99.00', 'EUR'),
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference,
        referenceAlreadyReversed: true,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.WalletPlayerMismatch,
    });
  });
});

describe('decideWager — contrato do ciclo de 10 tentativas (D11, D57, D61) e pureza', () => {
  test('ciclo completo de 10 tentativas com scheduleReferenceRetry antes de decideWager (D57) para referência ausente', () => {
    const wallet = openWallet('100.00');
    const transaction = createTx({
      kind: Refund,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-missing',
    });

    // Submissão inicial (PENDING, attempts = 0): decideWager → AWAIT_REFERENCE → markPendingReference
    const initialDecision = decideWager({
      transaction,
      wallet,
      reference: undefined,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });
    expect(initialDecision).toEqual({ type: 'AWAIT_REFERENCE' });
    transaction.markPendingReference(T0, BACKOFF);
    expect(transaction.referenceAttempts).toBe(0);

    // Tentativas 1 a 9 do worker: scheduleReferenceRetry incrementa para 1..9 antes de decideWager
    for (let attempt = 1; attempt < BACKOFF.maxAttempts; attempt += 1) {
      transaction.scheduleReferenceRetry(T1, BACKOFF);
      expect(transaction.referenceAttempts).toBe(attempt);
      expect(
        decideWager({
          transaction,
          wallet,
          reference: undefined,
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        }),
      ).toEqual({ type: 'AWAIT_REFERENCE' });
    }

    // 10ª tentativa: scheduleReferenceRetry leva attempts a 10, e decideWager rejeita imediatamente
    transaction.scheduleReferenceRetry(T1, BACKOFF);
    expect(transaction.referenceAttempts).toBe(10);
    expect(
      decideWager({
        transaction,
        wallet,
        reference: undefined,
        referenceAlreadyReversed: false,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceNotFound,
    });
  });

  test('ciclo completo de 10 tentativas quando a referência permanece PENDING_REFERENCE (D57, D61)', () => {
    const wallet = openWallet('100.00');
    const transaction = createTx({
      kind: Rollback,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-win-pending',
    });
    const pendingWinRef = rehydrateTx({
      kind: Win,
      status: PendingReference,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-bet-missing',
    });

    expect(
      decideWager({
        transaction,
        wallet,
        reference: pendingWinRef,
        referenceAlreadyReversed: false,
        backoff: BACKOFF,
      }),
    ).toEqual({ type: 'AWAIT_REFERENCE' });
    transaction.markPendingReference(T0, BACKOFF);

    for (let attempt = 1; attempt < BACKOFF.maxAttempts; attempt += 1) {
      transaction.scheduleReferenceRetry(T1, BACKOFF);
      expect(
        decideWager({
          transaction,
          wallet,
          reference: pendingWinRef,
          referenceAlreadyReversed: false,
          backoff: BACKOFF,
        }),
      ).toEqual({ type: 'AWAIT_REFERENCE' });
    }

    transaction.scheduleReferenceRetry(T1, BACKOFF);
    expect(transaction.referenceAttempts).toBe(10);
    expect(
      decideWager({
        transaction,
        wallet,
        reference: pendingWinRef,
        referenceAlreadyReversed: false,
        backoff: BACKOFF,
      }),
    ).toEqual({
      type: 'REJECT',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test('decideWager é pura: não muta transaction, wallet nem reference', () => {
    const wallet = openWallet('100.00');
    const reference = rehydrateTx({ kind: Bet, status: Processed, money: money('25.00') });
    const transaction = createTx({
      kind: Refund,
      money: money('25.00'),
      referenceExternalTransactionId: 'ext-ref-1',
    });

    const decision = decideWager({
      transaction,
      wallet,
      reference,
      referenceAlreadyReversed: false,
      backoff: BACKOFF,
    });

    expect(decision).toEqual({ type: 'APPLY', direction: LedgerDirection.Credit });
    expect(wallet.balance.equals(money('100.00'))).toBe(true);
    expect(wallet.version).toBe(1);
    expect(transaction.status).toBe(Pending);
    expect(transaction.balanceAfter).toBeUndefined();
    expect(transaction.referenceTransactionId).toBeUndefined();
    expect(reference.status).toBe(Processed);
  });
});
