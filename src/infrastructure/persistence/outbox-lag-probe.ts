import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmOutboxRepository } from './outbox-repository';

/**
 * Lag do outbox para a métrica `wagering_outbox_lag_seconds`.
 * Leitura de observabilidade fora da Unit of Work, como o `ReadinessProbe`: a porta
 * `OutboxRepository` não muda, e o worker chama este provider de infraestrutura
 * direto.
 */
@Injectable()
export class OutboxLagProbe {
  constructor(private readonly orm: MikroORM) {}

  async lagSeconds(now: Date): Promise<number> {
    return new MikroOrmOutboxRepository(this.orm.em.fork()).computeLagSeconds(now);
  }
}
