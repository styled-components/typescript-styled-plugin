/**
 * Compare-release sensor: runs the same templates through the working build (lib/, from
 * `corepack yarn compile`) and a published release of this package, each loaded as tsserver loads
 * a plugin but inside an in-memory TypeScript language service, and prints every diagnostic,
 * completion list, hover, folding result, and code fix that differs.
 *
 * Usage: `corepack yarn compare-release [--version 1.0.1] [--all] [case-module ...]`
 * - A case module's default export is an array of cases (CompareCase in
 *   scripts/compare-release-cases.ts, the default module when none is given). `⟨name⟩` in a case's
 *   code marks a position (stripped before the code is used); `ops` defaults to one `diag`.
 * - `--version` picks the release (default 1.0.1). It is fetched once with `npm pack
 *   --ignore-scripts` and extracted under node_modules/.cache/compare-release/<version>/, where it
 *   resolves its dependencies from this repository's own node_modules: nothing is installed and no
 *   package script runs.
 * - `--all` prints every case, not only the ones that differ.
 * - `--filter <regex>` runs only the cases whose name matches, such as `'^(?!huge)'`.
 * - Each build runs in its own worker thread, both builds of a case at once, and each case is
 *   stopped at CASE_DEADLINE_MS or CASE_HEAP_CAP_MB (scripts/bounded-worker.ts). A stop is that
 *   build's result for the operation it stopped in, printed like a throw, and the run goes on in a
 *   fresh worker.
 *
 * Fails loudly (exit 1) when lib/ is missing or older than src/, when either build does not load,
 * or when either build reports nothing for a positive-control template with a misspelled property,
 * which a plugin that silently failed to load would also do, or stops on it.
 *
 * Blind spots: tsserver itself is not involved (no protocol, no closed-file handling, no project
 * loading); positions after a `change` op still come from the markers of the original code; the
 * release runs against this repository's dependency versions, not the ones a fresh install of it
 * would resolve.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { isMainThread } from 'node:worker_threads'

import ts from 'typescript'

import { BoundedWorker, formatSeconds, serveBounded } from './bounded-worker.ts'
import type { CompareCase, CompareOperation } from './compare-release-cases.ts'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = '@styled/typescript-styled-plugin'
const DEFAULT_VERSION = '1.0.1'
const PLUGIN_SOURCE = 'ts-styled-plugin'
const DEFAULT_CASES = path.join(REPOSITORY_ROOT, 'scripts', 'compare-release-cases.ts')
const CACHE_ROOT = path.join(REPOSITORY_ROOT, 'node_modules', '.cache', 'compare-release')
const WORKING_ENTRY = path.join(REPOSITORY_ROOT, 'lib', 'index.js')
const VIRTUAL_DIRECTORY = '/compare-release'
const DEFAULT_COMPLETION_SHOW = 10
/** Longest spanned text a result line quotes; a folding range can cover a whole template. */
const MAX_QUOTED_LENGTH = 80
const MARKER_PATTERN = /⟨([^⟩]*)⟩/g

const CONTROL_CASE: CompareCase = {
  code: "import styled from 'styled-components'\nconst A = styled.div`\n  colr: red;\n`",
  name: 'positive control',
}
const CONTROL_MESSAGE = "Unknown property: 'colr'"

interface PluginModule {
  create(info: object): ts.LanguageService
  onConfigurationChanged?(configuration: unknown): void
}

interface Build {
  readonly factory: (modules: { typescript: typeof ts }) => unknown
  readonly label: string
}

class CompareReleaseError extends Error {}

function fail(message: string): never {
  throw new CompareReleaseError(message)
}

function parseArguments(argv: readonly string[]) {
  let version = DEFAULT_VERSION
  let showAll = false
  let filter: RegExp | undefined
  const caseModules: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] ?? ''
    if (argument === '--all') {
      showAll = true
    } else if (argument === '--version') {
      version = argv[++index] ?? fail('--version needs a value, such as --version 1.0.1.')
    } else if (argument === '--filter') {
      filter = parseFilter(argv[++index] ?? fail('--filter needs a regular expression.'))
    } else if (argument.startsWith('--')) {
      fail(`Unknown option ${argument}. Options: --version <version>, --filter <regex>, --all.`)
    } else {
      caseModules.push(path.resolve(argument))
    }
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`--version ${version} is not a release version such as 1.0.1.`)
  }
  return {
    caseModules: caseModules.length > 0 ? caseModules : [DEFAULT_CASES],
    filter,
    showAll,
    version,
  }
}

