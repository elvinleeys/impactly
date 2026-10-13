import { failed, section } from '../core/result.js';
import type { DiffData, Evidence, ImpactData, Limits, ReviewData, Section } from '../core/types.js';
import { readBlobs } from '../git/runner.js';
import { listTree } from '../git/tree.js';
import { isCodeFile } from '../impact/parseModule.js';
import { addedLineNumbers, onLines, reviewFindings } from './rules.js';
import { scanCode, type CodeSignals } from './scan.js';

export interface ReviewRunInput {
  cwd: string;
  diff: DiffData;
  impact?: ImpactData;
  limits: Limits;
}

/**
 * Scans the changed code files of the head commit (from git objects, not the working tree) and
 * applies the review rules to what the PR added. Files without line ranges, over the size limit,
 * or that the parser cannot handle are not scanned; that is recorded instead of reported as clean.
 */
export async function runReview(input: ReviewRunInput): Promise<Section<ReviewData>> {
  const evidence: Evidence[] = [];
  try {
    const { diff, limits } = input;
    // Pure renames and mode changes have no added lines; files without line ranges cannot be scanned.
    const withLines = diff.files.filter((file) => file.change !== 'deleted' && isCodeFile(file.path) && !file.binary && file.hunks?.length !== 0);
    const entries = new Map((await listTree(diff.head, input.cwd)).map((entry) => [entry.path, entry]));
    const toRead = withLines.flatMap((file) => {
      const entry = entries.get(file.path);
      const readable = file.hunks !== null && entry?.type === 'blob' && (entry.size ?? 0) <= limits.maxFileBytes;
      return readable ? [{ file, oid: entry.oid }] : [];
    });
    const skipped = withLines.length - toRead.length;
    const blobs = await readBlobs([...new Set(toRead.map((item) => item.oid))], input.cwd);

    const signals = new Map<string, CodeSignals>();
    let unparsable = 0;
    for (const { file, oid } of toRead) {
      const blob = blobs.get(oid);
      if (blob === undefined) continue;
      try {
        signals.set(file.path, onLines(scanCode(file.path, blob.toString('utf8')), addedLineNumbers(file.hunks ?? [])));
      } catch {
        unparsable++;
      }
    }

    let reason: string | undefined;
    const notScanned = skipped + unparsable;
    if (notScanned > 0) {
      reason = `${notScanned} changed code files were not scanned (no line ranges, over ${limits.maxFileBytes} bytes, or unparsable)`;
      evidence.push({ source: 'limits', detail: reason });
    }
    const findings = reviewFindings({ diff, signals, ...(input.impact === undefined ? {} : { impact: input.impact }) });
    return section(notScanned > 0 ? 'truncated' : 'ok', { findings }, evidence, reason);
  } catch (error) {
    return failed(error, evidence);
  }
}
