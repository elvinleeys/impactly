import { compareStrings } from '../core/paths.js';
import type { Certainty, ImpactCandidate, ImpactReason } from '../core/types.js';

/** `from` imports (or re-exports from) `to`. Both are repository-relative paths. */
export interface ImportEdge {
  from: string;
  to: string;
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

export function buildReverseIndex(edges: readonly ImportEdge[]): Map<string, string[]> {
  const reverse = new Map<string, string[]>();
  for (const { from, to } of edges) {
    if (from === to) continue;
    const importers = reverse.get(to);
    if (importers === undefined) reverse.set(to, [from]);
    else if (!importers.includes(from)) importers.push(from);
  }
  for (const importers of reverse.values()) importers.sort();
  return reverse;
}

/**
 * Breadth-first search over the reverse import graph starting from the changed files.
 * Direct importers of a changed file are `confirmed`; anything further is `possible`,
 * because a dependency on a dependency does not mean the change propagates. Pure.
 */
export function computeImpact(seeds: readonly Seed[], edges: readonly ImportEdge[], maxDepth: number): ImpactResult {
  const reverse = buildReverseIndex(edges);
  const found = new Map<string, ImpactCandidate>();
  const sortedSeeds = [...seeds].sort((a, b) => compareStrings(a.path, b.path));

  for (const seed of sortedSeeds) {
    if (!seed.listed || found.has(seed.path)) continue;
    found.set(seed.path, seedCandidate(seed, (reverse.get(seed.path) ?? []).length > 0));
  }

  let frontier = sortedSeeds.map((seed) => ({ path: seed.path, kind: seed.kind, via: [seed.path] }));
  const expanded = new Set(frontier.map((node) => node.path));
  let depthLimited = false;

  for (let depth = 1; frontier.length > 0; depth++) {
    if (depth > maxDepth) {
      depthLimited = frontier.some((node) => (reverse.get(node.path) ?? []).some((importer) => !expanded.has(importer)));
      break;
    }
    const next: typeof frontier = [];
    for (const node of frontier) {
      for (const importer of reverse.get(node.path) ?? []) {
        if (expanded.has(importer)) continue;
        expanded.add(importer);
        const via = [importer, ...node.via];
        found.set(importer, {
          path: importer,
          certainty: depth === 1 ? 'confirmed' : 'possible',
          reason: depth === 1 ? directReason(node.kind) : 'transitive',
          depth,
          via,
        });
        next.push({ path: importer, kind: node.kind, via });
      }
    }
    frontier = next;
  }

  return { candidates: sortCandidates([...found.values()]), depthLimited };
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
