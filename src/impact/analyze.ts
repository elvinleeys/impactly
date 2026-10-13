import path from 'node:path';
import { compareStrings, normalizeRepoPath } from '../core/paths.js';
import { failed, section } from '../core/result.js';
import type { DiffData, Evidence, ImpactCandidate, ImpactData, Limits, Section, Status } from '../core/types.js';
import { readBlobs } from '../git/runner.js';
import { listTree, type TreeEntry } from '../git/tree.js';
import { seedsFromDiff } from './classify.js';
import { isConfigFile, loadResolverConfig } from './config.js';
import { computeImpact, sortCandidates } from './graph.js';
import { isCodeFile, parseModule, type ModuleSyntax } from './parseModule.js';
import { createResolver, type RepoSnapshot } from './resolve.js';
import { buildSymbolEdges, type ResolvedImport, type ResolvedModule, type ResolvedReexport } from './symbols.js';

export interface ImpactInput {
  cwd: string;
  diff: DiffData;
  limits: Limits;
}

/**
 * Builds the import graph of the head commit (read from git objects, not the working tree)
 * and finds files that import the changed files directly or transitively.
 */
export async function analyzeImpact(input: ImpactInput): Promise<Section<ImpactData>> {
  const evidence: Evidence[] = [];
  try {
    const { limits, diff } = input;
    let status: Status = 'ok';
    const reasons: string[] = [];
    const truncate = (reason: string): void => {
      status = 'truncated';
      reasons.push(reason);
      evidence.push({ source: 'limits', detail: reason });
    };

    if (diff.totals.files > diff.files.length) {
      truncate(`Impact computed for ${diff.files.length} of ${diff.totals.files} changed files`);
    }

    const tree = selectEntries(await listTree(diff.head, input.cwd), evidence);
    const changed = new Set(diff.files.map((file) => file.path));
    let codeEntries = tree.filter((entry) => isCodeFile(entry.path));
    const totalCodeFiles = codeEntries.length;
    const oversized = codeEntries.filter((entry) => (entry.size ?? 0) > limits.maxFileBytes);
    if (oversized.length > 0) {
      evidence.push({
        source: 'limits',
        detail: `${oversized.length} source files over ${limits.maxFileBytes} bytes were not parsed (e.g. ${oversized[0]?.path ?? ''})`,
      });
      codeEntries = codeEntries.filter((entry) => (entry.size ?? 0) <= limits.maxFileBytes);
    }
    // Config files are read first (they drive resolution), then changed files, so that their own imports
    // are always analysed when a limit cuts the graph short.
    const configEntries = tree.filter(
      (entry) => (isConfigFile(entry.path) || path.posix.basename(entry.path) === 'package.json') && (entry.size ?? 0) <= limits.maxFileBytes,
    );
    codeEntries.sort((a, b) => Number(changed.has(b.path)) - Number(changed.has(a.path)) || compareStrings(a.path, b.path));
    const budget = { bytes: 0 };
    const withinBudget = (entry: TreeEntry): boolean => {
      const size = entry.size ?? 0;
      if (budget.bytes + size > limits.maxTotalBytes) return false;
      budget.bytes += size;
      return true;
    };
    const readableConfigs = takeWhile(configEntries, withinBudget);
    const foundCode = codeEntries.length;
    codeEntries = takeWhile(codeEntries.slice(0, limits.maxGraphNodes), withinBudget);
    if (readableConfigs.length < configEntries.length || codeEntries.length < Math.min(foundCode, limits.maxGraphNodes)) {
      truncate(`Read limit of ${limits.maxTotalBytes} bytes reached; remaining files were not parsed`);
    }
    if (foundCode > limits.maxGraphNodes) {
      truncate(`${foundCode} source files found; only ${limits.maxGraphNodes} were parsed`);
    }

    const toRead = [...readableConfigs, ...codeEntries];
    const blobs = await readBlobs([...new Set(toRead.map((entry) => entry.oid))], input.cwd);
    const contents = new Map<string, string>();
    for (const entry of toRead) {
      const blob = blobs.get(entry.oid);
      if (blob !== undefined) contents.set(entry.path, blob.toString('utf8'));
    }

    // Deleted files and old rename paths stay resolvable so that importers still pointing at them are found.
    const removedPaths = diff.files.flatMap((file) =>
      file.change === 'deleted' ? [file.path] : file.change === 'renamed' && file.oldPath !== undefined ? [file.oldPath] : [],
    );
    const snapshot: RepoSnapshot = {
      paths: new Set([...tree.map((entry) => entry.path), ...removedPaths]),
      read: (repoPath) => contents.get(repoPath),
    };
    const { config, evidence: configEvidence } = loadResolverConfig(snapshot);
    evidence.push(...configEvidence);
    const resolver = createResolver(snapshot, config);

    const modules = new Map<string, ResolvedModule>();
    const unknown: ImpactCandidate[] = [];
    const changedOrRemoved = [...changed, ...removedPaths];
    let unresolvedSpecifiers = 0;
    let opaqueDynamicImports = 0;
    let analyzedFiles = 0;

    const unparsable: string[] = [];
    for (const entry of codeEntries) {
      const content = contents.get(entry.path);
      if (content === undefined) continue;
      let parsed: ModuleSyntax;
      try {
        parsed = parseModule(entry.path, content);
      } catch {
        // e.g. pathologically nested code overflowing the parser's stack; isolate it to this file.
        unparsable.push(entry.path);
        continue;
      }
      analyzedFiles++;
      const resolveTarget = (specifier: string): string | null => {
        const resolution = resolver.resolve(entry.path, specifier);
        if (resolution.kind === 'internal') return resolution.path;
        if (resolution.kind === 'unresolved') {
          unresolvedSpecifiers++;
          // Only changed files are reported: an unresolved import there may be a break the PR introduced.
          if (changed.has(entry.path)) {
            evidence.push({ source: 'import-graph', detail: `${entry.path}: ${resolution.reason}` });
          }
        }
        return null;
      };
      const imports: ResolvedImport[] = [];
      for (const { specifier, ...rest } of parsed.imports) {
        const target = resolveTarget(specifier);
        if (target !== null) imports.push({ target, ...rest });
      }
      const reexports: ResolvedReexport[] = [];
      for (const { specifier, ...rest } of parsed.reexports) {
        const target = resolveTarget(specifier);
        if (target !== null) reexports.push({ target, ...rest });
      }
      modules.set(entry.path, {
        imports,
        reexports,
        localExports: parsed.localExports === null ? null : new Set(parsed.localExports),
      });
      for (const dynamic of parsed.dynamic) {
        const directory = dynamicTargetDirectory(entry.path, dynamic.staticPrefix);
        if (directory === null) {
          opaqueDynamicImports++;
          continue;
        }
        const target = changedOrRemoved.find((file) => file.startsWith(`${directory}/`));
        if (target !== undefined) {
          unknown.push({ path: entry.path, certainty: 'unknown', reason: 'dynamic-import', depth: 1, via: [entry.path, target] });
        }
      }
    }
    if (unparsable.length > 0) {
      truncate(`${unparsable.length} source files could not be parsed and their imports are unknown (e.g. ${unparsable[0] ?? ''})`);
    }
    if (opaqueDynamicImports > 0) {
      evidence.push({
        source: 'import-graph',
        detail: `${opaqueDynamicImports} dynamic import()/require() calls have no static path and were not followed`,
      });
    }

    const edges = buildSymbolEdges(modules);
    const result = computeImpact(seedsFromDiff(diff.files), edges, limits.maxDepth);
    if (result.depthLimited) truncate(`Dependents beyond depth ${limits.maxDepth} were not explored`);

    const candidates = new Map(result.candidates.map((candidate) => [candidate.path, candidate]));
    for (const candidate of unknown) {
      // A resolved relationship always wins over an unknown one for the same file.
      if (!candidates.has(candidate.path)) candidates.set(candidate.path, candidate);
    }

    const data: ImpactData = {
      candidates: sortCandidates([...candidates.values()]),
      stats: {
        analyzedFiles,
        skippedFiles: totalCodeFiles - analyzedFiles,
        edges: edges.length,
        unresolvedSpecifiers,
      },
    };
    return section(status, data, evidence, reasons.length > 0 ? reasons.join('; ') : undefined);
  } catch (error) {
    return failed(error, evidence);
  }
}

