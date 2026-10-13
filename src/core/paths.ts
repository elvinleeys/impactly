import path from 'node:path';

/**
 * Normalises a repository-relative path to POSIX form and rejects anything
 * that could escape the repository root. Returns null for unsafe paths.
 */
export function normalizeRepoPath(input: string): string | null {
  if (input.length === 0 || input.includes('\0')) return null;
  const slashed = input.replace(/\\/g, '/');
  // Absolute POSIX paths, UNC paths and Windows drive paths are never repository-relative.
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return null;
  const normalized = path.posix.normalize(slashed).replace(/\/+$/, '');
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

/** True when `target` (absolute) is `root` itself or lies inside it. */
export function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Locale-independent ordering by UTF-16 code units, so output order is identical on every machine. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
