import { appendFileSync } from 'node:fs';

/**
 * The small part of the GitHub Actions runtime the action needs, without the @actions toolkit:
 * inputs come from INPUT_* variables, outputs and the job summary go to files named by
 * GITHUB_OUTPUT / GITHUB_STEP_SUMMARY, and annotations are workflow commands on stdout.
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** `with: { report-dir: x }` arrives as INPUT_REPORT-DIR (spaces become underscores, hyphens stay). */
export function getInput(env: Env, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

export interface AnalyzeTarget {
  baseSha: string;
  headSha: string;
  prNumber: number;
}

/** The PR to analyse, from a `pull_request` event payload; null for any other event. Pure. */
export function analyzeTarget(eventName: string, payload: unknown): AnalyzeTarget | null {
  if (eventName !== 'pull_request') return null;
  const pr = field(payload, 'pull_request');
  const baseSha = field(field(pr, 'base'), 'sha');
  const headSha = field(field(pr, 'head'), 'sha');
  const prNumber = field(pr, 'number');
  if (typeof baseSha !== 'string' || typeof headSha !== 'string' || typeof prNumber !== 'number') return null;
  return { baseSha, headSha, prNumber };
}

/**
 * The analysed commit the comment must belong to: `workflow_run.head_sha` for the fork-safe
 * two-workflow setup (only runs triggered by pull requests), or the PR head for a single
 * `pull_request` workflow. Null for anything else. Pure.
 */
export function commentHeadSha(eventName: string, payload: unknown): string | null {
  if (eventName === 'workflow_run') {
    const run = field(payload, 'workflow_run');
    const sha = field(run, 'head_sha');
    return field(run, 'event') === 'pull_request' && typeof sha === 'string' ? sha : null;
  }
  if (eventName === 'pull_request') {
    const sha = field(field(field(payload, 'pull_request'), 'head'), 'sha');
    return typeof sha === 'string' ? sha : null;
  }
  return null;
}

export interface Runner {
  info(message: string): void;
  notice(message: string): void;
  error(message: string): void;
  setOutput(name: string, value: string): void;
  appendSummary(markdown: string): void;
}

/** A Runner writing to the real Actions runtime. */
export function actionsRunner(env: Env, write: (text: string) => void = (text) => process.stdout.write(text)): Runner {
  const command = (name: string, message: string): void => { write(`::${name}::${escapeData(message)}\n`); };
  return {
    info: (message) => { write(`${message}\n`); },
    notice: (message) => { command('notice', message); },
    error: (message) => { command('error', message); },
    setOutput: (name, value) => {
      const file = env.GITHUB_OUTPUT;
      if (file === undefined || file === '') return;
      const delimiter = `impactly_${Math.random().toString(36).slice(2)}`;
      appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    },
    appendSummary: (markdown) => {
      const file = env.GITHUB_STEP_SUMMARY;
      if (file !== undefined && file !== '') appendFileSync(file, `${markdown}\n`);
    },
  };
}

/** Workflow command data escaping, so a message cannot start a second command. */
export function escapeData(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}
