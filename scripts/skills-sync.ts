/**
 * `.agents/skills/` é a fonte das skills (lida pelo Antigravity).
 * `.claude/skills/` é cópia gerada para o Claude Code. Cópia e não symlink: symlink
 * no Windows depende de modo desenvolvedor e de `core.symlinks` no git.
 *
 *   bun scripts/skills-sync.ts          # copia
 *   bun scripts/skills-sync.ts --check  # só compara; sai 1 se divergir
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
export const SOURCE = join(ROOT, '.agents', 'skills');
export const TARGET = join(ROOT, '.claude', 'skills');

/** Caminhos relativos a `root`, com `/`, ordenados. */
function listRelative(root: string, dir = root): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listRelative(root, path));
    else files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files.sort();
}

/** Diferenças entre fonte e cópia. Lista vazia = sincronizado. */
export function diffSkills(): string[] {
  const source = new Set(listRelative(SOURCE));
  const target = new Set(listRelative(TARGET));
  const problems: string[] = [];
  for (const file of source) {
    if (!target.has(file)) problems.push(`falta em .claude/skills: ${file}`);
    else if (!readFileSync(join(SOURCE, file)).equals(readFileSync(join(TARGET, file)))) {
      problems.push(`conteúdo diferente: ${file}`);
    }
  }
  for (const file of target) {
    if (!source.has(file)) problems.push(`sobrando em .claude/skills: ${file}`);
  }
  return problems;
}

if (import.meta.main) {
  if (process.argv.includes('--check')) {
    const problems = diffSkills();
    if (problems.length > 0) {
      console.error(`Skills fora de sincronia (rode: bun run skills:sync):\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log('skills sincronizadas');
  } else {
    rmSync(TARGET, { recursive: true, force: true });
    cpSync(SOURCE, TARGET, { recursive: true });
    console.log(`skills copiadas: ${listRelative(TARGET).length} arquivo(s)`);
  }
}
