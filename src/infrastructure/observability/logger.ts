import { Injectable, Optional, type LoggerService } from '@nestjs/common';
import { getRequestContext } from './request-context';

const FORBIDDEN_KEY_PATTERN = /^(amount|balance|balancebefore|balanceafter|money)$/i;

/**
 * Sanitiza objetos recursivamente para garantir que nenhuma chave com quantia monetária
 * ou saldo seja emitida nos logs (restrição inviolável 5.1 e I-23).
 */
export function sanitizeLogData(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
      stack: value.stack ? sanitizeString(value.stack) : undefined,
    };
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogData(item));
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      continue;
    }
    result[key] = sanitizeLogData(val);
  }
  return result;
}

function sanitizeString(str: string): string {
  return str
    .replace(/"amount"\s*:\s*"[^"]*"/gi, '"amount":"[REDACTED]"')
    .replace(/"amount"\s*:\s*[0-9.]+/gi, '"amount":"[REDACTED]"')
    .replace(/amount\s*=\s*\S+/gi, 'amount=[REDACTED]');
}

export type LogWriter = (line: string) => void;

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  kind?: string;
  status?: string;
  failureCode?: string;
  context?: string;
  [key: string]: unknown;
}

@Injectable()
export class AppLogger implements LoggerService {
  private writer: LogWriter;

  constructor(@Optional() writer?: LogWriter) {
    this.writer = writer ?? ((line: string) => console.log(line));
  }

  setWriter(writer: LogWriter): void {
    this.writer = writer;
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.writeEntry('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.writeEntry('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.writeEntry('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.writeEntry('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.writeEntry('verbose', message, optionalParams);
  }

  private writeEntry(level: string, rawMessage: unknown, optionalParams: unknown[]): void {
    const alsContext = getRequestContext() ?? {};
    let messageText = '';
    let nestContext: string | undefined;
    const extraMeta: Record<string, unknown> = {};

    if (typeof rawMessage === 'string') {
      messageText = rawMessage;
    } else if (rawMessage instanceof Error) {
      messageText = rawMessage.message;
      extraMeta.error = sanitizeLogData(rawMessage);
    } else if (typeof rawMessage === 'object' && rawMessage !== null) {
      const sanitized = sanitizeLogData(rawMessage) as Record<string, unknown>;
      messageText = typeof sanitized.message === 'string' ? sanitized.message : JSON.stringify(sanitized);
      Object.assign(extraMeta, sanitized);
    } else {
      messageText = String(rawMessage);
    }

    for (const param of optionalParams) {
      if (typeof param === 'string') {
        nestContext = param;
      } else if (param instanceof Error) {
        extraMeta.error = sanitizeLogData(param);
      } else if (typeof param === 'object' && param !== null) {
        Object.assign(extraMeta, sanitizeLogData(param) as Record<string, unknown>);
      }
    }

    const mergedData = { ...alsContext, ...extraMeta };
    const sanitizedData = sanitizeLogData(mergedData) as Record<string, unknown>;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizeString(messageText),
      ...sanitizedData,
    };

    if (nestContext && !entry.context) {
      entry.context = nestContext;
    }

    // Garante que nenhum campo de quantia monetária exista no payload final
    for (const key of Object.keys(entry)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        delete entry[key];
      }
    }

    this.writer(JSON.stringify(entry));
  }
}
