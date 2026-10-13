import type { Certainty, Report } from '../core/types.js';
import type { AddedLines } from './diff.js';

/**
 * The AI review's output contract and its verification. The model's answer is untrusted: it may be
 * wrong, or steered by instructions hidden in the PR. Everything that names code must point at a
 * line the PR really added (checked by quoting it), everything that names a file must be a file
 * the analysis knows, and facts the model cannot know (what was executed or measured) are not
 * taken from it at all. Pure.
 */

export type AiSeverity = 'must' | 'consider' | 'info';

export interface AiSuggestion {
  severity: AiSeverity;
  file: string;
  line: number;
  /** What is wrong, in plain Korean. */
  problem: string;
  /** How to fix it, in plain Korean. */
  suggestion: string;
  /** Optional replacement code. */
  code?: string;
}

export interface AiReviewData {
  summary: string;
  changedAreas: { area: string; files: string[] }[];
  /** Files the analysis already lists; certainty always comes from the analysis, not the model. */
  potentialImpacts: { file: string; certainty: Certainty; reason: string }[];
  suggestions: AiSuggestion[];
  /** Recommended, never executed. */
  recommendedTests: string[];
  uncertainties: string[];
}

export interface VerifiedReview {
  data: AiReviewData;
  /** Model items dropped because they did not match the PR (missing file, line or quote). */
  dropped: number;
}

/** JSON schema of the `submit_review` tool the model must call. */
export const REVIEW_TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'changed_areas',
    'potential_impacts',
    'review_suggestions',
    'recommended_tests',
    'executed_checks',
    'performance_changes',
    'evidence',
    'uncertainties',
  ],
  properties: {
    summary: { type: 'string', description: '이 PR이 무엇을 바꾸는지 2~3문장의 쉬운 한국어 요약' },
    changed_areas: {
      type: 'array',
      items: {
        type: 'object',
        required: ['area', 'files'],
        properties: { area: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
      },
    },
    potential_impacts: {
      type: 'array',
      description: '입력의 impact 목록에 있는 파일만. certainty는 입력 값을 그대로 쓴다.',
      items: {
        type: 'object',
        required: ['file', 'certainty', 'reason'],
        properties: {
          file: { type: 'string' },
          certainty: { type: 'string', enum: ['confirmed', 'possible', 'unknown'] },
          reason: { type: 'string' },
        },
      },
    },
    review_suggestions: {
      type: 'array',
      description: '이 PR에서 추가된 줄에 대한 리뷰 제안. quote는 그 줄의 코드를 그대로 복사한다.',
      items: {
        type: 'object',
        required: ['severity', 'file', 'line', 'quote', 'problem', 'suggestion'],
        properties: {
          severity: { type: 'string', enum: ['must', 'consider', 'info'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          quote: { type: 'string' },
          problem: { type: 'string' },
          suggestion: { type: 'string' },
          suggested_code: { type: 'string' },
        },
      },
    },
    recommended_tests: { type: 'array', items: { type: 'string' } },
    executed_checks: { type: 'array', description: '입력에 실행 기록이 없으면 빈 배열', items: { type: 'string' } },
    performance_changes: { type: 'array', description: '측정 데이터가 없으면 빈 배열', items: { type: 'string' } },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'quote'],
        properties: { file: { type: 'string' }, line: { type: 'integer' }, quote: { type: 'string' } },
      },
    },
    uncertainties: { type: 'array', items: { type: 'string' } },
  },
} as const;

const LIMITS = { suggestions: 8, areas: 8, impacts: 15, tests: 6, uncertainties: 6, text: 400, code: 1_500, quote: 300 } as const;
const SEVERITIES: readonly AiSeverity[] = ['must', 'consider', 'info'];

/**
 * Keeps only what can be checked against the PR. A suggestion survives only if its quote is found
 * on an added line of that file; if the quote sits on another added line, the line is corrected.
 */
export function verifyAiOutput(raw: unknown, report: Report, added: AddedLines): VerifiedReview {
  const root = asObject(raw);
  if (root === null) throw new Error('The model did not return an object');
  let dropped = 0;

  const changedFiles = new Set((report.diff.data?.files ?? []).map((file) => file.path));
  const candidates = new Map((report.impact.data?.candidates ?? []).map((c) => [c.path, c.certainty]));

  const suggestions: AiSuggestion[] = [];
  for (const item of asArray(root.review_suggestions)) {
    const s = asObject(item);
    const severity = typeof s?.severity === 'string' && (SEVERITIES as readonly string[]).includes(s.severity) ? (s.severity as AiSeverity) : null;
    const file = text(s?.file, 1_000);
    const problem = text(s?.problem, LIMITS.text);
    const suggestion = text(s?.suggestion, LIMITS.text);
    const line = locate(added.get(file ?? ''), typeof s?.line === 'number' ? s.line : 0, text(s?.quote, LIMITS.quote));
    if (severity === null || file === null || problem === null || suggestion === null || line === null || !changedFiles.has(file)) {
      dropped++;
      continue;
    }
    const code = text(s?.suggested_code, LIMITS.code);
    suggestions.push({ severity, file, line, problem, suggestion, ...(code === null ? {} : { code }) });
  }
  if (suggestions.length > LIMITS.suggestions) suggestions.length = LIMITS.suggestions;

  const changedAreas: AiReviewData['changedAreas'] = [];
  for (const item of asArray(root.changed_areas).slice(0, LIMITS.areas)) {
    const a = asObject(item);
    const area = text(a?.area, LIMITS.text);
    const files = asArray(a?.files).filter((f): f is string => typeof f === 'string' && changedFiles.has(f));
    if (area === null) dropped++;
    else changedAreas.push({ area, files });
  }

  const potentialImpacts: AiReviewData['potentialImpacts'] = [];
  for (const item of asArray(root.potential_impacts)) {
    const p = asObject(item);
    const file = text(p?.file, 1_000);
    const reason = text(p?.reason, LIMITS.text);
    const certainty = file === null ? undefined : candidates.get(file);
    if (file === null || reason === null || certainty === undefined) {
      dropped++;
      continue;
    }
    if (potentialImpacts.length < LIMITS.impacts) potentialImpacts.push({ file, certainty, reason });
  }

  // Quotes in `evidence` are checked like suggestions; unverifiable ones only count as dropped.
  for (const item of asArray(root.evidence)) {
    const e = asObject(item);
    const file = text(e?.file, 1_000);
    if (file === null || locate(added.get(file), typeof e?.line === 'number' ? e.line : 0, text(e?.quote, LIMITS.quote)) === null) dropped++;
  }

  return {
    data: {
      summary: text(root.summary, LIMITS.text * 2) ?? '',
      changedAreas,
      potentialImpacts,
      suggestions,
      recommendedTests: strings(root.recommended_tests, LIMITS.tests),
      uncertainties: strings(root.uncertainties, LIMITS.uncertainties),
    },
    dropped,
  };
}

/** The added line the quote is on: the given line if it matches, else the first added line that does. */
function locate(lines: ReadonlyMap<number, string> | undefined, line: number, quote: string | null): number | null {
  if (lines === undefined || quote === null) return null;
  const needle = quote.trim();
  if (needle.length < 3) return null;
  if (lines.get(line)?.includes(needle) === true) return line;
  for (const [number, content] of lines) if (content.includes(needle)) return number;
  return null;
}

function strings(value: unknown, max: number): string[] {
  return asArray(value)
    .map((item) => text(item, LIMITS.text))
    .filter((item): item is string => item !== null)
    .slice(0, max);
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
