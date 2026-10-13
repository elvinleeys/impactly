#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGitHubRequest, publishReport, type GitHubRequest } from '../github/comment.js';

/**
 * Posts an Impactly report as a PR comment. Meant for a `workflow_run` job that downloaded the
 * report artifact of a `pull_request` run. Reads GITHUB_TOKEN, GITHUB_REPOSITORY and optionally
 * GITHUB_API_URL from the environment. Exit codes: 0 posted or skipped as stale, 1 failed, 2 usage error.
 */

const USAGE = `Usage: impactly-comment --report <report.json> --pr-file <pr-number.txt> --head-sha <sha>`;
const MAX_REPORT_BYTES = 20 * 1024 * 1024;

export interface CommentCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runCommentCli(argv: readonly string[], env: NodeJS.ProcessEnv, request?: GitHubRequest): Promise<CommentCliResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { report: { type: 'string' }, 'pr-file': { type: 'string' }, 'head-sha': { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    return usage(error instanceof Error ? error.message : String(error));
  }
  if (values.report === undefined || values['pr-file'] === undefined || values['head-sha'] === undefined) {
    return usage('--report, --pr-file and --head-sha are required');
  }
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  if (token === undefined || token === '' || repository === undefined) return usage('GITHUB_TOKEN and GITHUB_REPOSITORY must be set');

  try {
    const [reportText, prText] = await Promise.all([readLimited(values.report), readLimited(values['pr-file'])]);
    const prNumber = /^\s*(\d{1,9})\s*$/.exec(prText)?.[1];
    if (prNumber === undefined) throw new Error('The PR number file does not contain a number');
    const result = await publishReport({
      request: request ?? createGitHubRequest(token, env.GITHUB_API_URL ?? 'https://api.github.com'),
      repository,
      prNumber: Number(prNumber),
      headSha: values['head-sha'],
      report: JSON.parse(reportText) as unknown,
    });
    const message =
      result.outcome === 'stale'
        ? `Skipped: the PR has a newer commit (${result.currentHead}); its own run will comment.`
        : `Comment ${result.outcome} (id ${result.commentId}).`;
    return { exitCode: 0, stdout: `${message}\n`, stderr: '' };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `impactly-comment: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

async function readLimited(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error(`${file} is not a regular file under ${MAX_REPORT_BYTES} bytes`);
  return readFile(file, 'utf8');
}

function usage(message: string): CommentCliResult {
  return { exitCode: 2, stdout: '', stderr: `impactly-comment: ${message}\n\n${USAGE}\n` };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const result = await runCommentCli(process.argv.slice(2), process.env);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
