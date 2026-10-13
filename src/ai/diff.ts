/**
 * Reads a unified diff (as returned by the GitHub API for a pull request) into the lines each
 * file added, so that AI suggestions can be checked against code that really is in the PR. Pure.
 */

/** Head path -> (head line number -> added line text). */
export type AddedLines = Map<string, Map<number, string>>;

export interface DiffExcerpt {
  /** Diff text sent to the model, cut at file boundaries to fit the budget. */
  text: string;
  /** Files included in `text`. */
  files: string[];
  /** Files left out because of the budget. */
  omitted: number;
}

interface FileDiff {
  path: string | null;
  text: string;
  added: Map<number, string>;
}

export function parseUnifiedDiff(diff: string): AddedLines {
  const result: AddedLines = new Map();
  for (const file of splitFiles(diff)) if (file.path !== null) result.set(file.path, file.added);
  return result;
}

/**
 * The diff restricted to files with added lines, in diff order, keeping whole files only while they
 * fit in `budget` characters. Files whose path cannot be read reliably (quoted names) are left out.
 */
export function diffExcerpt(diff: string, budget: number): DiffExcerpt {
  const files = splitFiles(diff).filter((file) => file.path !== null && file.added.size > 0);
  const parts: string[] = [];
  const included: string[] = [];
  let used = 0;
  for (const file of files) {
    if (used + file.text.length > budget) continue;
    parts.push(file.text);
    included.push(file.path ?? '');
    used += file.text.length;
  }
  return { text: parts.join('\n'), files: included, omitted: files.length - included.length };
}

function splitFiles(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;
  let lines: string[] = [];
  let newLine = 0;
  let inHunk = false;
  const flush = (): void => {
    if (current !== undefined) {
      current.text = lines.join('\n');
      files.push(current);
    }
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = { path: null, text: '', added: new Map() };
      lines = [line];
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;
    lines.push(line);
    if (!inHunk && line.startsWith('+++ ')) {
      // `+++ b/path` for normal names; git quotes unusual names ("b/...") and those are skipped.
      const target = line.slice(4);
      current.path = target.startsWith('b/') ? target.slice(2) : null;
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      current.added.set(newLine, line.slice(1));
      newLine++;
    } else if (line.startsWith(' ')) {
      newLine++;
    }
    // '-' lines and "\ No newline at end of file" do not advance the head side.
  }
  flush();
  return files;
}
