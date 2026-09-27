AGENTS.md: instructions for any agent or contributor working in this repository.

Project: `@styled/typescript-styled-plugin`, a TypeScript language service (tsserver) plugin that adds CSS completions, diagnostics, quick fixes, hover, folding, and Emmet inside styled-components tagged templates. Published to npm; bundled by the vscode-styled-components extension. Public OSS repository.

Map

- docs/architecture.md: spec for request flow, substitution and virtual-document invariants, position mapping, completion merging, caching, configuration, public surface. Read before touching src/.
- docs/tsserver-host.md: verified facts about tsserver plugin loading, supported TypeScript and Node versions, host runtimes, the decorator dependency, tag matching, and tsserver test-harness pitfalls.
- docs/usage.md: user-facing configuration (tags, validation, lint, Emmet) and host requirements.
- docs/maintenance.md: commands, project layout, focused tests, tsserver debugging, packaging, releases.
- CHANGELOG.md: released, user-visible changes, assembled by the release workflow from `.changeset/`; never edited by hand.
- .changeset/: one file per pending noteworthy change or fix, consumed by the next release (Git and releases, below).
- src/api.ts: the public API (`./api` export). src/index.ts: the tsserver entry. src/features/: one file per language feature.
- scripts/: build, packaging, and diagnostic tooling behind the commands below.
- test/unit (vitest, imports src and scripts/), test/e2e (a shared tsserver per suite file, runs the built lib/), test/package-api (packed tarball consumed from ESM and CommonJS), test/performance (benchmark, scaling check, and a cache-key retention probe).

Commands

- Package manager: Yarn 4 through corepack (`corepack yarn ...`); setup and install in docs/maintenance.md, "Requirements".
- `corepack yarn verify` runs format check, lint (warnings fail), typecheck, unit, e2e (default TypeScript version), scaling, package API, pack contents (`yarn test:pack`). CI additionally gates on the TypeScript e2e matrix (`corepack yarn test:e2e:minimum`, `:5.9`, `:current`) and a Node-floor tsserver smoke job (docs/maintenance.md, "Testing changes"); run both locally before relying on a passing `verify` alone for a change near that boundary.
- Only composite commands build (`verify`, `test:e2e*`, `pack:artifact`); every other check reads the existing lib/ or packed tarball (docs/maintenance.md, "Running tests").
- e2e against another TypeScript: set `TSSERVER_TYPESCRIPT_PACKAGE` to an alias declared in test/e2e/package.json.
- `corepack yarn benchmark` prints completion/diagnostics/hover/folding latency and retained-heap slopes (KB per iteration between settle points, with a no-op and a deliberate-leak control).
- `corepack yarn compare-release [cases...]` prints the diagnostics, completions, hovers, folds, and code fixes that differ between `lib/` and a published release (docs/maintenance.md, "Comparing with a release").

Rules

Prose

- American English, plain words, jargon defined on first use. No em-dashes in written files.
- Docs state current behavior; no narration of history. One fact, one home: link to the home instead of restating.
- Error and log messages name the problem, where it occurred, and the fix (for example the required TypeScript version and the detected one).
- No attribution footers or trailers in commits, PRs, or files.

User experience

- Least surprise for the plugin's users: code that works at runtime in a supported styled-components version produces no plugin diagnostic, and when unsure, stay silent rather than report a false error. Completions offer what a user would plausibly type in that position.
- Contributor tooling (`verify`, the scaling check, the pack checks) fails only for real defects, never for machine load or environment noise.
- Legacy CSS syntax that nearly no current user writes (vendor-prefixed at-rules and similar) is out of scope and not worth adding support for, unless 1.0.1 already supported it.

Correctness and types

- TypeScript strict; no `as any`, non-null assertions, or `@ts-expect-error` outside a marked negative type test.
- The tsserver boundary is untrusted input: plugin configuration arrives as `unknown` and is normalized, never assumed.
- Never let an exception escape into tsserver: a throw fails the whole response for the file, including TypeScript's own diagnostics.
- Never call `TemplateContext.toOffset` or `toPosition` with a value outside the template (tsserver asserts on closed files).
- Substitution output keeps the input length exactly; mapping never relies on the substituted text's line breaks (docs/architecture.md).
- Public surface (package root factory, `./api` exports, emitted `.d.ts`) is backward compatible or ships in a `major` changeset that states the break. Internal code may be rewritten freely.
- Emitted declarations must compile under `skipLibCheck: false` on the minimum and maximum supported TypeScript, plus two versions in between, and under `moduleResolution: node10` and `bundler`; `corepack yarn test:package-api:consumers` runs every gate, one `test/package-api/tsconfig.consumers.<gate>.json` each, so adding a TypeScript version means adding one tsconfig (docs/architecture.md, "Public surface").
- Version support covers what the last release demonstrably ran on, plus newer hosts; never widen support backward to a host the last release did not actually work on, even when its code gate admitted it (docs/tsserver-host.md records the measured floors). A host below the floor gets a logged message and an untouched language service.
- 1.0.1's deep-import surface (no `exports` map at all) is a compatibility floor, not a spec: a new subpath keeps resolving the way it did in 1.0.1 (`./lib/index`, `./lib/index.js`, `./lib/api`, `./lib/api.js`), or the removal ships in a `major` changeset.

