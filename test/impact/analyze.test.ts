import { afterEach, describe, expect, it } from 'vitest';
import { resolveLimits } from '../../src/core/limits.js';
import type { ImpactCandidate, Limits } from '../../src/core/types.js';
import { collectDiff } from '../../src/git/collect.js';
import { analyzeImpact } from '../../src/impact/analyze.js';
import { createRepo, type TestRepo } from '../helpers/repo.js';

let repo: TestRepo | undefined;
afterEach(() => repo?.cleanup());

const APP = {
  'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
  'package.json': '{ "name": "app" }',
  'src/theme.ts': 'export const color = "red";\n',
  'src/Button.tsx': "import { color } from './theme';\nexport const Button = () => color;\n",
  'src/index.ts': "export * from './Button';\n",
  'app/page.tsx': "import { Button } from '@/index';\nimport '@/styles.css';\nexport default function Page() { return Button(); }\n",
  'app/about/page.tsx': "import React from 'react';\nexport default () => null;\n",
  'src/styles.css': 'body { color: red }\n',
  'src/i18n.ts': 'export const load = (lang: string) => import(`./locales/${lang}.json`);\n',
  'src/locales/en.json': '{ "hi": "hi" }\n',
  'test/Button.test.tsx': "import { Button } from '../src/Button';\n",
};

async function analyze(changes: (r: TestRepo) => void, limits: Partial<Limits> = {}, baseFiles: Record<string, string> = {}) {
  repo = createRepo();
  repo.write({ ...APP, ...baseFiles });
  const base = repo.commit('base');
  changes(repo);
  const head = repo.commit('head');
  const resolved = resolveLimits(limits);
  const diff = await collectDiff({ baseSha: base, headSha: head, cwd: repo.dir, limits: resolved });
  if (!diff.data) throw new Error(`diff failed: ${diff.reason ?? ''}`);
  return analyzeImpact({ cwd: repo.dir, diff: diff.data, limits: resolved });
}

const summary = (candidates: ImpactCandidate[] = []) => candidates.map((c) => `${c.certainty}:${c.reason}:${c.path}`);

