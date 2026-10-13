import { normalizeRepoPath } from '../core/paths.js';
import { failed, section } from '../core/result.js';
import type { ChangedFile, DiffData, Evidence, Limits, Section, Status } from '../core/types.js';
import { combineDiff, parseNameStatus, parseNumstat, parsePatch, type PatchBlock } from './parse.js';
import { GitOutputLimitError, resolveCommit, runGit } from './runner.js';

export interface DiffInput {
  baseSha: string;
  headSha: string;
  /** Repository working directory. */
  cwd: string;
  limits: Limits;
  /**
   * merge-base (default): compare head against the common ancestor, which is what a PR shows.
   * direct: compare base and head trees as-is.
   */
  mode?: 'merge-base' | 'direct';
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M', '-C'] as const;

/** Collects changed files, line counts and changed line ranges between two commits. */
export async function collectDiff(input: DiffInput): Promise<Section<DiffData>> {
  const evidence: Evidence[] = [];
  try {
    const base = await resolveCommit(input.baseSha, input.cwd);
    const head = await resolveCommit(input.headSha, input.cwd);

    let diffBase = base;
    if ((input.mode ?? 'merge-base') === 'merge-base') {
      diffBase = (await runGit(['merge-base', '--end-of-options', base, head], { cwd: input.cwd })).trim();
      evidence.push({ source: 'git', detail: `Diff taken from merge-base ${diffBase.slice(0, 12)} to head ${head.slice(0, 12)}` });
    } else {
      evidence.push({ source: 'git', detail: `Diff taken directly from base ${base.slice(0, 12)} to head ${head.slice(0, 12)}` });
    }

    const range = ['--end-of-options', diffBase, head];
    const nameStatusOut = await runGit(['diff', ...DIFF_FLAGS, '--name-status', '-z', ...range], { cwd: input.cwd });
    const numstatOut = await runGit(['diff', ...DIFF_FLAGS, '--numstat', '-z', ...range], { cwd: input.cwd });

    let status: Status = 'ok';
    let reason: string | undefined;
    let patchBlocks: PatchBlock[] | null = null;
    try {
      const patch = await runGit(['diff', ...DIFF_FLAGS, '--unified=0', ...range], {
        cwd: input.cwd,
        maxBuffer: input.limits.maxDiffBytes,
      });
      patchBlocks = parsePatch(patch);
    } catch (error) {
      if (!(error instanceof GitOutputLimitError)) throw error;
      status = 'truncated';
      reason = `Patch larger than ${input.limits.maxDiffBytes} bytes; changed line ranges omitted`;
      evidence.push({ source: 'limits', detail: reason });
    }

    const { entries, issues: statusIssues } = parseNameStatus(nameStatusOut);
    const { files: combined, issues: combineIssues } = combineDiff(entries, parseNumstat(numstatOut), patchBlocks);
    for (const issue of [...statusIssues, ...combineIssues]) evidence.push({ source: 'git', detail: issue.detail });

    const files = sanitizePaths(combined, evidence);
    let reported = files;
    if (files.length > input.limits.maxFiles) {
      reported = files.slice(0, input.limits.maxFiles);
      status = 'truncated';
      reason = `${files.length} files changed; only the first ${input.limits.maxFiles} are reported`;
      evidence.push({ source: 'limits', detail: reason });
    }

    const data: DiffData = { base, head, diffBase, files: reported, totals: summarize(files) };
    return section(status, data, evidence, reason);
  } catch (error) {
    return failed(error, evidence);
  }
}

function sanitizePaths(files: ChangedFile[], evidence: Evidence[]): ChangedFile[] {
  const safe: ChangedFile[] = [];
  for (const file of files) {
    const path = normalizeRepoPath(file.path);
    const oldPath = file.oldPath === undefined ? undefined : normalizeRepoPath(file.oldPath);
    if (path === null || oldPath === null) {
      evidence.push({ source: 'paths', detail: `Rejected unsafe path ${JSON.stringify(file.path)}` });
      continue;
    }
    const clean: ChangedFile = { ...file, path };
    if (oldPath !== undefined) clean.oldPath = oldPath;
    safe.push(clean);
  }
  return safe;
}

/** Totals over all changed files, including those beyond the report limit. Binary files count as 0 lines. */
export function summarize(files: readonly ChangedFile[]): DiffData['totals'] {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { files: files.length, additions, deletions };
}
