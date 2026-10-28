/**
 * Coordenação das tarefas de docs/EXECUCAO.md entre agentes (Claude Code e Antigravity).
 *
 * A fonte da verdade é docs/TAREFAS.md **na main**. Worktrees compartilham o mesmo
 * `.git`, então toda ferramenta enxerga a mesma main: uma tarefa só conta como
 * terminada depois que o humano a mergeou e marcou `Entregue` lá.
 *
 *   bun scripts/tarefas.ts status
 *   bun scripts/tarefas.ts iniciar T12 [--aqui]
 *   bun scripts/tarefas.ts gate [--tudo]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const CWD = process.cwd();
const BOARD_PATH = 'docs/TAREFAS.md';
const NOTE_TEMPLATE = 'docs/notas/_TEMPLATE.md';
const MAX_ACTIVE = 4;
const MAX_IN_REVIEW = 3;

const ACTIVE = new Set(['Abordagem', 'Implementada']);
const IN_REVIEW = new Set(['Testada', 'Revisada', 'Validada']);

interface Task {
  id: string;
  title: string;
  locked: boolean;
  wave: string;
  lane: string;
  deps: string[];
  state: string;
  branch: string;
  reviewer: string;
}

function git(args: string[], cwd = CWD): { ok: boolean; out: string } {
  const run = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = (run.exitCode === 0 ? run.stdout : run.stderr).toString().trim();
  return { ok: run.exitCode === 0, out };
}

function fail(message: string): never {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/** Lê o quadro da main. Fora dela (antes do primeiro commit do quadro), cai no arquivo local. */
function readBoard(): { tasks: Task[]; source: string } {
  const fromMain = git(['show', `main:${BOARD_PATH}`]);
  const text = fromMain.ok ? fromMain.out : readFileSync(join(CWD, BOARD_PATH), 'utf8');
  const source = fromMain.ok ? `main:${BOARD_PATH}` : `${BOARD_PATH} (local; ainda não está na main)`;

  const tasks: Task[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/^\|\s*T\d{2}\b/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const [name = '', wave = '', lane = '', deps = '', state = '', branch = '', reviewer = ''] = cells;
    const id = name.split(/\s+/)[0] ?? '';
    tasks.push({
      id,
      title: name.slice(id.length).replace('🔒', '').trim(),
      locked: name.includes('🔒'),
      wave,
      lane,
      deps: deps === '—' || deps === '' ? [] : deps.split(',').map((dep) => dep.trim()),
      state,
      branch,
      reviewer,
    });
  }
  if (tasks.length === 0) fail(`nenhuma tarefa encontrada em ${source}`);
  return { tasks, source };
}

function missingDeps(task: Task, byId: Map<string, Task>): string[] {
  return task.deps.filter((dep) => byId.get(dep)?.state !== 'Entregue');
}

function label(task: Task): string {
  return `${task.id} ${task.title}${task.locked ? ' 🔒' : ''}`;
}

// ------------------------------------------------------------------ status

function status(): void {
  const { tasks, source } = readBoard();
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const ready = tasks.filter((t) => t.state === 'Proposta' && missingDeps(t, byId).length === 0);
  const blocked = tasks.filter((t) => t.state === 'Proposta' && missingDeps(t, byId).length > 0);
  const inProgress = tasks.filter((t) => t.state !== 'Proposta' && t.state !== 'Entregue');
  const done = tasks.filter((t) => t.state === 'Entregue');

  console.log(`Quadro: ${source}\n`);
  console.log(`Entregues: ${done.length}/${tasks.length}  ${done.map((t) => t.id).join(' ')}\n`);

  console.log('Liberadas agora:');
  for (const t of ready) console.log(`  ${label(t)}  [raia ${t.lane}, revisor ${t.reviewer}, onda ${t.wave}]`);
  if (ready.length === 0) console.log('  (nenhuma)');

  console.log('\nEm andamento:');
  for (const t of inProgress) {
    const waiting = t.state === 'Abordagem' || t.state === 'Validada' ? '  ← aguardando o humano' : '';
    console.log(`  ${label(t)}  ${t.state}  (${t.branch})${waiting}`);
  }
  if (inProgress.length === 0) console.log('  (nenhuma)');

  console.log('\nBloqueadas:');
  for (const t of blocked) console.log(`  ${label(t)}  falta: ${missingDeps(t, byId).join(', ')}`);
  if (blocked.length === 0) console.log('  (nenhuma)');

  const alerts: string[] = [];
  const active = tasks.filter((t) => ACTIVE.has(t.state)).length;
  const inReview = tasks.filter((t) => IN_REVIEW.has(t.state)).length;
  if (active > MAX_ACTIVE) alerts.push(`${active} tarefas ativas (limite ${MAX_ACTIVE})`);
  if (inReview > MAX_IN_REVIEW) alerts.push(`${inReview} tarefas esperando revisão (limite ${MAX_IN_REVIEW})`);
  for (const t of done) {
    if (t.branch === '—' || !git(['rev-parse', '--verify', '--quiet', t.branch]).ok) continue;
    if (!git(['merge-base', '--is-ancestor', t.branch, 'main']).ok) {
      alerts.push(`${t.id} está Entregue no quadro, mas a branch ${t.branch} não está na main`);
    }
  }
  for (const t of tasks.filter((x) => x.state !== 'Proposta' && x.state !== 'Entregue')) {
    if (t.branch !== '—' && !git(['rev-parse', '--verify', '--quiet', t.branch]).ok) {
      alerts.push(`${t.id} está ${t.state}, mas a branch ${t.branch} não existe`);
    }
  }
  if (alerts.length > 0) console.log(`\nAlertas:\n  ${alerts.join('\n  ')}`);
}

