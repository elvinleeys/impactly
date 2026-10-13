import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildReport } from '../entry/run.js';
import { createGitHubRequest, publishReport, type GitHubRequest } from '../github/comment.js';
import { renderMarkdown } from '../report/markdown.js';
import { actionsRunner, analyzeTarget, commentHeadSha, getInput, type Env, type Runner } from './context.js';

/**
 * GitHub Action entry point (bundled into action-dist/index.cjs).
 *
 * - mode: analyze (on `pull_request`, read-only): analyse the PR checked out in the workspace and
 *   write report.json + pr-number.txt into `report-dir`, plus the comment text to the job summary.
 * - mode: comment (on `workflow_run` after the analysis, or on `pull_request` for same-repo PRs):
 *   read `report-dir`, validate it, check the PR head and create or update the PR comment.
 *
 * Analysis problems never fail the step: they are explained in the report. Misconfiguration
 * (unknown mode, missing token) and failed GitHub API calls do.
 */

export interface ActionDeps {
  runner?: Runner;
  request?: GitHubRequest;
}

const MAX_REPORT_BYTES = 20 * 1024 * 1024;

export async function runAction(env: Env, deps: ActionDeps = {}): Promise<number> {
  const runner = deps.runner ?? actionsRunner(env);
  try {
    const mode = getInput(env, 'mode');
    if (mode === 'analyze') return await analyze(env, runner);
    if (mode === 'comment') return await comment(env, runner, deps.request);
    runner.error(`Input "mode" must be "analyze" or "comment" (got "${mode}").`);
    return 1;
  } catch (error) {
    runner.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function analyze(env: Env, runner: Runner): Promise<number> {
  const target = analyzeTarget(env.GITHUB_EVENT_NAME ?? '', readEvent(env));
  if (target === null) {
    runner.notice('Impactly analyze runs on pull_request events only; nothing to do for this event.');
    return 0;
  }
  const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
  const report = await buildReport({
    baseSha: target.baseSha,
    headSha: target.headSha,
    cwd: path.resolve(workspace, getInput(env, 'path') || '.'),
    limits: limitInputs(env),
  });
  if (report.diff.status === 'failed') {
    runner.notice('Impactly could not read the PR diff. Check out the repository with `fetch-depth: 0` so both commits are available.');
  }

  const dir = reportDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(dir, 'pr-number.txt'), `${target.prNumber}\n`);
  runner.appendSummary(renderMarkdown(report));
  runner.setOutput('report-dir', dir);
  runner.info(`Impactly report written to ${dir}`);
  return 0;
}

async function comment(env: Env, runner: Runner, request?: GitHubRequest): Promise<number> {
  const headSha = commentHeadSha(env.GITHUB_EVENT_NAME ?? '', readEvent(env));
  if (headSha === null) {
    runner.notice('Impactly comment runs on workflow_run (triggered by a pull request) or pull_request events; nothing to do.');
    return 0;
  }
  const dir = reportDir(env);
  const reportFile = path.join(dir, 'report.json');
  if (!existsSync(reportFile)) {
    runner.notice(`No Impactly report in ${dir} (the analysis may have been cancelled); nothing to post.`);
    return 0;
  }
  const token = getInput(env, 'github-token');
  if (token === '') {
    runner.error('Input "github-token" is empty. The comment needs a token with pull-requests: write.');
    return 1;
  }
  const prNumber = /^\s*(\d{1,9})\s*$/.exec(readLimited(path.join(dir, 'pr-number.txt')))?.[1];
  if (prNumber === undefined) throw new Error('pr-number.txt does not contain a PR number');

  const result = await publishReport({
    request: request ?? createGitHubRequest(token, env.GITHUB_API_URL ?? 'https://api.github.com'),
    repository: env.GITHUB_REPOSITORY ?? '',
    prNumber: Number(prNumber),
    headSha,
    report: JSON.parse(readLimited(reportFile)) as unknown,
  });
  if (result.outcome === 'stale') runner.notice(`The PR has a newer commit (${result.currentHead}); its own run will comment.`);
  else {
    runner.info(`Impactly comment ${result.outcome} (id ${result.commentId}).`);
    runner.setOutput('comment-id', String(result.commentId));
  }
  return 0;
}

function readEvent(env: Env): unknown {
  const file = env.GITHUB_EVENT_PATH;
  if (file === undefined || file === '' || !existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function reportDir(env: Env): string {
  return path.resolve(env.GITHUB_WORKSPACE ?? process.cwd(), getInput(env, 'report-dir') || 'impactly-report');
}

function readLimited(file: string): string {
  const info = statSync(file);
  if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error(`${file} is not a regular file under ${MAX_REPORT_BYTES} bytes`);
  return readFileSync(file, 'utf8');
}

function limitInputs(env: Env): { maxDepth?: number; maxFiles?: number } {
  const limits: { maxDepth?: number; maxFiles?: number } = {};
  for (const [input, key] of [['max-depth', 'maxDepth'], ['max-files', 'maxFiles']] as const) {
    const raw = getInput(env, input);
    if (raw === '') continue;
    if (!/^\d+$/.test(raw) || Number(raw) === 0) throw new Error(`Input "${input}" must be a positive integer`);
    limits[key] = Number(raw);
  }
  return limits;
}
