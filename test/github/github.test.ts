import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommentCli } from '../../src/entry/comment.js';
import { createGitHubRequest, GitHubApiError, publishReport, type GitHubRequest, type GitHubResponse } from '../../src/github/comment.js';
import { ReportValidationError, validateReport } from '../../src/github/validate.js';
import { COMMENT_MARKER } from '../../src/report/markdown.js';

const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);

function validReport(): Record<string, unknown> {
  return {
    version: 1,
    base: BASE,
    head: HEAD,
    diff: {
      status: 'ok',
      reason: 'ignored',
      evidence: [{ source: 'git', detail: 'ignored' }],
      data: {
        base: BASE,
        head: HEAD,
        diffBase: BASE,
        files: [{ path: 'src/a.ts', change: 'modified', additions: 1, deletions: 0, binary: false, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1 }] }],
        totals: { files: 1, additions: 1, deletions: 0 },
      },
    },
    impact: {
      status: 'ok',
      evidence: [],
      data: {
        candidates: [{ path: 'src/a.ts', certainty: 'confirmed', reason: 'changed', depth: 0, via: ['src/a.ts'] }],
        unresolved: [],
        stats: { analyzedFiles: 1, skippedFiles: 0, edges: 0, unresolvedSpecifiers: 0 },
      },
    },
    review: { status: 'ok', evidence: [], data: { findings: [{ rule: 'console-log', file: 'src/a.ts', line: 1, count: 1, extra: 'dropped' }] } },
    tests: { status: 'skipped', evidence: [] },
    bundle: { status: 'skipped', evidence: [] },
  };
}

describe('validateReport', () => {
  it('copies known fields and drops free text and unknown fields', () => {
    const report = validateReport(validReport());
    expect(report.diff.reason).toBeUndefined();
    expect(report.diff.evidence).toEqual([]);
    expect(report.review.data?.findings).toEqual([{ rule: 'console-log', file: 'src/a.ts', line: 1, count: 1 }]);
    expect(report.impact.data?.candidates).toHaveLength(1);
  });

  const broken: [string, (r: Record<string, unknown>) => void][] = [
    ['wrong version', (r) => { r.version = 2; }],
    ['short SHA', (r) => { r.head = 'abc'; }],
    ['unknown status', (r) => { (r.diff as Record<string, unknown>).status = 'great'; }],
    ['unknown rule', (r) => { (r.review as { data: { findings: unknown[] } }).data.findings = [{ rule: 'rm -rf' }]; }],
    ['negative count', (r) => { (r.review as { data: { findings: unknown[] } }).data.findings = [{ rule: 'todo', line: -1 }]; }],
    ['non-string path', (r) => { (r.impact as { data: { candidates: unknown[] } }).data.candidates = [{ path: 1 }]; }],
    ['huge string', (r) => { (r.impact as { data: { unresolved: unknown[] } }).data.unresolved = [{ file: 'x'.repeat(2000), specifier: 'y' }]; }],
    ['missing section', (r) => { delete r.review; }],
  ];
  it.each(broken)('rejects %s', (_name, breakIt) => {
    const report = validReport();
    breakIt(report);
    expect(() => validateReport(report)).toThrow(ReportValidationError);
  });

  it('rejects non-objects', () => {
    expect(() => validateReport(null)).toThrow(ReportValidationError);
    expect(() => validateReport([])).toThrow(ReportValidationError);
  });
});

