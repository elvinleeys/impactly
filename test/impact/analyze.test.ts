import { afterEach, describe, expect, it } from 'vitest';
import { resolveLimits } from '../../src/core/limits.js';
import type { ImpactCandidate, Limits } from '../../src/core/types.js';
import { collectDiff } from '../../src/git/collect.js';
import { analyzeImpact } from '../../src/impact/analyze.js';
import { createRepo, type TestRepo } from '../helpers/repo.js';

let repo: TestRepo | undefined;
afterEach(() => repo?.cleanup());

const APP = {
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
  'package.json': '{ "name": "app" }',
  'src/theme.ts': 'export const color = "red";\n',
  'src/Button.tsx': "import { color } from './theme';\nexport const Button = () => color;\n",
  'src/index.ts': "export * from './Button';\n",
  'app/page.tsx': "import { Button } from '@/index';\nimport '@/styles.css';\nexport default Button;\n",
  'app/about/page.tsx': "import React from 'react';\nexport default () => null;\n",
  'src/styles.css': 'body { color: red }\n',
  'src/i18n.ts': 'export const load = (lang: string) => import(`./locales/${lang}.json`);\n',
  'src/locales/en.json': '{ "hi": "hi" }\n',
  'test/Button.test.tsx': "import { Button } from '../src/Button';\n",
};

async function analyze(changes: (r: TestRepo) => void, limits: Partial<Limits> = {}) {
  repo = createRepo();
  repo.write(APP);
  const base = repo.commit('base');
  changes(repo);
  const head = repo.commit('head');
  const resolved = resolveLimits(limits);
  const diff = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits: resolved });
  if (!diff.data) throw new Error(`diff failed: ${diff.reason ?? ''}`);
  return analyzeImpact({ cwd: repo.dir, diff: diff.data, limits: resolved });
}

const summary = (candidates: ImpactCandidate[] = []) => candidates.map((c) => `${c.certainty}:${c.reason}:${c.path}`);

describe('analyzeImpact (integration)', () => {
  it('follows relative imports, barrel re-exports and path aliases', async () => {
    const result = await analyze((r) => { r.write({ 'src/theme.ts': 'export const color = "blue";\n' }); });
    expect(result.status).toBe('ok');
    expect(summary(result.data?.candidates)).toEqual([
      'confirmed:changed:src/theme.ts',
      'confirmed:imports-changed:src/Button.tsx',
      'possible:transitive:src/index.ts',
      'possible:transitive:test/Button.test.tsx',
      'possible:transitive:app/page.tsx',
    ]);
    const page = result.data?.candidates.find((c) => c.path === 'app/page.tsx');
    expect(page?.via).toEqual(['app/page.tsx', 'src/index.ts', 'src/Button.tsx', 'src/theme.ts']);
    expect(result.evidence.some((e) => e.detail.includes('tsconfig.json (1 path aliases)'))).toBe(true);
  });

  it('reports importers of a deleted file as confirmed imports-deleted', async () => {
    const result = await analyze((r) => { r.remove('src/theme.ts'); });
    expect(summary(result.data?.candidates).slice(0, 2)).toEqual([
      'confirmed:changed:src/theme.ts',
      'confirmed:imports-deleted:src/Button.tsx',
    ]);
  });

  it('tracks both paths of a rename: importers of the old path may break', async () => {
    const result = await analyze((r) => {
      r.git('mv', 'src/theme.ts', 'src/colors.ts');
    });
    const candidates = summary(result.data?.candidates);
    expect(candidates).toContain('confirmed:changed:src/colors.ts');
    expect(candidates).toContain('confirmed:imports-deleted:src/Button.tsx');
    expect(candidates).not.toContain('confirmed:changed:src/theme.ts');
  });

  it('links stylesheets imported by code and marks files with matching dynamic imports as unknown', async () => {
    const result = await analyze((r) => { r.write({ 'src/styles.css': 'body { color: blue }\n', 'src/locales/en.json': '{ "hi": "hello" }\n' }); },
    );
    const candidates = summary(result.data?.candidates);
    expect(candidates).toContain('confirmed:changed:src/styles.css');
    expect(candidates).toContain('confirmed:imports-changed:app/page.tsx');
    expect(candidates).toContain('unknown:non-code-change:src/locales/en.json');
    expect(candidates).toContain('unknown:dynamic-import:src/i18n.ts');
  });

  it('marks config changes as unknown scope and reports unresolved imports in changed files', async () => {
    const result = await analyze((r) => { r.write({ 'package.json': '{ "name": "app", "version": "2" }', 'app/about/page.tsx': "import x from './missing';\n" }); },
    );
    expect(summary(result.data?.candidates)).toEqual(['confirmed:changed:app/about/page.tsx', 'unknown:config-change:package.json']);
    expect(result.evidence.some((e) => e.detail.includes('app/about/page.tsx: Relative import "./missing"'))).toBe(true);
    expect(result.data?.stats.unresolvedSpecifiers).toBe(1);
  });

  it('marks the section truncated when the depth limit cuts the search short', async () => {
    const result = await analyze((r) => { r.write({ 'src/theme.ts': 'export const color = 1;\n' }); }, { maxDepth: 1 });
    expect(result.status).toBe('truncated');
    expect(result.reason).toContain('beyond depth 1');
    expect(summary(result.data?.candidates)).toEqual(['confirmed:changed:src/theme.ts', 'confirmed:imports-changed:src/Button.tsx']);
  });

  it('parses changed files first when maxGraphNodes truncates the graph', async () => {
    const result = await analyze((r) => { r.write({ 'src/theme.ts': 'export const color = 2;\n' }); }, { maxGraphNodes: 2 });
    expect(result.status).toBe('truncated');
    expect(result.data?.stats.analyzedFiles).toBe(2);
    expect(result.data?.stats.skippedFiles).toBe(5);
  });

  it('skips oversized source files and records it', async () => {
    const result = await analyze((r) => { r.write({ 'src/huge.ts': `export const x = "${'x'.repeat(2048)}";\n` }); }, { maxFileBytes: 1024 });
    expect(result.evidence.some((e) => e.detail.includes('over 1024 bytes'))).toBe(true);
    expect(result.data?.stats.skippedFiles).toBe(1);
  });

  it('does not follow symlinks committed to the repository', async () => {
    const result = await analyze((r) => {
      // A symlink whose target points outside the repository. With core.symlinks=false the
      // working file holds the target text and git keeps the symlink mode from the index.
      const target = '../../../outside/secret.ts';
      r.write({ 'src/escape.ts': target });
      const linkOid = r.git('hash-object', '-w', '--', 'src/escape.ts').trim();
      r.git('update-index', '--add', '--cacheinfo', `120000,${linkOid},src/escape.ts`);
      r.write({ 'src/theme.ts': "import './escape';\nexport const color = 3;\n" });
    });
    expect(repo?.git('ls-tree', 'HEAD', 'src/escape.ts')).toMatch(/^120000 /);
    expect(result.status).toBe('ok');
    expect(result.evidence.some((e) => e.detail.includes('symlinks/submodules were not followed'))).toBe(true);
    expect(summary(result.data?.candidates)).not.toContain('confirmed:imports-changed:src/escape.ts');
  });
});
