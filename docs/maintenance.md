# Maintenance

This document describes the local workflow for maintaining
`@styled/typescript-styled-plugin`.

## Requirements

- The Node.js version in `.github/.node-version` for development and builds.
- Node.js 14.21.3 or newer in the tsserver host at runtime, for both the plugin root and `./api` (docs/tsserver-host.md).
- Corepack and the Yarn version declared in `package.json`'s `packageManager` field.
- Git for contributing changes.

Clone the repository, enable the package manager when necessary, and install
the locked dependency graph:

```bash
git clone https://github.com/styled-components/typescript-styled-plugin.git
cd typescript-styled-plugin
corepack enable
yarn install --immutable
```

Without `corepack enable`, prefix every command with `corepack` instead
(`corepack yarn install --immutable`, `corepack yarn verify`); the commands
below are written in the shorter form. Dependencies' install scripts stay off
through `enableScripts: false` in `.yarnrc.yml`, so no extra flag or
environment variable is needed.

The root workspace includes the dependencies used by the tsserver E2E fixtures.
Do not install dependencies inside individual fixture directories.

## Commands

| Command                           | Purpose                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn compile`                    | Build the CommonJS tsserver entry and ESM API into `lib/`; also generates CJS types for `./api`.                                                                     |
| `yarn watch:compile`              | Rebuild the package while source files change.                                                                                                                       |
| `yarn pack:artifact`              | Build `lib/` (through `prepack`) and pack it to `package-artifact/package.tgz`, the tarball the package checks read.                                                 |
| `yarn benchmark`                  | Measure per-feature latency, cache throughput, and retained-heap slope.                                                                                              |
| `yarn format`                     | Apply formatting with `oxfmt`.                                                                                                                                       |
| `yarn format:check`               | Check formatting without modifying files.                                                                                                                            |
| `yarn lint`                       | Run `oxlint`.                                                                                                                                                        |
| `yarn lint:fix`                   | Apply safe lint fixes.                                                                                                                                               |
| `yarn typecheck`                  | Type-check source, scripts, and test code without emitting files.                                                                                                    |
| `yarn test`                       | Run `test:unit` then `test:e2e`.                                                                                                                                     |
| `yarn test:unit`                  | Run unit tests in `test/unit`.                                                                                                                                       |
| `yarn test:e2e`                   | Rebuild and run the Node tsserver scenarios in `test/e2e/scenarios`.                                                                                                 |
| `yarn test:e2e:run`               | Run E2E scenarios against the existing `lib/` build without rebuilding it.                                                                                           |
| `yarn test:e2e:current`           | Rebuild, then run E2E scenarios against the `typescript-current` workspace alias.                                                                                    |
| `yarn test:e2e:minimum`           | Rebuild, then run E2E scenarios against the minimum supported TypeScript workspace alias.                                                                            |
| `yarn test:e2e:5.9`               | Rebuild, then run E2E scenarios against the `typescript-5.9` workspace alias.                                                                                        |
| `yarn test:package-api`           | Load the packed tarball's root, `./api`, and deep subpaths through `require()` and `import()` (see Packaging below).                                                 |
| `yarn test:package-api:consumers` | Type-check the built declarations in every consumer gate, each on its own TypeScript version; name gates to run only those (docs/architecture.md, "Public surface"). |
| `yarn test:scaling`               | Fail on superlinear growth, a wrong result, or no real work in a hot operation, or cache memory past its bounds (see below).                                         |
| `yarn test:pack`                  | Assert the exact file list of the packed tarball (see Packaging below).                                                                                              |
| `yarn verify`                     | Run formatting, linting, type checking, all tests, and the package checks, building `lib/` once.                                                                     |
| `yarn compare-release`            | Print every diagnostic, completion, hover, fold, and code fix that differs from a published release (see below).                                                     |
| `yarn changeset`                  | Add a changeset describing a pending, noteworthy change (see Releases below).                                                                                        |
| `yarn changeset-credits`          | List the git authors and co-authors behind each pending changeset.                                                                                                   |
| `yarn changeset-version`          | Consume pending changesets: bump the version, write CHANGELOG.md, delete the changeset files. Run only by the release workflow.                                      |
| `yarn changeset-publish`          | Build and publish the package to npm. Run only by the release workflow.                                                                                              |

Run `yarn verify` before opening a pull request. It is the release-oriented
local gate and the closest equivalent to the CI workflow.

## Running tests

Only composite commands build: `yarn verify`, `yarn test:e2e` (and its
`:minimum`, `:5.9`, `:current` forms), `yarn pack:artifact`, and every
`yarn pack` through the `prepack` lifecycle. Every other check reads what is
already on disk: `yarn test:e2e:run`, `yarn test:package-api:consumers`, and
`yarn compare-release` read `lib/` (run `yarn compile`), while
`yarn test:package-api` and `yarn test:pack` read
`package-artifact/package.tgz` (run `yarn pack:artifact`). Each of the last
four fails with a message naming that command when its input is missing.
After a source change, rebuild before running one of them alone, since a
stale build passes as current (only `yarn compare-release` compares
modification times).

`yarn verify` builds once, through `yarn pack:artifact`, and runs every check
that reads `lib/` or the tarball after it. `yarn changeset-publish` builds
once, through the `prepack` lifecycle of the `yarn npm publish` it runs.

Every `test:e2e*` script rebuilds the same `lib/` directory, so running two of
them at once (checking two TypeScript aliases side by side, for example) races
on that rebuild: one run's `yarn compile` can overwrite `lib/` while the other
run's tsserver instances are loading it, producing a build mismatch rather
than a clean failure. Each run's tsserver logs go to their own directory
(`test/e2e/tsserver-fixture/clear-logs.ts`, keyed by the vitest process's
pid), but the rebuild is still not safe to run concurrently: run one
`test:e2e*` script to completion before starting another.

Every tool that runs plugin code is bounded so a regression fails it instead
of hanging the machine: the scaling check, the benchmark, and compare-release
run it in a worker thread with a deadline and a heap cap (below); an e2e
request with no answer within `TSSERVER_RESPONSE_TIMEOUT_MS`
(`test/e2e/tsserver-fixture/timeouts.ts`) fails its test and stops that
tsserver at once, and each tsserver runs with a heap cap
(`test/e2e/tsserver-fixture/server.ts`); each unit test worker runs with a heap
cap (`vitest.config.ts`). Vitest's own `testTimeout` cannot stop a test stuck
in a synchronous loop, since its timer runs on the same blocked thread, so
`yarn test:unit` and `yarn test:e2e:run` each run through
`scripts/with-deadline.ts` instead of calling Vitest directly (the deadline
each passes it is set where package.json invokes the wrapper). The wrapper
starts Vitest as the leader of its own process group and, once the run's
wall-clock deadline passes, kills the whole group, including any tsserver
child an e2e test started, then exits nonzero with a message naming what ran,
the deadline, and, when the wrapped command is `vitest`, that a synchronous
loop is the likely cause and how to find it (rerun with `--reporter=verbose`
to see which test last started). A run that finishes in time passes its exit
code and output through unchanged, and the wrapper forwards SIGINT and SIGTERM
to the child group so a cancelled run leaves nothing behind. Override the
deadline with the `WITH_DEADLINE_MS` environment variable for a shorter one
while testing the wrapper itself, or a longer one to keep a debugger attached
past the default.

Ad hoc probes of `src/` need `node --experimental-transform-types`, not
`--experimental-strip-types`: the source uses TypeScript parameter properties,
which type stripping alone rejects.

## Performance baseline

Run `yarn benchmark` to execute
`test/performance/template-language-service.bench.ts` with Node's native
TypeScript transform and explicit garbage collection. It prints a table of
latency and throughput for completions, diagnostics, hover, and folding on
small and large templates, plus a warmed completion-cache lookup. It also
reports two retained-heap slopes, KB retained per iteration between three
settle points, for a realistic request-per-iteration shape, a no-op control
(should read near zero), and a deliberate-leak control (should read clearly
above the no-op control). The command fails loudly if `--expose-gc` was not
passed, instead of printing a meaningless delta, and when any task throws. The
whole run happens in one worker thread (`scripts/bounded-worker.ts`), stopped
at a wall-clock deadline or a heap cap defined in the benchmark file; a stop
fails the command, naming the task it reached. The command passes
`--no-flush-bytecode` for the same reason the scaling guardrail does (below).

Results are machine-dependent; this repository does not record fixed numbers
here. Run the benchmark locally before and after a hot-path change and
compare the two runs directly, rather than against a number in this document.

## Scaling guardrail

`yarn test:scaling` (`test/performance/scaling-check.ts`, wired into `yarn
verify` and CI) times each hot operation (substitution, diagnostics, folding,
hover, completions, code fixes) at N and 4N, alternating the two sizes and
taking the minimum of several runs per size, and fails when time(4N)/time(N)
exceeds the threshold defined in that file. Each timing is the CPU time of the
thread running the check (`process.threadCpuUsage`), so time spent preempted by
other processes never counts; the script needs the development Node version for
that API. A
linear operation lands near 4; a quadratic one lands near 16;
the threshold sits between the two. Every timed result is also checked against
what its fixture must produce (a diagnostic per misspelled property, a fold
per rule, the expected substituted text), because the language service turns
a feature's exception into an empty result that is fast at every size; a
wrong result fails the check on its own, and so does a ratio below the floor
defined in that file, which means the timed call stopped doing work that
grows with its input. Heavy machine load can push one measurement's ratio past
the threshold or under the floor on unchanged code, so a ratio outside that
range prints a `retry 1/2` line and measures the check again, up to the retry
count defined in that file; the check fails only when every attempt lands
outside the range, which a real regression does. A wrong result is not
retried. This is the mechanical enforcement of the
AGENTS.md Performance rule against per-result or per-placeholder work
proportional to template length. It also runs a retained-heap guardrail that
drives a distinct edit session, several times longer than the diagnostics
validation cache's byte budget can hold, through
`StyledTemplateLanguageService.getSemanticDiagnostics` and fails if the heap
retained afterward exceeds a threshold derived from that byte budget
(`src/features/diagnostics.ts`, docs/architecture.md, Caching). It needs
`--expose-gc` and `--no-flush-bytecode`, which `yarn test:scaling` passes; a
run without either fails before any check starts. Without the second, V8
flushes the bytecode of idle functions after a number of collections that
varies from run to run, which moves the retained-heap reading by megabytes. A
heap that drops below zero by more than the tolerance defined in
`test/performance/scaling-check.ts`, and a measured service that stops
answering, fail as a broken probe, reported separately from a reading over the
threshold.

Each check, the retained-heap guardrail included, runs alone in its own worker
thread (`scripts/bounded-worker.ts`), which the script stops at a wall-clock
deadline or a heap cap, both defined in `test/performance/scaling-check.ts`.
Either stop fails that check as over the limit, naming the size and attempt it
reached, and most likely means a superlinear regression (a loop that never
ends included) or unbounded retention. Each check's line prints its wall time,
which a healthy run keeps far below the deadline even on a loaded machine. An
attempt whose ratio already sits far above the threshold after a few samples
stops sampling early; the check still fails only when every attempt does. A
budget defined in the same file bounds the whole run: each check's deadline is
cut to what remains of it, and checks left once it is spent fail unrun, so a
regression every check shares cannot run past CI's job timeout. No worker
outlives its check.

Run one check in isolation, to red/green it without paying for the whole
suite, with `--filter <substring>`: every check (and the retained-heap
guardrail) whose name includes the substring runs, keeping the run budget and
per-check deadline above unchanged. A substring that matches nothing fails
loudly, listing every check's name, rather than silently running zero checks:

```bash
corepack yarn test:scaling --filter 'JavaScript escape'
corepack yarn test:scaling --filter 'retained-heap guardrail'
```

## Comparing with a release

`yarn compare-release` (`scripts/compare-release.ts`) runs the same templates
through the working build in `lib/` and a published release (1.0.1 unless
`--version` names another), each loaded as a tsserver plugin inside an
in-memory TypeScript language service, and prints what differs. Use it to
confirm that a change to user-visible behavior differs from the release only
where intended, and to find shapes where the release already behaved
differently from the working build.

```bash
yarn compile
yarn compare-release                                   # the default cases
yarn compare-release path/to/cases.mjs --all           # every case, differing or not
yarn compare-release cases.mjs --filter '^(?!huge)'    # only cases whose name matches
```

- Cases: a module whose default export is an array of
  `{ name, code, ext?, config?, ops? }` (the `CompareCase` type in
  `scripts/compare-release-cases.ts`, which holds the default cases). `⟨a⟩` in
  `code` marks a position named `a`. `ops` lists `diag`, `fix`, `fold`,
  `{ op: 'comp', at, show? }`, `{ op: 'hover', at }`,
  `{ op: 'configure', configuration }`, and `{ op: 'change', from, to?, text }`,
  and defaults to one `diag`. `config` holds plugin settings, as in
  `tsconfig.json`.
- The release is fetched once with `npm pack --ignore-scripts` into
  `node_modules/.cache/compare-release/<version>/`, and resolves its
  dependencies from this repository's `node_modules`: nothing is installed and
  no package script runs. Delete that directory to fetch it again.
- A release that throws is a result, printed as `threw` with the first line of
  the error (tsserver fails the whole response for a file on one).
- Each build runs in its own worker thread, both builds of a case at once, and
  each case is stopped at a wall-clock deadline or a heap cap defined in the
  script. A stop is also a result: the operation it happened in reads as
  stopped at the deadline or the heap cap, later ones as not run, and the run
  goes on to the next case in a fresh worker for that build.
- The run fails with a message, exit code 1, when `lib/` is missing or older
  than `src/`, when either build does not load, or when either build reports
  nothing for a positive-control template with a misspelled property, which a
  plugin that failed to load silently would also do.
- Blind spots: no real tsserver (protocol, closed files, and project loading
  are the e2e suite's job); positions after a `change` op come from the markers
  of the original code; the release runs on this repository's dependency
  versions.

## Project layout

- `src/`: plugin implementation and public API source. In `src/virtual-document/`, `styled-virtual-document-provider.ts` builds the virtual document and its reading, `css-code-scanner.ts` holds the boundary scanner every structural read shares, and `template-line-map.ts` maps lines, positions, and ranges between the template and the virtual document.
- `test/unit/`: fast tests for mapping, configuration, and feature behavior.
- `test/e2e/scenarios/`: protocol-level scenarios that fork a real tsserver.
- `test/e2e/tsserver-fixture/`: the tsserver process harness.
- `test/e2e/*-project-fixture/`: fixture projects used by E2E scenarios.
- `test/performance/`: `scaling-check.ts` (see Scaling guardrail below) and its pure CLI helpers in `scaling-check-cli.ts` (`--filter` parsing, per-check progress tracking, both covered by `test/unit/scaling-check-cli.test.ts`); `template-language-service.bench.ts` and its shared fixtures in `template-language-service-fixture.ts` (see Performance baseline below); a standalone, flag-run memory probe with no build step, `validation-cache-key-flattening-probe.mjs` (the diagnostics validation cache's key, `buildValidationCacheKey` in `src/features/diagnostics.ts`), runnable directly with `node --expose-gc <path>` and self-checking against a held-forever control before trusting its own reading.
- `scripts/`: the changelog generator, the pack-contents check, the consumer type gate runner, changeset credits, the compare-release sensor, `bounded-worker.ts`, which runs plugin code for the scaling check, the benchmark, and compare-release in a worker thread with a deadline and a heap cap, `kill-group.ts`, the POSIX process-group signaling `with-deadline.ts` uses (split out so a test can exercise it without triggering that file's own CLI entry point), and `with-deadline.ts`, which gives `yarn test:unit` and `yarn test:e2e:run` a whole-run wall-clock deadline (see [Running tests](#running-tests)).
- `lib/`: generated build output; never edit it manually.

E2E tests load the compiled `lib/` package; see [Running tests](#running-tests)
for when that build needs a rebuild.

## Focused tests and tsserver debugging

Run a single unit or E2E scenario through Yarn so the workspace-provided
Vitest binary and configuration loader are used, through the same deadline
wrapper `yarn test:unit` and `yarn test:e2e:run` use (raise the deadline with
`WITH_DEADLINE_MS` to keep a debugger attached to the one file past the
default):

```bash
yarn node --experimental-strip-types scripts/with-deadline.ts 60000 -- vitest run test/unit/plugin-configuration.test.ts --configLoader runner
yarn compile && yarn node --experimental-strip-types scripts/with-deadline.ts 300000 -- vitest run test/e2e/scenarios/completions.test.ts --configLoader runner
```

E2E scenarios drive a real tsserver through `test/e2e/tsserver-fixture/`'s
`TSServer` wrapper (`server.ts`). Most scenario files share one tsserver
across every test in the file (`useSharedServer`, started before the first
test and closed after the last, `test/e2e/tsserver-fixture/helpers.ts`); a
scenario that needs an isolated instance, such as one exercising plugin
startup itself, uses `startServer` instead, which closes it when that one
test finishes. `TSServer.request` matches each response to its request by
`request_seq`, and stops that tsserver at once, failing the whole session, if
no response for a request arrives within `TSSERVER_RESPONSE_TIMEOUT_MS`
(`test/e2e/tsserver-fixture/timeouts.ts`), since a plugin stuck in a
synchronous loop never reads stdin again for `close()` to end it. To
investigate a plugin-host interaction, add or adjust the smallest scenario in
`test/e2e/scenarios/`, use `server.open()` to provide the source, marking
positions and ranges in it with `⟨name⟩` and `⟨/name⟩` and reading them back
through `mark()`'s `at`/`range` (`test/e2e/tsserver-fixture/markers.ts`), send
the relevant protocol command, then inspect the typed response helpers. Each
`TSServer` instance writes verbose tsserver output to its own gitignored file
under `test/e2e/tsserver-fixture/logs/`, cleared once per e2e run
(`test/e2e/tsserver-fixture/clear-logs.ts`, wired in as the `globalSetup` of
`vitest.config.ts`'s `e2e` project only, alongside `check-plugin-link.ts`,
which fails the run up front if the e2e workspace resolves the plugin package
to anywhere other than this repository's own build; a `test:unit` run, which
resolves to the separate `unit` project, leaves the directory untouched);
read it back in a scenario with `server.readLog()` to confirm plugin
discovery and request handling after a failing scenario, or after closing the
server, from disk directly.

The only runtime call into `typescript-template-language-service-decorator` is
in `src/tsserver/tsserver-plugin.ts`. Keep that integration direct until a
confirmed compatibility defect requires a local adapter. Changes at this
boundary must run `yarn test:e2e:current`; the lifecycle and syntax scenarios
verify plugin loading, configured tag matching, and tag configuration updates
through a real tsserver host at the `typescript-current` alias version
(`test/e2e/package.json`).

## Testing changes

Add a unit test when changing template substitution, virtual document mapping,
configuration handling, or a feature implementation that can be exercised
without a process boundary. Add or update a tsserver scenario when the change
affects plugin discovery, tsserver protocol behavior, source-file handling, or
the interaction between the plugin and a real TypeScript host.

CI builds the package with the Node.js version in `.github/.node-version`, then
verifies the resulting artifact on Node 22.12 and that version against the
TypeScript versions listed in the e2e matrix
of `.github/workflows/ci.yml` (the supported floor through the current
release); `yarn verify` only runs the e2e suite once, against the default
TypeScript version, so run `yarn test:e2e:minimum`, `yarn test:e2e:5.9`, and
`yarn test:e2e:current` locally too before relying on `verify` alone for a
change near the supported TypeScript range. The vitest-based E2E suite cannot
run on this package's own Node floor, 14.21.3 (docs/tsserver-host.md): vitest
declares a newer `engines.node` than that. A separate CI job
(`tsserver-smoke-floor`) drives a real tsserver directly with
`test/package-api/tsserver-smoke.cjs`, a plain-CommonJS script with no
build-tool dependency, against the packed
tarball on that floor Node; `yarn verify` does not run this job. Reproduce it
locally in two steps. Pack with the development Node, since Yarn 4 itself
requires Node 18.12 or newer:

```bash
yarn pack:artifact
```

Then run the smoke script with a Node 14.21.3 binary specifically on `PATH`
(the whole point is the package's own floor, so running it with the
development Node instead proves nothing about it; a version manager such as
`nvm install 14.21.3 && nvm use 14.21.3` or
`fnm install 14.21.3 && fnm use 14.21.3` selects one):

```bash
node test/package-api/tsserver-smoke.cjs package-artifact/package.tgz node_modules/typescript-minimum
```

Neither job establishes compatibility with a specific editor. Before claiming
support for an additional host, verify its TypeScript and Node versions meet
the package requirements and that it can load the plugin through the normal
`plugins` configuration path.

## Packaging and pull requests

`package.json` publishes only `lib/`; runtime dependencies are installed by npm
from the package's `dependencies`. The `prepack` lifecycle rebuilds `lib/`
before every tarball is created, including on a dry run, and tsdown empties
`lib/` before each build, so a tarball never carries a stale file: Yarn's
`enableScripts: false` disables dependencies' install scripts, not this
package's own `prepack`. Every tarball this repository builds, in CI and in
tests, comes from `yarn pack`, the packer `yarn npm publish` uses, through
`yarn pack:artifact`. The package API test (`test/package-api/runtime.ts`)
extracts that tarball into a throwaway project and loads the synchronous
tsserver entry and the ESM API from it, each through both `require()` and
`import()`. Inspect the release contents with:

```bash
yarn pack --dry-run
```

`yarn test:pack` (`scripts/check-pack-contents.ts`, wired into `yarn verify`
and CI) lists the same tarball and fails listing every missing and
unexpected file. It expects every path `package.json` points a consumer at
(`main`, `types`, `exports`, `typesVersions`), plus the build-hook files and
the root files Yarn always packs, both listed in the script. A `files` glob or
negation, or an `exports` or `typesVersions` wildcard pattern, fails the check
with a message naming it, since the script compares literal paths only.

Keep changes focused and include tests at a scope proportionate to the behavior
change. Use a feature branch, push it to your fork, and open a pull request
against this repository. All contributors must follow the
[Code of Conduct](../CODE_OF_CONDUCT.md).

## Releases

`package.json`'s `workspaces` field lists `.` alongside `test/e2e`. Without
that entry, `@changesets/cli`'s workspace detection (`@manypkg/get-packages`)
treats the presence of any `workspaces` field as turning this into a
monorepo, and stops treating the root package as a package at all, so every
changesets command fails with "which is not in the workspace". Listing `.` as
a workspace member fixes that without changing how `test/e2e` itself
installs or links against the root package.

Every noteworthy change or fix ships with a changeset:

```bash
corepack yarn changeset
```

This prompts for a bump type (patch or minor; use major only for an
intentional break in the public surface, AGENTS.md "Correctness and types")
and a description, then writes a file under `.changeset/`. Write the
description in declarative release-note voice (what changed, for whom), never
first-person, matching the tone of the existing `.changeset/*.md` files.
Before crediting anyone by name, run:

```bash
corepack yarn changeset-credits
```

This lists the git authors and co-authors behind every pending changeset, so a
thank-you is derived from history rather than recalled from memory.

Release automation lives in `.github/workflows/release.yml`. On every push to
`main`, a `verify` job runs `yarn verify` once; the `release` and `prerelease`
jobs both wait on it (`needs: verify`) before doing anything else. The
`release` job either opens or updates a "Version Packages" pull request (one
`changeset version` behind pending changesets) or, once that pull request is
merged, builds and publishes the package. A failing `verify` stops both jobs
before anything is published. Nobody bumps `version` or runs `npm publish` by
hand.

The `prerelease` job publishes a snapshot build to the npm `test` dist-tag
whenever the push leaves pending changesets behind (any `.changeset/*.md`
other than `README.md`), so a reviewer can install a pull request's changes
before the "Version Packages" pull request merges. It versions with
`changeset version --snapshot prerelease` (never committed), publishes with
`changeset publish --tag test --no-git-tag`, then tags the commit itself
(`<package>@<version>`) and creates a GitHub prerelease, using
`scripts/prerelease-notes.ts` to pull that version's release notes out of the
`CHANGELOG.md` the snapshot version just wrote. It no-ops once the "Version
Packages" pull request merges, since that merge consumes every pending
changeset. Install a snapshot with:

```bash
npm install @styled/typescript-styled-plugin@test
```

Publishing itself needs no long-lived npm token: it relies on
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers), which
exchanges the workflow's own GitHub Actions OIDC identity for a short-lived
npm credential. This is a one-time, maintainer-only setup step, not something
a contribution needs to touch:

1. On npmjs.com, open `@styled/typescript-styled-plugin`'s settings and add a
   GitHub Actions trusted publisher.
2. Point it at the `styled-components/typescript-styled-plugin` repository and
   the `release.yml` workflow filename (`.github/workflows/release.yml`).
3. Under the allowed actions, also allow direct publishing with `npm publish`.
   A trusted publisher created after September 3, 2026 allows only
   `npm stage publish` by default, and the release workflow publishes
   directly rather than staging a release for later approval.

The release workflow publishes with `yarn npm publish`, which performs that
exchange against the registry in `package.json`'s `publishConfig.registry`
(`https://registry.npmjs.org`) rather than Yarn's default,
`registry.yarnpkg.com`, which forwards to npm. Until the trusted publisher is
configured with direct publishing allowed, the publish step fails with an
authentication error; it is not something a change to this repository's code
can fix.

CI releases carry npm provenance: the release workflow sets Yarn's
`npmPublishProvenance` setting (as `YARN_NPM_PUBLISH_PROVENANCE`), so each
published version links to the workflow run that built it. Yarn signs the
provenance statement before it contacts the registry, with no fallback, so a
release requires:

- the `id-token: write` permission in `release.yml` (without it, Yarn stops
  with "Provenance generation in GitHub Actions requires "write" access to the
  "id-token" permission");
- a runner that reaches Sigstore's certificate authority, Fulcio
  (`https://fulcio.sigstore.dev`), and its transparency log, Rekor
  (`https://rekor.sigstore.dev`), the default endpoints Yarn calls.

When Sigstore is unavailable, the publish step fails before anything reaches
npm, in either the `release` or the `prerelease` job (both publish with
provenance). Re-run the failed job once Sigstore recovers (its status page is
[status.sigstore.dev](https://status.sigstore.dev)). The re-run is safe:
`changeset publish` publishes only versions the registry does not list yet,
the `release` job's git tag comes from `changeset publish` itself for a
version it published, and the `prerelease` job's git tag and GitHub release
are separate steps that run only after its publish step succeeds; a failed
publish attempt leaves no tag, GitHub release, or registry entry behind to
block the retry.
