import { resolveLimits } from '../core/limits.js';
import { failed, skipped } from '../core/result.js';
import type { ImpactData, Limits, Report, ReviewData, Section } from '../core/types.js';
import { collectDiff } from '../git/collect.js';
import { runGit } from '../git/runner.js';
import { analyzeImpact } from '../impact/analyze.js';
import { runReview } from '../review/review.js';

export interface RunOptions {
  baseSha: string;
  headSha: string;
  cwd: string;
  mode?: 'merge-base' | 'direct';
  limits?: Partial<Limits>;
}

/**
 * Runs the stages implemented so far (diff, impact, rule-based review). Later stages are reported as
 * skipped with a reason, never as successful.
 */
export async function buildReport(options: RunOptions): Promise<Report> {
  const limits = resolveLimits(options.limits);
  const cwd = (await runGit(['rev-parse', '--show-toplevel'], { cwd: options.cwd })).trim();

  const diffInput = { baseSha: options.baseSha, headSha: options.headSha, cwd, limits };
  const diff = await collectDiff(options.mode === undefined ? diffInput : { ...diffInput, mode: options.mode });

  let impact: Section<ImpactData>;
  let review: Section<ReviewData>;
  if (diff.data === undefined) {
    impact = failed(new Error('Impact analysis needs the diff, which failed'));
    review = failed(new Error('Review needs the diff, which failed'));
  } else {
    impact = await analyzeImpact({ cwd, diff: diff.data, limits });
    review = await runReview({ cwd, diff: diff.data, limits, ...(impact.data === undefined ? {} : { impact: impact.data }) });
  }

  return {
    version: 1,
    base: diff.data?.base ?? options.baseSha,
    head: diff.data?.head ?? options.headSha,
    diff,
    impact,
    review,
    tests: skipped('Test discovery is not implemented yet'),
    bundle: skipped('Bundle comparison is not implemented yet'),
  };
}