function parseFilter(source: string): RegExp {
  try {
    return new RegExp(source)
  } catch (error) {
    fail(`--filter ${source} is not a valid regular expression: ${String(error)}`)
  }
}

/** The newest modification time under `directory`, in milliseconds. */
function newestModification(directory: string): number {
  let newest = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    const modified = entry.isDirectory()
      ? newestModification(entryPath)
      : statSync(entryPath).mtimeMs
    newest = Math.max(newest, modified)
  }
  return newest
}

function checkWorkingBuild(): void {
  if (!existsSync(WORKING_ENTRY)) {
    fail(`The working build is missing (${WORKING_ENTRY}). Run corepack yarn compile first.`)
  }
  if (newestModification(path.join(REPOSITORY_ROOT, 'src')) > statSync(WORKING_ENTRY).mtimeMs) {
    fail(
      'lib/ is older than src/, so it would compare stale code. Run corepack yarn compile first.',
    )
  }
}

/** The release's lib/index.js, fetched and extracted into the cache on first use. */
function ensureRelease(version: string): string {
  const versionDirectory = path.join(CACHE_ROOT, version)
  const entry = path.join(versionDirectory, 'package', 'lib', 'index.js')
  if (existsSync(entry)) {
    return entry
  }
  const workDirectory = mkdtempSync(path.join(tmpdir(), 'compare-release-'))
  try {
    execFileSync(
      'npm',
      [
        'pack',
        `${PACKAGE_NAME}@${version}`,
        '--ignore-scripts',
        '--pack-destination',
        workDirectory,
      ],
      { cwd: workDirectory, stdio: ['ignore', 'ignore', 'inherit'] },
    )
    const tarball = readdirSync(workDirectory).find((name) => name.endsWith('.tgz'))
    if (!tarball) {
      fail(`npm pack ${PACKAGE_NAME}@${version} wrote no tarball to ${workDirectory}.`)
    }
    const extracted = path.join(workDirectory, 'extracted')
    mkdirSync(extracted)
    execFileSync('tar', ['-xzf', path.join(workDirectory, tarball), '-C', extracted])
    mkdirSync(CACHE_ROOT, { recursive: true })
    rmSync(versionDirectory, { force: true, recursive: true })
    renameSync(extracted, versionDirectory)
  } finally {
    rmSync(workDirectory, { force: true, recursive: true })
  }
  if (!existsSync(entry)) {
    fail(`The ${version} tarball has no lib/index.js (looked for ${entry}).`)
  }
  return entry
}

function requireEntry(entry: string, label: string): unknown {
  try {
    return createRequire(import.meta.url)(entry)
  } catch (error) {
    fail(`The ${label} build failed to load from ${entry}: ${String(error)}`)
  }
}

function loadBuild(entry: string, label: string): Build {
  const loaded = requireEntry(entry, label)
  if (typeof loaded !== 'function') {
    fail(`The ${label} build at ${entry} exports no plugin factory function.`)
  }
  return { factory: (modules) => Reflect.apply(loaded, undefined, [modules]), label }
}

function isPluginModule(value: unknown): value is PluginModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'create' in value &&
    typeof value.create === 'function'
  )
}

interface ParsedCode {
  readonly markers: ReadonlyMap<string, number>
  readonly text: string
}

function parseMarkers(code: string): ParsedCode {
  const markers = new Map<string, number>()
  let text = ''
  let last = 0
  for (const match of code.matchAll(MARKER_PATTERN)) {
    text += code.slice(last, match.index)
    markers.set(match[1] ?? '', text.length)
    last = match.index + match[0].length
  }
  return { markers, text: text + code.slice(last) }
}

