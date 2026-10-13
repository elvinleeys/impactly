import { describe, expect, it } from 'vitest';
import type { ChangedFile } from '../../src/core/types.js';
import { dynamicTargetDirectory } from '../../src/impact/analyze.js';
import { isGlobalConfig, seedKind, seedsFromDiff } from '../../src/impact/classify.js';
import { isConfigFile, loadResolverConfig } from '../../src/impact/config.js';
import { buildReverseIndex, computeImpact, sortCandidates, type ImportEdge, type Seed } from '../../src/impact/graph.js';
import { isCodeFile, parseModule } from '../../src/impact/parseModule.js';
import { createResolver, matchAlias, type RepoSnapshot } from '../../src/impact/resolve.js';
import { buildSymbolEdges, exportNames, type ResolvedModule } from '../../src/impact/symbols.js';

function snapshot(files: Record<string, string>, extraPaths: string[] = []): RepoSnapshot {
  return { paths: new Set([...Object.keys(files), ...extraPaths]), read: (path) => files[path] };
}

describe('parseModule', () => {
  it('collects imports, re-exports, require, literal import(), import types and references', () => {
    const source = `
      /// <reference path="./globals.d.ts" />
      import a from './a';
      import type { B } from '@/b';
      export * from './c';
      export { d } from '../d.js';
      const e = require('./e');
      const f = await import('./f');
      import './styles.css';
      type G = import('./g').G;
    `;
    const parsed = parseModule('src/x.ts', source);
    expect(parsed.imports).toEqual([
      { specifier: './styles.css', imported: null, dependents: '*' },
      { specifier: './a', imported: 'default', dependents: [] },
      { specifier: '@/b', imported: 'B', dependents: [] },
      { specifier: './e', imported: null, dependents: [] },
      { specifier: './f', imported: null, dependents: [] },
      { specifier: './g', imported: null, dependents: [] },
      { specifier: './globals.d.ts', imported: null, dependents: '*' },
    ]);
    expect(parsed.reexports).toEqual([
      { specifier: './c', kind: 'star' },
      { specifier: '../d.js', kind: 'named', imported: 'd', exported: 'd' },
    ]);
    expect(parsed.localExports).toEqual([]);
    expect(parsed.dynamic).toEqual([]);
  });

  it('records which exports use each import, through local declarations', () => {
    const source = `
      import { a } from './a';
      import { b } from './b';
      import { c } from './c';
      import * as ns from './ns';
      import { side } from './side';
      const helper = () => a;
      export function usesA() { return helper(); }
      export const usesB = b;
      export default class { m() { return ns; } }
      export type T = typeof c;
      side();
      function unusedLocal() { return c; }
      const lazy = () => import('./lazy');
      export { lazy };
    `;
    const parsed = parseModule('src/x.ts', source);
    expect(parsed.imports).toEqual([
      { specifier: './a', imported: 'a', dependents: ['usesA'] },
      { specifier: './b', imported: 'b', dependents: ['usesB'] },
      { specifier: './c', imported: 'c', dependents: ['T'] },
      { specifier: './ns', imported: null, dependents: ['default'] },
      { specifier: './side', imported: 'side', dependents: '*' },
      { specifier: './lazy', imported: null, dependents: ['lazy'] },
    ]);
    expect(parsed.localExports).toEqual(['usesA', 'usesB', 'default', 'T', 'lazy']);
  });

  it('tells re-exported bindings from used ones and lists local exports', () => {
    const source = `
      import { a, b as bee } from './ab';
      import * as ns from './ns';
      import def from './def';
      import { used } from './used';
      import { both } from './both';
      export { a, bee as b2, ns };
      export default def;
      export { used, both };
      console.log(used);
      export * as all from './all';
      export const [x, { y }] = arr;
      export function f() { return both; }
      export class K {}
      export interface I {}
      export type T = 1;
      export enum E {}
      const local = 1;
      export { local as renamed };
    `;
    const parsed = parseModule('src/x.ts', source);
    expect(parsed.reexports).toEqual([
      { specifier: './ab', kind: 'named', imported: 'a', exported: 'a' },
      { specifier: './ab', kind: 'named', imported: 'b', exported: 'b2' },
      { specifier: './ns', kind: 'namespace', exported: 'ns' },
      { specifier: './def', kind: 'named', imported: 'default', exported: 'default' },
      { specifier: './used', kind: 'named', imported: 'used', exported: 'used' },
      { specifier: './both', kind: 'named', imported: 'both', exported: 'both' },
      { specifier: './all', kind: 'namespace', exported: 'all' },
    ]);
    expect(parsed.imports).toEqual([
      { specifier: './used', imported: 'used', dependents: '*' },
      { specifier: './both', imported: 'both', dependents: ['f'] },
    ]);
    expect(parsed.localExports).toEqual(['x', 'y', 'f', 'K', 'I', 'T', 'E', 'renamed']);
  });

  it('treats a namespace import as the whole module', () => {
    expect(parseModule('x.ts', "import * as UI from './ui';\nexport const all = UI;\n").imports).toEqual([
      { specifier: './ui', imported: null, dependents: ['all'] },
    ]);
  });

  it('marks exports it cannot list (CommonJS, export =) as null', () => {
    expect(parseModule('x.js', "module.exports = require('./y');\n")).toMatchObject({
      imports: [{ specifier: './y', imported: null, dependents: '*' }],
      localExports: null,
    });
    expect(parseModule('x.ts', 'const v = 1;\nexport = v;\n').localExports).toBeNull();
    expect(parseModule('x.ts', 'export default function () {}\n').localExports).toEqual(['default']);
  });

  it('reports non-literal dynamic imports with their static prefix', () => {
    const source = [
      'const a = import(`./locales/${lang}.json`);',
      "const b = require('./plugins/' + name);",
      'const c = import(moduleName);',
      "const d = import('./literal');",
    ].join('\n');
    expect(parseModule('x.js', source).dynamic).toEqual([
      { staticPrefix: './locales/' },
      { staticPrefix: './plugins/' },
      { staticPrefix: null },
    ]);
  });

  it('parses JSX in .js and .tsx files without failing', () => {
    const parsed = parseModule('c.tsx', "import B from './B';\nexport const C = () => <B x={import(path)} />;");
    expect(parsed.imports).toEqual([{ specifier: './B', imported: 'default', dependents: ['C'] }]);
    expect(parsed.localExports).toEqual(['C']);
    expect(parsed.dynamic).toEqual([{ staticPrefix: null }]);
  });

  it('isCodeFile recognises JS/TS extensions only', () => {
    expect(['a.ts', 'a.tsx', 'a.mts', 'a.cjs', 'a.jsx', 'a.d.ts'].every(isCodeFile)).toBe(true);
    expect(['a.css', 'a.json', 'a.vue', 'ts'].some(isCodeFile)).toBe(false);
  });
});

