import { afterEach, describe, expect, it } from 'vitest';
import type { Report } from '../../src/core/types.js';
import { formatText, runCli } from '../../src/entry/cli.js';
import { buildReport } from '../../src/entry/run.js';
import { createRepo, type TestRepo } from '../helpers/repo.js';

let repo: TestRepo | undefined;
afterEach(() => repo?.cleanup());

function twoCommits(): { base: string; head: string } {
  repo = createRepo();
  repo.write({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': "import { a } from './a';\nexport const b = a;\n" });
  const base = repo.commit('base');
  repo.write({ 'src/a.ts': 'export const a = 2;\n' });
  return { base, head: repo.commit('head') };
}

describe('buildReport', () => {
  it('runs diff and impact and marks later stages as skipped, never ok', async () => {
    const { base, head } = twoCommits();
    const report = await buildReport({ baseSha: base, headSha: head, cwd: repo?.dir ?? '' });
    expect(report).toMatchObject({ version: 1, base, head });
    expect(report.diff.status).toBe('ok');
    expect(report.impact.data?.candidates.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(report.tests).toMatchObject({ status: 'skipped' });
    expect(report.bundle).toMatchObject({ status: 'skipped' });
  });

  it('fails the impact section when the diff fails, keeping the original inputs', async () => {
    const { head } = twoCommits();
    const report = await buildReport({ baseSha: 'f'.repeat(40), headSha: head, cwd: repo?.dir ?? '' });
    expect(report.diff.status).toBe('failed');
    expect(report.impact).toMatchObject({ status: 'failed', reason: 'Impact analysis needs the diff, which failed' });
    expect(report.base).toBe('f'.repeat(40));
  });

  it('works from a subdirectory of the repository', async () => {
    const { base, head } = twoCommits();
    const report = await buildReport({ baseSha: base, headSha: head, cwd: `${repo?.dir ?? ''}/src` });
    expect(report.diff.data?.files.map((f) => f.path)).toEqual(['src/a.ts']);
  });
});

describe('runCli', () => {
  it('prints JSON by default and exits 0', async () => {
    const { base, head } = twoCommits();
    const result = await runCli(['--base', base, '--head', head, '--cwd', repo?.dir ?? '']);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.diff.data?.files).toHaveLength(1);
  });

  it('prints a text summary with --text', async () => {
    const { base, head } = twoCommits();
    const result = await runCli(['--base', base, '--head', head, '--cwd', repo?.dir ?? '', '--text', '--max-depth', '1']);
    expect(result.stdout).toContain('[confirmed] src/b.ts — imports-changed, via src/b.ts -> src/a.ts');
    expect(result.stdout).toContain('tests: skipped');
  });

  it('exits 1 when a section failed', async () => {
    const { head } = twoCommits();
    const result = await runCli(['--base', 'abcdef0', '--head', head, '--cwd', repo?.dir ?? '']);
    expect(result.exitCode).toBe(1);
  });

  it.each([
    [[], '--base and --head are required'],
    [['--base', 'a'], '--base and --head are required'],
    [['--base', 'a', '--head', 'b', '--mode', 'x'], '--mode must be'],
    [['--base', 'a', '--head', 'b', '--max-depth=1.5'], '--max-depth must be a positive integer'],
    [['--unknown'], 'Unknown option'],
  ])('rejects %j with exit 2', async (argv, message) => {
    const result = await runCli(argv);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('exits 2 for a zero limit and for a directory that is not a repository', async () => {
    expect((await runCli(['--base', 'abcdef0', '--head', 'abcdef0', '--max-files', '0'])).stderr).toContain('positive integer');
    const notRepo = await runCli(['--base', 'abcdef0', '--head', 'abcdef0', '--cwd', '/']);
    expect(notRepo.exitCode).toBe(2);
  });

  it('prints help', async () => {
    const result = await runCli(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: impactly');
  });
});

describe('formatText', () => {
  it('shows binary files, renames and failure reasons', () => {
    const report: Report = {
      version: 1,
      base: 'a',
      head: 'b',
      diff: {
        status: 'ok',
        evidence: [],
        data: {
          base: 'a',
          head: 'b',
          diffBase: 'a',
          totals: { files: 2, additions: 0, deletions: 0 },
          files: [
            { path: 'x.png', change: 'added', additions: null, deletions: null, binary: true, hunks: null },
            { path: 'n.ts', oldPath: 'o.ts', change: 'renamed', additions: 0, deletions: 0, binary: false, hunks: [] },
          ],
        },
      },
      impact: { status: 'failed', reason: 'boom', evidence: [] },
      tests: { status: 'skipped', reason: 'later', evidence: [] },
      bundle: { status: 'skipped', reason: 'later', evidence: [] },
    };
    const text = formatText(report);
    expect(text).toContain('(binary)');
    expect(text).toContain('o.ts -> n.ts');
    expect(text).toContain('impact: failed (boom)');
  });
});