describe('analyzeImpact (integration)', () => {
  it('follows relative imports, barrel re-exports and path aliases', async () => {
    const result = await analyze((r) => { r.write({ 'src/theme.ts': 'export const color = "blue";\n' }); });
    expect(result.status).toBe('ok');
    expect(summary(result.data?.candidates)).toEqual([
      'confirmed:changed:src/theme.ts',
      'confirmed:imports-changed:src/Button.tsx',
      'possible:transitive:app/page.tsx',
      'possible:re-exports:src/index.ts',
      'possible:transitive:test/Button.test.tsx',
    ]);
    const page = result.data?.candidates.find((c) => c.path === 'app/page.tsx');
    expect(page?.via).toEqual(['app/page.tsx', 'src/index.ts', 'src/Button.tsx', 'src/theme.ts']);
    expect(result.evidence.some((e) => e.detail.includes('tsconfig.json (1 path aliases)'))).toBe(true);
  });

  describe('barrel files', () => {
    const UI = {
      'src/ui/Button.tsx': 'export const Button = () => "button";\nexport const OldButton = () => "old";\n',
      'src/ui/Modal.tsx': 'export const Modal = () => "modal";\nexport default Modal;\n',
      'src/ui/Card.tsx': 'export default function Card() { return "card"; }\n',
      'src/ui/index.ts': "export * from './Button';\nexport { Modal } from './Modal';\nexport { default as Card } from './Card';\n",
      'src/lib/index.ts': "import { Modal } from '../ui/Modal';\nexport { Modal };\nexport * as ui from '../ui';\n",
      'app/home.tsx': "import { Modal } from '@/ui';\nexport const Home = () => Modal();\n",
      'app/settings.tsx': "import { Button } from '@/ui';\nexport const Settings = () => Button();\n",
      'app/legacy.tsx': "import { OldButton } from '@/ui';\nexport const Legacy = () => OldButton();\n",
      'app/cards.tsx': "import { Card } from '@/ui';\nexport const Cards = () => Card();\n",
      'app/all.tsx': "import * as UI from '@/ui';\nexport const All = () => UI;\n",
      'app/shell.tsx': "import { Settings } from './settings';\nimport { Home } from './home';\nexport const Shell = () => [Settings, Home];\n",
      'app/lib-user.tsx': "import { Modal } from '@/lib';\nexport const X = () => Modal();\n",
    };
    const withUi = (change: (r: TestRepo) => void, extra: Record<string, string> = {}) => analyze(change, {}, { ...UI, ...extra });
    const paths = (candidates: ImpactCandidate[] = []) => candidates.map((c) => c.path);

    it('links importers of a barrel only to the files that define the names they use', async () => {
      const result = await withUi((r) => { r.write({ 'src/ui/Button.tsx': 'export const Button = () => "new";\nexport const OldButton = () => "old";\n' }); });
      expect(result.status).toBe('ok');
      const candidates = summary(result.data?.candidates);
      expect(candidates).toContain('confirmed:imports-changed:app/settings.tsx');
      expect(candidates).toContain('confirmed:imports-changed:app/legacy.tsx');
      expect(candidates).toContain('confirmed:imports-changed:app/all.tsx');
      expect(candidates).toContain('confirmed:re-exports:src/ui/index.ts');
      expect(candidates).toContain('possible:transitive:app/shell.tsx');
      expect(paths(result.data?.candidates)).not.toContain('app/home.tsx');
      expect(paths(result.data?.candidates)).not.toContain('app/cards.tsx');
      expect(paths(result.data?.candidates)).not.toContain('app/lib-user.tsx');
      const settings = result.data?.candidates.find((c) => c.path === 'app/settings.tsx');
      expect(settings?.via).toEqual(['app/settings.tsx', 'src/ui/index.ts', 'src/ui/Button.tsx']);
    });

    it('passes on only the exports of an affected file that use the changed import', async () => {
      const result = await withUi((r) => { r.write({ 'src/ui/Button.tsx': 'export const Button = () => "new";\nexport const OldButton = () => "old";\n' }); }, {
        'src/ui/types.ts': "import type { Button } from './Button';\nexport type ButtonProps = Parameters<typeof Button>;\nexport type Size = 'sm' | 'lg';\n",
        'app/sized.tsx': "import type { Size } from '../src/ui/types';\nexport const size: Size = 'sm';\n",
        'app/props.tsx': "import type { ButtonProps } from '../src/ui/types';\nexport const props: ButtonProps = [];\n",
      });
      const candidates = summary(result.data?.candidates);
      expect(candidates).toContain('confirmed:imports-changed:src/ui/types.ts');
      expect(candidates).toContain('possible:transitive:app/props.tsx');
      expect(paths(result.data?.candidates)).not.toContain('app/sized.tsx');
    });

    it('follows default re-exports and imported bindings that are exported again', async () => {
      const result = await withUi((r) => { r.write({ 'src/ui/Modal.tsx': 'export const Modal = () => "new";\nexport default Modal;\n' }); });
      const candidates = summary(result.data?.candidates);
      expect(candidates).toContain('confirmed:imports-changed:app/home.tsx');
      expect(candidates).toContain('confirmed:imports-changed:app/lib-user.tsx');
      expect(candidates).toContain('confirmed:re-exports:src/lib/index.ts');
      expect(paths(result.data?.candidates)).not.toContain('app/settings.tsx');
      expect(paths(result.data?.candidates)).not.toContain('app/cards.tsx');

      const card = await withUi((r) => { r.write({ 'src/ui/Card.tsx': 'export default function Card() { return "new"; }\n' }); });
      expect(summary(card.data?.candidates)).toContain('confirmed:imports-changed:app/cards.tsx');
      expect(paths(card.data?.candidates)).not.toContain('app/home.tsx');
    });

    it('keeps importers of a name the PR stopped exporting', async () => {
      const result = await withUi((r) => { r.write({ 'src/ui/Button.tsx': 'export const Button = () => "button";\n' }); });
      expect(summary(result.data?.candidates)).toContain('confirmed:imports-changed:app/legacy.tsx');
    });

    it('treats every importer of a changed barrel as affected', async () => {
      const result = await withUi((r) => { r.write({ 'src/ui/index.ts': "export * from './Button';\nexport { Modal } from './Modal';\n" }); });
      const candidates = summary(result.data?.candidates);
      expect(candidates).toContain('confirmed:imports-changed:app/home.tsx');
      expect(candidates).toContain('confirmed:imports-changed:app/cards.tsx');
      expect(candidates).toContain('confirmed:imports-changed:app/settings.tsx');
    });

    it('reports a barrel that re-exports a deleted file and the importers of that name', async () => {
      const result = await withUi((r) => { r.remove('src/ui/Card.tsx'); });
      const candidates = summary(result.data?.candidates);
      expect(candidates).toContain('confirmed:imports-deleted:src/ui/index.ts');
      expect(candidates).toContain('confirmed:imports-deleted:app/cards.tsx');
      expect(paths(result.data?.candidates)).not.toContain('app/home.tsx');
    });

    it('survives re-export cycles without dropping importers', async () => {
      const result = await withUi(
        (r) => { r.write({ 'src/cycle/b.ts': "export * from './a';\nexport const b = 2;\n" }); },
        {
          'src/cycle/a.ts': "export * from './b';\nexport const a = 1;\n",
          'src/cycle/b.ts': "export * from './a';\nexport const b = 1;\n",
          'src/cycle/user.ts': "import { b, missing } from './a';\nexport const u = [b, missing];\n",
        },
      );
      expect(result.status).toBe('ok');
      expect(summary(result.data?.candidates)).toContain('confirmed:imports-changed:src/cycle/user.ts');
    });
  });

  it('reports importers of a deleted file as confirmed imports-deleted', async () => {
    const result = await analyze((r) => { r.remove('src/theme.ts'); });
    expect(summary(result.data?.candidates).slice(0, 2)).toEqual([
      'confirmed:changed:src/theme.ts',
      'confirmed:imports-deleted:src/Button.tsx',
    ]);
  });

  it('tracks both paths of a rename: importers of the old path may break', async () => {
    const result = await analyze((r) => {
      r.git('mv', 'src/theme.ts', 'src/colors.ts');
    });
    const candidates = summary(result.data?.candidates);
    expect(candidates).toContain('confirmed:changed:src/colors.ts');
    expect(candidates).toContain('confirmed:imports-deleted:src/Button.tsx');
    expect(candidates).not.toContain('confirmed:changed:src/theme.ts');
  });

  it('links stylesheets imported by code and marks files with matching dynamic imports as unknown', async () => {
    const result = await analyze((r) => { r.write({ 'src/styles.css': 'body { color: blue }\n', 'src/locales/en.json': '{ "hi": "hello" }\n' }); },
    );
    const candidates = summary(result.data?.candidates);
    expect(candidates).toContain('confirmed:changed:src/styles.css');
    expect(candidates).toContain('confirmed:imports-changed:app/page.tsx');
    expect(candidates).toContain('unknown:non-code-change:src/locales/en.json');
    expect(candidates).toContain('unknown:dynamic-import:src/i18n.ts');
  });

  it('marks config changes as unknown scope and reports unresolved imports in changed files', async () => {
    const result = await analyze((r) => { r.write({ 'package.json': '{ "name": "app", "version": "2" }', 'app/about/page.tsx': "import x from './missing';\n" }); },
    );
    expect(summary(result.data?.candidates)).toEqual(['confirmed:changed:app/about/page.tsx', 'unknown:config-change:package.json']);
    expect(result.evidence.some((e) => e.detail.includes('app/about/page.tsx: Relative import "./missing"'))).toBe(true);
    expect(result.data?.stats.unresolvedSpecifiers).toBe(1);
  });

  it('marks the section truncated when the depth limit cuts the search short', async () => {
    const result = await analyze((r) => { r.write({ 'src/theme.ts': 'export const color = 1;\n' }); }, { maxDepth: 1 });
    expect(result.status).toBe('truncated');
    expect(result.reason).toContain('beyond depth 1');
    expect(summary(result.data?.candidates)).toEqual(['confirmed:changed:src/theme.ts', 'confirmed:imports-changed:src/Button.tsx']);
  });

  it('parses changed files first when maxGraphNodes truncates the graph', async () => {
    const result = await analyze((r) => { r.write({ 'src/theme.ts': 'export const color = 2;\n' }); }, { maxGraphNodes: 2 });
    expect(result.status).toBe('truncated');
    expect(result.data?.stats.analyzedFiles).toBe(2);
    expect(result.data?.stats.skippedFiles).toBe(5);
  });

  it('isolates a file that crashes the parser instead of failing the whole analysis', async () => {
    const depth = 50_000; // ~100KB, below maxFileBytes, deep enough to overflow a recursive parser
    const nested = `export const x = import(${'('.repeat(depth)}y${')'.repeat(depth)});\n`;
    const result = await analyze((r) => { r.write({ 'src/bomb.ts': nested, 'src/theme.ts': 'export const color = 9;\n' }); });
    expect(result.status).toBe('truncated');
    expect(result.reason).toContain('could not be parsed');
    expect(result.reason).toContain('src/bomb.ts');
    expect(summary(result.data?.candidates)).toContain('confirmed:imports-changed:src/Button.tsx');
  });

  it('stops reading source once the total byte budget is spent', async () => {
    const result = await analyze((r) => { r.write({ 'src/theme.ts': 'export const color = 4;\n' }); }, { maxTotalBytes: 200 });
    expect(result.status).toBe('truncated');
    expect(result.reason).toContain('Read limit of 200 bytes');
    expect(result.data?.stats.analyzedFiles).toBeLessThan(7);
  });

  it('skips oversized source files and records it', async () => {
    const result = await analyze((r) => { r.write({ 'src/huge.ts': `export const x = "${'x'.repeat(2048)}";\n` }); }, { maxFileBytes: 1024 });
    expect(result.evidence.some((e) => e.detail.includes('over 1024 bytes'))).toBe(true);
    expect(result.data?.stats.skippedFiles).toBe(1);
  });

  it('does not follow symlinks committed to the repository', async () => {
    const result = await analyze((r) => {
      // A symlink whose target points outside the repository. With core.symlinks=false the
      // working file holds the target text and git keeps the symlink mode from the index.
      const target = '../../../outside/secret.ts';
      r.write({ 'src/escape.ts': target });
      const linkOid = r.git('hash-object', '-w', '--', 'src/escape.ts').trim();
      r.git('update-index', '--add', '--cacheinfo', `120000,${linkOid},src/escape.ts`);
      r.write({ 'src/theme.ts': "import './escape';\nexport const color = 3;\n" });
    });
    expect(repo?.git('ls-tree', 'HEAD', 'src/escape.ts')).toMatch(/^120000 /);
    expect(result.status).toBe('ok');
    expect(result.evidence.some((e) => e.detail.includes('symlinks/submodules were not followed'))).toBe(true);
    expect(summary(result.data?.candidates)).not.toContain('confirmed:imports-changed:src/escape.ts');
  });
});