/** Keeps regular files with safe paths outside node_modules; records what was dropped. */
function selectEntries(entries: readonly TreeEntry[], evidence: Evidence[]): TreeEntry[] {
  const selected: TreeEntry[] = [];
  let links = 0;
  for (const entry of entries) {
    if (entry.type !== 'blob') {
      links++;
      continue;
    }
    const safe = normalizeRepoPath(entry.path);
    if (safe === null) {
      evidence.push({ source: 'paths', detail: `Rejected unsafe path ${JSON.stringify(entry.path)}` });
      continue;
    }
    if (safe.split('/').includes('node_modules')) continue;
    selected.push({ ...entry, path: safe });
  }
  if (links > 0) evidence.push({ source: 'paths', detail: `${links} symlinks/submodules were not followed` });
  return selected;
}

/** Directory a dynamic import with a relative static prefix can load from, or null if unknown. */
export function dynamicTargetDirectory(fromFile: string, staticPrefix: string | null): string | null {
  if (staticPrefix === null || !(staticPrefix.startsWith('./') || staticPrefix.startsWith('../'))) return null;
  const prefixDir = staticPrefix.endsWith('/') ? staticPrefix : path.posix.dirname(staticPrefix);
  const directory = normalizeRepoPath(path.posix.join(path.posix.dirname(fromFile), prefixDir));
  return directory;
}

function takeWhile<T>(items: readonly T[], predicate: (item: T) => boolean): T[] {
  const taken: T[] = [];
  for (const item of items) {
    if (!predicate(item)) break;
    taken.push(item);
  }
  return taken;
}