/** A fake GitHub API: a PR with a head SHA and a list of comments. */
function fakeGitHub(options: { prHead?: string; comments?: unknown[]; association?: string; diff?: string; diffStatus?: number } = {}) {
  const calls: { method: string; path: string; body?: unknown; accept?: string }[] = [];
  const request: GitHubRequest = (method, apiPath, body, accept) => {
    calls.push({ method, path: apiPath, body, ...(accept === undefined ? {} : { accept }) });
    let response: GitHubResponse = { status: 404, body: { message: 'Not Found' } };
    if (method === 'GET' && apiPath === '/repos/o/r/pulls/7' && accept === 'application/vnd.github.diff') {
      response = { status: options.diffStatus ?? 200, body: null, text: options.diff ?? '' };
    } else if (method === 'GET' && apiPath === '/repos/o/r/pulls/7') {
      response = { status: 200, body: { head: { sha: options.prHead ?? HEAD }, author_association: options.association ?? 'OWNER' } };
    }
    else if (method === 'GET' && apiPath.startsWith('/repos/o/r/issues/7/comments')) response = { status: 200, body: options.comments ?? [] };
    else if (method === 'POST' && apiPath === '/repos/o/r/issues/7/comments') response = { status: 201, body: { id: 99 } };
    else if (method === 'PATCH' && apiPath.startsWith('/repos/o/r/issues/comments/')) response = { status: 200, body: {} };
    return Promise.resolve(response);
  };
  return { request, calls };
}

describe('publishReport', () => {
  const input = (request: GitHubRequest, overrides: Record<string, unknown> = {}) => ({
    request,
    repository: 'o/r',
    prNumber: 7,
    headSha: HEAD,
    report: validReport(),
    ...overrides,
  });

  it('creates a Korean comment with the marker when none exists', async () => {
    const github = fakeGitHub();
    expect(await publishReport(input(github.request))).toEqual({ outcome: 'created', commentId: 99 });
    const post = github.calls.find((call) => call.method === 'POST');
    const body = (post?.body as { body: string }).body;
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain('Impactly PR 점검 결과');
  });

  it('updates only its own earlier comment, not one by another user with the same marker', async () => {
    const github = fakeGitHub({
      comments: [
        { id: 1, user: { login: 'mallory' }, body: `${COMMENT_MARKER} fake` },
        { id: 2, user: { login: 'github-actions[bot]' }, body: 'unrelated bot comment' },
        { id: 3, user: { login: 'github-actions[bot]' }, body: `${COMMENT_MARKER}\nold` },
      ],
    });
    expect(await publishReport(input(github.request))).toEqual({ outcome: 'updated', commentId: 3 });
    expect(github.calls.some((call) => call.method === 'PATCH' && call.path === '/repos/o/r/issues/comments/3')).toBe(true);
  });

  it('skips stale runs when the PR has a newer commit', async () => {
    const github = fakeGitHub({ prHead: 'c'.repeat(40) });
    expect(await publishReport(input(github.request))).toEqual({ outcome: 'stale', currentHead: 'c'.repeat(40) });
    expect(github.calls.some((call) => call.method !== 'GET')).toBe(false);
  });

  it('refuses a report made for another commit, an invalid report, or bad inputs', async () => {
    const github = fakeGitHub();
    await expect(publishReport(input(github.request, { headSha: 'c'.repeat(40) }))).rejects.toThrow('different commit');
    await expect(publishReport(input(github.request, { report: { version: 1 } }))).rejects.toThrow(ReportValidationError);
    await expect(publishReport(input(github.request, { repository: 'o/r/../x' }))).rejects.toThrow('owner/name');
    await expect(publishReport(input(github.request, { prNumber: -1 }))).rejects.toThrow('positive integer');
    expect(github.calls).toEqual([]);
  });

  it('reports API errors with their status', async () => {
    const failing: GitHubRequest = () => Promise.resolve({ status: 403, body: { message: 'Resource not accessible by integration' } });
    const error = await publishReport(input(failing)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).status).toBe(403);
  });
});

