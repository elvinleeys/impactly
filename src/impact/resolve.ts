import path from 'node:path';
import ts from 'typescript';
import { normalizeRepoPath } from '../core/paths.js';

/**
 * Module resolution over an in-memory view of a commit. Nothing touches the
 * real file system, so resolution cannot follow symlinks or leave the repository.
 */

/** Virtual root the repository is mounted at for the TypeScript resolver. */
export const VIRTUAL_ROOT = '/__repo__';
const ROOT = VIRTUAL_ROOT;

export interface RepoSnapshot {
  /** Every repository-relative POSIX path that exists (or, for ghosts, existed) in the analysed commit. */
  paths: ReadonlySet<string>;
  /** Returns text content for files that were loaded (source files, package.json, tsconfig). */
  read(path: string): string | undefined;
}

export type Resolution =
  | { kind: 'internal'; path: string }
  | { kind: 'external' }
  | { kind: 'unresolved'; reason: string };

export interface Resolver {
  resolve(fromFile: string, specifier: string): Resolution;
}

export interface ResolverConfig {
  /** Repository-relative baseUrl from tsconfig/jsconfig. */
  baseUrl?: string;
  paths?: Readonly<Record<string, readonly string[]>>;
  /** Repository-relative directory `paths` are relative to when there is no baseUrl (the config file's directory). */
  pathsBase?: string;
}

export function createResolver(snapshot: RepoSnapshot, config: ResolverConfig = {}): Resolver {
  const directories = collectDirectories(snapshot.paths);
  const toRepo = (absolute: string): string | null => {
    const normalized = absolute.replace(/\\/g, '/');
    return normalized.startsWith(`${ROOT}/`) ? normalized.slice(ROOT.length + 1) : null;
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => {
      const rel = toRepo(file);
      return rel !== null && snapshot.paths.has(rel);
    },
    readFile: (file) => {
      const rel = toRepo(file);
      return rel === null ? undefined : snapshot.read(rel);
    },
    directoryExists: (dir) => {
      const normalized = dir.replace(/\\/g, '/').replace(/\/$/, '');
      if (normalized === ROOT) return true;
      const rel = toRepo(normalized);
      return rel !== null && directories.has(rel);
    },
    realpath: (file) => file,
    getCurrentDirectory: () => ROOT,
    useCaseSensitiveFileNames: true,
  };

  // Resolution is deliberately lenient (Bundler mode, JS and JSON allowed) regardless of the
  // project's own settings: the goal is to find dependencies, not to type-check.
  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    resolveJsonModule: true,
    allowArbitraryExtensions: true,
  };
  // `baseUrl` is deprecated in TypeScript 6, so it is never passed on. Alias targets are rewritten
  // relative to the repository root (the host's current directory), and a project baseUrl is
  // emulated with a trailing `*` mapping, which TypeScript tries after every more specific alias.
  const aliasPaths = rebasePaths(config);
  const mappedPaths: ts.MapLike<string[]> = { ...aliasPaths };
  if (config.baseUrl !== undefined && mappedPaths['*'] === undefined) {
    mappedPaths['*'] = [path.posix.join(config.baseUrl, '*')];
  }
  if (Object.keys(mappedPaths).length > 0) options.paths = mappedPaths;
  const cache = ts.createModuleResolutionCache(ROOT, (name) => name, options);
  // Only the project's own aliases decide whether an unmatched specifier is a broken alias or a package.
  const aliases = Object.entries(aliasPaths);

  return {
    resolve(fromFile, specifier) {
      const containing = path.posix.join(ROOT, fromFile);
      const result = ts.resolveModuleName(specifier, containing, options, host, cache).resolvedModule;
      if (result) {
        const rel = toRepo(result.resolvedFileName);
        if (rel === null || result.isExternalLibraryImport === true || rel.split('/').includes('node_modules')) {
          return { kind: 'external' };
        }
        return { kind: 'internal', path: rel };
      }

      const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..';
      if (isRelative) {
        // Non-code assets (css, svg, json without resolveJsonModule hits, ...) referenced with their extension.
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
        if (!target.startsWith('../') && snapshot.paths.has(target)) return { kind: 'internal', path: target };
        return { kind: 'unresolved', reason: `Relative import "${specifier}" did not match any file` };
      }
      if (specifier.startsWith('/')) return { kind: 'unresolved', reason: `Absolute import "${specifier}" is not supported` };
      const matching = aliases.flatMap(([pattern, targets]) => {
        const wildcard = matchAlias(pattern, specifier);
        return wildcard === null ? [] : [{ wildcard, targets }];
      });
      if (matching.length > 0) {
        // Non-code assets through an alias (e.g. "@/styles.css"), which TypeScript itself does not resolve.
        for (const { wildcard, targets } of matching) {
          for (const target of targets) {
            const candidate = normalizeRepoPath(target.replace('*', wildcard));
            if (candidate !== null && snapshot.paths.has(candidate)) return { kind: 'internal', path: candidate };
          }
        }
        return { kind: 'unresolved', reason: `Path alias "${specifier}" did not match any file` };
      }
      // Bare specifiers are packages; node_modules is not part of the analysed tree.
      return { kind: 'external' };
    },
  };
}

function collectDirectories(paths: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>();
  for (const file of paths) {
    let dir = path.posix.dirname(file);
    while (dir !== '.' && !directories.has(dir)) {
      directories.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  return directories;
}

/**
 * Makes alias targets repository-relative: tsconfig resolves them against baseUrl, else the config's directory.
 * Patterns and targets with more than one `*` are invalid in tsconfig and are dropped (TypeScript reports them
 * as config diagnostics). The result has no prototype so keys such as "__proto__" stay ordinary entries.
 */
function rebasePaths(config: ResolverConfig): ts.MapLike<string[]> {
  const base = config.baseUrl ?? config.pathsBase ?? '.';
  const result = Object.create(null) as ts.MapLike<string[]>;
  for (const [key, targets] of Object.entries(config.paths ?? {})) {
    if (countStars(key) > 1) continue;
    const valid = targets.filter((target) => countStars(target) <= 1).map((target) => path.posix.join(base, target));
    if (valid.length > 0) result[key] = valid;
  }
  return result;
}

function countStars(value: string): number {
  return value.split('*').length - 1;
}

/**
 * Matches a tsconfig `paths` pattern (at most one `*`) against a specifier the way TypeScript does:
 * exact match, or prefix + anything + suffix. Returns the text matched by `*`, or null.
 * Plain string comparison keeps matching linear for any pattern found in an untrusted config.
 */
export function matchAlias(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return null;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}
