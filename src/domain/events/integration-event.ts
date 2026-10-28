import { notImplemented } from '../not-implemented';

/**
 * O que o use case fornece para montar um evento. O `eventId` vem daqui porque o
 * domínio não gera id (D44): quem emite dois eventos chama o `IdGenerator` duas vezes.
 */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Envelope serializado, gravado no `payload` da outbox e publicado como está. */
export interface IntegrationEventJson<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601. */
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope de evento de integração (CHALLENGE §11). Cada evento é uma subclasse
 * concreta: `eventType` e `version` vivem no tipo, nunca numa string no call site.
 * `data` carrega `MoneyProps` e datas ISO, nunca `Money` nem `Date`.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventJson<T> {
    return notImplemented('T13');
  }
}
