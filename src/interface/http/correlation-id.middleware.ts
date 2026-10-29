import { type NestMiddleware, Injectable } from '@nestjs/common';
import { generateUuidV7 } from '../../infrastructure/id-generator';
import { runWithRequestContext } from '../../infrastructure/observability/request-context';
import type { HttpRequest, HttpResponse } from './types';

/** Propaga ou gera o `X-Correlation-Id` e abre o contexto da requisição (ARQUITETURA §6.1, D29). */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: HttpRequest, res: HttpResponse, next: () => void) {
    const rawHeader = req.headers['x-correlation-id'];
    const correlationId =
      typeof rawHeader === 'string' && rawHeader.trim().length > 0 ? rawHeader.trim() : generateUuidV7();

    res.setHeader('X-Correlation-Id', correlationId);
    req.correlationId = correlationId;

    runWithRequestContext({ correlationId }, () => {
      next();
    });
  }
}
