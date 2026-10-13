import { compareStrings } from '../core/paths.js';
import type { Certainty, ImpactCandidate, ImpactReason } from '../core/types.js';

/** A list of export names, or `'*'` for all of them. */
export type NameSet = '*' | readonly string[];

/**
 * `from` depends on code defined in `to`. Both are repository-relative paths.
 * - use: `from`'s own code uses a binding defined in `to` (or loads `to` as a whole).
 * - reexport: `from` only passes on a binding defined in `to` (a barrel file).
 * - through: `from` imports a binding that the barrel `to` passes on. This only matters when
 *   the barrel itself changed, since that can change what the binding refers to.
 * `through` lists the barrel files between them, e.g. `components/index.ts` for
 * `import { Button } from './components'`.
 */
export interface ImportEdge {
  from: string;
  to: string;
  kind?: EdgeKind;
  through?: readonly string[];
  /** Exports of `to` the edge depends on. Default: all. */
  names?: NameSet;
  /** Exports of `from` affected when those change. Default: all. */
  exports?: NameSet;
}

export type EdgeKind = 'use' | 'reexport' | 'through';

export interface ReverseEdge {
  from: string;
  kind: EdgeKind;
  through: readonly string[];
  names: NameSet;
  exports: NameSet;
}

export type SeedKind =
  /** A changed source file that exists in head. */
  | 'code'
  /** Deleted file, or the old path of a renamed file: importers still pointing at it may break. */
  | 'removed'
  /** Changed configuration that affects the build globally (package.json, tsconfig, *.config.*, .env). */
  | 'config'
  /** Changed non-code file (styles, assets, docs). */
  | 'asset';

export interface Seed {
  path: string;
  kind: SeedKind;
  /** False for seeds that should drive the search but not be listed (old path of a rename). */
  listed: boolean;
}

export interface ImpactResult {
  candidates: ImpactCandidate[];
  /** True when dependents beyond maxDepth exist and were not explored. */
  depthLimited: boolean;
}

const CERTAINTY_ORDER: Readonly<Record<Certainty, number>> = { confirmed: 0, possible: 1, unknown: 2 };

/** Maps each file to the edges of files depending on it, without duplicates or self-imports. */
export function buildReverseIndex(edges: readonly ImportEdge[]): Map<string, ReverseEdge[]> {
  const reverse = new Map<string, ReverseEdge[]>();
  const seen = new Set<string>();
  for (const { from, to, kind = 'use', through = [], names = '*', exports = '*' } of edges) {
    if (from === to) continue;
    const key = [to, from, kind, nameKey(names), nameKey(exports)].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    const importers = reverse.get(to);
    const edge: ReverseEdge = { from, kind, through, names, exports };
    if (importers === undefined) reverse.set(to, [edge]);
    else importers.push(edge);
  }
  for (const importers of reverse.values()) importers.sort((a, b) => compareStrings(a.from, b.from) || compareStrings(a.kind, b.kind));
  return reverse;
}

type Affected = '*' | ReadonlySet<string>;

interface FrontierNode {
  path: string;
  kind: SeedKind;
  via: string[];
  /** Exports of `path` that became affected in the previous step. */
  names: Affected;
}

/**
 * Breadth-first search over the reverse dependency graph starting from the changed files, at the
 * level of exported names: an importer is affected when it uses an affected export, and only its
 * exports whose code uses that import are passed on. Changed files have all exports affected.
 *
 * Files using a changed file directly are `confirmed`; anything further is `possible`, because a
 * dependency on a dependency does not mean the change propagates. Barrels that only re-export
 * affected code are listed but not expanded: their importers are linked to the code they use.
 * Depth counts `use` steps only. Pure.
 */
