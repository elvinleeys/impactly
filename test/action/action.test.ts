import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actionsRunner, analyzeTarget, commentHeadSha, escapeData, getInput, type Runner } from '../../src/action/context.js';
import { runAction } from '../../src/action/main.js';
import type { GitHubRequest } from '../../src/github/comment.js';
import { createRepo, type TestRepo } from '../helpers/repo.js';

let repo: TestRepo | undefined;
let dir: string | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);

/** A Runner that records everything. */
function recorder() {
  const log = { info: [] as string[], notice: [] as string[], error: [] as string[], outputs: {} as Record<string, string>, summary: '' };
  const runner: Runner = {
    info: (m) => log.info.push(m),
    notice: (m) => log.notice.push(m),
    error: (m) => log.error.push(m),
    setOutput: (name, value) => {
      log.outputs[name] = value;
    },
    appendSummary: (markdown) => {
      log.summary += markdown;
    },
  };
  return { runner, log };
}

function workspace(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'impactly-action-'));
  return dir;
}

function writeEvent(root: string, payload: unknown): string {
  const file = path.join(root, 'event.json');
  writeFileSync(file, JSON.stringify(payload));
  return file;
}

describe('context helpers', () => {
  it('reads inputs the way the runner passes them', () => {
    expect(getInput({ 'INPUT_REPORT-DIR': '  out  ' }, 'report-dir')).toBe('out');
    expect(getInput({}, 'mode')).toBe('');
  });

  it('takes the PR to analyse only from pull_request events', () => {
    const payload = { pull_request: { number: 3, base: { sha: BASE }, head: { sha: HEAD } } };
    expect(analyzeTarget('pull_request', payload)).toEqual({ baseSha: BASE, headSha: HEAD, prNumber: 3 });
    expect(analyzeTarget('pull_request_target', payload)).toBeNull();
    expect(analyzeTarget('pull_request', { pull_request: { number: '3' } })).toBeNull();
  });

  it('takes the commit to comment on from workflow_run (PR runs only) or pull_request', () => {
    expect(commentHeadSha('workflow_run', { workflow_run: { event: 'pull_request', head_sha: HEAD } })).toBe(HEAD);
    expect(commentHeadSha('workflow_run', { workflow_run: { event: 'push', head_sha: HEAD } })).toBeNull();
    expect(commentHeadSha('pull_request', { pull_request: { head: { sha: HEAD } } })).toBe(HEAD);
    expect(commentHeadSha('push', {})).toBeNull();
  });

  it('escapes workflow command data so a message cannot inject another command', () => {
    expect(escapeData('50%\r\n::error::x')).toBe('50%25%0D%0A::error::x');
    let written = '';
    actionsRunner({}, (text) => (written += text)).error('a\n::set-output name=x::y');
    expect(written).toBe('::error::a%0A::set-output name=x::y\n');
  });

  it('writes outputs and the summary to the runner files', () => {
    const root = workspace();
    const output = path.join(root, 'output');
    const summary = path.join(root, 'summary');
    writeFileSync(output, '');
    writeFileSync(summary, '');
    const runner = actionsRunner({ GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary }, () => undefined);
    runner.setOutput('report-dir', '/tmp/x');
    runner.appendSummary('# hi');
    expect(readFileSync(output, 'utf8')).toMatch(/^report-dir<<(impactly_\w+)\n\/tmp\/x\n\1\n$/);
    expect(readFileSync(summary, 'utf8')).toBe('# hi\n');
  });
});

