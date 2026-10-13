import path from 'node:path';
import type { ChangedFile } from '../core/types.js';
import type { Seed, SeedKind } from './graph.js';
import { isCodeFile } from './parseModule.js';

const GLOBAL_CONFIG_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lock',
  'bun.lockb',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.browserslistrc',
]);

/**
 * Files that change how the whole project is installed, built or configured. Their effect
 * cannot be bounded by the import graph. Pure.
 */
export function isGlobalConfig(repoPath: string): boolean {
  const name = path.posix.basename(repoPath);
  return (
    GLOBAL_CONFIG_NAMES.has(name) ||
    /^[tj]sconfig[^/]*\.json$/.test(name) ||
    /^\.env(\..+)?$/.test(name) ||
    /^\.babelrc(\..+)?$/.test(name) ||
    /\.config\.(?:[cm]?[jt]s|json)$/.test(name)
  );
}

export function seedKind(repoPath: string): Exclude<SeedKind, 'removed'> {
  if (isGlobalConfig(repoPath)) return 'config';
  return isCodeFile(repoPath) ? 'code' : 'asset';
}

/** Turns changed files into search seeds. Deleted files and old rename paths become `removed` seeds. Pure. */
export function seedsFromDiff(files: readonly ChangedFile[]): Seed[] {
  const seeds: Seed[] = [];
  for (const file of files) {
    if (file.change === 'deleted') {
      seeds.push({ path: file.path, kind: 'removed', listed: true });
      continue;
    }
    seeds.push({ path: file.path, kind: seedKind(file.path), listed: true });
    if (file.change === 'renamed' && file.oldPath !== undefined) {
      seeds.push({ path: file.oldPath, kind: 'removed', listed: false });
    }
  }
  return seeds;
}
