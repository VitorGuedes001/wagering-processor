import { randomUUID } from 'node:crypto';
import type { AppCluster } from './app-process';

export interface HttpRequestOptions {
  idempotencyKey?: string;
  correlationId?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

function resolveUrl(target: string | AppCluster, path: string): string {
  const base = typeof target === 'string' ? target : target.nextUrl();
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

async function parseResponseBody(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Envia uma requisição HTTP POST para criar wallet (`POST /wallets`).
 */
export async function createWallet(
  target: string | AppCluster,
  payload: unknown,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const url = resolveUrl(target, '/wallets');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.correlationId ? { 'X-Correlation-Id': options.correlationId } : {}),
    ...options.headers,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });

  const body = await parseResponseBody(res);
  return { status: res.status, body, headers: res.headers };
}

/**
 * Envia uma requisição HTTP POST de transação (`POST /wagering/transactions`).
 * Inclui obrigatoriamente o header `Idempotency-Key`.
 */
export async function postTransaction(
  target: string | AppCluster,
  payload: any,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const url = resolveUrl(target, '/wagering/transactions');
  const idempotencyKey =
    options.idempotencyKey ??
    payload?.idempotencyKey ??
    (payload?.providerId && payload?.externalTransactionId
      ? `${payload.providerId}:${payload.externalTransactionId}`
      : randomUUID());

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    'X-Correlation-Id': options.correlationId ?? randomUUID(),
    ...options.headers,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });

  const body = await parseResponseBody(res);
  return { status: res.status, body, headers: res.headers };
}

/**
 * Consulta wallet por id (`GET /wallets/:id`).
 */
export async function getWallet(
  target: string | AppCluster,
  walletId: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse> {
  const url = resolveUrl(target, `/wallets/${walletId}`);
  const headers: Record<string, string> = {
    ...(options.correlationId ? { 'X-Correlation-Id': options.correlationId } : {}),
    ...options.headers,
  };

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
  });

  const body = await parseResponseBody(res);
  return { status: res.status, body, headers: res.headers };
}
