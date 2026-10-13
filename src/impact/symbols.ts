import type { ImportEdge } from './graph.js';
import type { Dependents } from './parseModule.js';

/**
 * Name-level linking: each imported name is followed through re-exports (barrel files) to the
 * file that defines it, so that importing `{ Modal }` from a barrel depends on `Modal.tsx` only,
 * not on everything else the barrel re-exports.
 */

export interface ResolvedImport {
  /** Repository-relative path the specifier resolved to. */
  target: string;
  /** Imported name, or null for the whole module. */
  imported: string | null;
  /** Exports of the importing module that use this import. */
  dependents: Dependents;
}

export type ResolvedReexport =
  | { target: string; kind: 'star' }
  | { target: string; kind: 'named'; imported: string; exported: string }
  | { target: string; kind: 'namespace'; exported: string };

export interface ResolvedModule {
  imports: readonly ResolvedImport[];
  reexports: readonly ResolvedReexport[];
  /** Null when the module's exports cannot be listed (CommonJS, `export =`). */
  localExports: ReadonlySet<string> | null;
}

/** A file that defines what was asked for: one name of it, or (null) the whole module. */
interface Origin {
  file: string;
  name: string | null;
  /** Barrel files passed on the way (excluding the importer and the defining file). */
  through: readonly string[];
}

/**
 * Turns parsed modules into dependency edges between the files that use code and the files that
 * define it, naming the definitions used and the importer's exports that use them. Files missing
 * from `modules` (assets, deleted paths, unparsed sources) are treated as defining every name they
 * are asked for. Whenever a name cannot be followed (unknown exports, a name no longer exported,
 * cycles), the edges fall back to the whole module, never to nothing. Pure.
 */
export function buildSymbolEdges(modules: ReadonlyMap<string, ResolvedModule>): ImportEdge[] {
  const names = exportNames(modules);
  const originMemo = new Map<string, Origin[]>();
  const closureMemo = new Map<string, Origin[]>();
  const visiting = new Set<string>();
  // Counts lookups cut short by a re-export cycle; results computed while one happened are partial and not memoised.
  let cycles = 0;

  /** Every module a whole-module import of `file` can reach through re-exports, including `file`. */
  const closure = (file: string): Origin[] => {
    const memo = closureMemo.get(file);
    if (memo) return memo;
    const result: Origin[] = [{ file, name: null, through: [] }];
    const seen = new Set([file]);
    for (let index = 0; index < result.length; index++) {
      const current = result[index];
      if (current === undefined) break;
      for (const reexport of modules.get(current.file)?.reexports ?? []) {
        if (seen.has(reexport.target)) continue;
        seen.add(reexport.target);
        result.push({ file: reexport.target, name: null, through: [...current.through, current.file] });
      }
    }
    closureMemo.set(file, result);
    return result;
  };

  const origins = (file: string, name: string): Origin[] => {
    const key = `${file}\0${name}`;
    const memo = originMemo.get(key);
    if (memo) return memo;
    const module = modules.get(file);
    if (module === undefined || module.localExports === null || module.localExports.has(name)) return [{ file, name, through: [] }];
    if (visiting.has(key)) {
      cycles++;
      return [];
    }
    visiting.add(key);
    const cyclesBefore = cycles;

    const result: Origin[] = [];
    const add = (found: readonly Origin[]): void => {
      for (const origin of found) result.push({ ...origin, through: [file, ...origin.through] });
    };
    for (const reexport of module.reexports) {
      if (reexport.kind === 'named' && reexport.exported === name) add(origins(reexport.target, reexport.imported));
      else if (reexport.kind === 'namespace' && reexport.exported === name) add(closure(reexport.target));
    }
    if (result.length === 0 && name !== 'default') {
      for (const reexport of module.reexports) {
        if (reexport.kind !== 'star') continue;
        const exported = names.get(reexport.target);
        if (exported === null || exported === undefined || exported.has(name)) add(origins(reexport.target, name));
      }
    }
    // Not found: maybe a name the PR stopped exporting, or one from an external package. Depend on
    // everything the module re-exports, so a removed export is not silently dropped.
    const final = result.length > 0 ? result : closure(file);

    visiting.delete(key);
    if (cycles === cyclesBefore) originMemo.set(key, final);
    return final;
  };

  const edges = new Map<string, ImportEdge>();
  const push = (edge: ImportEdge): void => {
    const key = [edge.from, edge.to, edge.kind, listKey(edge.names), listKey(edge.exports)].join('\0');
    if (!edges.has(key)) edges.set(key, edge);
  };
  const link = (from: string, found: readonly Origin[], kind: 'use' | 'reexport', exports: Dependents): void => {
    for (const origin of found) {
      push({ from, to: origin.file, kind, through: origin.through, names: origin.name === null ? '*' : [origin.name], exports });
      if (kind !== 'use') continue;
      origin.through.forEach((barrel, index) => {
        push({ from, to: barrel, kind: 'through', through: origin.through.slice(0, index), names: '*', exports });
      });
    }
  };

  for (const [file, module] of modules) {
    for (const { target, imported, dependents } of module.imports) {
      link(file, imported === null ? closure(target) : origins(target, imported), 'use', dependents);
    }
    for (const reexport of module.reexports) {
      if (reexport.kind === 'named') link(file, origins(reexport.target, reexport.imported), 'reexport', [reexport.exported]);
      else link(file, closure(reexport.target), 'reexport', reexport.kind === 'namespace' ? [reexport.exported] : '*');
    }
  }
  return [...edges.values()];
}

function listKey(list: Dependents | undefined): string {
  return list === undefined || list === '*' ? '*' : list.join('\u0001');
}

/**
 * Names each module exports, following `export *` (which never passes on `default`).
 * Null when any part cannot be listed. Computed as a fixed point, so cycles are fine. Pure.
 */
export function exportNames(modules: ReadonlyMap<string, ResolvedModule>): Map<string, ReadonlySet<string> | null> {
  const result = new Map<string, Set<string> | null>();
  for (const [file, module] of modules) {
    if (module.localExports === null) {
      result.set(file, null);
      continue;
    }
    const own = new Set(module.localExports);
    for (const reexport of module.reexports) if (reexport.kind !== 'star') own.add(reexport.exported);
    result.set(file, own);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [file, module] of modules) {
      const own = result.get(file);
      if (own === null || own === undefined) continue;
      for (const reexport of module.reexports) {
        if (reexport.kind !== 'star') continue;
        const theirs = result.get(reexport.target);
        if (theirs === null || theirs === undefined) {
          result.set(file, null);
          changed = true;
          break;
        }
        for (const name of theirs) {
          if (name === 'default' || own.has(name)) continue;
          own.add(name);
          changed = true;
        }
      }
    }
  }
  return result;
}
