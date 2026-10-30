import type { CallerIdentity, ProviderIdentityPort } from '../application/ports';

/** Token da porta `ProviderIdentityPort`. */
export const PROVIDER_IDENTITY = Symbol('PROVIDER_IDENTITY');

/**
 * Sem autenticação: aceita qualquer chamador. Com um IdP, a troca é aqui:
 * lançar quando `caller.providerId` diverge do `providerId` do payload (403).
 */
export class AcceptAllProviderIdentity implements ProviderIdentityPort {
  assertMaySubmit(_caller: CallerIdentity, _providerId: string): void {}
}
