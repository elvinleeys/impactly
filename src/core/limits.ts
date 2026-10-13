import type { Limits } from './types.js';

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  maxFiles: 3000,
  maxDiffBytes: 5 * 1024 * 1024,
  maxDepth: 5,
  maxGraphNodes: 20_000,
  maxFileBytes: 1024 * 1024,
});

/** Merges user overrides into the defaults, rejecting anything that is not a positive integer. */
export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Limit "${key}" must be a positive integer, got ${String(value)}`);
    }
    limits[key] = value;
  }
  return limits;
}
