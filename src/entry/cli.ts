#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Limits, Report } from '../core/types.js';
import { renderMarkdown } from '../report/markdown.js';
import { buildReport } from './run.js';

const USAGE = `Usage: impactly --base <sha> --head <sha> [options]

Options:
  --cwd <dir>          Repository directory (default: current directory)
  --mode <mode>        merge-base (default) or direct
  --max-depth <n>      Reverse dependency search depth
  --max-files <n>      Maximum changed files to report
  --text               Print a short text summary instead of JSON
  --markdown           Print the PR comment (Korean Markdown) instead of JSON
  -h, --help           Show this help`;

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Parses arguments and runs the analysis. Exit code 2 = usage error, 1 = a section failed. */
export async function runCli(argv: readonly string[]): Promise<CliResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        base: { type: 'string' },
        head: { type: 'string' },
        cwd: { type: 'string' },
        mode: { type: 'string' },
        'max-depth': { type: 'string' },
        'max-files': { type: 'string' },
        text: { type: 'boolean', default: false },
        markdown: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  if (values.help) return { exitCode: 0, stdout: `${USAGE}\n`, stderr: '' };
  if (values.base === undefined || values.head === undefined) return usageError('--base and --head are required');
  if (values.text && values.markdown) return usageError('--text and --markdown cannot be combined');
  if (values.mode !== undefined && values.mode !== 'merge-base' && values.mode !== 'direct') {
    return usageError('--mode must be "merge-base" or "direct"');
  }

  const limits: Partial<Limits> = {};
  for (const [flag, key] of [['max-depth', 'maxDepth'], ['max-files', 'maxFiles']] as const) {
    const raw = values[flag];
    if (raw === undefined) continue;
    if (!/^\d+$/.test(raw)) return usageError(`--${flag} must be a positive integer`);
    limits[key] = Number(raw);
  }

  try {
    const report = await buildReport({
      baseSha: values.base,
      headSha: values.head,
      cwd: values.cwd ?? process.cwd(),
      limits,
      ...(values.mode === undefined ? {} : { mode: values.mode }),
    });
    const failedSection = report.diff.status === 'failed' || report.impact.status === 'failed' || report.review.status === 'failed';
    const stdout = values.markdown ? renderMarkdown(report) : values.text ? formatText(report) : `${JSON.stringify(report, null, 2)}\n`;
    return { exitCode: failedSection ? 1 : 0, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `impactly: ${error instanceof Error ? error.message : String(error)}\n` };
  }
}

function usageError(message: string): CliResult {
  return { exitCode: 2, stdout: '', stderr: `impactly: ${message}\n\n${USAGE}\n` };
}

/** Plain-text summary for local debugging. The user-facing output is the Markdown comment (--markdown). */
export function formatText(report: Report): string {
  const lines = [`diff: ${report.diff.status}${report.diff.reason ? ` (${report.diff.reason})` : ''}`];
  for (const file of report.diff.data?.files ?? []) {
    const counts = file.binary ? 'binary' : `+${file.additions ?? '?'} -${file.deletions ?? '?'}`;
    lines.push(`  ${file.change.padEnd(12)} ${file.oldPath ? `${file.oldPath} -> ` : ''}${file.path} (${counts})`);
  }
  lines.push(`impact: ${report.impact.status}${report.impact.reason ? ` (${report.impact.reason})` : ''}`);
  for (const candidate of report.impact.data?.candidates ?? []) {
    lines.push(`  [${candidate.certainty}] ${candidate.path} — ${candidate.reason}, via ${candidate.via.join(' -> ')}`);
  }
  lines.push(`review: ${report.review.status}${report.review.reason ? ` (${report.review.reason})` : ''}`);
  for (const finding of report.review.data?.findings ?? []) {
    const where = `${finding.file ?? ''}${finding.line === undefined ? '' : `:${finding.line}`}`;
    lines.push(`  [${finding.rule}] ${where}${finding.related ? ` (${finding.related.join(', ')})` : ''}`);
  }
  for (const item of [...report.diff.evidence, ...report.impact.evidence, ...report.review.evidence]) {
    lines.push(`  · ${item.source}: ${item.detail}`);
  }
  lines.push(`tests: ${report.tests.status} (${report.tests.reason ?? ''})`, `bundle: ${report.bundle.status} (${report.bundle.reason ?? ''})`);
  return `${lines.join('\n')}\n`;
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
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