/** One build's language service over one in-memory file, with the plugin applied as tsserver applies it. */
function createSession(build: Build, compareCase: CompareCase, initialText: string) {
  const fileName = `${VIRTUAL_DIRECTORY}/case.${compareCase.ext ?? 'tsx'}`
  const logs: string[] = []
  let text = initialText
  let version = 1
  const host: ts.LanguageServiceHost = {
    fileExists: (name) => name === fileName,
    getCompilationSettings: () => ({
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      target: ts.ScriptTarget.ES2022,
    }),
    getCurrentDirectory: () => VIRTUAL_DIRECTORY,
    getDefaultLibFileName: () => 'lib.d.ts',
    getScriptFileNames: () => [fileName],
    getScriptSnapshot: (name) =>
      name === fileName ? ts.ScriptSnapshot.fromString(text) : undefined,
    getScriptVersion: () => String(version),
    readFile: (name) => (name === fileName ? text : undefined),
  }
  const languageService = ts.createLanguageService(host)
  const logger = { info: (message: string) => logs.push(message), loggingEnabled: () => true }
  const pluginModule = build.factory({ typescript: ts })
  if (!isPluginModule(pluginModule)) {
    fail(`The ${build.label} plugin factory returned no module with a create function.`)
  }
  const sourceFile = () =>
    languageService.getProgram()?.getSourceFile(fileName) ??
    fail(`The ${build.label} language service has no source file for ${fileName}.`)
  const plugged = pluginModule.create({
    config: { name: PACKAGE_NAME, ...compareCase.config },
    languageService,
    languageServiceHost: host,
    project: {
      getCompilerOptions: () => host.getCompilationSettings(),
      getCurrentDirectory: () => VIRTUAL_DIRECTORY,
      getLanguageService: () => languageService,
      getScriptInfo: () => ({
        lineOffsetToPosition: (line: number, offset: number) =>
          sourceFile().getPositionOfLineAndCharacter(line - 1, offset - 1),
        positionToLineOffset: (position: number) => {
          const { character, line } = sourceFile().getLineAndCharacterOfPosition(position)
          return { line: line + 1, offset: character + 1 }
        },
      }),
      projectService: { logger },
    },
    serverHost: {},
  })
  return {
    change(start: number, end: number, insert: string) {
      text = text.slice(0, start) + insert + text.slice(end)
      version++
    },
    configure(configuration: unknown) {
      pluginModule.onConfigurationChanged?.(configuration)
    },
    fileName,
    logs,
    service: plugged,
    text: () => text,
  }
}

type Session = ReturnType<typeof createSession>

/** The line starts of the last text described, so describing many spans in a large file stays linear. */
let cachedLineStartsText: string | undefined
let cachedLineStarts: readonly number[] = []

function lineStartsOf(text: string): readonly number[] {
  if (text !== cachedLineStartsText) {
    const starts = [0]
    for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
      starts.push(index + 1)
    }
    cachedLineStartsText = text
    cachedLineStarts = starts
  }
  return cachedLineStarts
}

/** `line:column "text"` for a span, both 1-based, with the spanned text quoted. */
function describeSpan(session: Session, start: number, length: number): string {
  const text = session.text()
  const lineStarts = lineStartsOf(text)
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((lineStarts[middle] ?? 0) <= start) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  const column = start - (lineStarts[low] ?? 0)
  const spanned = text.slice(start, start + Math.min(length, MAX_QUOTED_LENGTH))
  const ellipsis = length > MAX_QUOTED_LENGTH ? '...' : ''
  return `${low + 1}:${column + 1} ${JSON.stringify(spanned)}${ellipsis}`
}

function pluginDiagnostics(session: Session): ts.Diagnostic[] {
  return session.service
    .getSemanticDiagnostics(session.fileName)
    .filter((diagnostic) => diagnostic.source === PLUGIN_SOURCE)
}

function flatten(message: string | ts.DiagnosticMessageChain): string {
  return ts.flattenDiagnosticMessageText(message, ' ')
}

function markerOffset(
  markers: ReadonlyMap<string, number>,
  name: string,
  caseName: string,
): number {
  return (
    markers.get(name) ?? fail(`Case "${caseName}" uses the marker ⟨${name}⟩, which its code lacks.`)
  )
}

