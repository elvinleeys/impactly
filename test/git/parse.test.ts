import { describe, expect, it } from 'vitest';
import { combineDiff, parseNameStatus, parseNumstat, parsePatch } from '../../src/git/parse.js';

describe('parseNameStatus', () => {
  it('parses all supported statuses including renames and copies', () => {
    const output = 'A\0new.ts\0M\0mod.ts\0D\0gone.ts\0R087\0old.ts\0renamed.ts\0C100\0src.ts\0copy.ts\0T\0link\0';
    expect(parseNameStatus(output)).toEqual({
      entries: [
        { change: 'added', path: 'new.ts' },
        { change: 'modified', path: 'mod.ts' },
        { change: 'deleted', path: 'gone.ts' },
        { change: 'renamed', path: 'renamed.ts', oldPath: 'old.ts', similarity: 87 },
        { change: 'copied', path: 'copy.ts', oldPath: 'src.ts', similarity: 100 },
        { change: 'type-changed', path: 'link' },
      ],
      issues: [],
    });
  });

  it('keeps paths with spaces, tabs and non-ASCII characters intact', () => {
    expect(parseNameStatus('M\0a b\tc/한글.ts\0').entries).toEqual([{ change: 'modified', path: 'a b\tc/한글.ts' }]);
  });

  it('reports unknown statuses instead of guessing', () => {
    const result = parseNameStatus('U\0conflict.ts\0M\0ok.ts\0');
    expect(result.entries).toEqual([{ change: 'modified', path: 'ok.ts' }]);
    expect(result.issues[0]?.detail).toContain('Unsupported git status "U"');
  });

  it('reports truncated records', () => {
    expect(parseNameStatus('R100\0only-old.ts\0').issues).toHaveLength(1);
    expect(parseNameStatus('M').issues).toHaveLength(1);
  });

  it('returns nothing for empty output', () => {
    expect(parseNameStatus('')).toEqual({ entries: [], issues: [] });
  });
});

describe('parseNumstat', () => {
  it('parses counts, binary files and renames', () => {
    const output = '3\t1\tsrc/a.ts\0-\t-\timg.png\0' + '2\t0\t\0old.ts\0new.ts\0';
    expect(parseNumstat(output)).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'img.png', additions: null, deletions: null },
      { path: 'new.ts', oldPath: 'old.ts', additions: 2, deletions: 0 },
    ]);
  });

  it('ignores malformed records', () => {
    expect(parseNumstat('garbage\0')).toEqual([]);
  });
});

describe('parsePatch', () => {
  it('extracts hunk ranges per file block, defaulting omitted counts to 1', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      'index 1..2 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      '-x',
      '+y',
      '+z',
      '@@ -10,0 +12,3 @@ function f() {',
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/mode.sh b/mode.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    expect(parsePatch(patch)).toEqual([
      {
        binary: false,
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2 },
          { oldStart: 10, oldLines: 0, newStart: 12, newLines: 3 },
        ],
      },
      { binary: true, hunks: [] },
      { binary: false, hunks: [] },
    ]);
  });

  it('returns no blocks for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

describe('combineDiff', () => {
  const entries = [
    { change: 'modified' as const, path: 'a.ts' },
    { change: 'renamed' as const, path: 'b2.ts', oldPath: 'b.ts', similarity: 90 },
  ];
  const numstat = [
    { path: 'a.ts', additions: 1, deletions: 1 },
    { path: 'b2.ts', oldPath: 'b.ts', additions: 0, deletions: 0 },
  ];
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 };

  it('pairs patch blocks with entries by order', () => {
    const { files, issues } = combineDiff(entries, numstat, [
      { binary: false, hunks: [hunk] },
      { binary: false, hunks: [] },
    ]);
    expect(issues).toEqual([]);
    expect(files).toEqual([
      { path: 'a.ts', change: 'modified', additions: 1, deletions: 1, binary: false, hunks: [hunk] },
      { path: 'b2.ts', oldPath: 'b.ts', similarity: 90, change: 'renamed', additions: 0, deletions: 0, binary: false, hunks: [] },
    ]);
  });

  it('reports null hunks when the patch is missing or does not line up', () => {
    expect(combineDiff(entries, numstat, null).files.every((file) => file.hunks === null)).toBe(true);
    const mismatched = combineDiff(entries, numstat, [{ binary: false, hunks: [hunk] }]);
    expect(mismatched.files.every((file) => file.hunks === null)).toBe(true);
    expect(mismatched.issues[0]?.detail).toContain('1 file blocks but name-status has 2');
  });

  it('marks binary files and leaves their counts null', () => {
    const { files } = combineDiff([{ change: 'added', path: 'x.png' }], [{ path: 'x.png', additions: null, deletions: null }], [
      { binary: true, hunks: [] },
    ]);
    expect(files[0]).toMatchObject({ binary: true, additions: null, deletions: null, hunks: null });
  });

  it('reports files without line counts', () => {
    expect(combineDiff([{ change: 'added', path: 'x.ts' }], [], null).issues[0]?.detail).toContain('No line counts');
  });
});
