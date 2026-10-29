import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão no-op para autenticação (CHALLENGE §2, ARQUITETURA §6, D31).
 * Não implementa validação de credenciais, permitindo integração futura com IdP (Keycloak/Zitadel).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}
