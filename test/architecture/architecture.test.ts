import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const SRC_DIR = join(ROOT_DIR, 'src');

const EXEMPTION_COMMENT_RE = /guard-ignore-5\.1|n[aã]o\s+[eé]\s+caminho\s+de\s+dinheiro/i;

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results.sort();
}

interface StripCommentsResult {
  clean: string;
  exemptedLines: Set<number>;
}

/**
 * Remove comentários de bloco e de linha preservando quebras de linha e strings
 * literais, e identifica linhas isentas por comentário explícito de exceção da
 * guarda 5.1 (ARQUITETURA §8: `guard-ignore-5.1` ou `não é caminho de dinheiro`),
 * tanto inline na própria linha quanto em comentário/JSDoc imediatamente acima
 * de uma declaração ou função.
 */
function stripCommentsWithExemptions(source: string, trackExemptions = false): StripCommentsResult {
  const exemptedLines = new Set<number>();
  let out = '';
  let i = 0;
  let line = 1;
  let hasCodeOnCurrentLine = false;
  let pendingExemption = false;
  let exemptionBraceDepth = 0;
  let inExemptedBlock = false;
  const len = source.length;

  while (i < len) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '\n') {
      out += '\n';
      line++;
      hasCodeOnCurrentLine = false;
      i++;
      continue;
    }

    // Comentário de linha
    if (ch === '/' && next === '/') {
      const commentLine = line;
      const hadCode = hasCodeOnCurrentLine;
      i += 2;
      let commentText = '';
      while (i < len && source[i] !== '\n') {
        commentText += source[i];
        i++;
      }
      if (trackExemptions && EXEMPTION_COMMENT_RE.test(commentText)) {
        if (hadCode) {
          exemptedLines.add(commentLine);
        } else {
          pendingExemption = true;
        }
      }
      continue;
    }

    // Comentário de bloco
    if (ch === '/' && next === '*') {
      const startLine = line;
      const hadCode = hasCodeOnCurrentLine;
      i += 2;
      let commentText = '';
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') {
          out += '\n';
          line++;
          hasCodeOnCurrentLine = false;
        }
        commentText += source[i];
        i++;
      }
      i += 2;
      if (trackExemptions && EXEMPTION_COMMENT_RE.test(commentText)) {
        if (hadCode) {
          for (let l = startLine; l <= line; l++) exemptedLines.add(l);
        } else {
          pendingExemption = true;
        }
      }
      continue;
    }

    // Strings simples, duplas ou template
    if (ch === "'" || ch === '"' || ch === '`') {
      hasCodeOnCurrentLine = true;
      if (pendingExemption || inExemptedBlock) {
        exemptedLines.add(line);
      }
      const quote = ch;
      out += ch;
      i++;
      while (i < len) {
        const c = source[i]!;
        if (c === '\n') {
          line++;
          if (pendingExemption || inExemptedBlock) {
            exemptedLines.add(line);
          }
        }
        out += c;
        i++;
        if (c === '\\' && i < len) {
          if (source[i] === '\n') line++;
          out += source[i]!;
          i++;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
      hasCodeOnCurrentLine = true;
      if (pendingExemption) {
        exemptedLines.add(line);
        if (ch === '{') {
          inExemptedBlock = true;
          exemptionBraceDepth = 1;
          pendingExemption = false;
        } else if (ch === ';') {
          pendingExemption = false;
        }
      } else if (inExemptedBlock) {
        exemptedLines.add(line);
        if (ch === '{') {
          exemptionBraceDepth++;
        } else if (ch === '}') {
          exemptionBraceDepth--;
          if (exemptionBraceDepth <= 0) {
            inExemptedBlock = false;
          }
        }
      }
    }

    out += ch;
    i++;
  }

  return { clean: out, exemptedLines };
}

export function extractImports(source: string): string[] {
  const { clean } = stripCommentsWithExemptions(source, false);
  const specifiers: string[] = [];

  const staticRe = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const match of clean.matchAll(staticRe)) {
    if (match[1]) specifiers.push(match[1]);
  }
  for (const match of clean.matchAll(dynamicRe)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function resolveLayerOfImport(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith('@/')) {
    const rest = specifier.slice(2);
    return rest.split('/')[0];
  }
  if (specifier.startsWith('.')) {
    const resolved = resolve(dirname(fromFile), specifier);
    const relToSrc = relative(SRC_DIR, resolved);
    if (relToSrc.startsWith('..')) return 'outside-src';
    const firstSegment = relToSrc.split(sep)[0];
    return firstSegment;
  }
  return undefined;
}

