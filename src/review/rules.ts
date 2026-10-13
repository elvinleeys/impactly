import path from 'node:path';
import { compareStrings } from '../core/paths.js';
import type { DiffData, Hunk, ImpactData, ReviewFinding, ReviewRule } from '../core/types.js';
import { isGlobalConfig } from '../impact/classify.js';
import { isCodeFile } from '../impact/parseModule.js';
import type { CodeSignals } from './scan.js';

/** A PR this large is hard to review well. Lockfiles are not counted. */
export const LARGE_PR = { files: 30, lines: 800 } as const;

export interface ReviewInput {
  diff: DiffData;
  /** Impact data, when that analysis succeeded. */
  impact?: ImpactData;
  /** Code signals on lines the PR added, per head path (only files that were scanned). */
  signals: ReadonlyMap<string, CodeSignals>;
}

const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']);
const TEST_FILE = /(^|\/)(__tests__|__mocks__|tests?|e2e|cypress|playwright)\/|\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$/;

export function isTestFile(repoPath: string): boolean {
  return TEST_FILE.test(repoPath);
}

/** Line numbers `hunks` added in the head version of a file. Pure. */
export function addedLineNumbers(hunks: readonly Hunk[]): Set<number> {
  const lines = new Set<number>();
  for (const hunk of hunks) for (let line = hunk.newStart; line < hunk.newStart + hunk.newLines; line++) lines.add(line);
  return lines;
}

/** Keeps only the signals on the given lines. Pure. */
export function onLines(signals: CodeSignals, lines: ReadonlySet<number>): CodeSignals {
  const keep = (found: readonly number[]): number[] => found.filter((line) => lines.has(line));
  return { debugger: keep(signals.debugger), consoleLog: keep(signals.consoleLog), anyType: keep(signals.anyType), todo: keep(signals.todo) };
}

/** Which signal each line rule reads, and for which files it applies. Tests may log and use `any`. */
const LINE_RULES: readonly { rule: ReviewRule; signal: keyof CodeSignals; inTests: boolean }[] = [
  { rule: 'debugger', signal: 'debugger', inTests: true },
  { rule: 'console-log', signal: 'consoleLog', inTests: false },
  { rule: 'any-type', signal: 'anyType', inTests: false },
  { rule: 'todo', signal: 'todo', inTests: true },
];

/** Applies the review rules to the PR's facts. Only reports what the data shows. Pure. */
export function reviewFindings(input: ReviewInput): ReviewFinding[] {
  const { diff, impact, signals } = input;
  const findings: ReviewFinding[] = [];

  for (const candidate of impact?.candidates ?? []) {
    if (candidate.reason !== 'imports-deleted') continue;
    const removed = candidate.via[candidate.via.length - 1];
    findings.push({ rule: 'deleted-still-imported', file: candidate.path, ...(removed === undefined ? {} : { related: [removed] }) });
  }
  for (const { file, specifier } of impact?.unresolved ?? []) findings.push({ rule: 'unresolved-import', file, specifier });

  for (const [file, found] of [...signals].sort(([a], [b]) => compareStrings(a, b))) {
    for (const { rule, signal, inTests } of LINE_RULES) {
      if (!inTests && isTestFile(file)) continue;
      const hits = found[signal];
      const first = hits[0];
      if (first !== undefined) findings.push({ rule, file, line: first, count: hits.length });
    }
  }

  const counted = diff.files.filter((file) => !LOCKFILES.has(path.posix.basename(file.path)));
  const lines = counted.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);
  if (diff.totals.files > LARGE_PR.files || lines > LARGE_PR.lines) {
    findings.push({ rule: 'large-pr', count: lines });
  }

  const configs = diff.files.filter((file) => file.change !== 'deleted' && isGlobalConfig(file.path)).map((file) => file.path);
  if (configs.length > 0) findings.push({ rule: 'config-change', related: configs });

  const sourceChanged = diff.files.some((file) => isCodeFile(file.path) && !isTestFile(file.path) && file.change !== 'deleted');
  const testChanged = diff.files.some((file) => isTestFile(file.path));
  const changedPaths = new Set(diff.files.map((file) => file.path));
  const affectedTests = (impact?.candidates ?? [])
    .filter((candidate) => candidate.certainty !== 'unknown' && isTestFile(candidate.path) && !changedPaths.has(candidate.path))
    .map((candidate) => candidate.path);
  if (affectedTests.length > 0) findings.push({ rule: 'tests-to-run', related: affectedTests });
  else if (sourceChanged && !testChanged && impact !== undefined) findings.push({ rule: 'no-tests' });

  return findings;
}
