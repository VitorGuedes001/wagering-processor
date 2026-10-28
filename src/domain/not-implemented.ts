/**
 * Corpo provisório dos contratos do M0. Cada stub diz qual tarefa o implementa e
 * falha alto, para nenhum teste passar por acidente. Some no M1.
 *
 * Os argumentos extras só existem para `noUnusedParameters`/`noUnusedLocals`
 * aceitarem assinaturas ainda sem corpo.
 */
export function notImplemented(task: string, ..._used: unknown[]): never {
  throw new Error(`Não implementado: ${task}`);
}
