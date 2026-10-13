import { afterEach, describe, expect, it } from 'vitest';
import { resolveLimits } from '../../src/core/limits.js';
import { collectDiff, summarize } from '../../src/git/collect.js';
import { createRepo, type TestRepo } from '../helpers/repo.js';

let repo: TestRepo | undefined;
afterEach(() => repo?.cleanup());

const lines = (count: number, prefix = 'line'): string => Array.from({ length: count }, (_, i) => `${prefix} ${i}`).join('\n') + '\n';

describe('collectDiff', () => {
  it('reports added, modified, deleted, renamed and binary files with line ranges', async () => {
    repo = createRepo();
    repo.write({
      'src/keep.ts': lines(10),
      'src/remove.ts': 'export const gone = 1;\n',
      'src/old-name.ts': lines(30, 'stable content'),
      'img.png': Buffer.from([0, 1, 2, 3]),
    });
    const base = repo.commit('base');
    repo.write({
      'src/keep.ts': lines(10).replace('line 4', 'changed 4'),
      'src/new.ts': 'export const fresh = 1;\n',
      'img.png': Buffer.from([0, 9, 9, 9]),
      '공백 있는 폴더/파일.ts': 'export {};\n',
    });
    repo.remove('src/remove.ts');
    repo.git('mv', 'src/old-name.ts', 'src/new-name.ts');
    const head = repo.commit('head');

    const result = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits: resolveLimits() });
    expect(result.status).toBe('ok');
    const files = new Map(result.data?.files.map((file) => [file.path, file]));

    expect(files.get('src/keep.ts')).toMatchObject({
      change: 'modified',
      additions: 1,
      deletions: 1,
      hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1 }],
    });
    expect(files.get('src/new.ts')).toMatchObject({ change: 'added', additions: 1, deletions: 0 });
    expect(files.get('src/remove.ts')).toMatchObject({ change: 'deleted', additions: 0, deletions: 1 });
    expect(files.get('src/new-name.ts')).toMatchObject({ change: 'renamed', oldPath: 'src/old-name.ts', similarity: 100 });
    expect(files.get('img.png')).toMatchObject({ change: 'modified', binary: true, additions: null, hunks: null });
    expect(files.get('공백 있는 폴더/파일.ts')).toMatchObject({ change: 'added' });
    expect(result.data?.totals).toEqual({ files: 6, additions: 3, deletions: 2 });
    expect(result.data?.diffBase).toBe(base);
  });

  it('uses the merge-base by default so changes on the base branch are not attributed to the PR', async () => {
    repo = createRepo();
    repo.write({ 'shared.ts': 'v1\n' });
    const root = repo.commit('root');
    repo.git('checkout', '--quiet', '-b', 'feature');
    repo.write({ 'feature.ts': 'feature\n' });
    const head = repo.commit('feature');
    repo.git('checkout', '--quiet', 'main');
    repo.write({ 'main-only.ts': 'main\n' });
    const base = repo.commit('main moves on');

    const mergeBase = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits: resolveLimits() });
    expect(mergeBase.data?.diffBase).toBe(root);
    expect(mergeBase.data?.files.map((file) => file.path)).toEqual(['feature.ts']);

    const direct = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits: resolveLimits(), mode: 'direct' });
    expect(direct.data?.files.map((file) => `${file.change}:${file.path}`).sort()).toEqual([
      'added:feature.ts',
      'deleted:main-only.ts',
    ]);
  });

  it('truncates the file list at maxFiles but keeps totals for all files', async () => {
    repo = createRepo();
    const base = repo.commit('empty');
    repo.write(Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}.ts`, 'x\n'])));
    const head = repo.commit('five files');

    const result = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits: resolveLimits({ maxFiles: 2 }) });
    expect(result.status).toBe('truncated');
    expect(result.data?.files).toHaveLength(2);
    expect(result.data?.totals.files).toBe(5);
    expect(result.reason).toContain('only the first 2');
  });

  it('omits line ranges instead of failing when the patch exceeds maxDiffBytes', async () => {
    repo = createRepo();
    const base = repo.commit('empty');
    repo.write({ 'big.ts': lines(500) });
    const head = repo.commit('big');

    const result = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits: resolveLimits({ maxDiffBytes: 1024 }) });
    expect(result.status).toBe('truncated');
    expect(result.data?.files[0]).toMatchObject({ path: 'big.ts', additions: 500, hunks: null });
    expect(result.evidence.some((item) => item.source === 'limits')).toBe(true);
  });

  it('returns an empty ok result when nothing changed', async () => {
    repo = createRepo();
    repo.write({ 'a.ts': 'a\n' });
    const sha = repo.commit();
    const result = await collectDiff({ baseSha: sha, headSha: sha, cwd: repo.dir, limits: resolveLimits() });
    expect(result.status).toBe('ok');
    expect(result.data?.files).toEqual([]);
  });

  it('fails with a reason for invalid or unknown SHAs, without throwing', async () => {
    repo = createRepo();
    const sha = repo.commit();
    const invalid = await collectDiff({ baseSha: 'main; echo hacked', headSha: sha, cwd: repo.dir, limits: resolveLimits() });
    expect(invalid).toMatchObject({ status: 'failed' });
    expect(invalid.reason).toContain('Invalid commit SHA');

    const unknown = await collectDiff({ baseSha: 'f'.repeat(40), headSha: sha, cwd: repo.dir, limits: resolveLimits() });
    expect(unknown.status).toBe('failed');
    expect(unknown.reason).toContain('was not found');
  });
});

describe('summarize', () => {
  it('counts binary files as zero lines', () => {
    expect(
      summarize([
        { path: 'a', change: 'modified', additions: 2, deletions: 1, binary: false, hunks: [] },
        { path: 'b', change: 'added', additions: null, deletions: null, binary: true, hunks: null },
      ]),
    ).toEqual({ files: 2, additions: 2, deletions: 1 });
  });
});
