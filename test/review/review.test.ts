import { afterEach, describe, expect, it } from 'vitest';
import { resolveLimits } from '../../src/core/limits.js';
import type { ChangedFile, DiffData, ImpactData } from '../../src/core/types.js';
import { collectDiff } from '../../src/git/collect.js';
import { analyzeImpact } from '../../src/impact/analyze.js';
import { runReview } from '../../src/review/review.js';
import { addedLineNumbers, isTestFile, onLines, reviewFindings } from '../../src/review/rules.js';
import { scanCode, type CodeSignals } from '../../src/review/scan.js';
import { createRepo, type TestRepo } from '../helpers/repo.js';

let repo: TestRepo | undefined;
afterEach(() => repo?.cleanup());

const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  change: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
  hunks: [],
  ...extra,
});
const diffOf = (files: ChangedFile[]): DiffData => ({
  base: 'a'.repeat(40),
  head: 'b'.repeat(40),
  diffBase: 'a'.repeat(40),
  files,
  totals: {
    files: files.length,
    additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
    deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
  },
});
const impactOf = (partial: Partial<ImpactData>): ImpactData => ({
  candidates: [],
  unresolved: [],
  stats: { analyzedFiles: 0, skippedFiles: 0, edges: 0, unresolvedSpecifiers: 0 },
  ...partial,
});
const none: CodeSignals = { debugger: [], consoleLog: [], anyType: [], todo: [] };

describe('addedLineNumbers / onLines', () => {
  it('takes the head-side lines of each hunk and keeps only signals on them', () => {
    const lines = addedLineNumbers([
      { oldStart: 1, oldLines: 0, newStart: 2, newLines: 2 },
      { oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 0 },
    ]);
    expect([...lines]).toEqual([2, 3, 5]);
    expect(onLines({ debugger: [1, 2], consoleLog: [5], anyType: [4], todo: [3, 9] }, lines)).toEqual({
      debugger: [2],
      consoleLog: [5],
      anyType: [],
      todo: [3],
    });
  });
});

describe('scanCode', () => {
  it('finds debugger statements, console calls, any types and TODO comments as real code', () => {
    const source = [
      'debugger;', // 1
      'console.log(x); console.debug(y);', // 2
      'const a: any = 1;', // 3
      'const b = c as any;', // 4
      '// TODO: remove', // 5
      '/**', // 6
      ' * FIXME later', // 7
      ' */', // 8
      'function f() { debugger }', // 9
    ].join('\n');
    expect(scanCode('a.ts', source)).toEqual({ debugger: [1, 9], consoleLog: [2, 2], anyType: [3, 4], todo: [5, 7] });
  });

  it('ignores the same words in strings, regular expressions, JSX text and comments that only mention them', () => {
    const source = [
      "const s = 'debugger; console.log(1); const x: any';",
      'const r = /:\\s*any|console\\.log\\(|\\/\\/ TODO/;',
      '/** Added TODO/FIXME comments are reported. */',
      'const t = `// TODO ${"any"}`;',
      'const anyThing = myconsole.log(1);',
      'logger.console.log(2);',
    ].join('\n');
    expect(scanCode('a.ts', source)).toEqual(none);
    expect(scanCode('a.tsx', 'export const C = () => <p>debugger console.log(1) TODO</p>;\n')).toEqual(none);
  });
});

describe('isTestFile', () => {
  it.each(['src/a.test.ts', 'src/a.spec.tsx', 'src/__tests__/a.ts', 'tests/a.ts', 'e2e/login.ts', 'test/helpers/repo.ts'])('%s is a test', (p) => {
    expect(isTestFile(p)).toBe(true);
  });
  it.each(['src/testing.ts', 'src/contest/a.ts', 'src/latest.ts'])('%s is not a test', (p) => {
    expect(isTestFile(p)).toBe(false);
  });
});

