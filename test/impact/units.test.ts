import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../src/core/types.js';
import { dynamicTargetDirectory } from '../../src/impact/analyze.js';
import { isGlobalConfig, seedKind, seedsFromDiff } from '../../src/impact/classify.js';
import { isConfigFile, loadResolverConfig } from '../../src/impact/config.js';
import { buildReverseIndex, computeImpact, sortCandidates, type ImportEdge, type Seed } from '../../src/impact/graph.js';
import { isCodeFile, parseImports } from '../../src/impact/parseImports.js';
import { createResolver, matchAlias, type RepoSnapshot } from '../../src/impact/resolve.js';

function snapshot(files: Record<string, string>, extraPaths: string[] = []): RepoSnapshot {
  return { paths: new Set([...Object.keys(files), ...extraPaths]), read: (path) => files[path] };
}

describe('parseImports', () => {
  it('collects static imports, re-exports, require, literal import() and references', () => {
    const source = `
      /// <reference path="./globals.d.ts" />
      import a from './a';
      import type { B } from '@/b';
      export * from './c';
      export { d } from '../d.js';
      const e = require('./e');
      const f = await import('./f');
      import './styles.css';
    `;
    const parsed = parseImports('src/x.ts', source);
    expect(parsed.specifiers).toEqual([
      { text: './a', kind: 'static' },
      { text: '@/b', kind: 'static' },
      { text: './c', kind: 'static' },
      { text: '../d.js', kind: 'static' },
      { text: './e', kind: 'static' },
      { text: './f', kind: 'static' },
      { text: './styles.css', kind: 'static' },
      { text: './globals.d.ts', kind: 'reference' },
    ]);
    expect(parsed.dynamic).toEqual([]);
  });

  it('reports non-literal dynamic imports with their static prefix', () => {
    const source = [
      'const a = import(`./locales/${lang}.json`);',
      "const b = require('./plugins/' + name);",
      'const c = import(moduleName);',
      "const d = import('./literal');",
    ].join('\n');
    expect(parseImports('x.js', source).dynamic).toEqual([
      { staticPrefix: './locales/' },
      { staticPrefix: './plugins/' },
      { staticPrefix: null },
    ]);
  });

  it('parses JSX in .js and .tsx files without failing', () => {
    const parsed = parseImports('c.tsx', "import B from './B';\nexport const C = () => <B x={import(path)} />;");
    expect(parsed.specifiers).toEqual([{ text: './B', kind: 'static' }]);
    expect(parsed.dynamic).toEqual([{ staticPrefix: null }]);
  });

  it('isCodeFile recognises JS/TS extensions only', () => {
    expect(['a.ts', 'a.tsx', 'a.mts', 'a.cjs', 'a.jsx', 'a.d.ts'].every(isCodeFile)).toBe(true);
    expect(['a.css', 'a.json', 'a.vue', 'ts'].some(isCodeFile)).toBe(false);
  });
});

