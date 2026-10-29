import { z } from 'zod';

/** Regex de formato monetário decimal estrito (MODELAGEM 2.1). */
const AMOUNT_REGEX = /^(0|[1-9]\d*)\.(\d{2})$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;

/**
 * Schema monetário na borda (CHALLENGE §6.1, restrição 5.1).
 * `amount` DEVE ser string decimal. Rejeita `number` imediatamente.
 */
export const moneySchema = z.object({
  amount: z
    .string({ message: 'amount precisa ser uma string decimal' })
    .regex(AMOUNT_REGEX, { message: 'amount deve estar no formato 0.00' }),
  currency: z
    .string({ message: 'currency precisa ser uma string' })
    .regex(CURRENCY_REGEX, { message: 'currency deve ser código ISO-4217 de 3 letras maiúsculas' }),
});

export const createWalletSchema = z.object({
  playerId: z.string().uuid({ message: 'playerId deve ser um UUID válido' }),
  initialBalance: moneySchema,
});

export type CreateWalletInput = z.infer<typeof createWalletSchema>;

export const wagerTransactionSchema = z.object({
  providerId: z.string().min(1, { message: 'providerId não pode ser vazio' }),
  externalTransactionId: z.string().min(1, { message: 'externalTransactionId não pode ser vazio' }),
  playerId: z.string().uuid({ message: 'playerId deve ser um UUID válido' }),
  walletId: z.string().uuid({ message: 'walletId deve ser um UUID válido' }),
  roundId: z.string().min(1, { message: 'roundId não pode ser vazio' }),
  gameId: z.string().min(1, { message: 'gameId não pode ser vazio' }),
  kind: z.enum(['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: z.string().min(1).optional(),
});

export type WagerTransactionInput = z.infer<typeof wagerTransactionSchema>;

export const idempotencyKeyHeaderSchema = z
  .string({ message: 'Idempotency-Key é obrigatório' })
  .min(1, { message: 'Idempotency-Key não pode ser vazio' })
  .max(256, { message: 'Idempotency-Key não pode ter mais de 256 caracteres' });

export const getLedgerQuerySchema = z.object({
  afterVersion: z.coerce.number().int({ message: 'afterVersion deve ser inteiro' }).min(0, { message: 'afterVersion deve ser >= 0' }).optional(),
  cursor: z.union([z.coerce.number().int().min(0), z.string()]).optional(),
  limit: z.coerce.number().int({ message: 'limit deve ser inteiro' }).min(1, { message: 'limit deve ser no mínimo 1' }).max(200, { message: 'limit deve ser no máximo 200' }).default(50),
});

export type GetLedgerQueryInput = z.infer<typeof getLedgerQuerySchema>;