describe('symbols', () => {
  const module = (partial: Partial<ResolvedModule>): ResolvedModule => ({ imports: [], reexports: [], localExports: new Set(), ...partial });
  const ui = new Map<string, ResolvedModule>([
    ['ui/Button.ts', module({ localExports: new Set(['Button', 'default']) })],
    ['ui/Modal.ts', module({ localExports: new Set(['Modal']) })],
    ['ui/legacy.js', module({ localExports: null })],
    [
      'ui/index.ts',
      module({
        reexports: [
          { target: 'ui/Button.ts', kind: 'star' },
          { target: 'ui/Modal.ts', kind: 'named', imported: 'Modal', exported: 'Dialog' },
        ],
      }),
    ],
    ['app.ts', module({ imports: [{ target: 'ui/index.ts', imported: 'Dialog', dependents: ['App'] }] })],
  ]);

  it('exportNames follows export * (without default) and propagates unknown exports', () => {
    const names = exportNames(
      new Map([
        ...ui,
        ['cycle/a.ts', module({ localExports: new Set(['a']), reexports: [{ target: 'cycle/b.ts', kind: 'star' }] })],
        ['cycle/b.ts', module({ localExports: new Set(['b']), reexports: [{ target: 'cycle/a.ts', kind: 'star' }] })],
        ['opaque.ts', module({ reexports: [{ target: 'ui/legacy.js', kind: 'star' }] })],
      ]),
    );
    expect([...(names.get('ui/index.ts') ?? [])].sort()).toEqual(['Button', 'Dialog']);
    expect([...(names.get('cycle/a.ts') ?? [])].sort()).toEqual(['a', 'b']);
    expect(names.get('opaque.ts')).toBeNull();
  });

  it('links an importer to the name in the file defining it, through the barrel', () => {
    const edges = buildSymbolEdges(ui);
    expect(edges.filter((edge) => edge.from === 'app.ts')).toEqual([
      { from: 'app.ts', to: 'ui/Modal.ts', kind: 'use', through: ['ui/index.ts'], names: ['Modal'], exports: ['App'] },
      { from: 'app.ts', to: 'ui/index.ts', kind: 'through', through: [], names: '*', exports: ['App'] },
    ]);
    expect(edges.filter((edge) => edge.from === 'ui/index.ts')).toEqual([
      { from: 'ui/index.ts', to: 'ui/Button.ts', kind: 'reexport', through: [], names: '*', exports: '*' },
      { from: 'ui/index.ts', to: 'ui/Modal.ts', kind: 'reexport', through: [], names: ['Modal'], exports: ['Dialog'] },
    ]);
  });

  it('falls back to everything the module re-exports for names it cannot find', () => {
    const modules = new Map([...ui, ['old.ts', module({ imports: [{ target: 'ui/index.ts', imported: 'Removed', dependents: '*' }] })]]);
    const targets = buildSymbolEdges(modules)
      .filter((edge) => edge.from === 'old.ts' && edge.kind === 'use')
      .map((edge) => [edge.to, edge.names]);
    expect(targets).toEqual([
      ['ui/index.ts', '*'],
      ['ui/Button.ts', '*'],
      ['ui/Modal.ts', '*'],
    ]);
  });

  it('treats files without parsed exports as defining every name', () => {
    const modules = new Map([
      ['ui/index.ts', module({ reexports: [{ target: 'ui/gone.ts', kind: 'star' }] })],
      ['app.ts', module({ imports: [{ target: 'ui/index.ts', imported: 'Anything', dependents: '*' }] })],
    ]);
    expect(buildSymbolEdges(modules).filter((edge) => edge.from === 'app.ts' && edge.kind === 'use')).toEqual([
      { from: 'app.ts', to: 'ui/gone.ts', kind: 'use', through: ['ui/index.ts'], names: ['Anything'], exports: '*' },
    ]);
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
    expect(reverse.get('theme.ts')).toEqual([
      { from: 'button.tsx', kind: 'use', through: [], names: '*', exports: '*' },
      { from: 'other.ts', kind: 'use', through: [], names: '*', exports: '*' },
    ]);
    expect(reverse.has('self.ts')).toBe(false);
  });

  it('passes on only the exports whose code uses an affected import', () => {
    // lib.useA uses util.a and lib.useB uses other.o; z uses lib.useA but exports nothing that does.
    const nameEdges: ImportEdge[] = [
      { from: 'lib.ts', to: 'util.ts', names: ['a'], exports: ['useA'] },
      { from: 'lib.ts', to: 'other.ts', names: ['o'], exports: ['useB'] },
      { from: 'x.ts', to: 'lib.ts', names: ['useA'] },
      { from: 'y.ts', to: 'lib.ts', names: ['useB'] },
      { from: 'z.ts', to: 'lib.ts', names: ['useA'], exports: [] },
      { from: 'w.ts', to: 'z.ts' },
    ];
    const util = computeImpact([{ path: 'util.ts', kind: 'code', listed: true }], nameEdges, 5);
    expect(util.candidates.map((c) => `${c.certainty}:${c.path}`)).toEqual(['confirmed:util.ts', 'confirmed:lib.ts', 'possible:x.ts', 'possible:z.ts']);
    const both = computeImpact(
      [
        { path: 'util.ts', kind: 'code', listed: true },
        { path: 'other.ts', kind: 'code', listed: true },
      ],
      nameEdges,
      5,
    );
    expect(both.candidates.map((c) => c.path)).toEqual(['other.ts', 'util.ts', 'lib.ts', 'x.ts', 'y.ts', 'z.ts']);
    expect(computeImpact([{ path: 'util.ts', kind: 'code', listed: true }], nameEdges, 1).depthLimited).toBe(true);
  });

  // page imports { Button } from the barrel ui/index.ts, which re-exports button.tsx and modal.tsx.
  const barrelEdges: ImportEdge[] = [
    { from: 'page.tsx', to: 'button.tsx', kind: 'use', through: ['ui/index.ts'] },
    { from: 'page.tsx', to: 'ui/index.ts', kind: 'through', through: [] },
    { from: 'ui/index.ts', to: 'button.tsx', kind: 'reexport', through: [] },
    { from: 'ui/index.ts', to: 'modal.tsx', kind: 'reexport', through: [] },
    { from: 'shell.tsx', to: 'page.tsx', kind: 'use', through: [] },
  ];

  it('lists barrels that re-export a changed file without expanding them, and shows them in the chain', () => {
    const { candidates } = computeImpact([{ path: 'button.tsx', kind: 'code', listed: true }], barrelEdges, 5);
    expect(candidates).toEqual([
      { path: 'button.tsx', certainty: 'confirmed', reason: 'changed', depth: 0, via: ['button.tsx'] },
      { path: 'page.tsx', certainty: 'confirmed', reason: 'imports-changed', depth: 1, via: ['page.tsx', 'ui/index.ts', 'button.tsx'] },
      { path: 'ui/index.ts', certainty: 'confirmed', reason: 're-exports', depth: 1, via: ['ui/index.ts', 'button.tsx'] },
      { path: 'shell.tsx', certainty: 'possible', reason: 'transitive', depth: 2, via: ['shell.tsx', 'page.tsx', 'ui/index.ts', 'button.tsx'] },
    ]);
    expect(computeImpact([{ path: 'modal.tsx', kind: 'code', listed: true }], barrelEdges, 5).candidates.map((c) => c.path)).toEqual([
      'modal.tsx',
      'ui/index.ts',
    ]);
  });

  it('counts importers passing through a barrel only when the barrel itself changed', () => {
    const changed = computeImpact([{ path: 'ui/index.ts', kind: 'code', listed: true }], barrelEdges, 5).candidates;
    expect(changed.map((c) => `${c.reason}:${c.path}`)).toEqual(['changed:ui/index.ts', 'imports-changed:page.tsx', 'transitive:shell.tsx']);
    const consumer = computeImpact([{ path: 'other.tsx', kind: 'code', listed: true }], [...barrelEdges, { from: 'ui/index.ts', to: 'other.tsx' }], 5);
    expect(consumer.candidates.map((c) => c.path)).toEqual(['other.tsx', 'ui/index.ts']);
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