/**
 * Lista branca de imports permitidos em `src/domain` (ARQUITETURA §2):
 * apenas caminhos relativos dentro do próprio `src/domain` e `node:*`.
 */
export function isAllowedDomainImport(fromFile: string, specifier: string): boolean {
  if (specifier.startsWith('node:')) {
    return true;
  }
  if (specifier.startsWith('.')) {
    return resolveLayerOfImport(fromFile, specifier) === 'domain';
  }
  return false;
}

export function scanMoneyGuardViolations(source: string, fileLabel = 'inline.ts'): string[] {
  const { clean, exemptedLines } = stripCommentsWithExemptions(source, true);
  const lines = clean.split(/\r?\n/);
  const violations: string[] = [];

  const rules: Array<{ name: string; regex: RegExp }> = [
    { name: 'parseFloat', regex: /\bparseFloat\b/ },
    { name: 'Number(', regex: /\bNumber\s*\(/ },
    { name: '.toFixed', regex: /\.toFixed\b/ },
    { name: 'Math.', regex: /\bMath\s*\./ },
    {
      name: 'number em propriedade monetária (*amount* | *balance* | *money*)',
      regex: /\b[A-Za-z0-9_]*(?:amount|balance|money)[A-Za-z0-9_]*\s*[?!]?\s*:\s*[^;=,\n)}]*\bnumber\b/i,
    },
  ];

  lines.forEach((line, idx) => {
    const lineNumber = idx + 1;
    if (exemptedLines.has(lineNumber)) return;
    for (const rule of rules) {
      if (rule.regex.test(line)) {
        violations.push(`${fileLabel}:${lineNumber} viola [${rule.name}]: ${line.trim()}`);
      }
    }
  });

  return violations;
}

