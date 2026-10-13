import type { Report } from '../core/types.js';
import { diffExcerpt, parseUnifiedDiff } from './diff.js';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt.js';
import { REVIEW_TOOL_SCHEMA, verifyAiOutput, type AiReviewData } from './schema.js';

/**
 * Optional AI review with the repository owner's own Anthropic API key. It only ever sees the
 * analysis facts and the PR diff, never runs code, and its answer goes through `verifyAiOutput`.
 * Any failure ends in a section with a reason code; the rule-based comment is posted regardless.
 */

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const DIFF_BUDGET = 120_000;
const MAX_TOKENS = 4_096;
const TIMEOUT_MS = 120_000;

/** Why the AI review did not run or did not finish; rendered as Korean by the report. */
export type AiSkipReason = 'no-key' | 'author-not-allowed' | 'diff-unavailable' | 'empty-diff';
export type AiFailReason = 'invalid-key' | 'rate-limited' | 'api-error' | 'invalid-output';

export class AnthropicApiError extends Error {
  override name = 'AnthropicApiError';
  constructor(readonly status: number) {
    super(`Anthropic API returned ${status}`);
  }
}

export type AiSection =
  | { status: 'ok'; data: AiReviewData; dropped: number; omittedFiles: number }
  | { status: 'skipped'; reason: AiSkipReason }
  | { status: 'failed'; reason: AiFailReason };

export interface AiReviewInput {
  apiKey: string;
  model?: string;
  report: Report;
  /** Unified diff of the PR (from the GitHub API). */
  diff: string;
  fetchImpl?: typeof fetch;
}

export async function runAiReview(input: AiReviewInput): Promise<AiSection> {
  const excerpt = diffExcerpt(input.diff, DIFF_BUDGET);
  if (excerpt.files.length === 0) return { status: 'skipped', reason: 'empty-diff' };

  let raw: unknown;
  try {
    raw = await callClaude(input.apiKey, input.model ?? DEFAULT_MODEL, buildUserPrompt(input.report, excerpt), input.fetchImpl ?? fetch);
  } catch (error) {
    const status = error instanceof AnthropicApiError ? error.status : 0;
    return { status: 'failed', reason: status === 401 || status === 403 ? 'invalid-key' : status === 429 ? 'rate-limited' : 'api-error' };
  }
  try {
    const verified = verifyAiOutput(raw, input.report, parseUnifiedDiff(input.diff));
    return { status: 'ok', data: verified.data, dropped: verified.dropped, omittedFiles: excerpt.omitted };
  } catch {
    return { status: 'failed', reason: 'invalid-output' };
  }
}

/** Calls the Messages API, forcing the `submit_review` tool, and returns the tool input. */
export async function callClaude(apiKey: string, model: string, user: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: user }],
      tools: [{ name: 'submit_review', description: 'PR 리뷰 결과를 제출합니다.', input_schema: REVIEW_TOOL_SCHEMA }],
      tool_choice: { type: 'tool', name: 'submit_review' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new AnthropicApiError(response.status);
  const body = (await response.json()) as { content?: unknown };
  const blocks = Array.isArray(body.content) ? (body.content as unknown[]) : [];
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_use') {
      return (block as { input?: unknown }).input;
    }
  }
  throw new Error('The response contained no tool call');
}