describe('createGitHubRequest', () => {
  it('sends an authenticated JSON request and parses the response', async () => {
    let seen: { url: string; init: RequestInit | undefined } | undefined;
    const fakeFetch = ((url: string, init?: RequestInit) => {
      seen = { url, init };
      return Promise.resolve(new Response('{"id":5}', { status: 201 }));
    }) as typeof fetch;
    const request = createGitHubRequest('tok', 'https://api.example', fakeFetch);
    expect(await request('POST', '/x', { body: 'hi' })).toEqual({ status: 201, body: { id: 5 }, text: '{"id":5}' });
    expect(seen?.url).toBe('https://api.example/x');
    expect((seen?.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(seen?.init?.body).toBe('{"body":"hi"}');
  });
});

describe('publishReport with the AI review', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -0,0 +1 @@',
    '+console.log(secret);',
  ].join('\n');
  const anthropic = (input: unknown) =>
    (() => Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'tool_use', input }] }), { status: 200 }))) as unknown as typeof fetch;
  const post = (calls: { method: string; body?: unknown }[]) => (calls.find((c) => c.method === 'POST')?.body as { body: string }).body;
  const base = (request: GitHubRequest) => ({ request, repository: 'o/r', prNumber: 7, headSha: HEAD, report: validReport() });

  it('says the review was skipped when no API key is set', async () => {
    const github = fakeGitHub();
    await publishReport({ ...base(github.request), ai: { allowedAuthors: ['OWNER'] } });
    expect(post(github.calls)).toContain('Claude API 키가 등록되지 않아서 건너뛰었어요');
    expect(github.calls.some((c) => c.accept !== undefined)).toBe(false);
  });

  it('does not spend the API key on PRs from authors outside the allowed list', async () => {
    const github = fakeGitHub({ association: 'FIRST_TIME_CONTRIBUTOR' });
    const fetchImpl = (() => Promise.reject(new Error('must not be called'))) as unknown as typeof fetch;
    await publishReport({ ...base(github.request), ai: { apiKey: 'k', allowedAuthors: ['OWNER', 'MEMBER'], fetchImpl } });
    expect(post(github.calls)).toContain('처음 기여하는 사람의 PR이라 건너뛰었어요');
  });

  it('reviews the PR diff and adds only verified suggestions to the comment', async () => {
    const github = fakeGitHub({ diff });
    const fetchImpl = anthropic({
      summary: '로그를 추가했어요.',
      review_suggestions: [
        { severity: 'must', file: 'src/a.ts', line: 1, quote: 'console.log(secret)', problem: '비밀값이 콘솔에 보여요.', suggestion: '이 줄을 지워 주세요.' },
        { severity: 'must', file: 'src/a.ts', line: 1, quote: 'eval(', problem: '지어낸 문제', suggestion: '버려져야 해요.' },
      ],
    });
    await publishReport({ ...base(github.request), ai: { apiKey: 'k', allowedAuthors: ['OWNER'], fetchImpl } });
    const body = post(github.calls);
    expect(body).toContain('### 🤖 AI 리뷰 (참고용)');
    expect(body).toContain('1. 🔴 `src/a.ts` 1번째 줄: 비밀값이 콘솔에 보여요.');
    expect(body).toContain('(확인되지 않은 1건은 뺐어요)');
    expect(body).not.toContain('지어낸 문제');
  });

  it('skips the review when the diff cannot be fetched, and still posts the comment', async () => {
    const github = fakeGitHub({ diffStatus: 406 });
    expect(await publishReport({ ...base(github.request), ai: { apiKey: 'k', allowedAuthors: ['OWNER'] } })).toMatchObject({ outcome: 'created' });
    expect(post(github.calls)).toContain('변경 내용이 너무 커서 가져오지 못했어요');
  });
});

describe('runCommentCli', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const files = (report: unknown, pr: string) => {
    dir = mkdtempSync(path.join(tmpdir(), 'impactly-comment-'));
    writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report));
    writeFileSync(path.join(dir, 'pr.txt'), pr);
    return ['--report', path.join(dir, 'report.json'), '--pr-file', path.join(dir, 'pr.txt'), '--head-sha', HEAD];
  };
  const env = { GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' };

  it('posts the comment and exits 0', async () => {
    const result = await runCommentCli(files(validReport(), '7\n'), env, fakeGitHub().request);
    expect(result).toMatchObject({ exitCode: 0, stdout: 'Comment created (id 99).\n' });
  });

  it('exits 1 for a PR file that is not a number', async () => {
    const result = await runCommentCli(files(validReport(), '7; rm -rf /'), env, fakeGitHub().request);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('does not contain a number');
  });

  it('exits 2 without the token or required options', async () => {
    expect((await runCommentCli([], env)).exitCode).toBe(2);
    expect((await runCommentCli(files(validReport(), '7'), { GITHUB_REPOSITORY: 'o/r' })).exitCode).toBe(2);
  });
});
