# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Impactly is a (planned) free GitHub Marketplace JavaScript Action that analyses a pull request — changed files, import-graph impact, related tests, bundle-size change — and posts an evidence-backed Markdown report. Target use case: PRs from a personal fork into an organization repo.

Work proceeds in gated stages; only the first implementation stage exists so far:
- **Done (S3):** Git diff collection (`src/git`) and import/export impact analysis (`src/impact`), plus a local CLI.
- **Not yet built:** test discovery/execution, bundle comparison, Markdown report + PR comment, the GitHub Action entry points, optional AI summary agent (opt-in with the user's own API key), Lighthouse (later). `Report.tests` / `Report.bundle` are currently always `skipped`.

## Commands

```bash
npm test                                  # vitest run (all tests)
npx vitest run test/impact/units.test.ts  # one file
npx vitest run -t "rename"                # tests whose name matches
npm run typecheck                         # tsc --noEmit over src + test
npm run lint                              # eslint, strictTypeChecked rules
npm run build                             # tsc -> dist/
node dist/entry/cli.js --base <sha> --head <sha> [--cwd <repo>] [--text] [--mode merge-base|direct] [--max-depth N] [--max-files N]
```

The CLI only accepts hex SHAs (not `HEAD~1` or branch names); resolve them with `git rev-parse` first. Exit codes: 0 ok, 1 a section failed, 2 usage error.

Tests create throwaway git repos via `test/helpers/repo.ts` (`createRepo()`), so `git` must be on PATH. Most integration tests build a small app in a temp repo, commit base/head, then run `collectDiff` → `analyzeImpact`.

## Architecture

Pipeline (`src/entry/run.ts` → `buildReport`):

1. **`src/git/collect.ts` `collectDiff`** — validates and resolves SHAs, diffs merge-base(base, head)..head by default. It makes three git calls: `--name-status -z`, `--numstat -z` and `--unified=0` (patch). `parse.ts` pairs the patch file blocks with name-status entries **by order** (file names are never parsed out of the patch). If the counts differ or the patch exceeds `maxDiffBytes`, hunks become `null` instead of failing.
2. **`src/impact/analyze.ts` `analyzeImpact`** — reads the **head commit from the git object database** (`ls-tree` + `cat-file --batch`), not the working tree. Symlinks, submodules and `node_modules` are skipped.
   - It parses imports with the TypeScript compiler API (`parseImports.ts`) and resolves them in memory (`resolve.ts`) against a virtual root `/__repo__`, so resolution can never touch the real filesystem.
   - It builds the import edges, then `graph.ts` `computeImpact` runs a BFS over the reverse graph from the seeds produced by `classify.ts`.
3. Each stage returns a `Section<T>` with `{ status, data?, reason?, evidence[] }` (`src/core/types.ts`). Errors are caught per section, so a failing section does not abort the others.

Impact semantics (keep these consistent when extending):
- Seeds: changed files. Deleted files and the *old* path of a rename become `removed` seeds. Their paths are added to the resolver's path set so that importers still pointing at them resolve and are reported as `imports-deleted`.
- Depth 1 importers are `confirmed`; depth ≥ 2 are `possible`. A dynamic `import()` whose static prefix directory contains a changed file is reported as `unknown`. Config files (`classify.ts` `isGlobalConfig`) and non-code files with no importers are `unknown` scope.
- Unresolved imports are only surfaced (as evidence) for changed files. Bare specifiers that match no alias are treated as external packages.
- Hitting `maxDepth`, `maxGraphNodes` or `maxFiles` sets the status to `truncated` with a reason. It must never be silently `ok`.

Path aliases: `config.ts` reads the root `tsconfig.json`/`jsconfig.json` (following `extends` within the repo). `resolve.ts` never passes `baseUrl` to TypeScript, because it is deprecated in TS 6. Instead it rewrites `paths` targets to be repo-relative and emulates a project `baseUrl` with a fallback `*` mapping. Non-code assets imported through aliases or relative paths (`@/styles.css`) are resolved by a manual fallback, because TypeScript doesn't resolve them.

## Constraints and invariants

- **`typescript` is a runtime dependency pinned to `6.0.3`.** TypeScript 7 has no classic compiler API (`preProcessFile`, `resolveModuleName`), and typescript-eslint supports only versions below 6.1. Don't upgrade it casually.
- Git is invoked only through `src/git/runner.ts`. It uses `execFile`/`spawn` with no shell, `--end-of-options`, and `-c core.quotePath=false`; diff calls also pass `--no-ext-diff --no-textconv`. Validate any externally supplied SHA with `validateSha`.
- Every repository path goes through `normalizeRepoPath` (rejects absolute, drive-letter, `..` escapes and NUL). Sort with `compareStrings`, never `localeCompare`, because output order must not depend on locale.
- Never mark something that was not executed or measured as `ok`. Use `skipped`, `unsupported` or `failed` with a `reason`.
- Analysis logic stays free of GitHub API calls. API access belongs in a separate module (planned `src/github/`) that consumes the `Report` JSON. The core analysis must run locally without network access.
- Fork-PR design for the future Action: analysis runs under `pull_request` (read-only token, no secrets); commenting runs under `workflow_run` and only reads the uploaded artifact. Never build or run fork code under `pull_request_target`.
- ESM with `NodeNext`: relative imports in `src`/`test` need the `.js` extension. `tsconfig` enables `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Omit optional properties instead of assigning `undefined`.

## Known limitations

- Barrel files (`index.ts` re-exporting everything) make `possible` candidates explode. On excalidraw, a 2-file change yielded about 500 `possible` files out of 710.
- Only the root tsconfig is read (monorepo package configs are ignored).
- `.vue`, `.svelte` and `.mdx` files are not parsed.
- Type-only imports are treated like runtime imports.
