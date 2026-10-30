import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { RequestErrorCode, type SubmitOutcome } from '../../application/contracts';
import type { ProviderIdentityPort } from '../../application/ports';
import { ApplicationTransactionQueries, type TransactionQueriesPort } from '../../application/queries';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { type SubmittableKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import { MetricsRegistry } from '../../infrastructure/observability/metrics';
import { getCorrelationId } from '../../infrastructure/observability/request-context';
import { PROVIDER_IDENTITY } from '../../infrastructure/provider-identity';
import { AuthGuard } from './auth.guard';
import { HttpErrorFilter, mapSubmitOutcomeToResponse } from './error-mapping';
import { idempotencyKeyHeaderSchema, wagerTransactionSchema } from './schemas';
import type { HttpRequest, HttpResponse } from './types';

@Controller()
@UseGuards(AuthGuard)
@UseFilters(HttpErrorFilter)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction)
    private readonly submitWagerUseCase: Pick<SubmitWagerTransaction, 'execute'>,
    @Inject(ApplicationTransactionQueries)
    private readonly transactionQueries: TransactionQueriesPort,
    @Inject(PROVIDER_IDENTITY)
    private readonly providerIdentity: ProviderIdentityPort,
    @Optional()
    @Inject(MetricsRegistry)
    private readonly metrics?: MetricsRegistry,
  ) {}

  /**
   * Submete uma aposta financeira.
   * Aceita tanto `/wagering/transactions` quanto `/wagers/v1`.
   */
  @Post(['wagering/transactions', 'wagers/v1'])
  async submitWager(
    @Body() rawBody: unknown,
    @Headers('idempotency-key') rawIdempotencyKey: unknown,
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ) {
    const idempotencyKey = idempotencyKeyHeaderSchema.parse(rawIdempotencyKey);
    const validated = wagerTransactionSchema.parse(rawBody);

    // Ponto de extensão da auth: hoje aceita tudo.
    this.providerIdentity.assertMaySubmit(req.caller ?? { providerId: undefined }, validated.providerId);

    const correlationId = req.correlationId || getCorrelationId() || '';

    const startedAt = performance.now();
    const outcome = await this.submitWagerUseCase.execute({
      providerId: validated.providerId,
      externalTransactionId: validated.externalTransactionId,
      idempotencyKey,
      playerId: validated.playerId,
      walletId: validated.walletId,
      roundId: validated.roundId,
      gameId: validated.gameId,
      kind: validated.kind as SubmittableKind,
      money: validated.money,
      referenceExternalTransactionId: validated.referenceExternalTransactionId,
      correlationId,
    });
    this.countOutcome(outcome, validated.kind);
    this.metrics?.processingDurationSeconds.observe({ entry: 'http' }, (performance.now() - startedAt) / 1000);

    return mapSubmitOutcomeToResponse(outcome, res);
  }

  /** Mesma contagem do consumidor SQS, com `source="http"` no replay. */
  private countOutcome(outcome: SubmitOutcome, kind: string): void {
    if (!this.metrics || outcome.type !== 'RESULT') return;
    if (outcome.idempotentReplay) {
      this.metrics.duplicatesTotal.inc({ source: 'http' });
      return;
    }
    this.metrics.transactionsTotal.inc({ kind, status: outcome.view.status });
    if (outcome.view.status === WagerTransactionStatus.Rejected && outcome.view.failureCode) {
      this.metrics.transactionsRejectedTotal.inc({ reason: outcome.view.failureCode });
    }
  }

  @Get('wagering/transactions/:transactionId')
  async getTransactionById(@Param('transactionId') transactionId: string, @Res() res: HttpResponse) {
    const tx = await this.transactionQueries.findById(transactionId);
    if (!tx) {
      return res.status(HttpStatus.NOT_FOUND).json({
        code: RequestErrorCode.TransactionNotFound,
        message: 'Transaction not found',
      });
    }
    return res.status(HttpStatus.OK).json(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Res() res: HttpResponse,
  ) {
    const tx = await this.transactionQueries.findByExternalId(providerId, externalTransactionId);
    if (!tx) {
      return res.status(HttpStatus.NOT_FOUND).json({
        code: RequestErrorCode.TransactionNotFound,
        message: 'Transaction not found',
      });
    }
    return res.status(HttpStatus.OK).json(tx);
  }
}
