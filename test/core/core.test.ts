import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, resolveLimits } from '../../src/core/limits.js';
import { compareStrings, isWithinRoot, normalizeRepoPath } from '../../src/core/paths.js';
import { errorMessage, failed, section, skipped } from '../../src/core/result.js';

describe('resolveLimits', () => {
  it('returns defaults when nothing is overridden', () => {
    expect(resolveLimits()).toEqual(DEFAULT_LIMITS);
  });

  it('applies valid overrides', () => {
    expect(resolveLimits({ maxDepth: 2 }).maxDepth).toBe(2);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %s', (value) => {
    expect(() => resolveLimits({ maxFiles: value })).toThrow(RangeError);
  });
});

describe('normalizeRepoPath', () => {
  it.each([
    ['src/a.ts', 'src/a.ts'],
    ['src\\b\\c.ts', 'src/b/c.ts'],
    ['./src/../lib/x.ts', 'lib/x.ts'],
    ['dir/', 'dir'],
    ['한글 경로/파일 이름.tsx', '한글 경로/파일 이름.tsx'],
  ])('normalises %j', (input, expected) => {
    expect(normalizeRepoPath(input)).toBe(expected);
  });

  it.each(['', '.', './', '..', '../x', 'a/../../x', '/etc/passwd', 'C:\\Windows', 'c:/x', '\\\\server\\share', 'a\0b'])(
    'rejects %j',
    (input) => {
      expect(normalizeRepoPath(input)).toBeNull();
    },
  );
});

describe('isWithinRoot', () => {
  const root = path.resolve('repo');
  it('accepts the root and children', () => {
    expect(isWithinRoot(root, root)).toBe(true);
    expect(isWithinRoot(root, path.join(root, 'a', 'b.ts'))).toBe(true);
  });
  it('rejects siblings and parents', () => {
    expect(isWithinRoot(root, path.resolve('repo-other'))).toBe(false);
    expect(isWithinRoot(root, path.join(root, '..'))).toBe(false);
  });
});

describe('compareStrings', () => {
  it('orders by code unit regardless of locale', () => {
    expect(['b', 'README.md', 'a', 'package.json', 'B'].sort(compareStrings)).toEqual(['B', 'README.md', 'a', 'b', 'package.json']);
  });
});

describe('result helpers', () => {
  it('section omits undefined data and reason', () => {
    expect(section('ok', undefined, [])).toEqual({ status: 'ok', evidence: [] });
    expect(section('truncated', 1, [], 'why')).toEqual({ status: 'truncated', data: 1, evidence: [], reason: 'why' });
  });
  it('skipped is never ok', () => {
    expect(skipped('later')).toEqual({ status: 'skipped', reason: 'later', evidence: [] });
  });
  it('failed records the error message', () => {
    expect(failed(new Error('boom'))).toEqual({ status: 'failed', reason: 'boom', evidence: [] });
    expect(errorMessage('plain')).toBe('plain');
  });
});
