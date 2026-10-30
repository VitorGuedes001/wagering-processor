import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { HttpRequest } from './types';

/**
 * Ponto de extensão no-op para autenticação.
 * Anexa um chamador sem `providerId`. Com um IdP, validaria o JWT pelo JWKS e
 * preencheria `providerId` com o `azp` do token.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    req.caller = { providerId: undefined };
    return true;
  }
}
