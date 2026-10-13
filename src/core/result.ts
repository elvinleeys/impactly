import type { Evidence, Section, Status } from './types.js';

export function section<T>(status: Status, data: T | undefined, evidence: Evidence[], reason?: string): Section<T> {
  const result: Section<T> = { status, evidence };
  if (data !== undefined) result.data = data;
  if (reason !== undefined) result.reason = reason;
  return result;
}

/** A section that was intentionally not run. Never reported as `ok`. */
export function skipped<T>(reason: string): Section<T> {
  return { status: 'skipped', reason, evidence: [] };
}

export function failed<T>(error: unknown, evidence: Evidence[] = []): Section<T> {
  return { status: 'failed', reason: errorMessage(error), evidence };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
