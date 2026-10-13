import { runGit } from './runner.js';

export type TreeEntryType = 'blob' | 'symlink' | 'submodule';

export interface TreeEntry {
  path: string;
  type: TreeEntryType;
  oid: string;
  /** Blob size in bytes; null for submodules. */
  size: number | null;
}

/** Lists every entry of a commit's tree. Reads from the object database, not the working tree. */
export async function listTree(commit: string, cwd: string): Promise<TreeEntry[]> {
  const output = await runGit(['ls-tree', '-r', '-z', '-l', '--full-tree', '--end-of-options', commit], { cwd });
  return parseLsTree(output);
}

/** Parses `git ls-tree -r -z -l` output. Pure. */
export function parseLsTree(output: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of output.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, objectType, oid, sizeText] = record.slice(0, tab).split(/ +/);
    const path = record.slice(tab + 1);
    if (mode === undefined || oid === undefined) continue;
    let type: TreeEntryType;
    if (objectType === 'commit') type = 'submodule';
    else if (mode === '120000') type = 'symlink';
    else if (objectType === 'blob') type = 'blob';
    else continue;
    const size = sizeText === undefined || sizeText === '-' ? null : Number(sizeText);
    entries.push({ path, type, oid, size: Number.isSafeInteger(size) ? size : null });
  }
  return entries;
}
