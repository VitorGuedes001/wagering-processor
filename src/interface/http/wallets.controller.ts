import {
  Body,
  Controller,
  Get,
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
import { CreateWallet } from '../../application/create-wallet';
import { ApplicationWalletQueries, type WalletQueriesPort } from '../../application/queries';
import { getCorrelationId } from '../../infrastructure/observability/request-context';
import { AuthGuard } from './auth.guard';
import { HttpErrorFilter, mapCreateWalletOutcomeToResponse } from './error-mapping';
import { createWalletSchema } from './schemas';
import type { HttpRequest, HttpResponse } from './types';

@Controller('wallets')
@UseGuards(AuthGuard)
@UseFilters(HttpErrorFilter)
export class WalletsController {
  constructor(
    @Inject(CreateWallet)
    private readonly createWalletUseCase: Pick<CreateWallet, 'execute'>,
    @Inject(ApplicationWalletQueries)
    private readonly walletQueries: WalletQueriesPort,
  ) {}

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