Testing

- Every behavior change ships with tests; prove each new test fails before the fix and passes after.
- Test real behavior headlessly: unit tests for mapping and translation logic, e2e for anything that depends on real tsserver behavior (closed files, protocol, plugin loading).
- Assert exact values derived from the input (offsets, spans, messages), never values copied from a run. Prefer full-output assertions over `length > 0`.
- Every "returns nothing" assertion needs a positive control in the same setup, since a plugin that failed to load also returns nothing.
- Cover edge shapes: multi-line interpolations, CRLF, U+2028/U+2029, empty and whitespace-only templates, unclosed blocks, `keyframes`, nested `css`, `.attrs()`, generics, files not open in the editor.
- Supported host matrix (TypeScript 5.0 floor through current 6.x; Node 14.21.3 floor) runs in CI via the e2e matrix plus the `tsserver-smoke-floor` job (the vitest-based e2e suite cannot run on the package's own Node floor, since vitest declares a newer `engines.node`). The `tsserver-smoke-legacy-typescript` job proves the plugin instead logs a message and leaves tsserver responsive on TypeScript 4.9.5, below that floor (docs/tsserver-host.md). Add an e2e matrix row when the TypeScript 5.0-or-newer support range changes, and update `tsserver-smoke-floor` when the Node floor changes.
- Local test runs stay fast; investigate any slow test instead of raising timeouts.

Organization and naming

- One language feature per file in src/features/; shared mapping lives in src/virtual-document/.
- Alphabetize fields in type declarations and object literals unless order is load-bearing (then comment why).
- Prefer exported constants over repeated string literals (tag names, diagnostic codes, plugin identity).
- A source file past about 1,000 lines prompts a split.

Comments

- Block comments (`/** */`) only, for design decisions and non-obvious behavior; never restate types or narrate a change.
- Code comments are not authoritative; the spec in docs/architecture.md is. Update the spec first for invariant changes.

Security and supply chain

- Package lifecycle scripts stay disabled; enable one only for demonstrated breakage with a one-line justification.
- Yarn's `npmMinimalAgeGate` holds back freshly published versions; do not bypass it.
- Lockfile changes accompany every dependency change and are verified by a full test run.
- No new runtime dependency without need; runtime dependencies must be CommonJS-loadable or bundled, with no top-level await (docs/tsserver-host.md).

Performance

- Completion and hover run per keystroke. Validate hot-path changes with `corepack yarn benchmark` before and after, with a realistic `TemplateContext` fixture; a slowdown is a regression.
- The happy path does not pay for edge cases: handling for a rare input shape runs only after a cheap check proves that shape is present, so a template without it costs the same as before the handling existed. Show it with a before-and-after benchmark on templates without the shape.
- Do not record measured numbers in docs; state the command that prints them.
- No per-result or per-placeholder work proportional to template length (a per-placeholder slice from the line start, a per-diagnostic line-map rebuild). A multi-entry cache keyed by template text copies the key (docs/architecture.md, Caching), never stores a slice of the source string, and is bounded by total size, not only entry count (every keystroke adds a distinct key). `corepack yarn test:scaling` (`test/performance/scaling-check.ts`) gates superlinear time, wrong results, implausibly flat timing, and retained memory in CI (docs/maintenance.md, "Scaling guardrail"); add a check there for a new hot operation or cache.

Git and releases

- Noteworthy changes and bugfixes get a changeset (`corepack yarn changeset`). Changeset bodies use declarative release-note voice (what changed, for whom), never first-person "I", and no conventional-commit prefixes. Match the tone of existing `.changeset/*.md` entries.
- Before crediting anyone in a changeset, derive the list rather than recalling it: `corepack yarn changeset-credits [name]` reports every commit author and co-author who introduced or edited that changeset file, pending or already released.
- Version bumps and npm publishing happen only through the release workflow (`.github/workflows/release.yml`), from accumulated changesets, including the snapshot builds its `prerelease` job publishes to the npm `test` dist-tag on every push to `main` with pending changesets (docs/maintenance.md, "Releases"); contributions leave `version` alone and never publish by hand.
- `scripts/changelog.cjs` is the changelog generator, wired in `.changeset/config.json` along with the `maintainers` list it reads. Attribution comes from git history, so the release job checks out full history rather than a shallow clone.
- Conventional commit subjects (`fix:`, `feat:`, `test:`, `docs:`, `chore:`) on commits and PR titles. Never `git stash`; use a temporary commit.
- Keep PRs to one kind of change (tooling, behavior, packaging) so each can be reviewed and reverted alone.

Method

- A reported defect names a class: search for every instance (code, tests, docs, CI) and fix all of them in the same change, or list the rest.
- Verify ecosystem claims (TypeScript, Node, editor hosts, dependencies) against primary sources or experiment before relying on them; record durable ones in docs/tsserver-host.md with a date.
- Fix causes, not symptoms: no swallowing catches around logic errors, no raised timeouts over races, no snapshots updated to green.
- Before reporting work complete or opening a PR, run an independent adversarial review with a fresh context.

Not applicable: UI and visual design (headless library), database migrations.

Tracker: GitHub Issues on styled-components/typescript-styled-plugin. AGENTS.md is not a changelog or backlog.