// ------------------------------------------------------------------ iniciar

function noteName(task: Task): string {
  const slug = task.branch.replace(/^t\d{2}-/, '');
  return `docs/notas/${task.id}-${slug}.md`;
}

function createNote(task: Task, root: string): string {
  const path = join(root, noteName(task));
  if (existsSync(path)) return path;
  const template = readFileSync(join(root, NOTE_TEMPLATE), 'utf8');
  const filled = template
    .replace('# TNN — Título', `# ${task.id} — ${task.title}${task.locked ? ' 🔒' : ''}`)
    .replace(
      /> Estado: .*$/m,
      `> Estado: ${task.locked ? 'Abordagem' : 'Implementada'} · Raia: ${task.lane} · Revisor: ${task.reviewer} · Branch: \`${task.branch}\``,
    );
  writeFileSync(path, filled);
  return path;
}

function start(id: string | undefined, here: boolean): void {
  if (!id || !/^T\d{2}$/.test(id)) fail('uso: bun run tarefa:iniciar TNN [--aqui]');
  const { tasks } = readBoard();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const task = byId.get(id) ?? fail(`${id} não está no quadro`);

  if (task.state === 'Entregue') fail(`${id} já está Entregue`);
  if (task.branch === '—') fail(`${id} não tem branch no quadro (tarefa do humano?)`);
  const missing = missingDeps(task, byId);
  if (missing.length > 0) {
    const verb = missing.length === 1 ? 'ainda não está' : 'ainda não estão';
    fail(`${id} depende de ${missing.join(', ')}, que ${verb} Entregue na main. Não comece.`);
  }

  let root: string;
  if (here) {
    const current = git(['branch', '--show-current']).out;
    if (current === 'main') fail('você está na main. Use um worktree próprio ou rode sem --aqui');
    root = git(['rev-parse', '--show-toplevel']).out;
    console.log(`Usando o worktree atual (${root}), branch ${current}.`);
    if (current !== task.branch) {
      console.log(`  Aviso: o quadro espera a branch ${task.branch}. Renomeie: git branch -m ${task.branch}`);
    }
  } else {
    // A raiz do repositório principal, mesmo se este comando rodar dentro de um worktree.
    const commonDir = resolve(CWD, git(['rev-parse', '--git-common-dir']).out);
    const mainRoot = dirname(commonDir);
    root = join(dirname(mainRoot), `wp-${id}`);
    if (existsSync(root)) {
      console.log(`Worktree já existe: ${root}`);
    } else {
      const branchExists = git(['rev-parse', '--verify', '--quiet', task.branch]).ok;
      const args = branchExists
        ? ['worktree', 'add', root, task.branch]
        : ['worktree', 'add', root, '-b', task.branch, 'main'];
      const added = git(args);
      if (!added.ok) fail(`git worktree add falhou: ${added.out}`);
      console.log(`Worktree criado: ${root} (branch ${task.branch})`);
      const install = Bun.spawnSync(['bun', 'install', '--frozen-lockfile'], { cwd: root, stdout: 'inherit', stderr: 'inherit' });
      if (install.exitCode !== 0) fail('bun install falhou no worktree');
    }
  }

  if (!existsSync(join(root, NOTE_TEMPLATE))) fail(`template de nota não encontrado em ${root}`);
  const note = createNote(task, root);

  console.log(`\nNota: ${note}`);
  console.log(`Briefing: linha ${id} em docs/EXECUCAO.md §6, mais os docs citados nela.`);
  console.log(
    task.locked
      ? '\n🔒 Escreva a seção Abordagem da nota e PARE para aprovação do humano antes de codar.'
      : '\nSe a linha da EXECUCAO não lista arquivos, proponha a lista na Abordagem e espere aprovação.',
  );
}