describe('createResolver', () => {
  const files = {
    'src/a.ts': '',
    'src/b/index.tsx': '',
    'src/c.js': '',
    'src/styles.css': '',
    'src/data.json': '{}',
    'lib/util.ts': '',
    'packages/ui/package.json': JSON.stringify({ name: 'ui', main: 'main.js' }),
    'packages/ui/main.js': '',
  };

  it('resolves relative imports with extension and index lookup', () => {
    const resolver = createResolver(snapshot(files));
    expect(resolver.resolve('src/x.ts', './a')).toEqual({ kind: 'internal', path: 'src/a.ts' });
    expect(resolver.resolve('src/x.ts', './b')).toEqual({ kind: 'internal', path: 'src/b/index.tsx' });
    expect(resolver.resolve('src/x.ts', './c.js')).toEqual({ kind: 'internal', path: 'src/c.js' });
    expect(resolver.resolve('src/x.ts', './data.json')).toEqual({ kind: 'internal', path: 'src/data.json' });
    expect(resolver.resolve('src/x.ts', '../lib/util')).toEqual({ kind: 'internal', path: 'lib/util.ts' });
    expect(resolver.resolve('src/x.ts', '../packages/ui')).toEqual({ kind: 'internal', path: 'packages/ui/main.js' });
  });

  it('resolves non-code assets referenced with their extension', () => {
    expect(createResolver(snapshot(files)).resolve('src/x.ts', './styles.css')).toEqual({ kind: 'internal', path: 'src/styles.css' });
  });

  it('resolves path aliases', () => {
    const resolver = createResolver(snapshot(files), { paths: { '@/*': ['src/*'], '~lib/*': ['lib/*'] }, pathsBase: '.' });
    expect(resolver.resolve('app/page.tsx', '@/a')).toEqual({ kind: 'internal', path: 'src/a.ts' });
    expect(resolver.resolve('app/page.tsx', '~lib/util')).toEqual({ kind: 'internal', path: 'lib/util.ts' });
    expect(resolver.resolve('app/page.tsx', '@/missing')).toMatchObject({ kind: 'unresolved' });
  });

  it('emulates a project baseUrl for bare imports without turning packages into broken aliases', () => {
    const resolver = createResolver(snapshot(files), { baseUrl: 'src' });
    expect(resolver.resolve('app/page.tsx', 'a')).toEqual({ kind: 'internal', path: 'src/a.ts' });
    expect(resolver.resolve('app/page.tsx', 'b')).toEqual({ kind: 'internal', path: 'src/b/index.tsx' });
    expect(resolver.resolve('app/page.tsx', 'react')).toEqual({ kind: 'external' });
  });

  it('prefers a specific alias over the baseUrl fallback', () => {
    const resolver = createResolver(snapshot(files), { baseUrl: '.', paths: { 'util/*': ['lib/*'] } });
    expect(resolver.resolve('app/page.tsx', 'util/util')).toEqual({ kind: 'internal', path: 'lib/util.ts' });
    expect(resolver.resolve('app/page.tsx', 'src/a')).toEqual({ kind: 'internal', path: 'src/a.ts' });
  });

  it('ignores invalid multi-star aliases from an untrusted tsconfig instead of throwing', () => {
    const resolver = createResolver(snapshot(files), {
      paths: { 'a**b': ['src/*'], '@/*': ['src/*'], 'x/*': ['lib/**'] },
      pathsBase: '.',
    });
    expect(resolver.resolve('app/page.tsx', 'a' + 'a'.repeat(40) + 'c')).toEqual({ kind: 'external' });
    expect(resolver.resolve('app/page.tsx', '@/a')).toEqual({ kind: 'internal', path: 'src/a.ts' });
    expect(resolver.resolve('app/page.tsx', 'x/util')).toEqual({ kind: 'external' });
  });

  it('treats a "__proto__" alias key as an ordinary alias', () => {
    const paths = JSON.parse('{"__proto__": ["lib/util.ts"], "@/*": ["src/*"]}') as Record<string, string[]>;
    const resolver = createResolver(snapshot(files), { paths, pathsBase: '.' });
    expect(resolver.resolve('app/page.tsx', '@/a')).toEqual({ kind: 'internal', path: 'src/a.ts' });
    expect(resolver.resolve('app/page.tsx', '__proto__')).toEqual({ kind: 'internal', path: 'lib/util.ts' });
  });

  it('resolves non-code assets through path aliases, honouring baseUrl', () => {
    const viaBase = createResolver(snapshot(files), { paths: { '@/*': ['./src/*'] }, pathsBase: '.' });
    expect(viaBase.resolve('app/page.tsx', '@/styles.css')).toEqual({ kind: 'internal', path: 'src/styles.css' });
    const viaBaseUrl = createResolver(snapshot(files), { baseUrl: 'src', paths: { '~/*': ['*'] } });
    expect(viaBaseUrl.resolve('app/page.tsx', '~/styles.css')).toEqual({ kind: 'internal', path: 'src/styles.css' });
    const escaping = createResolver(snapshot(files), { paths: { 'x/*': ['../../*'] }, pathsBase: '.' });
    expect(escaping.resolve('app/page.tsx', 'x/etc/passwd')).toMatchObject({ kind: 'unresolved' });
  });

  it('treats bare package specifiers as external and missing relative files as unresolved', () => {
    const resolver = createResolver(snapshot(files));
    expect(resolver.resolve('src/x.ts', 'react')).toEqual({ kind: 'external' });
    expect(resolver.resolve('src/x.ts', '@scope/pkg/sub')).toEqual({ kind: 'external' });
    expect(resolver.resolve('src/x.ts', './nope')).toMatchObject({ kind: 'unresolved' });
    expect(resolver.resolve('src/x.ts', '/abs/path')).toMatchObject({ kind: 'unresolved' });
  });

  it('never resolves outside the repository', () => {
    const resolver = createResolver(snapshot(files));
    expect(resolver.resolve('src/x.ts', '../../../../etc/passwd')).toMatchObject({ kind: 'unresolved' });
    expect(resolver.resolve('x.ts', '../outside.ts')).toMatchObject({ kind: 'unresolved' });
  });
});

