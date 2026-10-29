import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TxRepositories, UnitOfWork } from '../../application/ports';
import type { AppConfig } from '../config';
import { FaultInjector, FaultPoint } from '../fault-injector';
import { translateDbError } from './db-errors';

/** Monta cada repositório ligado ao `EntityManager` da transação. Composto no `PersistenceModule`. */
export type RepositoryFactories = { [K in keyof TxRepositories]: (em: EntityManager) => TxRepositories[K] };

/** D21: uma transação travada não segura o lock de uma wallet para sempre. */
const STATEMENT_TIMEOUT = '5s';
const IDLE_IN_TRANSACTION_TIMEOUT = '10s';

/**
 * Unit of Work explícita (D25): o que está dentro da transação é o que roda
 * dentro de `work`. Cada chamada usa um `EntityManager` próprio, sem
 * `AsyncLocalStorage`.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly config: Pick<AppConfig, 'DB_LOCK_TIMEOUT_MS'>,
    private readonly factories: RepositoryFactories,
  ) {}

  /** `READ COMMITTED` (D15) com os `SET LOCAL` de D21 antes de qualquer outra query. */
  run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T> {
    return this.transaction(
      async (em) => {
        await em.execute(
          `select set_config('lock_timeout', ?, true),
                  set_config('statement_timeout', ?, true),
                  set_config('idle_in_transaction_session_timeout', ?, true)`,
          [`${this.config.DB_LOCK_TIMEOUT_MS}ms`, STATEMENT_TIMEOUT, IDLE_IN_TRANSACTION_TIMEOUT],
        );
        const result = await work(this.repositories(em));
        FaultInjector.hit(FaultPoint.UowBeforeCommit);
        return result;
      },
      { isolationLevel: IsolationLevel.READ_COMMITTED },
    );
  }

  /**
   * Wallet e ledger do mesmo snapshot, sem lock (D22). Escrita falha com `25006`.
   * Sem `lock_timeout`, porque não trava nada, mas com os outros dois de D21: um
   * snapshot parado seguraria a conexão e o horizonte de limpeza do Postgres.
   */
  readSnapshot<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T> {
    return this.transaction(
      async (em) => {
        await em.execute(
          `select set_config('statement_timeout', ?, true),
                  set_config('idle_in_transaction_session_timeout', ?, true)`,
          [STATEMENT_TIMEOUT, IDLE_IN_TRANSACTION_TIMEOUT],
        );
        return work(this.repositories(em));
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }

  /**
   * A tradução envolve o `work` **e o COMMIT**: os triggers deferred (D53) só
   * falham no commit, e são as garantias mais fortes do schema.
   */
  private async transaction<T>(
    work: (em: EntityManager) => Promise<T>,
    options: { isolationLevel: IsolationLevel; readOnly?: boolean },
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(work, options);
    } catch (error) {
      throw translateDbError(error);
    }
  }

  private repositories(em: EntityManager): TxRepositories {
    return {
      wallets: this.factories.wallets(em),
      transactions: this.factories.transactions(em),
      ledger: this.factories.ledger(em),
      inbox: this.factories.inbox(em),
      outbox: this.factories.outbox(em),
    };
  }
}
