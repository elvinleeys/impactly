import path from 'node:path';
import ts from 'typescript';
import type { Evidence } from '../core/types.js';
import { VIRTUAL_ROOT, type RepoSnapshot, type ResolverConfig } from './resolve.js';

const CONFIG_CANDIDATES = ['tsconfig.json', 'jsconfig.json'] as const;

/** True for files the config loader may need (root configs and the configs they extend). */
export function isConfigFile(repoPath: string): boolean {
  return /(^|\/)[tj]sconfig[^/]*\.json$/.test(repoPath);
}

/**
 * Reads baseUrl/paths from the repository's root tsconfig.json or jsconfig.json, following
 * `extends` within the repository. Configs extended from packages are not available and are
 * reported in the evidence. Pure with respect to the snapshot.
 */
export function loadResolverConfig(snapshot: RepoSnapshot): { config: ResolverConfig; evidence: Evidence[] } {
  const evidence: Evidence[] = [];
  const file = CONFIG_CANDIDATES.find((name) => snapshot.paths.has(name));
  if (file === undefined) {
    evidence.push({ source: 'config', detail: 'No root tsconfig.json or jsconfig.json; path aliases are not resolved' });
    return { config: {}, evidence };
  }
  const text = snapshot.read(file);
  if (text === undefined) {
    evidence.push({ source: 'config', detail: `${file} could not be read; path aliases are not resolved` });
    return { config: {}, evidence };
  }

  const toAbsolute = (rel: string): string => path.posix.join(VIRTUAL_ROOT, rel);
  const toRepo = (absolute: string): string | null => {
    const normalized = absolute.replace(/\\/g, '/');
    if (normalized === VIRTUAL_ROOT) return '.';
    return normalized.startsWith(`${VIRTUAL_ROOT}/`) ? normalized.slice(VIRTUAL_ROOT.length + 1) : null;
  };
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    fileExists: (f) => {
      const rel = toRepo(f);
      return rel !== null && snapshot.paths.has(rel);
    },
    readFile: (f) => {
      const rel = toRepo(f);
      return rel === null ? undefined : snapshot.read(rel);
    },
    // File lists (include/exclude) are irrelevant for resolution.
    readDirectory: () => [],
  };

  const parsedJson = ts.parseConfigFileTextToJson(toAbsolute(file), text);
  if (parsedJson.error) {
    evidence.push({ source: 'config', detail: `${file} is not valid JSON; path aliases are not resolved` });
    return { config: {}, evidence };
  }
  const parsed = ts.parseJsonConfigFileContent(parsedJson.config, host, VIRTUAL_ROOT, undefined, toAbsolute(file));
  for (const diagnostic of parsed.errors) {
    if (diagnostic.code === 18003) continue; // "No inputs were found" — expected, readDirectory is stubbed.
    evidence.push({
      source: 'config',
      detail: `${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    });
  }

  const config: ResolverConfig = {};
  // baseUrl is deprecated in TypeScript 6 but existing projects still declare it, so it must be read.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const { baseUrl, paths } = parsed.options;
  if (baseUrl !== undefined) {
    const rel = toRepo(baseUrl);
    if (rel !== null) config.baseUrl = rel;
  }
  if (paths !== undefined) {
    config.paths = paths;
    // pathsBasePath is set by the parser to the directory of the config that declared `paths`.
    const basePath = (parsed.options as { pathsBasePath?: unknown }).pathsBasePath;
    const rel = typeof basePath === 'string' ? toRepo(basePath) : null;
    config.pathsBase = rel ?? path.posix.dirname(file);
  }
  evidence.push({
    source: 'config',
    detail: `Module resolution uses ${file} (${paths ? `${Object.keys(paths).length} path aliases` : 'no path aliases'})`,
  });
  return { config, evidence };
}
