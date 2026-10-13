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
   - It parses each module with the TypeScript compiler API (`parseModule.ts`) and resolves specifiers in memory (`resolve.ts`) against a virtual root `/__repo__`, so resolution can never touch the real filesystem.
   - `parseModule` records per import binding which of the module's exports use it (`dependents`, through top-level declarations; `'*'` when module-level code uses it), plus re-exports and local export names.
   - `symbols.ts` `buildSymbolEdges` follows each imported name through re-exports to the defining file. Edges carry `names` (what of `to` is used) and `exports` (what of `from` is then affected).
   - `graph.ts` `computeImpact` runs a name-level BFS over the reverse graph from the seeds produced by `classify.ts`.
3. Each stage returns a `Section<T>` with `{ status, data?, reason?, evidence[] }` (`src/core/types.ts`). Errors are caught per section, so a failing section does not abort the others.

Impact semantics (keep these consistent when extending):
- Seeds: changed files. Deleted files and the *old* path of a rename become `removed` seeds. Their paths are added to the resolver's path set so that importers still pointing at them resolve and are reported as `imports-deleted`.
- Propagation is by export name: an importer is hit only if it uses an affected export, and only its exports whose code uses that import propagate further. Changed files have all exports affected.
- Edge kinds: `use` (code uses the definition), `reexport` (barrel passes it on; listed as `re-exports`, never expanded), `through` (importer passed through a barrel; only counts when that barrel itself changed). Depth counts `use` steps; barrels appear in `via` but add no depth.
- When a name cannot be followed (namespace import, CommonJS/`export =`, unparsed file, a name no longer exported, re-export cycle), fall back to the whole module. Precision may degrade; recall must not.
- Depth 1 users are `confirmed`; depth ≥ 2 are `possible`. A dynamic `import()` whose static prefix directory contains a changed file is reported as `unknown`. Config files (`classify.ts` `isGlobalConfig`) and non-code files with no importers are `unknown` scope.
- Unresolved imports are only surfaced (as evidence) for changed files. Bare specifiers that match no alias are treated as external packages.
- Hitting `maxDepth`, `maxGraphNodes`, `maxTotalBytes` or `maxFiles`, or a file the parser cannot handle, sets the status to `truncated` with a reason. It must never be silently `ok`.
- `tsconfig` `paths` from the analysed repo are untrusted: aliases are matched with plain prefix/suffix comparison (`matchAlias`), never by building a RegExp from config text.

Path aliases: `config.ts` reads the root `tsconfig.json`/`jsconfig.json` (following `extends` within the repo). `resolve.ts` never passes `baseUrl` to TypeScript, because it is deprecated in TS 6. Instead it rewrites `paths` targets to be repo-relative and emulates a project `baseUrl` with a fallback `*` mapping. Non-code assets imported through aliases or relative paths (`@/styles.css`) are resolved by a manual fallback, because TypeScript doesn't resolve them.

## Constraints and invariants

- **`typescript` is a runtime dependency pinned to `6.0.3`.** TypeScript 7 has no classic compiler API (`preProcessFile`, `resolveModuleName`), and typescript-eslint supports only versions below 6.1. Don't upgrade it casually.
- Git is invoked only through `src/git/runner.ts`. It uses `execFile`/`spawn` with no shell, `--end-of-options`, and `-c core.quotePath=false`; diff calls also pass `--no-ext-diff --no-textconv`. Validate any externally supplied SHA with `validateSha`.
- Every repository path goes through `normalizeRepoPath` (rejects absolute, drive-letter, `..` escapes and NUL). Sort with `compareStrings`, never `localeCompare`, because output order must not depend on locale.
- Never mark something that was not executed or measured as `ok`. Use `skipped`, `unsupported` or `failed` with a `reason`.
- Analysis logic stays free of GitHub API calls. API access belongs in a separate module (planned `src/github/`) that consumes the `Report` JSON. The core analysis must run locally without network access.
- Fork-PR design for the future Action: analysis runs under `pull_request` (read-only token, no secrets); commenting runs under `workflow_run` and only reads the uploaded artifact. Never build or run fork code under `pull_request_target`.

## This repo's own PR checks

- `ci.yml` (`pull_request`): typecheck, lint, test, build, plus an Impactly report in the job summary. It is informational only, by the owner's choice; tests are not a merge requirement.
- `security.yml` (`pull_request_target`) is the **only merge-blocking check**. It publishes the commit status `security-gate` on the PR head, and the `main` ruleset requires that status. It runs `.github/scripts/security-gate.sh` and gitleaks (pinned version and SHA-256) with `.gitleaks.toml`, all taken from the **base branch**, so edits in a PR only apply after merge. The script must keep treating the PR as git data only (no checkout-and-run, no `npm install`). It also fails closed: tool errors exit 2 and leaks it cannot parse still fail.
- Test the gate script locally with throwaway repos. It needs `gitleaks` and `jq`. With Git Bash on Windows, put `/c/...` style paths in `PATH`, because `C:` breaks the `:` separator.
- ESM with `NodeNext`: relative imports in `src`/`test` need the `.js` extension. `tsconfig` enables `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Omit optional properties instead of assigning `undefined`.

## Known limitations

- Hub files still fan out: on excalidraw a 2-file change yields about 256 `possible` files (down from about 500 before name-level tracking), mostly through `App.tsx`. A class or object counts as one declaration, so using any import anywhere in it affects that whole export.
- Identifier matching is by name, not scope (shadowing can only over-report). Module side effects reached through barrels are not tracked.
- Only the root tsconfig is read (monorepo package configs are ignored).
- `.vue`, `.svelte` and `.mdx` files are not parsed.
- Type-only imports are treated like runtime imports.
