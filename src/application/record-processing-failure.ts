import type { WagerCommand } from './contracts';
import type { Clock, IdGenerator, UnitOfWork } from './ports';
import { UniqueViolationError } from './ports';
import { FailureCode } from '../domain/failure-code';
import { Money } from '../domain/money';
import { payloadHash } from '../domain/payload-hash';
import { WagerTransaction } from '../domain/wager-transaction';

export type RecordProcessingFailureResult = 'RECORDED' | 'ALREADY_EXISTS' | 'SKIPPED';

/**
 * Grava `FAILED`/`PROCESSING_FAILED` para uma mensagem na última entrega antes
 * da DLQ (SCHEMA 4.4, MODELAGEM 10.1). Decisão DP-3 da T40:
 *
 * - transação própria, porque a financeira já deu rollback;
 * - só quando o comando é válido e a falha foi transitória ou bug;
 * - não grava se a `(providerId, idempotencyKey)` ou o id externo já existem,
 *   nem se a wallet não existe ou tem outra moeda (a transação não teria onde
 *   ficar). Assim o provedor que reenviar recebe replay `FAILED`;
 * - sem evento no outbox: MODELAGEM 8 não define evento para `FAILED`.
 *
 * O HTTP nunca chama este use case: lá a falha transitória é 503.
 */
export class RecordProcessingFailure {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  async execute(command: WagerCommand): Promise<RecordProcessingFailureResult> {
    const money = Money.from(command.money);
    const hash = payloadHash({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      playerId: command.playerId,
      walletId: command.walletId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
    });

    try {
      return await this.uow.run(async (tx) => {
        const byKey = await tx.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
        if (byKey) return 'ALREADY_EXISTS';
        const byExternal = await tx.transactions.findByExternalId(
          command.providerId,
          command.externalTransactionId,
        );
        if (byExternal) return 'ALREADY_EXISTS';

        const wallet = await tx.wallets.findById(command.walletId);
        if (!wallet || wallet.currency !== money.currency) return 'SKIPPED';

        const now = this.clock.now();
        const transaction = WagerTransaction.create({
          id: this.idGenerator.next(),
          providerId: command.providerId,
          externalTransactionId: command.externalTransactionId,
          idempotencyKey: command.idempotencyKey,
          payloadHash: hash,
          walletId: command.walletId,
          playerId: command.playerId,
          roundId: command.roundId,
          gameId: command.gameId,
          kind: command.kind,
          money,
          referenceExternalTransactionId: command.referenceExternalTransactionId,
          at: now,
        });
        transaction.fail(FailureCode.ProcessingFailed, now);
        await tx.transactions.insert(transaction);
        return 'RECORDED';
      });
    } catch (error) {
      // Corrida com outra entrega que gravou primeiro: o efeito já existe.
      if (
        error instanceof UniqueViolationError &&
        (error.constraint === 'wager_tx_idempotency_uq' || error.constraint === 'wager_tx_external_uq')
      ) {
        return 'ALREADY_EXISTS';
      }
      throw error;
    }
  }
}
