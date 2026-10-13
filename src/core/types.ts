/**
 * Shared result types. Every analysis section carries a status, the reason it
 * ended in that status, and the evidence it is based on, so that nothing that
 * was not actually computed can be presented as a successful result.
 */

export type Status = 'ok' | 'skipped' | 'unsupported' | 'failed' | 'truncated';

/**
 * How sure the engine is that a file is affected.
 * - confirmed: a static import/export path to a changed file was resolved.
 * - possible: reached transitively; the dependency exists but the change may not propagate.
 * - unknown: the relationship could not be analysed (dynamic import, unresolved specifier, non-code change).
 */
export type Certainty = 'confirmed' | 'possible' | 'unknown';

export type EvidenceSource = 'git' | 'import-graph' | 'config' | 'limits' | 'paths';

export interface Evidence {
  source: EvidenceSource;
  detail: string;
}

export interface Section<T> {
  status: Status;
  data?: T;
  reason?: string;
  evidence: Evidence[];
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface ChangedFile {
  /** Repository-relative POSIX path in head (for deleted files: the path in base). */
  path: string;
  /** Previous path for renamed/copied files. */
  oldPath?: string;
  change: ChangeKind;
  /** Rename/copy similarity score reported by git (0-100). */
  similarity?: number;
  /** Null when git reports the file as binary. */
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Changed line ranges; null when the patch was not available (binary, truncated). */
  hunks: Hunk[] | null;
}

export interface DiffData {
  base: string;
  head: string;
  /** Commit the diff was taken from (merge-base of base and head, or base itself in direct mode). */
  diffBase: string;
  files: ChangedFile[];
  totals: { files: number; additions: number; deletions: number };
}

export type ImpactReason =
  | 'changed'
  | 'imports-changed'
  | 'imports-deleted'
  | 'transitive'
  /** A barrel file that passes on (re-exports) affected code without using it. */
  | 're-exports'
  | 'dynamic-import'
  | 'config-change'
  | 'non-code-change';

export interface ImpactCandidate {
  path: string;
  certainty: Certainty;
  reason: ImpactReason;
  /**
   * Number of files using code from the next one between this file and the nearest changed file
   * (0 = changed itself). Barrels that only re-export do not add depth; they still appear in `via`.
   */
  depth: number;
  /** Import chain from this file to the changed file it depends on, including barrels, e.g. [page.tsx, components/index.ts, Button.tsx]. */
  via: string[];
}

/** An import in a changed file that matches no file in the head commit. */
export interface UnresolvedImport {
  file: string;
  specifier: string;
}

export interface ImpactData {
  candidates: ImpactCandidate[];
  /** Unresolved imports in changed files (other files are not reported). */
  unresolved: UnresolvedImport[];
  stats: {
    analyzedFiles: number;
    skippedFiles: number;
    edges: number;
    unresolvedSpecifiers: number;
  };
}

export interface Limits {
  /** Maximum number of changed files to report. */
  maxFiles: number;
  /** Maximum size of the unified patch read from git. */
  maxDiffBytes: number;
  /** Maximum depth of the reverse-dependency search. */
  maxDepth: number;
  /** Maximum number of source files parsed for the import graph. */
  maxGraphNodes: number;
  /** Source files larger than this are not parsed. */
  maxFileBytes: number;
  /** Total bytes of source and config files read from git for the import graph. */
  maxTotalBytes: number;
}

/**
 * Rule-based review findings. They carry only structured facts (rule, paths, line numbers);
 * the human-readable text is produced by the report renderer, so a report coming from an
 * untrusted PR run cannot inject its own wording into a comment.
 */
export type ReviewRule =
  /** An importer still points at a deleted or renamed file. */
  | 'deleted-still-imported'
  /** A changed file imports something that matches no file. */
  | 'unresolved-import'
  /** An added `debugger` statement. */
  | 'debugger'
  /** Added console.log/debug/trace/dir calls outside tests. */
  | 'console-log'
  /** Added `any` types in TypeScript. */
  | 'any-type'
  /** Added TODO/FIXME/XXX/HACK comments. */
  | 'todo'
  /** Many files or lines changed in one PR. */
  | 'large-pr'
  /** Project-wide configuration changed. */
  | 'config-change'
  /** Test files that use the changed code (recommended to run; not executed). */
  | 'tests-to-run'
  /** Source code changed, but no related test file was changed or found. */
  | 'no-tests';

export interface ReviewFinding {
  rule: ReviewRule;
  /** File the finding is about, if any. */
  file?: string;
  /** First relevant line in the head version of `file`. */
  line?: number;
  /** How many times the pattern occurs in `file` (line rules), or the size measured (large-pr). */
  count?: number;
  /** Other files involved, e.g. the deleted file that is still imported. */
  related?: string[];
  /** Unresolved import specifier (unresolved-import only). */
  specifier?: string;
}

export interface ReviewData {
  findings: ReviewFinding[];
}

export interface Report {
  version: 1;
  base: string;
  head: string;
  diff: Section<DiffData>;
  impact: Section<ImpactData>;
  review: Section<ReviewData>;
  tests: Section<never>;
  bundle: Section<never>;
}
