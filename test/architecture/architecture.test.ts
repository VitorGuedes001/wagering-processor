import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT_DIR = resolve(import.meta.dir, '../..');
const SRC_DIR = join(ROOT_DIR, 'src');

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

/**
 * Remove comentários de bloco e de linha preservando quebras de linha, mas
 * preservando strings literais simples/duplas/template básicas para não apagar
 * `http://` ou caminhos de import.
 */
function stripComments(source: string, ignoreMarker?: string): string {
  // Primeiro, se uma linha inteira tem o marcador de exceção, esvazia a linha.
  const prefiltered = ignoreMarker
    ? source
        .split(/\r?\n/)
        .map((line) => (line.includes(ignoreMarker) ? '' : line))
        .join('\n')
    : source;

  let out = '';
  let i = 0;
  const len = prefiltered.length;

  while (i < len) {
    const ch = prefiltered[i];
    const next = prefiltered[i + 1];

    // Comentário de linha
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && prefiltered[i] !== '\n') i++;
      continue;
    }

    // Comentário de bloco
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(prefiltered[i] === '*' && prefiltered[i + 1] === '/')) {
        if (prefiltered[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    // Strings simples, duplas ou template
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i++;
      while (i < len) {
        const c = prefiltered[i]!;
        out += c;
        i++;
        if (c === '\\' && i < len) {
          out += prefiltered[i]!;
          i++;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

export function extractImports(source: string): string[] {
  const clean = stripComments(source);
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

export function scanMoneyGuardViolations(source: string, fileLabel = 'inline.ts'): string[] {
  const clean = stripComments(source, 'guard-ignore-5.1');
  const lines = clean.split(/\r?\n/);
  const violations: string[] = [];

  const rules: Array<{ name: string; regex: RegExp }> = [
    { name: 'parseFloat', regex: /\bparseFloat\b/ },
    { name: 'Number(', regex: /\bNumber\s*\(/ },
    { name: '.toFixed', regex: /\.toFixed\b/ },
    { name: 'Math.', regex: /\bMath\s*\./ },
    {
      name: 'number em propriedade monetária (amount | balance* | money)',
      regex: /\b(?:amount|money|balance[A-Za-z0-9_]*)\s*\??\s*:\s*number\b/,
    },
  ];

  lines.forEach((line, idx) => {
    for (const rule of rules) {
      if (rule.regex.test(line)) {
        violations.push(`${fileLabel}:${idx + 1} viola [${rule.name}]: ${line.trim()}`);
      }
    }
  });

  return violations;
}

describe('Arquitetura e Guardas Estáticas (ARQUITETURA §2 e §8)', () => {
  test('A-01: src/domain não importa Nest, MikroORM, AWS SDK, zod nem outras camadas', () => {
    const domainDir = join(SRC_DIR, 'domain');
    const files = listTsFiles(domainDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
      const imports = extractImports(readFileSync(file, 'utf8'));

      for (const spec of imports) {
        if (
          spec.startsWith('@nestjs/') ||
          spec.startsWith('@mikro-orm/') ||
          spec.startsWith('@aws-sdk/') ||
          spec === 'zod' ||
          spec.startsWith('zod/')
        ) {
          violations.push(`${rel} importa pacote proibido no domínio: "${spec}"`);
          continue;
        }

        const targetLayer = resolveLayerOfImport(file, spec);
        if (targetLayer !== undefined && targetLayer !== 'domain') {
          violations.push(`${rel} importa fora de src/domain (${targetLayer}): "${spec}"`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('A-02: src/application, src/infrastructure e src/interface respeitam as fronteiras de camada (ARQUITETURA §2)', () => {
    const violations: string[] = [];

    // 1. src/application: pode importar domain; não pode importar MikroORM, AWS SDK, zod, infrastructure, interface,
    // nem @nestjs/* exceto @Injectable/@Module em eventual *.module.ts.
    const appFiles = listTsFiles(join(SRC_DIR, 'application'));
    expect(appFiles.length).toBeGreaterThan(0);

    for (const file of appFiles) {
      const rel = relative(ROOT_DIR, file).replaceAll('\\', '/');
      const source = readFileSync(file, 'utf8');
      const imports = extractImports(source);
      const isModuleFile = file.endsWith('.module.ts');

      for (const spec of imports) {
        if (
          spec.startsWith('@mikro-orm/') ||
          spec.startsWith('@aws-sdk/') ||
          spec === 'zod' ||
          spec.startsWith('zod/')
        ) {
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

  test('A-03 (auto-teste do scanner): detecta cada proibição da guarda 5.1 e respeita comentários e guard-ignore-5.1', () => {
    expect(scanMoneyGuardViolations('const x = parseFloat("10.00");')).toHaveLength(1);
    expect(scanMoneyGuardViolations('const x = Number(rawAmount);')).toHaveLength(1);
    expect(scanMoneyGuardViolations('const s = val.toFixed(2);')).toHaveLength(1);
    expect(scanMoneyGuardViolations('const r = Math.round(v);')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { amount: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { balance: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { balanceAfter?: number; }')).toHaveLength(1);
    expect(scanMoneyGuardViolations('interface Bad { money: number; }')).toHaveLength(1);

    // Comentários de linha, de bloco e guard-ignore-5.1 não devem disparar falso positivo
    const safeSample = `
      // parseFloat Number( .toFixed Math.floor amount: number
      /*
        balance: number
        money: number
        Math.abs(1)
      */
      const version: number = 1;
      const walletVersion: number = 2;
      const allowed = Number(envPort); // guard-ignore-5.1
    `;
    expect(scanMoneyGuardViolations(safeSample)).toEqual([]);
  });
});
