import type {
  Certainty,
  ChangedFile,
  ChangeKind,
  DiffData,
  Hunk,
  ImpactCandidate,
  ImpactData,
  ImpactReason,
  Report,
  ReviewData,
  ReviewFinding,
  ReviewRule,
  Section,
  Status,
  UnresolvedImport,
} from '../core/types.js';

/**
 * Validates a report produced by a PR run. That run executes the PR's own code, so for a fork PR
 * the report is attacker-controlled. Only known fields with the expected types and sane sizes are
 * copied into a fresh object; free-text fields (`reason`, `evidence`) are dropped because the
 * renderer never shows them. Throws `ReportValidationError` on anything unexpected. Pure.
 */
export class ReportValidationError extends Error {
  override name = 'ReportValidationError';
}

const LIMITS = { items: 50_000, via: 64, string: 1_000, related: 1_000 } as const;
const STATUSES: readonly Status[] = ['ok', 'skipped', 'unsupported', 'failed', 'truncated'];
const CERTAINTIES: readonly Certainty[] = ['confirmed', 'possible', 'unknown'];
const CHANGES: readonly ChangeKind[] = ['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed'];
const REASONS: readonly ImpactReason[] = [
  'changed',
  'imports-changed',
  'imports-deleted',
  'transitive',
  're-exports',
  'dynamic-import',
  'config-change',
  'non-code-change',
];
const RULES: readonly ReviewRule[] = [
  'deleted-still-imported',
  'unresolved-import',
  'debugger',
  'console-log',
  'any-type',
  'todo',
  'large-pr',
  'config-change',
  'tests-to-run',
  'no-tests',
];

type Json = Record<string, unknown>;

export function validateReport(input: unknown): Report {
  const root = object(input, 'report');
  if (root.version !== 1) fail('report.version must be 1');
  return {
    version: 1,
    base: sha(root.base, 'report.base'),
    head: sha(root.head, 'report.head'),
    diff: sectionOf(root.diff, 'diff', diffData),
    impact: sectionOf(root.impact, 'impact', impactData),
    review: sectionOf(root.review, 'review', reviewData),
    tests: statusOnly(root.tests, 'tests'),
    bundle: statusOnly(root.bundle, 'bundle'),
  };
}

/** Sections that never carry data yet (tests, bundle). */
function statusOnly(value: unknown, where: string): Section<never> {
  return { status: oneOf(object(value, where).status, STATUSES, `${where}.status`), evidence: [] };
}

function sectionOf<T>(value: unknown, where: string, data: (value: unknown, where: string) => T | undefined): Section<T> {
  const section = object(value, where);
  const status = oneOf(section.status, STATUSES, `${where}.status`);
  const parsed = section.data === undefined ? undefined : data(section.data, `${where}.data`);
  return parsed === undefined ? { status, evidence: [] } : { status, data: parsed, evidence: [] };
}

function diffData(value: unknown, where: string): DiffData {
  const data = object(value, where);
  const totals = object(data.totals, `${where}.totals`);
  return {
    base: sha(data.base, `${where}.base`),
    head: sha(data.head, `${where}.head`),
    diffBase: sha(data.diffBase, `${where}.diffBase`),
    files: array(data.files, `${where}.files`, LIMITS.items).map((item, i) => changedFile(item, `${where}.files[${i}]`)),
    totals: { files: count(totals.files, 'totals.files'), additions: count(totals.additions, 'totals.additions'), deletions: count(totals.deletions, 'totals.deletions') },
  };
}

function changedFile(value: unknown, where: string): ChangedFile {
  const file = object(value, where);
  const result: ChangedFile = {
    path: text(file.path, `${where}.path`),
    change: oneOf(file.change, CHANGES, `${where}.change`),
    additions: file.additions === null ? null : count(file.additions, `${where}.additions`),
    deletions: file.deletions === null ? null : count(file.deletions, `${where}.deletions`),
    binary: bool(file.binary, `${where}.binary`),
    hunks: file.hunks === null ? null : array(file.hunks, `${where}.hunks`, LIMITS.items).map((h, i) => hunk(h, `${where}.hunks[${i}]`)),
  };
  if (file.oldPath !== undefined) result.oldPath = text(file.oldPath, `${where}.oldPath`);
  if (file.similarity !== undefined) result.similarity = count(file.similarity, `${where}.similarity`);
  return result;
}

