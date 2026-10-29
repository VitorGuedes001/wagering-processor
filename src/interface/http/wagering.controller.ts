import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { RequestErrorCode } from '../../application/contracts';
import type { ProviderIdentityPort } from '../../application/ports';
import { ApplicationTransactionQueries, type TransactionQueriesPort } from '../../application/queries';
import { SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import type { SubmittableKind } from '../../domain/wager-transaction';
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
  ) {}

  /**
   * Submete uma aposta financeira (CHALLENGE §9, ARQUITETURA §6).
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

    // Ponto de extensão da auth (D31): hoje aceita tudo.
    this.providerIdentity.assertMaySubmit(req.caller ?? { providerId: undefined }, validated.providerId);

    const correlationId = req.correlationId || getCorrelationId() || '';

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

    return mapSubmitOutcomeToResponse(outcome, res);
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
