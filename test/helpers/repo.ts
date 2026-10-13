import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TestRepo {
  dir: string;
  git(...args: string[]): string;
  write(files: Record<string, string | Buffer>): void;
  remove(...files: string[]): void;
  commit(message?: string): string;
  cleanup(): void;
}

/** Creates a throwaway git repository with deterministic identity and settings. */
export function createRepo(): TestRepo {
  const dir = mkdtempSync(path.join(tmpdir(), 'impactly-test-'));
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
        GIT_CONFIG_NOSYSTEM: '1',
      },
    });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'core.autocrlf', 'false');
  git('config', 'core.symlinks', 'false');
  git('config', 'commit.gpgsign', 'false');

  return {
    dir,
    git,
    write(files) {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(dir, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    },
    remove(...files) {
      for (const file of files) rmSync(path.join(dir, file));
    },
    commit(message = 'commit') {
      git('add', '--all');
      git('commit', '--quiet', '--allow-empty', '-m', message);
      return git('rev-parse', 'HEAD').trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
