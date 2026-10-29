import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { RequestErrorCode } from '../../application/contracts';
import { CreateWallet } from '../../application/create-wallet';
import { ApplicationWalletQueries, type WalletQueriesPort } from '../../application/queries';
import { ReconcileWallet } from '../../application/reconcile-wallet';
import { AppLogger } from '../../infrastructure/observability/logger';
import { defaultMetricsRegistry, MetricsRegistry } from '../../infrastructure/observability/metrics';
import { getCorrelationId } from '../../infrastructure/observability/request-context';
import { AuthGuard } from './auth.guard';
import { HttpErrorFilter, mapCreateWalletOutcomeToResponse } from './error-mapping';
import { createWalletSchema, getLedgerQuerySchema } from './schemas';
import type { HttpRequest, HttpResponse } from './types';

@Controller('wallets')
@UseGuards(AuthGuard)
@UseFilters(HttpErrorFilter)
export class WalletsController {
  private readonly logger: AppLogger;
  private readonly metricsRegistry: MetricsRegistry;

  constructor(
    @Inject(CreateWallet)
    private readonly createWalletUseCase: Pick<CreateWallet, 'execute'>,
    @Inject(ApplicationWalletQueries)
    private readonly walletQueries: WalletQueriesPort,
    @Inject(ReconcileWallet)
    private readonly reconcileWalletUseCase: ReconcileWallet,
    @Optional() @Inject(AppLogger) logger?: AppLogger,
    @Optional() @Inject(MetricsRegistry) metricsRegistry?: MetricsRegistry,
  ) {
    this.logger = logger ?? new AppLogger();
    this.metricsRegistry = metricsRegistry ?? defaultMetricsRegistry;
  }

  @Post()
  async createWallet(@Body() rawBody: unknown, @Req() req: HttpRequest, @Res() res: HttpResponse) {
    const validated = createWalletSchema.parse(rawBody);
    const correlationId = req.correlationId || getCorrelationId() || '';

    const outcome = await this.createWalletUseCase.execute({
      playerId: validated.playerId,
      initialBalance: validated.initialBalance,
      correlationId,
    });

    return mapCreateWalletOutcomeToResponse(outcome, res);
  }

  @Get(':id/ledger')
  async getLedger(
    @Param('id') id: string,
    @Query() rawQuery: unknown,
    @Res() res: HttpResponse,
  ) {
    const validated = getLedgerQuerySchema.parse(rawQuery);
    let afterVersion = 0;
    if (validated.afterVersion !== undefined) {
      afterVersion = validated.afterVersion;
    } else if (validated.cursor !== undefined) {
      if (typeof validated.cursor === 'number') {
        afterVersion = validated.cursor;
      } else {
        const num = Number(validated.cursor);
        if (!Number.isNaN(num) && Number.isInteger(num) && num >= 0) {
          afterVersion = num;
        } else {
          try {
            const decoded = JSON.parse(Buffer.from(validated.cursor, 'base64url').toString('utf8'));
            if (typeof decoded?.v === 'number' && Number.isInteger(decoded.v) && decoded.v >= 0) {
              afterVersion = decoded.v;
            }
          } catch {
            // ignore non-json base64
          }
        }
      }
    }

    const page = await this.walletQueries.getLedger(id, afterVersion, validated.limit);
    if (!page) {
      return res.status(HttpStatus.NOT_FOUND).json({
        code: RequestErrorCode.WalletNotFound,
        message: 'Wallet not found',
      });
    }

    return res.status(HttpStatus.OK).json(page);
  }

  @Post(':id/reconciliation')
  async reconcileWallet(
    @Param('id') id: string,
    @Res() res: HttpResponse,
  ) {
    const outcome = await this.reconcileWalletUseCase.execute(id);
    if (!outcome) {
      return res.status(HttpStatus.NOT_FOUND).json({
        code: RequestErrorCode.WalletNotFound,
        message: 'Wallet not found',
      });
    }

    if (!outcome.consistent) {
      this.metricsRegistry.reconciliationMismatchTotal.inc();
      this.logger.warn({
        message: 'Reconciliation mismatch detected',
        walletId: outcome.walletId,
        consistent: false,
        chainIntact: outcome.chainIntact,
        checkedEntries: outcome.checkedEntries,
      });
    }

    return res.status(HttpStatus.OK).json({
      walletId: outcome.walletId,
      storedBalance: outcome.storedBalance,
      calculatedBalance: outcome.calculatedBalance,
      difference: outcome.difference,
      consistent: outcome.consistent,
      checkedEntries: outcome.checkedEntries,
    });
  }

  @Get(':id')
  async getWallet(@Param('id') id: string, @Res() res: HttpResponse) {
    const wallet = await this.walletQueries.findById(id);
    if (!wallet) {
      return res.status(HttpStatus.NOT_FOUND).json({
        code: RequestErrorCode.WalletNotFound,
        message: 'Wallet not found',
      });
    }
    return res.status(HttpStatus.OK).json(wallet);
  }
}