describe('runAction analyze', () => {
  it('analyses the PR in the workspace and writes the report, PR number and summary', async () => {
    repo = createRepo();
    repo.write({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': "import { a } from './a';\nexport const b = a;\n" });
    const base = repo.commit('base');
    repo.write({ 'src/a.ts': 'export const a = 2;\n' });
    const head = repo.commit('head');
    const root = workspace();
    const { runner, log } = recorder();
    const code = await runAction(
      {
        INPUT_MODE: 'analyze',
        'INPUT_REPORT-DIR': path.join(root, 'out'),
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: writeEvent(root, { pull_request: { number: 9, base: { sha: base }, head: { sha: head } } }),
        GITHUB_WORKSPACE: repo.dir,
      },
      { runner },
    );
    expect(code).toBe(0);
    const report = JSON.parse(readFileSync(path.join(root, 'out', 'report.json'), 'utf8')) as { head: string; impact: { status: string } };
    expect(report.head).toBe(head);
    expect(report.impact.status).toBe('ok');
    expect(readFileSync(path.join(root, 'out', 'pr-number.txt'), 'utf8')).toBe('9\n');
    expect(log.summary).toContain('Impactly PR 점검 결과');
    expect(log.outputs['report-dir']).toBe(path.join(root, 'out'));
  });

  it('explains a missing history instead of failing', async () => {
    repo = createRepo();
    const head = repo.commit('only');
    const root = workspace();
    const { runner, log } = recorder();
    const code = await runAction(
      {
        INPUT_MODE: 'analyze',
        'INPUT_REPORT-DIR': path.join(root, 'out'),
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: writeEvent(root, { pull_request: { number: 1, base: { sha: 'c'.repeat(40) }, head: { sha: head } } }),
        GITHUB_WORKSPACE: repo.dir,
      },
      { runner },
    );
    expect(code).toBe(0);
    expect(log.notice.join()).toContain('fetch-depth: 0');
  });

  it('does nothing outside pull_request events and rejects bad inputs', async () => {
    const { runner, log } = recorder();
    expect(await runAction({ INPUT_MODE: 'analyze', GITHUB_EVENT_NAME: 'push' }, { runner })).toBe(0);
    expect(log.notice.join()).toContain('pull_request events only');
    expect(await runAction({ INPUT_MODE: 'deploy' }, { runner })).toBe(1);
    expect(log.error.join()).toContain('Input "mode" must be');

    const root = workspace();
    const event = writeEvent(root, { pull_request: { number: 1, base: { sha: BASE }, head: { sha: HEAD } } });
    expect(await runAction({ INPUT_MODE: 'analyze', 'INPUT_MAX-DEPTH': '0', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event }, { runner })).toBe(1);
    expect(log.error.join()).toContain('"max-depth" must be a positive integer');
  });
});

describe('runAction comment', () => {
  function reportFiles(root: string, prNumber = '7'): void {
    const out = path.join(root, 'impactly-report');
    mkdirSync(out, { recursive: true });
    const report = {
      version: 1,
      base: BASE,
      head: HEAD,
      diff: { status: 'ok', evidence: [], data: { base: BASE, head: HEAD, diffBase: BASE, files: [], totals: { files: 0, additions: 0, deletions: 0 } } },
      impact: { status: 'ok', evidence: [], data: { candidates: [], unresolved: [], stats: { analyzedFiles: 0, skippedFiles: 0, edges: 0, unresolvedSpecifiers: 0 } } },
      review: { status: 'ok', evidence: [], data: { findings: [] } },
      tests: { status: 'skipped', evidence: [] },
      bundle: { status: 'skipped', evidence: [] },
    };
    writeFileSync(path.join(out, 'report.json'), JSON.stringify(report));
    writeFileSync(path.join(out, 'pr-number.txt'), `${prNumber}\n`);
  }

  const github = (prHead = HEAD) => {
    const calls: string[] = [];
    const request: GitHubRequest = (method, apiPath) => {
      calls.push(`${method} ${apiPath}`);
      if (method === 'GET' && apiPath === '/repos/o/r/pulls/7') return Promise.resolve({ status: 200, body: { head: { sha: prHead } } });
      if (method === 'GET') return Promise.resolve({ status: 200, body: [] });
      return Promise.resolve({ status: 201, body: { id: 55 } });
    };
    return { request, calls };
  };

  const env = (root: string, eventName = 'workflow_run', payload: unknown = { workflow_run: { event: 'pull_request', head_sha: HEAD } }) => ({
    INPUT_MODE: 'comment',
    'INPUT_GITHUB-TOKEN': 'token',
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: writeEvent(root, payload),
    GITHUB_WORKSPACE: root,
    GITHUB_REPOSITORY: 'o/r',
  });

  it('posts the comment for a workflow_run triggered by a PR', async () => {
    const root = workspace();
    reportFiles(root);
    const api = github();
    const { runner, log } = recorder();
    expect(await runAction(env(root), { runner, request: api.request })).toBe(0);
    expect(api.calls).toContain('POST /repos/o/r/issues/7/comments');
    expect(log.outputs['comment-id']).toBe('55');
  });

  it('skips stale runs, missing reports and non-PR events without failing', async () => {
    const root = workspace();
    reportFiles(root);
    const { runner, log } = recorder();
    expect(await runAction(env(root), { runner, request: github('c'.repeat(40)).request })).toBe(0);
    expect(log.notice.join()).toContain('newer commit');

    expect(await runAction(env(root, 'workflow_run', { workflow_run: { event: 'push', head_sha: HEAD } }), { runner })).toBe(0);
    const empty = mkdtempSync(path.join(tmpdir(), 'impactly-empty-'));
    try {
      expect(await runAction(env(empty), { runner })).toBe(0);
      expect(log.notice.join()).toContain('No Impactly report');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('fails on a missing token, a bad PR number file or a rejected report', async () => {
    const root = workspace();
    reportFiles(root, 'abc');
    const { runner, log } = recorder();
    expect(await runAction({ ...env(root), 'INPUT_GITHUB-TOKEN': '' }, { runner })).toBe(1);
    expect(log.error.join()).toContain('github-token');
    expect(await runAction(env(root), { runner, request: github().request })).toBe(1);
    expect(log.error.join()).toContain('PR number');
    reportFiles(root);
    writeFileSync(path.join(root, 'impactly-report', 'report.json'), '{"version":1}');
    expect(await runAction(env(root), { runner, request: github().request })).toBe(1);
  });
});
