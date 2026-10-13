import type { ChangeKind, ChangedFile, Hunk } from '../core/types.js';

/** Pure parsers for `git diff` output. All take NUL-separated (`-z`) output where applicable. */

export interface NameStatusEntry {
  change: ChangeKind;
  path: string;
  oldPath?: string;
  similarity?: number;
}

const STATUS_KIND: Readonly<Record<string, ChangeKind>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};

export interface ParseIssue {
  detail: string;
}

/** Parses `git diff --name-status -z`. Unknown status letters are reported as issues instead of guessed. */
export function parseNameStatus(output: string): { entries: NameStatusEntry[]; issues: ParseIssue[] } {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries: NameStatusEntry[] = [];
  const issues: ParseIssue[] = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++] ?? '';
    const letter = status.charAt(0);
    const change = STATUS_KIND[letter];
    const pairs = letter === 'R' || letter === 'C';
    if (pairs) {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (change === undefined || oldPath === undefined || path === undefined) {
        issues.push({ detail: `Truncated name-status record for status "${status}"` });
        break;
      }
      const entry: NameStatusEntry = { change, path, oldPath };
      const score = Number.parseInt(status.slice(1), 10);
      if (Number.isFinite(score)) entry.similarity = score;
      entries.push(entry);
      continue;
    }
    const path = tokens[i++];
    if (path === undefined) {
      issues.push({ detail: `Truncated name-status record for status "${status}"` });
      break;
    }
    if (change === undefined) {
      issues.push({ detail: `Unsupported git status "${status}" for ${path}; file not analysed` });
      continue;
    }
    entries.push({ change, path });
  }
  return { entries, issues };
}

export interface NumstatEntry {
  path: string;
  oldPath?: string;
  additions: number | null;
  deletions: number | null;
}

/** Parses `git diff --numstat -z`. Binary files report `-` and map to null counts. */
export function parseNumstat(output: string): NumstatEntry[] {
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const entries: NumstatEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const record = tokens[i++] ?? '';
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(record);
    if (!match) continue;
    const additions = match[1] === '-' ? null : Number(match[1]);
    const deletions = match[2] === '-' ? null : Number(match[2]);
    const inlinePath = match[3] ?? '';
    if (inlinePath === '') {
      // Renames and copies: the two paths follow as separate NUL-terminated tokens.
      const oldPath = tokens[i++];
      const path = tokens[i++];
      if (oldPath === undefined || path === undefined) break;
      entries.push({ path, oldPath, additions, deletions });
    } else {
      entries.push({ path: inlinePath, additions, deletions });
    }
  }
  return entries;
}

export interface PatchBlock {
  binary: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Splits a unified patch into per-file blocks (in git's output order) and extracts hunk ranges.
 * File names are not parsed from the patch; callers pair blocks with name-status entries by order.
 */
export function parsePatch(patch: string): PatchBlock[] {
  const blocks: PatchBlock[] = [];
  let current: PatchBlock | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { binary: false, hunks: [] };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      const match = HUNK_HEADER.exec(line);
      if (match) {
        current.hunks.push({
          oldStart: Number(match[1]),
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newLines: match[4] === undefined ? 1 : Number(match[4]),
        });
      }
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      current.binary = true;
    }
  }
  return blocks;
}

/**
 * Combines the three git views of the same diff into ChangedFile records.
 * `patchBlocks` is null when the patch was not collected (e.g. over the size limit);
 * hunks are then reported as null rather than empty.
 */
export function combineDiff(
  entries: readonly NameStatusEntry[],
  numstat: readonly NumstatEntry[],
  patchBlocks: readonly PatchBlock[] | null,
): { files: ChangedFile[]; issues: ParseIssue[] } {
  const issues: ParseIssue[] = [];
  const counts = new Map<string, NumstatEntry>();
  for (const entry of numstat) counts.set(entry.path, entry);

  const blocksUsable = patchBlocks !== null && patchBlocks.length === entries.length;
  if (patchBlocks !== null && !blocksUsable) {
    issues.push({
      detail: `Patch has ${patchBlocks.length} file blocks but name-status has ${entries.length} entries; line ranges omitted`,
    });
  }

  const files = entries.map((entry, index): ChangedFile => {
    const stat = counts.get(entry.path);
    const block = blocksUsable ? patchBlocks[index] : undefined;
    const binary = (stat !== undefined && stat.additions === null) || block?.binary === true;
    const file: ChangedFile = {
      path: entry.path,
      change: entry.change,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      binary,
      hunks: block && !binary ? block.hunks : null,
    };
    if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
    if (entry.similarity !== undefined) file.similarity = entry.similarity;
    if (stat === undefined) issues.push({ detail: `No line counts reported for ${entry.path}` });
    return file;
  });
  return { files, issues };
}
