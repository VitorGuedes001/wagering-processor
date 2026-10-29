import { resolve } from 'node:path';
import { eventually } from './eventually';

const ROOT_DIR = resolve(import.meta.dir, '../..');

export interface AppProcessOptions {
  DB_NAME?: string;
  DB_HOST?: string;
  DB_PORT?: number | string;
  DB_USER?: string;
  DB_PASSWORD?: string;
  DB_LOCK_TIMEOUT_MS?: number | string;
  PORT?: number | string;
  SQS_ENDPOINT?: string;
  SQS_INPUT_QUEUE?: string;
  SQS_DLQ?: string;
  SQS_EVENTS_QUEUE?: string;
  REFERENCE_POLL_MS?: number | string;
  REFERENCE_BACKOFF_BASE_MS?: number | string;
  REFERENCE_MAX_ATTEMPTS?: number | string;
  OUTBOX_POLL_MS?: number | string;
  OUTBOX_BATCH?: number | string;
  OUTBOX_LEASE_MS?: number | string;
  SHUTDOWN_GRACE_MS?: number | string;
  FAULT_POINT?: string;
  ENABLE_HTTP?: boolean | string;
  ENABLE_CONSUMER?: boolean | string;
  ENABLE_OUTBOX_WORKER?: boolean | string;
  ENABLE_REFERENCE_WORKER?: boolean | string;
  [key: string]: string | number | boolean | undefined;
}

export interface AppProcess {
  readonly pid: number;
  readonly port: number;
  readonly url: string;
  readonly exited: Promise<number>;
  kill(signal?: 'SIGKILL' | 'SIGTERM'): Promise<void>;
  logs(): string;
  stop(): Promise<void>;
}

export interface AppCluster {
  readonly apps: AppProcess[];
  readonly urls: string[];
  nextUrl(): string;
  killAll(signal?: 'SIGKILL' | 'SIGTERM'): Promise<void>;
  logs(): string[];
}

/**
 * Sobe uma instância real da aplicação em processo separado via `Bun.spawn` (TESTES D36, §3.2).
 * Por padrão usa `PORT: '0'` para alocação dinâmica de porta pelo SO e aguarda `/health/ready` responder 200.
 */
export async function spawnApp(options: AppProcessOptions = {}): Promise<AppProcess> {
  const stringEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      stringEnv[key] = String(value);
    }
  }

  // PORT='0' por padrão se não informado
  if (!stringEnv.PORT) {
    stringEnv.PORT = '0';
  }

  const mergedEnv = {
    ...process.env,
    ...stringEnv,
  };

  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    cwd: ROOT_DIR,
    env: mergedEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const logsList: string[] = [];
  let capturedPort: number | undefined;
  let resolvePort!: (port: number) => void;
  let rejectPort!: (err: Error) => void;
  const portPromise = new Promise<number>((res, rej) => {
    resolvePort = res;
    rejectPort = rej;
  });

  // Leitura de stdout para capturar linha JSON de listening ou ready e coletar logs
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          logsList.push(trimmed);
          if (capturedPort === undefined) {
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.msg === 'listening' && typeof parsed.port === 'number' && parsed.port > 0) {
                capturedPort = parsed.port;
                resolvePort(parsed.port);
              } else if (parsed.msg === 'ready') {
                capturedPort = 0;
                resolvePort(0);
              }
            } catch {
              // ignora linhas que não são JSON
            }
          }
        }
      }
      if (buffer.trim()) {
        logsList.push(buffer.trim());
      }
    } catch (err) {
      if (capturedPort === undefined) {
        rejectPort(err as Error);
      }
    }
  })();

  // Leitura de stderr
  (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        logsList.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // Ignora erro de leitura no término
    }
  })();

  const port = await Promise.race([
    portPromise,
    proc.exited.then((code) => {
      throw new Error(
        `Processo da aplicação encerrou precocemente com código ${code} antes de abrir porta:\n${logsList.join('\n')}`,
      );
    }),
  ]);

  const url = port > 0 ? `http://127.0.0.1:${port}` : '';

  // Aguarda /health/ready responder 200 quando HTTP está ativo
  if (port > 0) {
    try {
      await eventually(
        async () => {
          const res = await fetch(`${url}/health/ready`);
          if (res.status !== 200) {
            throw new Error(`health/ready retornou ${res.status}`);
          }
        },
        { timeoutMs: 15_000, intervalMs: 50 },
      );
    } catch (err) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignora
      }
      throw new Error(
        `Aplicação não respondeu 200 em /health/ready dentro do timeout:\n${logsList.join('\n')}\nCausa: ${err}`,
      );
    }
  }

  const appInstance: AppProcess = {
    pid: proc.pid,
    port,
    url,
    exited: proc.exited,
    async kill(signal: 'SIGKILL' | 'SIGTERM' = 'SIGTERM'): Promise<void> {
      try {
        proc.kill(signal);
      } catch {
        // já encerrado
      }
      await proc.exited;
    },
    async stop(): Promise<void> {
      return this.kill('SIGTERM');
    },
    logs(): string {
      return logsList.join('\n');
    },
  };

  return appInstance;
}

/**
 * Sobe N instâncias da aplicação em processos separados contra o mesmo banco e filas (TESTES D36, §3.2).
 * Fornece distribuição round-robin via `nextUrl()`.
 */
export async function spawnCluster(
  count: number,
  options: AppProcessOptions = {},
): Promise<AppCluster> {
  const apps = await Promise.all(
    Array.from({ length: count }, () => spawnApp(options)),
  );

  let rr = 0;
  return {
    apps,
    urls: apps.map((a) => a.url),
    nextUrl(): string {
      const url = apps[rr % apps.length]!.url;
      rr += 1;
      return url;
    },
    async killAll(signal: 'SIGKILL' | 'SIGTERM' = 'SIGTERM'): Promise<void> {
      await Promise.all(apps.map((a) => a.kill(signal)));
    },
    logs(): string[] {
      return apps.map((a) => a.logs());
    },
  };
}