/** Runs one operation and returns its result as comparable lines. */
function runOperation(
  session: Session,
  operation: CompareOperation,
  markers: ReadonlyMap<string, number>,
  caseName: string,
): string[] {
  switch (operation.op) {
    case 'diag':
      return pluginDiagnostics(session).map(
        (diagnostic) =>
          `${describeSpan(session, diagnostic.start ?? 0, diagnostic.length ?? 0)} ${flatten(diagnostic.messageText)}`,
      )
    case 'comp': {
      const position = markerOffset(markers, operation.at, caseName)
      const info = session.service.getCompletionsAtPosition(session.fileName, position, {})
      const entries = (info?.entries ?? []).map((entry) =>
        entry.replacementSpan
          ? `${entry.name} replacing ${JSON.stringify(session.text().slice(entry.replacementSpan.start, entry.replacementSpan.start + entry.replacementSpan.length))}`
          : entry.name,
      )
      return [`${entries.length} entries`, ...entries]
    }
    case 'hover': {
      const position = markerOffset(markers, operation.at, caseName)
      const info = session.service.getQuickInfoAtPosition(session.fileName, position)
      if (!info) {
        return ['no hover']
      }
      const documentation = (info.documentation ?? []).map((part) => part.text).join('')
      return [
        `${describeSpan(session, info.textSpan.start, info.textSpan.length)} ${JSON.stringify(documentation.slice(0, 120))}`,
      ]
    }
    case 'fold':
      return session.service
        .getOutliningSpans(session.fileName)
        .map((span) => describeSpan(session, span.textSpan.start, span.textSpan.length))
    case 'fix':
      return pluginDiagnostics(session).flatMap((diagnostic) => {
        const start = diagnostic.start ?? 0
        const end = start + (diagnostic.length ?? 0)
        const fixes = session.service.getCodeFixesAtPosition(
          session.fileName,
          start,
          end,
          [diagnostic.code],
          {},
          {},
        )
        return fixes.length === 0
          ? [`no fix for ${flatten(diagnostic.messageText)}`]
          : fixes.map((fix) => `${fix.description} => ${applyFix(session.text(), fix)}`)
      })
    case 'configure':
      session.configure(operation.configuration)
      return ['configured']
    case 'change': {
      const start = markerOffset(markers, operation.from, caseName)
      const end = markerOffset(markers, operation.to ?? operation.from, caseName)
      session.change(start, end, operation.text)
      return ['changed']
    }
  }
}

/** The source line holding a fix's first edit, after every edit of the fix is applied. */
function applyFix(text: string, fix: ts.CodeFixAction): string {
  const changes = fix.changes
    .flatMap((change) => change.textChanges)
    .sort((left, right) => right.span.start - left.span.start)
  let result = text
  for (const change of changes) {
    result =
      result.slice(0, change.span.start) +
      change.newText +
      result.slice(change.span.start + change.span.length)
  }
  const first = changes[changes.length - 1]?.span.start ?? 0
  const lineStart = result.lastIndexOf('\n', first - 1) + 1
  const lineEnd = result.indexOf('\n', first)
  return JSON.stringify(result.slice(lineStart, lineEnd === -1 ? undefined : lineEnd))
}

interface OperationResult {
  readonly label: string
  readonly lines: readonly string[]
  readonly operation: CompareOperation
}

const DEFAULT_OPERATIONS: readonly CompareOperation[] = [{ op: 'diag' }]

function operationLabel(operation: CompareOperation): string {
  return operation.op + ('at' in operation ? ` at ⟨${operation.at}⟩` : '')
}

/** Runs every operation of one case, reporting each result as it completes. */
function runCase(
  build: Build,
  compareCase: CompareCase,
  reportResult: (result: OperationResult) => void,
): void {
  const parsed = parseMarkers(compareCase.code)
  const session = createSession(build, compareCase, parsed.text)
  for (const operation of compareCase.ops ?? DEFAULT_OPERATIONS) {
    reportResult({
      label: operationLabel(operation),
      lines: runRecordingThrows(() =>
        runOperation(session, operation, parsed.markers, compareCase.name),
      ),
      operation,
    })
  }
}

/**
 * An exception a build lets escape is a result to compare (tsserver fails the whole response for
 * the file on one), recorded by its first line; a case-file mistake still fails the run.
 */
