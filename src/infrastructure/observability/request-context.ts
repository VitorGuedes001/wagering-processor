import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de uma requisição ou mensagem (ARQUITETURA §9, D29). Um único store
 * para quem grava (middleware HTTP, consumidor SQS) e quem lê (logger).
 */
export interface RequestContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  kind?: string;
  status?: string;
  failureCode?: string;
  [key: string]: unknown;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/** Roda `fn` com o contexto atual somado a `context`. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  const parent = requestContextStorage.getStore();
  const merged: RequestContext = { ...parent, ...context };
  return requestContextStorage.run(merged, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/** Acrescenta campos ao contexto atual. Fora de um contexto, não faz nada. */
export function updateRequestContext(fields: Partial<RequestContext>): void {
  const store = requestContextStorage.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}

export function getCorrelationId(): string | undefined {
  return requestContextStorage.getStore()?.correlationId;
}