export function computeImpact(seeds: readonly Seed[], edges: readonly ImportEdge[], maxDepth: number): ImpactResult {
  const reverse = buildReverseIndex(edges);
  const found = new Map<string, ImpactCandidate>();
  const affected = new Map<string, '*' | Set<string>>();
  const sortedSeeds = [...seeds].sort((a, b) => compareStrings(a.path, b.path));

  for (const seed of sortedSeeds) {
    affected.set(seed.path, '*');
    if (!seed.listed || found.has(seed.path)) continue;
    found.set(seed.path, seedCandidate(seed, (reverse.get(seed.path) ?? []).length > 0));
  }

  let frontier: FrontierNode[] = sortedSeeds.map((seed) => ({ path: seed.path, kind: seed.kind, via: [seed.path], names: '*' }));
  let depthLimited = false;

  for (let depth = 1; frontier.length > 0; depth++) {
    // Passing through a barrel only counts when the barrel itself is a changed seed.
    const follows = (edge: ReverseEdge): boolean => edge.kind === 'use' || (edge.kind === 'through' && depth === 1);
    if (depth > maxDepth) {
      depthLimited = frontier.some((node) =>
        (reverse.get(node.path) ?? []).some((edge) => {
          if (!hits(edge.names, node.names)) return false;
          if (edge.kind === 'reexport') return !found.has(edge.from);
          return follows(edge) && (!found.has(edge.from) || grows(affected.get(edge.from), edge.exports));
        }),
      );
      break;
    }
    const certainty: Certainty = depth === 1 ? 'confirmed' : 'possible';
    const next = new Map<string, FrontierNode>();
    // Users first, so a file that both uses and re-exports affected code is reported as a user.
    for (const node of frontier) {
      for (const edge of reverse.get(node.path) ?? []) {
        if (!follows(edge) || !hits(edge.names, node.names)) continue;
        let candidate = found.get(edge.from);
        if (candidate === undefined) {
          const reason: ImpactReason = depth === 1 ? directReason(node.kind) : 'transitive';
          candidate = { path: edge.from, certainty, reason, depth, via: [edge.from, ...edge.through, ...node.via] };
          found.set(edge.from, candidate);
        }
        const delta = grow(affected, edge.from, edge.exports);
        if (delta === null) continue;
        const queued = next.get(edge.from);
        if (queued === undefined) next.set(edge.from, { path: edge.from, kind: node.kind, via: candidate.via, names: delta });
        else queued.names = queued.names === '*' || delta === '*' ? '*' : new Set([...queued.names, ...delta]);
      }
    }
    for (const node of frontier) {
      for (const edge of reverse.get(node.path) ?? []) {
        if (edge.kind !== 'reexport' || found.has(edge.from) || !hits(edge.names, node.names)) continue;
        const reason: ImpactReason = depth === 1 && node.kind === 'removed' ? 'imports-deleted' : 're-exports';
        found.set(edge.from, { path: edge.from, certainty, reason, depth, via: [edge.from, ...edge.through, ...node.via] });
      }
    }
    frontier = [...next.values()];
  }

  return { candidates: sortCandidates([...found.values()]), depthLimited };
}

/** Whether an edge depending on `names` is affected by a change to `changed`. */
function hits(names: NameSet, changed: Affected): boolean {
  return names === '*' || changed === '*' || names.some((name) => changed.has(name));
}

function grows(current: Affected | undefined, exports: NameSet): boolean {
  if (current === '*') return false;
  if (exports === '*') return true;
  return exports.some((name) => current?.has(name) !== true);
}

/** Adds `exports` to the affected exports of `file`; returns what was new, or null if nothing was. */
function grow(affected: Map<string, '*' | Set<string>>, file: string, exports: NameSet): Affected | null {
  const current = affected.get(file);
  if (current === '*') return null;
  if (exports === '*') {
    affected.set(file, '*');
    return '*';
  }
  const set = current ?? new Set<string>();
  affected.set(file, set);
  const delta = new Set(exports.filter((name) => !set.has(name)));
  for (const name of delta) set.add(name);
  return delta.size > 0 ? delta : null;
}

function nameKey(names: NameSet): string {
  return names === '*' ? '*' : names.join('\u0001');
}

function seedCandidate(seed: Seed, hasImporters: boolean): ImpactCandidate {
  // Config changes and unreferenced non-code files can affect the build in ways the
  // import graph cannot show, so their scope is reported as unknown rather than guessed.
  const unknownScope = seed.kind === 'config' || (seed.kind === 'asset' && !hasImporters);
  const reason: ImpactReason = seed.kind === 'config' ? 'config-change' : unknownScope ? 'non-code-change' : 'changed';
  return { path: seed.path, certainty: unknownScope ? 'unknown' : 'confirmed', reason, depth: 0, via: [seed.path] };
}

function directReason(kind: SeedKind): ImpactReason {
  return kind === 'removed' ? 'imports-deleted' : 'imports-changed';
}

export function sortCandidates(candidates: ImpactCandidate[]): ImpactCandidate[] {
  return candidates.sort(
    (a, b) =>
      a.depth - b.depth ||
      CERTAINTY_ORDER[a.certainty] - CERTAINTY_ORDER[b.certainty] ||
      compareStrings(a.path, b.path),
  );
}
