import { Inject, Injectable, type NestMiddleware, Optional } from '@nestjs/common';
import { MetricsRegistry } from '../../infrastructure/observability/metrics';

/** O pedaço do Express que a métrica lê: a rota casada, não a URL crua. */
interface RoutedRequest {
  method: string;
  baseUrl?: string;
  route?: { path?: unknown };
}

interface FinishingResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): unknown;
}

/** Rota sem casamento (404) vira um rótulo só, para não criar uma série por URL. */
const UNMATCHED_ROUTE = 'unmatched';

function routeOf(req: RoutedRequest): string {
  const path = req.route?.path;
  return typeof path === 'string' ? `${req.baseUrl ?? ''}${path}` : UNMATCHED_ROUTE;
}

/**
 * `wagering_http_requests_total` e `wagering_http_request_duration_seconds` por
 * método, rota e status. Mede no `finish`, depois do filtro de
 * erros, então o status é o que o cliente recebeu.
 */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(@Optional() @Inject(MetricsRegistry) private readonly metrics?: MetricsRegistry) {}

  use(req: RoutedRequest, res: FinishingResponse, next: () => void) {
    const metrics = this.metrics;
    if (!metrics) return next();

    const startedAt = performance.now();
    res.on('finish', () => {
      const labels = { method: req.method, path: routeOf(req), status: String(res.statusCode) };
      metrics.httpRequestsTotal.inc(labels);
      metrics.httpRequestDurationSeconds.observe(labels, (performance.now() - startedAt) / 1000);
    });
    next();
  }
}
