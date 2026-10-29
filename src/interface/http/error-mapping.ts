import {
  type ArgumentsHost,
  type ExceptionFilter,
  Catch,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import {
  type CreateWalletOutcome,
  RequestErrorCode,
  type SubmitOutcome,
} from '../../application/contracts';
import { TransientInfrastructureError } from '../../application/ports';
import { InvalidMoneyError, InvalidWagerRequestError } from '../../domain/errors';
import type { HttpResponse } from './types';

export interface ErrorResponseBody {
  code: string;
  message: string;
  details?: unknown[];
}

/**
 * Filtro global de exceções HTTP (ARQUITETURA §6.2).
 * Garante que qualquer erro na borda segue o contrato:
 * `{ "code": "...", "message": "...", "details"?: [...] }`
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<HttpResponse>();

    // 1. Erro de validação Zod -> 400 INVALID_PAYLOAD
    if (typeof exception === 'object' && exception !== null && 'issues' in exception) {
      const issues = (exception as { issues: Array<{ path: Array<string | number>; message: string }> }).issues;
      const body: ErrorResponseBody = {
        code: RequestErrorCode.InvalidPayload,
        message: 'Payload inválido',
        details: issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
      return response.status(HttpStatus.BAD_REQUEST).json(body);
    }

    // 2. Erros de validação de domínio (Money, regras de create) -> 400 INVALID_PAYLOAD
    if (exception instanceof InvalidMoneyError || exception instanceof InvalidWagerRequestError) {
      const body: ErrorResponseBody = {
        code: RequestErrorCode.InvalidPayload,
        message: exception.message,
      };
      return response.status(HttpStatus.BAD_REQUEST).json(body);
    }

    // 3. Falha transitória de infraestrutura (lock_timeout, conexão) -> 503 SERVICE_UNAVAILABLE + Retry-After
    if (exception instanceof TransientInfrastructureError) {
      response.setHeader('Retry-After', '1');
      const body: ErrorResponseBody = {
        code: RequestErrorCode.ServiceUnavailable,
        message: exception.message,
      };
      return response.status(HttpStatus.SERVICE_UNAVAILABLE).json(body);
    }

    // 4. HttpException nativa do Nest
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'object' && res !== null && 'code' in res) {
        return response.status(status).json(res);
      }
      const message =
        typeof res === 'object' && res !== null && 'message' in res
          ? Array.isArray((res as { message: unknown }).message)
            ? ((res as { message: unknown[] }).message.join(', ') as string)
            : String((res as { message: unknown }).message)
          : exception.message;

      const code =
        status === HttpStatus.NOT_FOUND
          ? RequestErrorCode.WalletNotFound
          : status === HttpStatus.BAD_REQUEST
            ? RequestErrorCode.InvalidPayload
            : status === HttpStatus.CONFLICT
              ? RequestErrorCode.IdempotencyConflict
              : RequestErrorCode.InternalError;

      const body: ErrorResponseBody = { code, message };
      return response.status(status).json(body);
    }

    // 5. Bug / Erro inesperado -> 500 INTERNAL_ERROR
    const error = exception instanceof Error ? exception : new Error(String(exception));
    const body: ErrorResponseBody = {
      code: RequestErrorCode.InternalError,
      message: error.message || 'Erro interno do servidor',
    };
    return response.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }
}

/**
 * Mapeia o SubmitOutcome do use case para o status HTTP e formato exato de ARQUITETURA §6.2.
 */
export function mapSubmitOutcomeToResponse(outcome: SubmitOutcome, res: HttpResponse) {
  switch (outcome.type) {
    case 'RESULT': {
      const { view, idempotentReplay } = outcome;
      if (idempotentReplay) {
        res.setHeader('X-Idempotent-Replay', 'true');
      }
      const responseBody = {
        transactionId: view.transactionId,
        status: view.status,
        balance: view.balance,
        ...(view.failureCode ? { failureCode: view.failureCode } : {}),
        idempotentReplay,
      };

      if (view.status === 'PROCESSED') {
        return res.status(HttpStatus.OK).json(responseBody);
      }
      if (view.status === 'PENDING_REFERENCE') {
        return res.status(HttpStatus.ACCEPTED).json(responseBody);
      }
      if (view.status === 'REJECTED') {
        return res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(responseBody);
      }
      return res.status(HttpStatus.OK).json(responseBody);
    }
    case 'IDEMPOTENCY_CONFLICT':
      return res.status(HttpStatus.CONFLICT).json({
        code: RequestErrorCode.IdempotencyConflict,
        message: 'Idempotency key already used with different payload',
      });
    case 'EXTERNAL_ID_CONFLICT':
      return res.status(HttpStatus.CONFLICT).json({
        code: RequestErrorCode.ExternalIdConflict,
        message: 'External transaction ID already used with different idempotency key',
      });
    case 'WALLET_NOT_FOUND':
      return res.status(HttpStatus.NOT_FOUND).json({
        code: RequestErrorCode.WalletNotFound,
        message: 'Wallet not found',
      });
    case 'DUPLICATE_MESSAGE':
    case 'MESSAGE_PAYLOAD_MISMATCH':
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        code: RequestErrorCode.InternalError,
        message: 'Inbox outcome received in HTTP channel',
      });
  }
}

/**
 * Mapeia o CreateWalletOutcome para o status HTTP e formato de CHALLENGE §9.
 */
export function mapCreateWalletOutcomeToResponse(outcome: CreateWalletOutcome, res: HttpResponse) {
  switch (outcome.type) {
    case 'CREATED':
      return res.status(HttpStatus.CREATED).json(outcome.view);
    case 'WALLET_ALREADY_EXISTS':
      return res.status(HttpStatus.CONFLICT).json({
        code: RequestErrorCode.WalletAlreadyExists,
        message: 'Wallet already exists for this player and currency',
      });
  }
}
