import { COMMENT_MARKER, renderMarkdown } from '../report/markdown.js';
import { validateReport } from './validate.js';

/**
 * Posts the report as a PR comment, updating the earlier one instead of adding a new comment
 * per push. This is the only module that calls the GitHub API.
 */

export interface GitHubResponse {
  status: number;
  body: unknown;
}

export type GitHubRequest = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<GitHubResponse>;

export class GitHubApiError extends Error {
  override name = 'GitHubApiError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** A REST client for api.github.com (or GITHUB_API_URL on GitHub Enterprise). */
export function createGitHubRequest(token: string, apiUrl = 'https://api.github.com', fetchImpl: typeof fetch = fetch): GitHubRequest {
  return async (method, path, body) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'impactly',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: parseJson(await response.text()) };
  };
}

export interface PublishInput {
  request: GitHubRequest;
  /** "owner/name" of the repository the PR belongs to. */
  repository: string;
  prNumber: number;
  /** Head SHA the analysed run was for, taken from the trusted workflow_run event. */
  headSha: string;
  /** Parsed report.json from the PR run; untrusted. */
  report: unknown;
}

export type PublishResult =
  | { outcome: 'created' | 'updated'; commentId: number }
  /** The PR moved on to a newer commit; a later run will comment for it. */
  | { outcome: 'stale'; currentHead: string };

const BOT_LOGIN = 'github-actions[bot]';
const MAX_COMMENT_PAGES = 30;

export async function publishReport(input: PublishInput): Promise<PublishResult> {
  const repository = checkRepository(input.repository);
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber <= 0) throw new Error('PR number must be a positive integer');
  if (!/^[0-9a-f]{40}$/.test(input.headSha)) throw new Error('head SHA must be a full commit SHA');

  const report = validateReport(input.report);
  if (report.head !== input.headSha) throw new Error('The report was made for a different commit than the workflow run');

  // The PR number comes from the untrusted artifact; it is only accepted if that PR's head is the analysed commit.
  const pr = await call(input.request, 'GET', `/repos/${repository}/pulls/${input.prNumber}`);
  const currentHead = field(field(pr, 'head'), 'sha');
  if (typeof currentHead !== 'string') throw new Error('Unexpected pull request response');
  if (currentHead !== input.headSha) return { outcome: 'stale', currentHead };

  const body = renderMarkdown(report);
  const existing = await findComment(input.request, repository, input.prNumber);
  if (existing !== null) {
    await call(input.request, 'PATCH', `/repos/${repository}/issues/comments/${existing}`, { body });
    return { outcome: 'updated', commentId: existing };
  }
  const created = field(await call(input.request, 'POST', `/repos/${repository}/issues/${input.prNumber}/comments`, { body }), 'id');
  if (typeof created !== 'number') throw new Error('Unexpected comment response');
  return { outcome: 'created', commentId: created };
}

/** Our earlier comment: written by the Actions bot and starting with the marker. */
async function findComment(request: GitHubRequest, repository: string, prNumber: number): Promise<number | null> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await call(request, 'GET', `/repos/${repository}/issues/${prNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(comments)) throw new Error('Unexpected comments response');
    for (const comment of comments) {
      const id = field(comment, 'id');
      const login = field(field(comment, 'user'), 'login');
      const body = field(comment, 'body');
      if (typeof id === 'number' && login === BOT_LOGIN && typeof body === 'string' && body.startsWith(COMMENT_MARKER)) return id;
    }
    if (comments.length < 100) break;
  }
  return null;
}

async function call(request: GitHubRequest, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
  const response = await request(method, path, body);
  if (response.status < 200 || response.status >= 300) {
    const message = field(response.body, 'message');
    throw new GitHubApiError(`GitHub API ${method} ${path} failed with ${response.status}${typeof message === 'string' ? `: ${message}` : ''}`, response.status);
  }
  return response.body;
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function checkRepository(value: string): string {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value)) throw new Error('Repository must look like "owner/name"');
  return value;
}