describe('Arquitetura e Guardas Estáticas (ARQUITETURA §2 e §8)', () => {
  test('A-01: src/domain usa lista branca de imports — só caminhos relativos dentro de src/domain e node:*', () => {
    const domainDir = join(SRC_DIR, 'domain');
    const files = listTsFiles(domainDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
      const imports = extractImports(readFileSync(file, 'utf8'));

      for (const spec of imports) {
        if (!isAllowedDomainImport(file, spec)) {
          violations.push(
            `${rel} importa fora da lista branca de src/domain (apenas relativos internos e node:*): "${spec}"`,
          );
        }
      }
    }

    expect(violations).toEqual([]);

    // Auto-teste da lista branca de A-01
    const sampleDomainFile = join(domainDir, 'money.ts');
    expect(isAllowedDomainImport(sampleDomainFile, './errors')).toBe(true);
    expect(isAllowedDomainImport(sampleDomainFile, './events/integration-event')).toBe(true);
    expect(isAllowedDomainImport(sampleDomainFile, 'node:crypto')).toBe(true);
    expect(isAllowedDomainImport(sampleDomainFile, 'decimal.js')).toBe(false);
    expect(isAllowedDomainImport(sampleDomainFile, 'zod')).toBe(false);
    expect(isAllowedDomainImport(sampleDomainFile, '@nestjs/common')).toBe(false);
    expect(isAllowedDomainImport(sampleDomainFile, '@mikro-orm/core')).toBe(false);
    expect(isAllowedDomainImport(sampleDomainFile, '@aws-sdk/client-sqs')).toBe(false);
    expect(isAllowedDomainImport(sampleDomainFile, '../application/ports')).toBe(false);
    expect(isAllowedDomainImport(sampleDomainFile, '@/domain/errors')).toBe(false);
  });

  test('A-02: src/application, src/infrastructure e src/interface respeitam as fronteiras de camada (ARQUITETURA §2)', () => {
    const violations: string[] = [];

    // 1. src/application: pode importar domain; não pode importar MikroORM, AWS SDK, infrastructure, interface,
    // nem @nestjs/* exceto @Injectable/@Module em eventual *.module.ts.
    const appFiles = listTsFiles(join(SRC_DIR, 'application'));
    expect(appFiles.length).toBeGreaterThan(0);

    for (const file of appFiles) {
      const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
      const source = readFileSync(file, 'utf8');
      const imports = extractImports(source);
      const isModuleFile = file.endsWith('.module.ts');

      for (const spec of imports) {
        if (spec.startsWith('@mikro-orm/') || spec.startsWith('@aws-sdk/')) {
          violations.push(`${rel} importa pacote proibido em application: "${spec}"`);
          continue;
        }

        if (spec.startsWith('@nestjs/')) {
          if (!isModuleFile || spec !== '@nestjs/common') {
            violations.push(`${rel} importa "${spec}" fora de módulo de composição`);
          }
          continue;
        }

        const targetLayer = resolveLayerOfImport(file, spec);
        if (targetLayer !== undefined && targetLayer !== 'domain' && targetLayer !== 'application') {
          violations.push(`${rel} importa camada proibida (${targetLayer}): "${spec}"`);
        }
      }
    }

    // 2. src/infrastructure: não pode importar interface.
    const infraFiles = listTsFiles(join(SRC_DIR, 'infrastructure'));
    for (const file of infraFiles) {
      const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
      const imports = extractImports(readFileSync(file, 'utf8'));

      for (const spec of imports) {
        const targetLayer = resolveLayerOfImport(file, spec);
        if (targetLayer === 'interface') {
          violations.push(`${rel} (infrastructure) importa interface: "${spec}"`);
        }
      }
    }

    // 3. src/interface: não pode importar @mikro-orm/* nem @aws-sdk/* diretamente.
    const interfaceFiles = listTsFiles(join(SRC_DIR, 'interface'));
    for (const file of interfaceFiles) {
      const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
      const imports = extractImports(readFileSync(file, 'utf8'));

      for (const spec of imports) {
        if (spec.startsWith('@mikro-orm/') || spec.startsWith('@aws-sdk/')) {
          violations.push(`${rel} (interface) importa adaptador diretamente: "${spec}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('A-03: guarda 5.1 — sem parseFloat, Number(, .toFixed, Math. ou number monetário em domain e persistence', () => {
    const domainFiles = listTsFiles(join(SRC_DIR, 'domain'));
    const persistenceFiles = listTsFiles(join(SRC_DIR, 'infrastructure', 'persistence'));
    const files = [...domainFiles, ...persistenceFiles];
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
      const source = readFileSync(file, 'utf8');
      violations.push(...scanMoneyGuardViolations(source, rel));
    }

    expect(violations).toEqual([]);
  });

  test('A-03 (auto-teste do scanner): detecta amostras positivas (incluindo !:, union e prefixo/sufixo) e aceita amostras negativas', () => {
    // Amostras positivas: funções/operadores de float
    expect(scanMoneyGuardViolations('const x = parseFloat("10.00");')).toHaveLength(1);
    expect(scanMoneyGuardViolations('const x = Number(rawAmount);')).toHaveLength(1);
    expect(scanMoneyGuardViolations('const s = val.toFixed(2);')).toHaveLength(1);
    expect(scanMoneyGuardViolations('const r = Math.round(v);')).toHaveLength(1);

    // Amostras positivas: propriedades monetárias com `:`, `?:`, `!:`, union e prefixos/sufixos
    expect(scanMoneyGuardViolations('interface Bad { amount: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { balance: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { money: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('class BadRecord { amount!: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('class BadRecord { balance!: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('class BadRecord { money!: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { amount: string | number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { amount: bigint | number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { balance?: number | undefined; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { balanceAfter: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { balanceAfter?: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { balanceBefore!: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { totalAmount: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { openingBalance: string | number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { amountCents: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { initialMoney!: number; }')).toHaveLength(1);

    // Amostras negativas: tipos permitidos (string, bigint, Money), outras propriedades numéricas na mesma linha,
    // comentários e exceção explícita documentada (ARQUITETURA §8)
    const safeSample = `
      // parseFloat Number( .toFixed Math.floor amount: number balance!: number
      /*
        balance: number
        money: number
        totalAmount: string | number
        Math.abs(1)
      */
      interface GoodProps {
        amount: string;
        balance: string;
        balanceAfter?: string;
        totalAmount: bigint;
        openingBalance: Money;
        money: MoneyProps;
      }
      class GoodRecord {
        amount!: string;
        balance!: string;
        balanceBefore!: string;
        balanceAfter?: string | null;
        version!: number;
        walletVersion!: number;
        referenceAttempts!: number;
      }
      interface SameLineDifferentProp { amount: string; version: number; }
      function check(totalAmount: string, count: number): void {}
      const allowed = Number(envPort); // guard-ignore-5.1
      /** Não é caminho de dinheiro, então number vale. */
      function backoff(baseMs: number, attempts: number, maxMs: number): number {
        return Math.min(baseMs * 2 ** attempts, maxMs);
      }
    `;
    expect(scanMoneyGuardViolations(safeSample)).toEqual([]);
  });
});