describe('loadResolverConfig', () => {
  it('reads paths from tsconfig.json with comments and trailing commas', () => {
    const tsconfig = `{
      // comment
      "compilerOptions": { "paths": { "@/*": ["./src/*"] }, },
    }`;
    const { config, evidence } = loadResolverConfig(snapshot({ 'tsconfig.json': tsconfig }));
    expect(config).toEqual({ paths: { '@/*': ['./src/*'] }, pathsBase: '.' });
    expect(evidence.at(-1)?.detail).toContain('1 path aliases');
  });

  it('follows extends within the repository and keeps the declaring directory as pathsBase', () => {
    const files = {
      'tsconfig.json': JSON.stringify({ extends: './config/base.json' }),
      'config/base.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '#/*': ['lib/*'] } } }),
    };
    const { config } = loadResolverConfig(snapshot(files));
    expect(config.baseUrl).toBe('.');
    expect(config.paths).toEqual({ '#/*': ['lib/*'] });
  });

  it('falls back to jsconfig.json', () => {
    const { config } = loadResolverConfig(snapshot({ 'jsconfig.json': '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}' }));
    expect(config.paths).toBeDefined();
  });

  it('reports missing, unreadable, invalid and package-extended configs as evidence', () => {
    expect(loadResolverConfig(snapshot({})).evidence[0]?.detail).toContain('No root tsconfig.json');
    expect(loadResolverConfig(snapshot({}, ['tsconfig.json'])).evidence[0]?.detail).toContain('could not be read');
    expect(loadResolverConfig(snapshot({ 'tsconfig.json': '{ not json' })).evidence[0]?.detail).toContain('not valid JSON');
    const extended = loadResolverConfig(snapshot({ 'tsconfig.json': '{"extends":"@tsconfig/strictest"}' }));
    expect(extended.evidence.some((item) => item.detail.includes('@tsconfig/strictest'))).toBe(true);
  });

  it('isConfigFile matches tsconfig/jsconfig variants only', () => {
    expect(['tsconfig.json', 'apps/web/tsconfig.base.json', 'jsconfig.json'].every(isConfigFile)).toBe(true);
    expect(['package.json', 'mytsconfig.json'].some(isConfigFile)).toBe(false);
  });
});

describe('classify', () => {
  it.each(['package.json', 'pnpm-lock.yaml', 'tsconfig.app.json', '.env.local', 'next.config.mjs', 'vite.config.ts', 'apps/web/.babelrc'])(
    '%s is a global config',
    (file) => { expect(isGlobalConfig(file)).toBe(true); },
  );

  it.each(['src/config.ts', 'environment.ts', 'package.ts'])('%s is not a global config', (file) => {
    expect(isGlobalConfig(file)).toBe(false);
  });

  it('seedKind distinguishes code, assets and config', () => {
    expect(seedKind('a.tsx')).toBe('code');
    expect(seedKind('a.css')).toBe('asset');
    expect(seedKind('package.json')).toBe('config');
  });

  it('seedsFromDiff seeds removed paths for deletions and renames', () => {
    const base = { additions: 0, deletions: 0, binary: false, hunks: [] };
    const files: ChangedFile[] = [
      { ...base, path: 'gone.ts', change: 'deleted' },
      { ...base, path: 'new.ts', oldPath: 'old.ts', change: 'renamed' },
      { ...base, path: 'a.css', change: 'modified' },
    ];
    expect(seedsFromDiff(files)).toEqual([
      { path: 'gone.ts', kind: 'removed', listed: true },
      { path: 'new.ts', kind: 'code', listed: true },
      { path: 'old.ts', kind: 'removed', listed: false },
      { path: 'a.css', kind: 'asset', listed: true },
    ]);
  });
});