// ------------------------------------------------------------------ gate

const INTEGRATION = /^(src\/(application|infrastructure|interface)\/|migrations\/|test\/(integration|support)\/)/;
const CONCURRENCY =
  /(submit-wager|unit-of-work|wallet-repository|wager-transaction-repository|outbox|inbox|workers\/|interface\/sqs\/|test\/concurrency\/|test\/support\/(app-process|lock-gate))/;

function changedFiles(): string[] {
  const committed = git(['diff', '--name-only', 'main...HEAD']).out.split('\n');
  const pending = git(['status', '--porcelain']).out.split('\n').map((line) => line.slice(3));
  return [...new Set([...committed, ...pending].map((f) => f.trim()).filter(Boolean))];
}

function hasTests(dir: string): boolean {
  const path = join(CWD, dir);
  if (!existsSync(path)) return false;
  const walk = (current: string): boolean =>
    readdirSync(current, { withFileTypes: true }).some((entry) =>
      entry.isDirectory() ? walk(join(current, entry.name)) : entry.name.endsWith('.test.ts'),
    );
  return walk(path);
}

function run(title: string, command: string[]): boolean {
  console.log(`\n▶ ${title}: ${command.join(' ')}`);
  const result = Bun.spawnSync(command, { cwd: CWD, stdout: 'inherit', stderr: 'inherit' });
  return result.exitCode === 0;
}

function gate(all: boolean): void {
  const branch = git(['branch', '--show-current']).out;
  if (branch !== 'main' && !git(['merge-base', '--is-ancestor', 'main', 'HEAD']).ok) {
    fail('a branch não contém a main atual. Rode: git rebase main');
  }

  const files = branch === 'main' ? [] : changedFiles();
  const integration = all || files.some((f) => INTEGRATION.test(f));
  const concurrency = all || files.some((f) => CONCURRENCY.test(f));

  const results: Array<[string, boolean | 'pulado']> = [];
  results.push(['typecheck', run('typecheck', ['bun', 'run', 'typecheck'])]);
  results.push(['skills', run('skills', ['bun', 'scripts/skills-sync.ts', '--check'])]);

  const levels: Array<[name: string, dir: string, wanted: boolean]> = [
    ['unidade', 'test/unit', true],
    ['arquitetura', 'test/architecture', true],
    ['integração', 'test/integration', integration],
    ['concorrência', 'test/concurrency', concurrency],
  ];
  for (const [name, dir, wanted] of levels) {
    if (!wanted) continue;
    if (!hasTests(dir)) {
      results.push([name, 'pulado']);
      continue;
    }
    results.push([name, run(name, ['bun', 'test', `./${dir}`])]);
  }

  if (branch !== 'main') {
    const id = /^t(\d{2})-/.exec(branch)?.[1];
    const noteDir = join(CWD, 'docs', 'notas');
    const hasNote = id !== undefined && existsSync(noteDir) && readdirSync(noteDir).some((f) => f.startsWith(`T${id}-`));
    if (!hasNote) results.push(['nota da tarefa', false]);
  }

  console.log('\nGate:');
  for (const [name, ok] of results) {
    const mark = ok === 'pulado' ? '–' : ok ? '✔' : '✖';
    console.log(`  ${mark} ${name}${ok === 'pulado' ? ' (sem testes ainda)' : ''}`);
  }
  if (results.some(([, ok]) => ok === false)) process.exit(1);
}

// ------------------------------------------------------------------ main

const [command, ...args] = process.argv.slice(2);
switch (command) {
  case 'status':
    status();
    break;
  case 'iniciar':
    start(args.find((arg) => !arg.startsWith('--')), args.includes('--aqui'));
    break;
  case 'gate':
    gate(args.includes('--tudo'));
    break;
  default:
    fail('uso: bun scripts/tarefas.ts status | iniciar TNN [--aqui] | gate [--tudo]');
}

