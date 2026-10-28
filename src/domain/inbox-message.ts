import { notImplemented } from './not-implemented';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  /** Hash de negócio do comando (`payloadHash`), para detectar mesmo `messageId` com payload diferente (D7). */
  payloadHash: string;
  at: Date;
}

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/**
 * Registro de deduplicação do consumidor, chave `(consumerName, messageId)`.
 * Gravado na mesma transação SQL do processamento (§6.5). Rejeição de negócio
 * também fica `processed`: o desfecho está na transação.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return notImplemented('T13', props);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return notImplemented('T13', state);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return notImplemented('T13');
  }

  markProcessed(at: Date): void {
    notImplemented('T13', at);
  }
}