describe('graph', () => {
  // page -> layout -> button -> theme ; other -> theme
  const edges: ImportEdge[] = [
    { from: 'page.tsx', to: 'layout.tsx' },
    { from: 'layout.tsx', to: 'button.tsx' },
    { from: 'button.tsx', to: 'theme.ts' },
    { from: 'other.ts', to: 'theme.ts' },
    { from: 'other.ts', to: 'theme.ts' },
    { from: 'self.ts', to: 'self.ts' },
  ];

  it('buildReverseIndex dedupes edges and drops self-imports', () => {
    const reverse = buildReverseIndex(edges);
    expect(reverse.get('theme.ts')).toEqual(['button.tsx', 'other.ts']);
    expect(reverse.has('self.ts')).toBe(false);
  });

  it('marks direct importers confirmed and transitive ones possible, with the import chain', () => {
    const { candidates, depthLimited } = computeImpact([{ path: 'theme.ts', kind: 'code', listed: true }], edges, 5);
    expect(depthLimited).toBe(false);
    expect(candidates).toEqual([
      { path: 'theme.ts', certainty: 'confirmed', reason: 'changed', depth: 0, via: ['theme.ts'] },
      { path: 'button.tsx', certainty: 'confirmed', reason: 'imports-changed', depth: 1, via: ['button.tsx', 'theme.ts'] },
      { path: 'other.ts', certainty: 'confirmed', reason: 'imports-changed', depth: 1, via: ['other.ts', 'theme.ts'] },
      { path: 'layout.tsx', certainty: 'possible', reason: 'transitive', depth: 2, via: ['layout.tsx', 'button.tsx', 'theme.ts'] },
      {
        path: 'page.tsx',
        certainty: 'possible',
        reason: 'transitive',
        depth: 3,
        via: ['page.tsx', 'layout.tsx', 'button.tsx', 'theme.ts'],
      },
    ]);
  });

  it('stops at maxDepth and reports that dependents were left unexplored', () => {
    const { candidates, depthLimited } = computeImpact([{ path: 'theme.ts', kind: 'code', listed: true }], edges, 1);
    expect(candidates.map((c) => c.path)).toEqual(['theme.ts', 'button.tsx', 'other.ts']);
    expect(depthLimited).toBe(true);
  });

  it('does not report depth limiting when nothing lies beyond it', () => {
    expect(computeImpact([{ path: 'page.tsx', kind: 'code', listed: true }], edges, 1).depthLimited).toBe(false);
  });

  it('reports importers of removed files and keeps unlisted seeds out of the output', () => {
    const seeds: Seed[] = [{ path: 'button.tsx', kind: 'removed', listed: false }];
    const { candidates } = computeImpact(seeds, edges, 1);
    expect(candidates).toEqual([
      { path: 'layout.tsx', certainty: 'confirmed', reason: 'imports-deleted', depth: 1, via: ['layout.tsx', 'button.tsx'] },
    ]);
  });

  it('keeps a changed file as changed even if it also imports another changed file', () => {
    const seeds: Seed[] = [
      { path: 'theme.ts', kind: 'code', listed: true },
      { path: 'button.tsx', kind: 'code', listed: true },
    ];
    const button = computeImpact(seeds, edges, 5).candidates.find((c) => c.path === 'button.tsx');
    expect(button).toMatchObject({ reason: 'changed', depth: 0 });
  });

  it('marks config changes and unreferenced assets as unknown scope', () => {
    const { candidates } = computeImpact(
      [
        { path: 'package.json', kind: 'config', listed: true },
        { path: 'README.md', kind: 'asset', listed: true },
        { path: 'theme.css', kind: 'asset', listed: true },
      ],
      [{ from: 'button.tsx', to: 'theme.css' }],
      5,
    );
    expect(candidates.map((c) => [c.path, c.certainty, c.reason])).toEqual([
      ['theme.css', 'confirmed', 'changed'],
      ['README.md', 'unknown', 'non-code-change'],
      ['package.json', 'unknown', 'config-change'],
      ['button.tsx', 'confirmed', 'imports-changed'],
    ]);
  });

  it('sortCandidates orders by depth, certainty, then path', () => {
    const make = (path: string, depth: number, certainty: 'confirmed' | 'possible' | 'unknown') => ({
      path,
      depth,
      certainty,
      reason: 'changed' as const,
      via: [path],
    });
    expect(sortCandidates([make('b', 1, 'unknown'), make('a', 1, 'unknown'), make('z', 1, 'confirmed'), make('y', 0, 'possible')]).map((c) => c.path)).toEqual([
      'y',
      'z',
      'a',
      'b',
    ]);
  });
});

describe('dynamicTargetDirectory', () => {
  it.each([
    ['src/i18n.ts', './locales/', 'src/locales'],
    ['src/i18n.ts', './locales/en-', 'src/locales'],
    ['src/a/b.ts', '../plugins/', 'src/plugins'],
  ])('%s + %j -> %s', (from, prefix, expected) => {
    expect(dynamicTargetDirectory(from, prefix)).toBe(expected);
  });

  it.each([
    ['src/a.ts', null],
    ['src/a.ts', '@/x/'],
    ['a.ts', './'],
    ['a.ts', '../../outside/'],
  ])('%s + %j -> null', (from, prefix) => {
    expect(dynamicTargetDirectory(from, prefix)).toBeNull();
  });
});

describe('matchAlias', () => {
  it.each([
    ['@/*', '@/components/Button', 'components/Button'],
    ['@/*', '@/', ''],
    ['*.css', 'theme.css', 'theme'],
    ['exact', 'exact', ''],
    ['pre*suf', 'pre-mid-suf', '-mid-'],
  ])('%s matches %s', (pattern, specifier, wildcard) => {
    expect(matchAlias(pattern, specifier)).toBe(wildcard);
  });

  it.each([
    ['@/*', '@components'],
    ['exact', 'exactly'],
    ['ab*ba', 'aba'],
  ])('%s does not match %s', (pattern, specifier) => {
    expect(matchAlias(pattern, specifier)).toBeNull();
  });

  it('stays fast on long adversarial input', () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) matchAlias(`${'a'.repeat(5000)}*b`, 'a'.repeat(100_000));
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
