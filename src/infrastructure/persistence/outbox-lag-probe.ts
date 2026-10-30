import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmOutboxRepository } from './outbox-repository';

/**
 * Lag do outbox para a métrica `wagering_outbox_lag_seconds` (SCHEMA 4.6; ARQUITETURA §9).
 * Leitura de observabilidade fora da Unit of Work, como o `ReadinessProbe`: a porta
 * `OutboxRepository` não muda, e o worker chama este provider de infraestrutura
 * direto (D74).
 */
@Injectable()
export class OutboxLagProbe {
  constructor(private readonly orm: MikroORM) {}

  async lagSeconds(now: Date): Promise<number> {
    return new MikroOrmOutboxRepository(this.orm.em.fork()).computeLagSeconds(now);
  }
}
