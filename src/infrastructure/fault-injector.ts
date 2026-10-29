/**
 * Injetor de falhas em pontos nomeados de teste (TESTES D38, §3.4, §6).
 * Se `process.env.FAULT_POINT === point`, encerra o processo imediatamente com `SIGKILL`.
 * Fora de teste, a variável não existe e o custo de execução é uma checagem de string/undefined.
 */
export const FaultPoint = {
  ConsumerAfterCommitBeforeAck: 'consumer.after-commit-before-ack',
  OutboxAfterClaimBeforePublish: 'outbox.after-claim-before-publish',
  OutboxAfterPublishBeforeMark: 'outbox.after-publish-before-mark',
  HttpAfterCommitBeforeResponse: 'http.after-commit-before-response',
  UowBeforeCommit: 'uow.before-commit',
} as const;

export type FaultPointName = (typeof FaultPoint)[keyof typeof FaultPoint] | string;

export class FaultInjector {
  /**
   * Dispara o ponto de falha. Se ativo na variável de ambiente FAULT_POINT,
   * encerra o processo imediatamente com SIGKILL (TerminateProcess no Windows).
   */
  static hit(point: FaultPointName): void {
    if (process.env.FAULT_POINT !== undefined && process.env.FAULT_POINT === point) {
      process.kill(process.pid, 'SIGKILL');
    }
  }
}