function runRecordingThrows(run: () => string[]): string[] {
  try {
    return run()
  } catch (error) {
    if (error instanceof CompareReleaseError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return [`threw ${message.split('\n')[0] ?? ''}`]
  }
}

function checkControl(build: Build): void {
  const session = createSession(build, CONTROL_CASE, CONTROL_CASE.code)
  const messages = pluginDiagnostics(session).map((diagnostic) => flatten(diagnostic.messageText))
  if (messages.length !== 1 || messages[0] !== CONTROL_MESSAGE) {
    fail(
      `The ${build.label} build did not report "${CONTROL_MESSAGE}" for the positive-control template ` +
        `(received ${JSON.stringify(messages)}), so its results would mean nothing. Plugin log:\n` +
        session.logs.join('\n'),
    )
  }
}

const OPERATION_SHAPES =
  'diag, fix, fold, { op: "comp", at, show? } with a whole-number show, { op: "hover", at }, ' +
  '{ op: "configure", configuration }, and { op: "change", from, to?, text }'

function isOperation(value: unknown): value is CompareOperation {
  if (typeof value !== 'object' || value === null || !('op' in value)) {
    return false
  }
  switch (value.op) {
    case 'diag':
    case 'fix':
    case 'fold':
      return true
    case 'comp':
      return (
        'at' in value &&
        typeof value.at === 'string' &&
        (!('show' in value) || value.show === undefined || Number.isInteger(value.show))
      )
    case 'hover':
      return 'at' in value && typeof value.at === 'string'
    case 'configure':
      return 'configuration' in value
    case 'change':
      return (
        'from' in value &&
        typeof value.from === 'string' &&
        'text' in value &&
        typeof value.text === 'string' &&
        (!('to' in value) || value.to === undefined || typeof value.to === 'string')
      )
    default:
      return false
  }
}

function isCompareCase(value: unknown): value is CompareCase {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'code' in value &&
    typeof value.code === 'string' &&
    (!('ops' in value) ||
      value.ops === undefined ||
      (Array.isArray(value.ops) && value.ops.every(isOperation)))
  )
}

async function loadCases(modulePath: string): Promise<CompareCase[]> {
  const loaded: unknown = await import(pathToFileURL(modulePath).href)
  const cases =
    typeof loaded === 'object' && loaded !== null && 'default' in loaded
      ? loaded.default
      : undefined
  if (!Array.isArray(cases)) {
    fail(`${modulePath} has no default export holding an array of cases.`)
  }
  return cases.map((value: unknown, index) =>
    isCompareCase(value)
      ? value
      : fail(
          `${modulePath}, case ${index}: a case needs a string name and code, and ops as a list ` +
            `of these operations: ${OPERATION_SHAPES}.`,
        ),
  )
}

/** The first `limit` items, plus a count of the rest when any are left out. */
function truncate(items: readonly string[], limit: number): string[] {
  return items.length > limit
    ? [...items.slice(0, limit), `... ${items.length - limit} more`]
    : [...items]
}

/**
 * Lines shown for one operation's result. Only a completion list is cut, to its `show` count
 * (entries after the leading count line); every other result is shown whole.
 */
function excerpt(operation: CompareOperation, lines: readonly string[]): string[] {
  if (lines.length === 0) {
    return ['(none)']
  }
  if (operation.op !== 'comp') {
    return [...lines]
  }
  const [count = '', ...entries] = lines
  return [count, ...truncate(entries, operation.show ?? DEFAULT_COMPLETION_SHOW)]
}

/** One case's comparison: whether the builds differ, and the lines to print (none when neither applies). */
function formatCase(
  compareCase: CompareCase,
  working: readonly OperationResult[],
  release: readonly OperationResult[],
  releaseLabel: string,
  showAll: boolean,
): { differs: boolean; lines: string[] } {
  const output: string[] = []
  let differs = false
  working.forEach((result, index) => {
    const other = release[index]?.lines ?? []
    const same = JSON.stringify(result.lines) === JSON.stringify(other)
    differs ||= !same
    if (same && !showAll) {
      return
    }
    const { operation } = result
    output.push(`  ${result.label}${same ? ' (same)' : ''}`)
    output.push(...excerpt(operation, result.lines).map((line) => `    working: ${line}`))
    if (!same) {
      output.push(...excerpt(operation, other).map((line) => `    ${releaseLabel}: ${line}`))
      if (operation.op === 'comp') {
        const limit = operation.show ?? DEFAULT_COMPLETION_SHOW
        const added = result.lines.slice(1).filter((line) => !other.includes(line))
        const removed = other.slice(1).filter((line) => !result.lines.includes(line))
        output.push(`    only in working: ${truncate(added, limit).join(', ') || '(none)'}`)
        output.push(
          `    only in ${releaseLabel}: ${truncate(removed, limit).join(', ') || '(none)'}`,
        )
      }
    }
  })
  return {
    differs,
    lines:
      differs || showAll ? [`== ${compareCase.name}${differs ? '' : ' (same)'}`, ...output] : [],
  }
}