describe('reviewFindings', () => {
  it('flags importers of deleted files and unresolved imports as must-fix facts', () => {
    const findings = reviewFindings({
      diff: diffOf([file('src/gone.ts', { change: 'deleted' }), file('src/test/a.test.ts')]),
      impact: impactOf({
        candidates: [{ path: 'src/app.ts', certainty: 'confirmed', reason: 'imports-deleted', depth: 1, via: ['src/app.ts', 'src/gone.ts'] }],
        unresolved: [{ file: 'src/app.ts', specifier: './missing' }],
      }),
      signals: new Map(),
    });
    expect(findings).toEqual([
      { rule: 'deleted-still-imported', file: 'src/app.ts', related: ['src/gone.ts'] },
      { rule: 'unresolved-import', file: 'src/app.ts', specifier: './missing' },
    ]);
  });

  it('turns code signals into findings with the first line and a count, skipping tests for logs and any', () => {
    const signals = new Map<string, CodeSignals>([
      ['src/a.ts', { debugger: [12], consoleLog: [10], anyType: [11, 13], todo: [14] }],
      ['src/a.test.ts', { debugger: [], consoleLog: [1], anyType: [2], todo: [3] }],
    ]);
    const findings = reviewFindings({ diff: diffOf([file('src/a.ts'), file('src/a.test.ts')]), impact: impactOf({}), signals });
    expect(findings.filter((f) => f.file !== undefined)).toEqual([
      { rule: 'todo', file: 'src/a.test.ts', line: 3, count: 1 },
      { rule: 'debugger', file: 'src/a.ts', line: 12, count: 1 },
      { rule: 'console-log', file: 'src/a.ts', line: 10, count: 1 },
      { rule: 'any-type', file: 'src/a.ts', line: 11, count: 2 },
      { rule: 'todo', file: 'src/a.ts', line: 14, count: 1 },
    ]);
  });

  it('suggests splitting large PRs, ignoring lockfiles', () => {
    const big = reviewFindings({ diff: diffOf([file('src/a.ts', { additions: 900 })]), signals: new Map() });
    expect(big).toContainEqual({ rule: 'large-pr', count: 900 });
    const lock = reviewFindings({ diff: diffOf([file('package-lock.json', { additions: 5000 })]), signals: new Map() });
    expect(lock.some((f) => f.rule === 'large-pr')).toBe(false);
  });

  it('lists changed project-wide config files', () => {
    const findings = reviewFindings({ diff: diffOf([file('package.json'), file('vite.config.ts'), file('src/a.ts')]), signals: new Map() });
    expect(findings).toContainEqual({ rule: 'config-change', related: ['package.json', 'vite.config.ts'] });
  });

  it('recommends running affected tests, or adding one when none is related', () => {
    const affected = reviewFindings({
      diff: diffOf([file('src/a.ts')]),
      impact: impactOf({ candidates: [{ path: 'src/a.test.ts', certainty: 'confirmed', reason: 'imports-changed', depth: 1, via: ['src/a.test.ts', 'src/a.ts'] }] }),
      signals: new Map(),
    });
    expect(affected).toContainEqual({ rule: 'tests-to-run', related: ['src/a.test.ts'] });

    expect(reviewFindings({ diff: diffOf([file('src/a.ts')]), impact: impactOf({}), signals: new Map() })).toContainEqual({ rule: 'no-tests' });
    // Unknown impact: no claim either way.
    expect(reviewFindings({ diff: diffOf([file('src/a.ts')]), signals: new Map() }).some((f) => f.rule === 'no-tests')).toBe(false);
    // A test changed in the same PR.
    expect(reviewFindings({ diff: diffOf([file('src/a.ts'), file('src/a.test.ts')]), impact: impactOf({}), signals: new Map() })).toEqual([]);
  });
});

describe('runReview (integration)', () => {
  it('reads added lines from the head commit and reports them with line numbers', async () => {
    repo = createRepo();
    repo.write({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': "import { a } from './a';\nexport const b = a;\n", 'README.md': 'hi\n' });
    const base = repo.commit('base');
    repo.write({
      'src/a.ts': 'export const a = 1;\nconsole.log(a);\nexport const c: any = 2;\n',
      'src/b.ts': "import { a } from './a';\nimport { x } from './nope';\nexport const b = a;\n",
      'README.md': 'hello\n',
    });
    const head = repo.commit('head');
    const limits = resolveLimits();
    const diff = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits });
    if (!diff.data) throw new Error('diff failed');
    const impact = await analyzeImpact({ cwd: repo.dir, diff: diff.data, limits });
    const result = await runReview({ cwd: repo.dir, diff: diff.data, limits, ...(impact.data ? { impact: impact.data } : {}) });
    expect(result.status).toBe('ok');
    expect(result.data?.findings).toEqual([
      { rule: 'unresolved-import', file: 'src/b.ts', specifier: './nope' },
      { rule: 'console-log', file: 'src/a.ts', line: 2, count: 1 },
      { rule: 'any-type', file: 'src/a.ts', line: 3, count: 1 },
      { rule: 'no-tests' },
    ]);
  });

  it('marks the section truncated when a changed file is too large to scan', async () => {
    repo = createRepo();
    repo.write({ 'src/a.ts': 'export const a = 1;\n' });
    const base = repo.commit('base');
    repo.write({ 'src/a.ts': `export const a = "${'x'.repeat(4000)}";\n` });
    const head = repo.commit('head');
    const limits = resolveLimits({ maxFileBytes: 1024 });
    const diff = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits });
    if (!diff.data) throw new Error('diff failed');
    const result = await runReview({ cwd: repo.dir, diff: diff.data, limits });
    expect(result.status).toBe('truncated');
    expect(result.reason).toContain('not scanned');
  });
});
