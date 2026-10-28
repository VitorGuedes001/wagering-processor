export interface EventuallyOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Polling curto até `fn` parar de lançar erro ou estourar `timeoutMs` (TESTES D39).
 * Substitui `sleep` em testes assíncronos e de concorrência.
 */
export async function eventually<T>(
  fn: () => T | Promise<T>,
  options: EventuallyOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (Date.now() >= deadline) {
        throw lastError;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