/**
 * A default case takes well under a second in either build, so a stop means that build regressed
 * on that case (a loop that never ends, a superlinear cost, or unbounded retention).
 */
const CASE_DEADLINE_MS = 60_000
const CASE_HEAP_CAP_MB = 2048

/** One build's work in a worker: its positive control when `compareCase` is absent, else one case. */
interface BuildTask {
  readonly compareCase?: CompareCase
  readonly entry: string
  readonly label: string
}

function runBuildTask(task: BuildTask, reportResult: (result: OperationResult) => void): null {
  const build = loadBuild(task.entry, task.label)
  if (task.compareCase === undefined) {
    checkControl(build)
  } else {
    runCase(build, task.compareCase, reportResult)
  }
  return null
}

/**
 * One build's worker, reused across cases so each pays the module load once, and replaced after a
 * case stops it. A stopped case keeps the results of the operations it finished; the operation it
 * stopped in reads as the stop, and the rest as not run.
 */
class BuildRunner {
  private readonly build: Omit<BuildTask, 'compareCase'>
  private worker: BoundedWorker<BuildTask, OperationResult, null> | undefined

  constructor(build: Omit<BuildTask, 'compareCase'>) {
    this.build = build
  }

  async run(compareCase?: CompareCase): Promise<OperationResult[]> {
    this.worker ??= new BoundedWorker({ entry: new URL(import.meta.url), heapMb: CASE_HEAP_CAP_MB })
    const results: OperationResult[] = []
    const outcome = await this.worker.run(
      { ...this.build, compareCase },
      { deadlineMs: CASE_DEADLINE_MS, onProgress: (result) => results.push(result) },
    )
    if (outcome.kind === 'done') {
      return results
    }
    await this.close()
    const subject =
      compareCase === undefined ? 'the positive control' : `case "${compareCase.name}"`
    if (outcome.kind === 'crashed') {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      fail(`The ${this.build.label} build's worker failed on ${subject}: ${message}`)
    }
    const stop =
      outcome.kind === 'deadline'
        ? `stopped at the ${formatSeconds(CASE_DEADLINE_MS)} wall-clock deadline`
        : `stopped at the ${CASE_HEAP_CAP_MB}MB heap cap`
    if (compareCase === undefined) {
      fail(
        `The ${this.build.label} build ${stop} on the positive control, a two-line template, so ` +
          'it is broken (a loop that never ends or unbounded retention) and its results would mean ' +
          'nothing.',
      )
    }
    return (compareCase.ops ?? DEFAULT_OPERATIONS).map(
      (operation, index): OperationResult =>
        results[index] ?? {
          label: operationLabel(operation),
          lines: [index === results.length ? stop : 'not run: an earlier operation stopped'],
          operation,
        },
    )
  }

  async close(): Promise<void> {
    const worker = this.worker
    this.worker = undefined
    await worker?.close()
  }
}

async function compareCases(
  working: BuildRunner,
  release: BuildRunner,
  options: ReturnType<typeof parseArguments>,
): Promise<void> {
  const { caseModules, filter, showAll, version } = options
  await Promise.all([working.run(), release.run()])

  let total = 0
  let differing = 0
  for (const modulePath of caseModules) {
    const cases = await loadCases(modulePath)
    for (const compareCase of cases) {
      if (filter && !filter.test(compareCase.name)) {
        continue
      }
      total++
      const [workingResults, releaseResults] = await Promise.all([
        working.run(compareCase),
        release.run(compareCase),
      ])
      const { differs, lines } = formatCase(
        compareCase,
        workingResults,
        releaseResults,
        version,
        showAll,
      )
      if (differs) {
        differing++
      }
      if (lines.length > 0) {
        console.log(lines.join('\n'))
      }
    }
  }
  console.log(
    `compare-release: ${total} cases, ${differing} differ from ${version}, ${total - differing} match ` +
      `(${caseModules.map((modulePath) => path.basename(modulePath)).join(', ')})`,
  )
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  checkWorkingBuild()
  const working = new BuildRunner({ entry: WORKING_ENTRY, label: 'working' })
  const release = new BuildRunner({ entry: ensureRelease(options.version), label: options.version })
  try {
    await compareCases(working, release, options)
  } finally {
    await Promise.all([working.close(), release.close()])
  }
}

if (isMainThread) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof CompareReleaseError ? error.message : error)
    process.exitCode = 1
  }
} else {
  serveBounded(runBuildTask)
}
