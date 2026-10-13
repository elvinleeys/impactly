import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitError,
  GitOutputLimitError,
  parseCatFileBatch,
  readBlobs,
  resolveCommit,
  runGit,
  validateSha,
} from '../../src/git/runner.js';
import { listTree, parseLsTree } from '../../src/git/tree.js';
import { createRepo, type TestRepo } from '../helpers/repo.js';

describe('validateSha', () => {
  it('accepts abbreviated, SHA-1 and SHA-256 ids and lower-cases them', () => {
    expect(validateSha('ABCDEF0')).toBe('abcdef0');
    expect(validateSha(` ${'a'.repeat(40)} `)).toBe('a'.repeat(40));
    expect(validateSha('b'.repeat(64))).toBe('b'.repeat(64));
  });

  it.each(['', 'abc', 'HEAD', 'main', '--output=/tmp/x', 'abcdefg', 'a'.repeat(65), 'abcdef0;rm -rf /', 'abcdef0^{tree}'])(
    'rejects %j',
    (value) => {
      expect(() => validateSha(value)).toThrow(TypeError);
    },
  );
});

describe('parseCatFileBatch', () => {
  it('parses consecutive blobs including empty and binary content, skipping missing objects', () => {
    const binary = Buffer.from([0, 10, 255]);
    const output = Buffer.concat([
      Buffer.from('aaa blob 5\nhello\n'),
      Buffer.from('bbb missing\n'),
      Buffer.from('ccc blob 0\n\n'),
      Buffer.from('ddd blob 3\n'),
      binary,
      Buffer.from('\n'),
    ]);
    const blobs = parseCatFileBatch(output);
    expect(blobs.map((blob) => [blob.oid, blob.content.toString('hex')])).toEqual([
      ['aaa', Buffer.from('hello').toString('hex')],
      ['ccc', ''],
      ['ddd', binary.toString('hex')],
    ]);
  });

  it('stops at a truncated blob instead of reading past the buffer', () => {
    expect(parseCatFileBatch(Buffer.from('aaa blob 10\nshort'))).toEqual([]);
  });
});

describe('parseLsTree', () => {
  it('classifies blobs, symlinks and submodules', () => {
    const output =
      '100644 blob 1111111      12\tsrc/a b.ts\0' +
      '120000 blob 2222222       5\tlink\0' +
      '160000 commit 3333333       -\tvendor/sub\0' +
      'garbage\0';
    expect(parseLsTree(output)).toEqual([
      { path: 'src/a b.ts', type: 'blob', oid: '1111111', size: 12 },
      { path: 'link', type: 'symlink', oid: '2222222', size: 5 },
      { path: 'vendor/sub', type: 'submodule', oid: '3333333', size: null },
    ]);
  });
});

describe('git process helpers', () => {
  let repo: TestRepo;
  let head: string;

  beforeAll(() => {
    repo = createRepo();
    repo.write({ 'a.txt': 'alpha\n', 'dir/b.txt': 'x'.repeat(2000) });
    head = repo.commit();
  });
  afterAll(() => { repo.cleanup(); });

  it('runGit returns stdout and wraps failures in GitError', async () => {
    expect((await runGit(['rev-parse', 'HEAD'], { cwd: repo.dir })).trim()).toBe(head);
    await expect(runGit(['not-a-command'], { cwd: repo.dir })).rejects.toBeInstanceOf(GitError);
  });

  it('runGit enforces the output limit', async () => {
    await expect(runGit(['show', 'HEAD:dir/b.txt'], { cwd: repo.dir, maxBuffer: 100 })).rejects.toBeInstanceOf(
      GitOutputLimitError,
    );
  });

  it('resolveCommit expands abbreviated ids and rejects unknown commits', async () => {
    expect(await resolveCommit(head.slice(0, 10), repo.dir)).toBe(head);
    await expect(resolveCommit('0'.repeat(40), repo.dir)).rejects.toThrow(/was not found/);
    await expect(resolveCommit('HEAD', repo.dir)).rejects.toThrow(TypeError);
  });

  it('listTree and readBlobs read committed content from the object database', async () => {
    const tree = await listTree(head, repo.dir);
    expect(tree.map((entry) => entry.path)).toEqual(['a.txt', 'dir/b.txt']);
    const blobs = await readBlobs(
      tree.map((entry) => entry.oid),
      repo.dir,
      1,
    );
    expect(blobs.get(tree[0]?.oid ?? '')?.toString()).toBe('alpha\n');
    expect(blobs.get(tree[1]?.oid ?? '')?.length).toBe(2000);
  });

  it('readBlobs rejects invalid object ids before calling git', async () => {
    await expect(readBlobs(['not-an-oid'], repo.dir)).rejects.toThrow(TypeError);
  });
});
