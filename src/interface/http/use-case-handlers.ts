import { randomUUID } from 'node:crypto';
import type {
  CreateWalletCommand,
  CreateWalletOutcome,
  SubmitOutcome,
  WagerCommand,
} from '../../application/contracts';
import type { Clock, IdGenerator, UnitOfWork } from '../../application/ports';
import { CreateWallet, SubmitWagerTransaction } from '../../application/use-cases';

export const CREATE_WALLET_USE_CASE = Symbol('CREATE_WALLET_USE_CASE');
export interface CreateWalletUseCase {
  execute(command: CreateWalletCommand): Promise<CreateWalletOutcome>;
}

export const SUBMIT_WAGER_USE_CASE = Symbol('SUBMIT_WAGER_USE_CASE');
export interface SubmitWagerUseCase {
  execute(command: WagerCommand): Promise<SubmitOutcome>;
}

const defaultClock: Clock = {
  now: () => new Date(),
};

const defaultIdGenerator: IdGenerator = {
  next: () => randomUUID(),
};

/**
 * Handler padrão de criação de wallet delegando ao use case CreateWallet (T30).
 */
export class DefaultCreateWalletHandler implements CreateWalletUseCase {
  private readonly useCase: CreateWallet;

  constructor(
    uow: UnitOfWork,
    clock: Clock = defaultClock,
    idGenerator: IdGenerator = defaultIdGenerator,
  ) {
    this.useCase = new CreateWallet(uow, clock, idGenerator);
  }

  execute(command: CreateWalletCommand): Promise<CreateWalletOutcome> {
    return this.useCase.execute(command);
  }
}

/**
 * Handler padrão de submissão de apostas delegando ao use case SubmitWagerTransaction (T30).
 */
export class DefaultSubmitWagerHandler implements SubmitWagerUseCase {
  private readonly useCase: SubmitWagerTransaction;

  constructor(
    uow: UnitOfWork,
    clock: Clock = defaultClock,
    idGenerator: IdGenerator = defaultIdGenerator,
  ) {
    this.useCase = new SubmitWagerTransaction(uow, clock, idGenerator);
  }

  execute(command: WagerCommand): Promise<SubmitOutcome> {
    return this.useCase.execute(command);
  }
}