function hunk(value: unknown, where: string): Hunk {
  const h = object(value, where);
  return {
    oldStart: count(h.oldStart, `${where}.oldStart`),
    oldLines: count(h.oldLines, `${where}.oldLines`),
    newStart: count(h.newStart, `${where}.newStart`),
    newLines: count(h.newLines, `${where}.newLines`),
  };
}

function impactData(value: unknown, where: string): ImpactData {
  const data = object(value, where);
  const stats = object(data.stats, `${where}.stats`);
  return {
    candidates: array(data.candidates, `${where}.candidates`, LIMITS.items).map((item, i) => candidate(item, `${where}.candidates[${i}]`)),
    unresolved: array(data.unresolved, `${where}.unresolved`, LIMITS.items).map((item, i) => unresolvedImport(item, `${where}.unresolved[${i}]`)),
    stats: {
      analyzedFiles: count(stats.analyzedFiles, 'stats.analyzedFiles'),
      skippedFiles: count(stats.skippedFiles, 'stats.skippedFiles'),
      edges: count(stats.edges, 'stats.edges'),
      unresolvedSpecifiers: count(stats.unresolvedSpecifiers, 'stats.unresolvedSpecifiers'),
    },
  };
}

function candidate(value: unknown, where: string): ImpactCandidate {
  const c = object(value, where);
  const via = array(c.via, `${where}.via`, LIMITS.via).map((p, i) => text(p, `${where}.via[${i}]`));
  if (via.length === 0) fail(`${where}.via must not be empty`);
  return {
    path: text(c.path, `${where}.path`),
    certainty: oneOf(c.certainty, CERTAINTIES, `${where}.certainty`),
    reason: oneOf(c.reason, REASONS, `${where}.reason`),
    depth: count(c.depth, `${where}.depth`),
    via,
  };
}

function unresolvedImport(value: unknown, where: string): UnresolvedImport {
  const u = object(value, where);
  return { file: text(u.file, `${where}.file`), specifier: text(u.specifier, `${where}.specifier`) };
}

function reviewData(value: unknown, where: string): ReviewData {
  const data = object(value, where);
  return { findings: array(data.findings, `${where}.findings`, LIMITS.items).map((item, i) => finding(item, `${where}.findings[${i}]`)) };
}

function finding(value: unknown, where: string): ReviewFinding {
  const f = object(value, where);
  const result: ReviewFinding = { rule: oneOf(f.rule, RULES, `${where}.rule`) };
  if (f.file !== undefined) result.file = text(f.file, `${where}.file`);
  if (f.line !== undefined) result.line = count(f.line, `${where}.line`);
  if (f.count !== undefined) result.count = count(f.count, `${where}.count`);
  if (f.specifier !== undefined) result.specifier = text(f.specifier, `${where}.specifier`);
  if (f.related !== undefined) {
    result.related = array(f.related, `${where}.related`, LIMITS.related).map((p, i) => text(p, `${where}.related[${i}]`));
  }
  return result;
}

function object(value: unknown, where: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Json;
}

function array(value: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  if (value.length > max) fail(`${where} has more than ${max} items`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.string) fail(`${where} must be a non-empty string up to ${LIMITS.string} characters`);
  return value;
}

function sha(value: unknown, where: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)) fail(`${where} must be a full commit SHA`);
  return value;
}

function count(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(`${where} must be a non-negative integer`);
  return value;
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(`${where} must be a boolean`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(`${where} has an unexpected value`);
  return value as T;
}

function fail(message: string): never {
  throw new ReportValidationError(message);
}
