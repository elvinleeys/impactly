import { execFile, spawn } from 'node:child_process';

const SHA_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * Options that keep git read-only and deterministic: no pager, no external diff
 * drivers or textconv filters (which could execute repository-configured programs),
 * and unquoted UTF-8 paths.
 */
const GIT_BASE_ARGS = ['-c', 'core.quotePath=false', '-c', 'diff.external=', '--no-pager'];

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Raised when git output exceeds the configured byte limit. */
export class GitOutputLimitError extends GitError {
  constructor(args: readonly string[], readonly limitBytes: number) {
    super(`git output exceeded ${limitBytes} bytes`, args, null);
    this.name = 'GitOutputLimitError';
  }
}

/** Validates a commit SHA supplied from outside (action inputs, CLI). Returns it lower-cased. */
export function validateSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(sha)) {
    throw new TypeError(`Invalid commit SHA: ${JSON.stringify(value)}`);
  }
  return sha;
}

export interface RunGitOptions {
  cwd: string;
  maxBuffer?: number;
}

/** Runs git without a shell. Arguments are passed as an array, never interpolated. */
export function runGit(args: readonly string[], options: RunGitOptions): Promise<string> {
  const fullArgs = [...GIT_BASE_ARGS, ...args];
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      { cwd: options.cwd, maxBuffer, encoding: 'utf8', windowsHide: true, shell: false },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if ((error as NodeJS.ErrnoException).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new GitOutputLimitError(args, maxBuffer));
          return;
        }
        const exitCode = typeof error.code === 'number' ? error.code : null;
        reject(new GitError(stderr.trim() || error.message, args, exitCode));
      },
    );
  });
}

/** Resolves a validated SHA to the full commit id, failing if it is not a commit in this repository. */
export async function resolveCommit(sha: string, cwd: string): Promise<string> {
  const valid = validateSha(sha);
  try {
    const out = await runGit(['rev-parse', '--verify', '--quiet', '--end-of-options', `${valid}^{commit}`], { cwd });
    return out.trim();
  } catch (error) {
    throw new GitError(`Commit ${valid} was not found. Fetch it first (actions/checkout with fetch-depth: 0).`, [
      'rev-parse',
      valid,
    ], error instanceof GitError ? error.exitCode : null);
  }
}

export interface BlobContent {
  oid: string;
  content: Buffer;
}

/**
 * Reads blobs through a single `git cat-file --batch` process per chunk.
 * Missing objects are skipped. Callers must bound the sizes of requested blobs.
 */
export async function readBlobs(oids: readonly string[], cwd: string, chunkSize = 500): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (let i = 0; i < oids.length; i += chunkSize) {
    const chunk = oids.slice(i, i + chunkSize).map(validateSha);
    const output = await spawnWithInput(['cat-file', '--batch'], `${chunk.join('\n')}\n`, cwd);
    for (const blob of parseCatFileBatch(output)) result.set(blob.oid, blob.content);
  }
  return result;
}

/** Parses `git cat-file --batch` output. Pure. */
export function parseCatFileBatch(output: Buffer): BlobContent[] {
  const blobs: BlobContent[] = [];
  let offset = 0;
  while (offset < output.length) {
    const newline = output.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = output.subarray(offset, newline).toString('utf8');
    offset = newline + 1;
    const parts = header.split(' ');
    if (parts[1] === 'missing' || parts.length !== 3) continue;
    const [oid, , sizeText] = parts as [string, string, string];
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || offset + size > output.length) break;
    blobs.push({ oid, content: output.subarray(offset, offset + size) });
    offset += size + 1; // content is followed by a newline
  }
  return blobs;
}

function spawnWithInput(args: readonly string[], input: string, cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...GIT_BASE_ARGS, ...args], { cwd, windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new GitError(stderr.trim() || `git exited with ${String(code)}`, args, code));
    });
    child.stdin.end(input);
  });
}
