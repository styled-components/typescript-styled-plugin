/**
 * Scaling guardrail (`corepack yarn test:scaling`, part of `verify` and CI): fails when a hot
 * operation's cost grows superlinearly with its input, returns a wrong result for its fixture,
 * stops doing work that grows with its input, or when the diagnostics validation cache retains
 * past its byte budget.
 *
 * - Each timed check and the retained-heap guardrail run one at a time, each in its own worker
 *   thread (scripts/bounded-worker.ts) that the main thread stops at CHECK_DEADLINE_MS of wall
 *   time or CHECK_HEAP_CAP_MB of heap. Either stop fails the check as over the limit, naming the
 *   size and attempt it reached. Timings stay CPU time of the worker's own thread.
 * - A timed check stops sampling early once its samples already put it far above the threshold
 *   (EARLY_EXIT_RATIO), and still fails only when every attempt lands above it.
 * - Worst-case wall time: RUN_BUDGET_MS, plus module load and one worker shutdown. Nothing outlives
 *   the run: every worker has exited before the next starts and before the script ends.
 * - Exit code 1 on any failure; each FAIL line names the check, and a closing line per failure
 *   kind says what it most likely means.
 * - Needs `--expose-gc` and `--no-flush-bytecode` (both passed by the package script) and the
 *   development Node version for process.threadCpuUsage; each missing one fails before any check.
 * - Blind spots: one input shape per check, so a regression only another shape triggers passes;
 *   a slowdown by a constant factor passes (the benchmark's job).
 */
import { isMainThread } from 'node:worker_threads'

import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import { formatSeconds, runBounded, serveBounded } from '../../scripts/bounded-worker.ts'
import {
  MAX_VALIDATION_CACHE_BYTES,
  MAX_VALIDATION_CACHE_ENTRIES,
} from '../../src/features/diagnostics.ts'
import { getTemplateSubstitutions } from '../../src/template/template-substitutions.ts'
import { replaceJavaScriptEscapes } from '../../src/virtual-document/javascript-escapes.ts'
import {
  createProgressLocationTracker,
  parseFilterArgument,
  selectChecks,
  selectMinimumPositiveSample,
  type StageOrLineProgress,
} from './scaling-check-cli.ts'
import {
  createDiagnosticsTemplate,
  createFoldingTemplate,
  createLargeTemplate,
  createTemplateContext,
  createTemplateLanguageService,
  requireGc,
  settleHeap,
  type TemplateSpan,
} from './template-language-service-fixture.ts'

/**
 * Guardrail against superlinear regressions in a hot operation. Times each check at N and 4N,
 * taking the minimum positive sample from RUNS_PER_SIZE runs per size to filter scheduler, GC, and
 * coarse-clock noise, then fails when time(4N)/time(N) exceeds SCALING_THRESHOLD. At 4x the input a
 * linear operation's ratio lands near 4 (its fixed per-call cost pulls it lower) and a quadratic
 * one's near 16. Every check's N is sized so a quadratic regression injected into its path lands at
 * 10 or more (SUBSTITUTION_CHECK_N and the sizes after it), so 7 gives a linear operation's noisy
 * readings 75% headroom above 4 while staying clearly under where a real regression lands.
 */
const SCALING_THRESHOLD = 7
/**
 * Every fixture below makes its operation's real work grow with the input, so a correct result
 * computed at 4N costs well over the N timing even after the fixed per-call cost pulls the ratio
 * under 4. A ratio near 1 means the timed call stopped doing that work (a cache shared across
 * service instances, an early return the result guard's expectations happen to accept), so the
 * probe measures nothing. Set low enough that scheduler noise inflating the N samples of a light
 * check (folding) under heavy machine load stays above it.
 */
const MIN_PLAUSIBLE_RATIO = 1.5
const RUNS_PER_SIZE = 5
/**
 * How many times a check whose ratio lands above SCALING_THRESHOLD or below MIN_PLAUSIBLE_RATIO is
 * measured again before it fails. Heavy machine load inflates one attempt's timings unevenly,
 * enough to push a linear operation's ratio past the threshold or a light one's under the floor,
 * while a real superlinear regression or a short-circuited probe lands outside the range on every
 * attempt, so a check fails only when every attempt does.
 */
const RATIO_RETRY_COUNT = 2
/**
 * An attempt stops sampling and counts as above SCALING_THRESHOLD once, after at least
 * EARLY_EXIT_MIN_RUNS runs at each size, its ratio so far (the best 4N sample over the best N
 * sample) exceeds this. More samples only lower each best, so the final ratio could still land
 * under the threshold, but only if every 4N sample so far ran at over twice its true cost; load
 * that inflates CPU time unevenly moves a linear check's ratio from near 4 to about the threshold,
 * not to twice it. The check still fails only when every attempt lands above the threshold, so a
 * false failure needs that inflation on every attempt. A quadratic regression whose ratio lands
 * near 16, or anything steeper, skips the remaining 4N samples, which dominate a regressed check's
 * run time.
 */
const EARLY_EXIT_RATIO = 2 * SCALING_THRESHOLD
const EARLY_EXIT_MIN_RUNS = 2

/**
 * Every check's line prints its wall time; the deadline covers the slowest of those on a loaded
 * machine many times over, including all RATIO_RETRY_COUNT retries on a slower CI runner, so only
 * a regression that multiplies a check's cost reaches it. The heap cap sits several times above
 * what the heaviest check's worker needs, module load included (lower it until checks fail to see
 * that need).
 */
const CHECK_DEADLINE_MS = 60_000
const CHECK_HEAP_CAP_MB = 512
/**
 * The whole run's wall-clock bound: a regression in code every check shares (the boundary
 * scanner, the virtual document) can stop every check at its deadline, which would otherwise add
 * up past CI's job timeout. Each check's deadline is cut to what remains of this budget, and once
 * it is spent the remaining checks fail unrun. A healthy run spends a small fraction of it, so only
 * checks stopped at their deadline can spend it.
 */
const RUN_BUDGET_MS = 10 * 60_000

/**
 * StyledTemplateLanguageService catches every exception a feature throws and returns an empty
 * result instead, and an operation that fails fast is also fast at every size, so timing alone
 * reads a feature broken on every call as a healthy one. Each check therefore also states what its
 * fixture must produce, and every timed result is compared against that after its own timing ends:
 * a mismatch fails the script as a wrong result, separately from a ratio failure.
 */
interface ResultMismatch {
  readonly expected: string
  readonly received: string
}

interface ScalingCheckDefinition<Result> {
  readonly n: number
  readonly name: string
  run(size: number): Result
  verify(result: Result, size: number): ResultMismatch | undefined
}

interface Measurement {
  readonly elapsedMs: number
  readonly mismatch: ResultMismatch | undefined
}

interface ScalingCheck {
  measure(size: number): Measurement
  readonly n: number
  readonly name: string
}

/**
 * `over-limit` is a timed check's ratio above SCALING_THRESHOLD, a retained heap over its
 * threshold, or a check stopped at its deadline or heap cap; `probe-broken` is a ratio below
 * MIN_PLAUSIBLE_RATIO or a heap reading that cannot be real or sits below the floor a working cache
 * retains; `crashed` is an exception thrown outside the language service's own recovery.
 */
type CheckOutcome = 'crashed' | 'ok' | 'over-limit' | 'probe-broken' | 'wrong-result'

/** What a check's worker reports while it runs: a line to print now, or the stage it is entering. */
type CheckProgress = StageOrLineProgress

type ReportProgress = (progress: CheckProgress) => void

interface CheckResult {
  /** The first line is the check's summary, printed with the check's wall time. */
  readonly lines: readonly [string, ...string[]]
  readonly outcome: CheckOutcome
}

/**
 * Every timing is main-thread CPU time, not wall-clock time. With more runnable threads than cores,
 * the scheduler preempts the process every few milliseconds: a short N sample often runs
 * uninterrupted while a 4N sample several times longer almost never does, so the minimum positive
 * sample over several wall-clock readings inflates only the 4N side and pushes a linear operation past
 * SCALING_THRESHOLD. Time spent preempted never counts as CPU time.
 */
function elapsedCpuMs(start: NodeJS.CpuUsage): number {
  const elapsed = process.threadCpuUsage(start)
  return (elapsed.user + elapsed.system) / 1000
}

function defineCheck<Result>(definition: ScalingCheckDefinition<Result>): ScalingCheck {
  return {
    measure(size) {
      const start = process.threadCpuUsage()
      const result = definition.run(size)
      const elapsedMs = elapsedCpuMs(start)
      return { elapsedMs, mismatch: definition.verify(result, size) }
    },
    n: definition.n,
    name: definition.name,
  }
}

function describeTextAt(text: string, offset: number): string {
  return `${text.length} characters, ${JSON.stringify(text.slice(offset, offset + 24))} at offset ${offset}`
}

function compareText(expected: string, received: string): ResultMismatch | undefined {
  if (expected === received) {
    return undefined
  }
  let offset = 0
  while (offset < expected.length && expected[offset] === received[offset]) {
    offset++
  }
  return {
    expected: describeTextAt(expected, offset),
    received: describeTextAt(received, offset),
  }
}

function describeOffsets(offsets: ReadonlyArray<number | undefined>, index: number): string {
  return `${offsets.length} results, result ${index} at offset ${String(offsets[index])}`
}

function compareOffsets(
  expected: readonly number[],
  received: ReadonlyArray<number | undefined>,
): ResultMismatch | undefined {
  let index = 0
  while (index < expected.length && expected[index] === received[index]) {
    index++
  }
  if (index === expected.length && received.length === expected.length) {
    return undefined
  }
  return {
    expected: describeOffsets(expected, index),
    received: describeOffsets(received, index),
  }
}

function offsetsOf(text: string, needle: string): number[] {
  const offsets: number[] = []
  for (
    let offset = text.indexOf(needle);
    offset !== -1;
    offset = text.indexOf(needle, offset + 1)
  ) {
    offsets.push(offset)
  }
  return offsets
}

/** Every template in the many-template checks holds one misspelled property, so every request yields exactly one diagnostic. */
function compareOneDiagnosticEach(
  expectedRequestCount: number,
  diagnosticsPerRequest: ReadonlyArray<readonly unknown[]>,
): ResultMismatch | undefined {
  const firstOther = diagnosticsPerRequest.findIndex((diagnostics) => diagnostics.length !== 1)
  if (diagnosticsPerRequest.length === expectedRequestCount && firstOther === -1) {
    return undefined
  }
  return {
    expected: `${expectedRequestCount} requests, one diagnostic each`,
    received:
      `${diagnosticsPerRequest.length} requests` +
      (firstOther === -1
        ? ''
        : `, request ${firstOther} returned ${diagnosticsPerRequest[firstOther]?.length} diagnostics`),
  }
}

/**
 * Caches one input per distinct size, so a hot operation's timed run pays only its own cost, never
 * the cost of building its fixture: building a fixture (ts.createSourceFile's parse inside
 * createTemplateContext, a long string and its span list) is itself linear in size and allocates
 * enough to trigger collections, and left inside the timed region it both dilutes a superlinear
 * regression enough to land under SCALING_THRESHOLD and adds collection noise to one side of the
 * ratio. runTimedCheck's warmup measures every check once at each size before timing it, which
 * pays the one build per size; every timed call after that is a cache hit here. Each language
 * feature check still constructs a fresh StyledTemplateLanguageService per run() call, which is
 * where RawValidationCache and every other per-request cache live (docs/architecture.md, Caching),
 * so reusing the same TemplateContext object across calls changes nothing about what the timed
 * operation itself has to do.
 */
function cachedBySize<Input>(build: (size: number) => Input): (size: number) => Input {
  const cache = new Map<number, Input>()
  return (size) => {
    const cached = cache.get(size)
    if (cached !== undefined) {
      return cached
    }
    const built = build(size)
    cache.set(size, built)
    return built
  }
}

function contextForSize(
  buildTemplate: (size: number) => string,
): (size: number) => TemplateContext {
  return cachedBySize((size) => createTemplateContext(buildTemplate(size)))
}

interface TextCase {
  readonly expected: string
  readonly spans: readonly TemplateSpan[]
  readonly text: string
}

/** The placeholder text every substitution fixture uses; each occurrence is one substitution span. */
const PLACEHOLDER = '${aaa}'

interface RepeatedUnit {
  readonly count: number
  readonly expectedUnit: string
  readonly prefix?: string
  readonly suffix?: string
  readonly unit: string
}

/** `prefix`, then `count` copies of `unit`, then `suffix`; the expected text repeats `expectedUnit` between the same prefix and suffix, and every PLACEHOLDER in the text becomes a span. */
function repeatUnit({
  count,
  expectedUnit,
  prefix = '',
  suffix = '',
  unit,
}: RepeatedUnit): TextCase {
  const text = prefix + unit.repeat(count) + suffix
  return {
    expected: prefix + expectedUnit.repeat(count) + suffix,
    spans: offsetsOf(text, PLACEHOLDER).map((start) => ({
      end: start + PLACEHOLDER.length,
      start,
    })),
    text,
  }
}

/**
 * Two block-position placeholders after a declaration on one line (`color: red; ${aaa} ${aaa}`):
 * the first follows a ";", the second follows the first (docs/architecture.md, statement rule), so
 * both become whitespace, many per line.
 */
function buildStatementPlaceholderCase(count: number): TextCase {
  return repeatUnit({
    count,
    expectedUnit: `color: red; ${' '.repeat(6)} ${' '.repeat(6)} `,
    unit: `color: red; ${PLACEHOLDER} ${PLACEHOLDER} `,
  })
}

const MULTI_LINE_PLACEHOLDER = '${\n  a\n}'
const SOLID_MULTI_LINE_FILL = 'x'.repeat(MULTI_LINE_PLACEHOLDER.length)

/** `count` copies of `unit`, each MULTI_LINE_PLACEHOLDER in it a span. */
function repeatMultiLineUnit(count: number, unit: string, expectedUnit: string): TextCase {
  const text = unit.repeat(count)
  return {
    expected: expectedUnit.repeat(count),
    spans: offsetsOf(text, MULTI_LINE_PLACEHOLDER).map((start) => ({
      end: start + MULTI_LINE_PLACEHOLDER.length,
      start,
    })),
    text,
  }
}

/**
 * A multi-line placeholder inside a quoted string, then another inside an unquoted url() argument,
 * repeated: every placeholder takes the solid fill, found by one walk of the spans against the
 * runs, never a search per placeholder.
 */
function buildStringAndUrlMultilinePlaceholderCase(count: number): TextCase {
  return repeatMultiLineUnit(
    count,
    `content: "${MULTI_LINE_PLACEHOLDER}"; background: url(${MULTI_LINE_PLACEHOLDER}); `,
    `content: "${SOLID_MULTI_LINE_FILL}"; background: url(${SOLID_MULTI_LINE_FILL}); `,
  )
}

/**
 * A multi-line placeholder inside a quoted string, then one at code as a mixin on the same line
 * (whitespace, where a solid fill would be x's), repeated: solid and classified placeholders
 * alternate, so the walk of the spans against the runs must keep its place between them instead of
 * starting over per placeholder.
 */
function buildStringAndCodeMultilinePlaceholderCase(count: number): TextCase {
  return repeatMultiLineUnit(
    count,
    `content: "${MULTI_LINE_PLACEHOLDER}"; ${MULTI_LINE_PLACEHOLDER} `,
    `content: "${SOLID_MULTI_LINE_FILL}"; ${' '.repeat(MULTI_LINE_PLACEHOLDER.length)} `,
  )
}

interface TextCheckCase {
  readonly build: (count: number) => TextCase
  readonly label: string
}

/** Each case is timed through getTemplateSubstitutions with its text and spans. */
const substitutionCases: readonly TextCheckCase[] = [
  /** A value placeholder with non-whitespace before it on its line and "px" after it, so it becomes six "x" characters. */
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: 'margin: xxxxxxpx; ', unit: 'margin: ${aaa}px; ' }),
    label: 'single-line placeholders',
  },
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: 'margin: xxxxxxpx;\n', unit: 'margin: ${aaa}px;\n' }),
    label: 'multi-line placeholders',
  },
  /**
   * A placeholder in property-name position, many per line with no "{" anywhere: the shape that
   * made getSubstitution's property-name/selector branches rescan toward the far end of the
   * document per placeholder. Each becomes the fake property name "$axxxx", since no "--" precedes
   * it.
   */
  {
    build: (count) => repeatUnit({ count, expectedUnit: '$axxxx: 1px; ', unit: '${aaa}: 1px; ' }),
    label: 'property-name placeholders, one line',
  },
  /** A placeholder in selector position, many per line; each becomes "&" padded with spaces. */
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: '&     :hover{color:red;} ',
        unit: '${aaa}:hover{color:red;} ',
      }),
    label: 'selector placeholders, one line',
  },
  {
    build: buildStatementPlaceholderCase,
    label: 'block-position placeholders after a statement boundary, one line',
  },
  /** The statement rule looks back past each block comment (createCodeLookback), so each placeholder becomes whitespace. */
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: `color: red; /* c */ ${' '.repeat(6)} `,
        unit: 'color: red; /* c */ ${aaa} ',
      }),
    label: 'block-position placeholders after a block comment, one line',
  },
  /**
   * Every placeholder's lookback lands inside the same comment, which must be scanned once, not
   * once per placeholder. Each stays an x-filled value.
   */
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: 'xxxxxx ', prefix: '/* ', suffix: '*/', unit: '${aaa} ' }),
    label: 'placeholders inside one block comment',
  },
  /**
   * Every placeholder's name scan reaches the same name end, which must be found once, not once
   * per placeholder. Each becomes the Sass interpolation "#{x  }".
   */
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: '#{x  }', suffix: '-x: 1px;', unit: PLACEHOLDER }),
    label: 'adjacent placeholders joined into one property name',
  },
  /** Each condition looks back over one word, never to the at-keyword, and becomes "(x   )". */
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: ' and (x   )',
        prefix: '@media screen',
        suffix: ' {}',
        unit: ' and ${aaa}',
      }),
    label: 'at-rule condition placeholders, one prelude',
  },
  /**
   * The rule body opens after a line break and a long run of whitespace, which must be scanned
   * once, not once per placeholder. Each becomes "&" padded with spaces.
   */
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: '&     :x ',
        suffix: `\n${' '.repeat(count)}{}`,
        unit: '${aaa}:x ',
      }),
    label: 'selector placeholders whose rule body opens on the next line',
  },
  /**
   * Every placeholder's selector-list scan reaches the same "{", which must be found once, not
   * once per placeholder. Each becomes "&" padded with spaces.
   */
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: '&     :x,\n', suffix: 'a {}', unit: '${aaa}:x,\n' }),
    label: 'selector list placeholders, one per line ending in ","',
  },
  /**
   * Every placeholder on one line reaches the same line break after a long run of whitespace:
   * whether that line ends in "," must be read once, not once per placeholder.
   */
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: '&     :x, ',
        suffix: `${' '.repeat(count)}\na {}`,
        unit: '${aaa}:x, ',
      }),
    label: 'selector list placeholders on one line ending in "," after long whitespace',
  },
  /**
   * The selector-shape search walks the text with the boundary scanner, which must resume where
   * its last query stopped instead of starting over per placeholder. Each ";" sits inside a comment
   * or string, so each placeholder still becomes "&" padded with spaces.
   */
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: '&     :hover /* a; */ {color:red;} ',
        unit: '${aaa}:hover /* a; */ {color:red;} ',
      }),
    label: 'selector placeholders with a comment holding ";" before the body, one line',
  },
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: '&     :not([x="a;b"]) ',
        suffix: `\n${' '.repeat(count)}{}`,
        unit: '${aaa}:not([x="a;b"]) ',
      }),
    label: 'selector placeholders with a string holding ";" whose rule body opens on the next line',
  },
  /** The list scan's remembered range must reach past each line's comment to the same "{". */
  {
    build: (count) =>
      repeatUnit({
        count,
        expectedUnit: '&     :x, /* a; */\n',
        suffix: 'a {}',
        unit: '${aaa}:x, /* a; */\n',
      }),
    label: 'selector list placeholders, one per line ending in "," and a comment holding ";"',
  },
  /**
   * Every statement starts with a block comment no "*\/" ever closes: the at-rule condition test
   * skips each statement's leading comments, and the search for the missing close must read the
   * rest of the text once, not once per statement. Every placeholder sits inside the comment, so
   * each stays an x-filled value.
   */
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: 'xxxxxx;/*', prefix: '/*', unit: '${aaa};/*' }),
    label: 'statements each opening an unterminated comment',
  },
  /** Out-of-order spans take normalizeSpans' copy-and-sort path, which must stay near-linear. */
  {
    build: (count) => {
      const textCase = buildStatementPlaceholderCase(count)
      return { ...textCase, spans: textCase.spans.toReversed() }
    },
    label: 'block-position placeholders, spans given in reverse order',
  },
  {
    build: buildStringAndUrlMultilinePlaceholderCase,
    label: 'multi-line placeholders inside strings and url() arguments',
  },
  {
    build: buildStringAndCodeMultilinePlaceholderCase,
    label: 'multi-line placeholders alternating between strings and code',
  },
]

/** Each case is timed through replaceJavaScriptEscapes with its text; spans are unused. */
const escapeCases: readonly TextCheckCase[] = [
  /**
   * CSS-escaped parens before a hex digit (`a\\(b` in the raw text), so no escape can absorb its
   * padding: each looks back for the url() it sits in, which must read the argument once, not once
   * per escape. Each padding becomes "_".
   */
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: 'a_\\(b', prefix: 'url(', suffix: ')', unit: 'a\\\\(b' }),
    label: 'padded escapes in one url() argument',
  },
  /** Each hex escape run follows "/", so every run's padding is "_". */
  {
    build: (count) =>
      repeatUnit({ count, expectedUnit: 'a/A___', prefix: 'url(', suffix: ')', unit: 'a/\\x41' }),
    label: 'hex escapes in one url() argument',
  },
  /** Each escape run continues the name, so every run's padding joins the spaces in front of it. */
  {
    build: (count) => ({
      expected: ' '.repeat(3 * count) + 'ab'.repeat(count),
      spans: [],
      text: 'a\\x62'.repeat(count),
    }),
    label: 'escape runs inside one name',
  },
]

/**
 * The per-placeholder algorithmic cost these checks exercise is small enough per character that a
 * genuinely quadratic per-placeholder regression in getTemplateSubstitutions needs a larger N
 * before its quadratic term clearly dominates the linear one; at a too-small N, the ratio can land
 * only marginally above SCALING_THRESHOLD instead of clearly above it. This is the smallest size
 * that, verified against a scratch copy of this repository with an injected quadratic per-
 * placeholder prefix scan (never committed here), lands every substitution check below at
 * ratio >= 10 while an unregressed run stays near 4.
 */
const SUBSTITUTION_CHECK_N = 6_000

function defineTextCheck(
  name: string,
  build: (count: number) => TextCase,
  transform: (textCase: TextCase) => string,
): ScalingCheck {
  const caseForSize = cachedBySize(build)
  return defineCheck({
    n: SUBSTITUTION_CHECK_N,
    name,
    run: (size) => transform(caseForSize(size)),
    verify: (result, size) => compareText(caseForSize(size).expected, result),
  })
}

/**
 * Sized the same way for the language-feature checks below, each against a quadratic injected into
 * that feature's own path in a scratch copy: a per-result prefix scan for diagnostics, folding, and
 * code fixes (whose candidate-diagnostic filter runs once per diagnostic in the template), and a
 * per-line prefix scan for hover and completions, whose result count stays fixed as the template
 * grows. At a small N, time that does not grow with the template is a large share of each timing and
 * pulls every ratio toward 1, a regressed one included. Each size below is the smallest that lands
 * its injected regression at ratio >= 10; folding's per-request work is light enough that this also
 * drags its unregressed ratio well under 4 at a smaller size, so its size is set instead by keeping
 * that ratio near 4 when it runs after every check above.
 */
const DIAGNOSTICS_TEMPLATE_CHECK_N = 600
/**
 * Sized the same way, against a per-"@" prefix scan injected into the virtual document's `@layer`
 * rewrite: validation cost dominates each timing, so the injected quadratic needs more layers than
 * the plain diagnostics check before it lands at ratio >= 10.
 */
const LAYER_DIAGNOSTICS_CHECK_N = 2_000
const FOLDING_CHECK_N = 1_200
const COMPLETIONS_CHECK_N = 700
/**
 * At 4N the many-template checks cache that many distinct small templates, which must stay under
 * MAX_VALIDATION_CACHE_ENTRIES (each entry is far under the byte budget's share) so the repeated
 * requests' second pass is all cache hits at both sizes; checked below.
 */
const MANY_TEMPLATE_CHECK_N = 250
if (MANY_TEMPLATE_CHECK_N * 4 > MAX_VALIDATION_CACHE_ENTRIES) {
  throw new Error(
    `Scaling check setup: MANY_TEMPLATE_CHECK_N * 4 (${MANY_TEMPLATE_CHECK_N * 4}) exceeds ` +
      `MAX_VALIDATION_CACHE_ENTRIES (${MAX_VALIDATION_CACHE_ENTRIES}), so the cache-hit check ` +
      'would evict and measure misses. Lower MANY_TEMPLATE_CHECK_N in test/performance/scaling-check.ts.',
  )
}

/**
 * One misspelled property ("colr") per rule, each after a declaration holding JavaScript escapes,
 * which the virtual document replaces with same-length stand-ins before validation.
 */
function createEscapedDiagnosticsTemplate(ruleCount: number): string {
  return Array.from(
    { length: ruleCount },
    (_, index) => `.rule-${index} { content: \\"\\\\f101\\"; colr: red; }`,
  ).join('\n')
}

/** One misspelled property ("colr") per nested block `@layer`, whose prelude the virtual document rewrites. */
function createLayerDiagnosticsTemplate(layerCount: number): string {
  return Array.from(
    { length: layerCount },
    (_, index) => `@layer layer-${index} { colr: red; margin: 0; }`,
  ).join('\n')
}

function createInterpolatedEmptyRulesContext(rulePairCount: number): TemplateContext {
  const placeholder = '${mixin}'
  const text = Array.from(
    { length: rulePairCount },
    (_, index) => `.interpolated-${index} { ${placeholder} }\n.empty-${index} {}`,
  ).join('\n')
  return createTemplateContext(
    text,
    offsetsOf(text, placeholder).map((start) => ({
      end: start + placeholder.length,
      start,
    })),
  )
}

const MISSPELLED_PROPERTY = 'colr'
const diagnosticsContextForSize = contextForSize(createDiagnosticsTemplate)
const foldingContextForSize = contextForSize(createFoldingTemplate)
const interpolatedEmptyRulesContextForSize = cachedBySize(createInterpolatedEmptyRulesContext)

interface DiagnosticsCheckCase {
  readonly context: (size: number) => TemplateContext
  readonly n: number
  readonly name: string
}

/** Every case's template holds one misspelled property per rule, so each yields a diagnostic at every one. */
const diagnosticsCases: readonly DiagnosticsCheckCase[] = [
  {
    context: diagnosticsContextForSize,
    n: DIAGNOSTICS_TEMPLATE_CHECK_N,
    name: 'diagnostics (many results in one template)',
  },
  {
    context: contextForSize(createLayerDiagnosticsTemplate),
    n: LAYER_DIAGNOSTICS_CHECK_N,
    name: 'diagnostics (many nested block @layer rules in one template)',
  },
  {
    context: contextForSize(createEscapedDiagnosticsTemplate),
    n: DIAGNOSTICS_TEMPLATE_CHECK_N,
    name: 'diagnostics (many JavaScript escapes in one template)',
  },
]

function defineDiagnosticsCheck({ context, n, name }: DiagnosticsCheckCase): ScalingCheck {
  return defineCheck({
    n,
    name,
    run: (size) => createTemplateLanguageService().getSemanticDiagnostics(context(size)),
    verify: (diagnostics, size) =>
      compareOffsets(
        offsetsOf(context(size).text, MISSPELLED_PROPERTY),
        diagnostics.map((diagnostic) => diagnostic.start),
      ),
  })
}

interface CompletionCheckCase {
  /** An entry the completions must leave out, and a tail where the same template must offer it (the positive control for its absence). */
  readonly excluded?: { readonly controlTail: string; readonly entry: string }
  readonly expected: string
  /** What kind of completion `expected` is, for the failure message. */
  readonly kind: string
  readonly name: string
  /** The large template's last line; the request goes at its end. */
  readonly tail: string
}

const completionCases: readonly CompletionCheckCase[] = [
  {
    expected: 'red',
    kind: 'color value',
    name: 'completions on a large template',
    tail: 'color:',
  },
  {
    expected: '@media',
    kind: 'nested at-rule',
    name: 'completions at an at-keyword on a large template',
    tail: '@',
  },
  /**
   * A value typed after a comment holding a ";", whose Emmet expansion is a declaration
   * (`margin: 10px;`): the caret placement search then finds that ";" is not code and walks every
   * structural character from the start, its costlier path. The value position must not offer
   * that declaration, while statement position in the same template does.
   */
  {
    excluded: { controlTail: 'm10', entry: 'margin: 10px;' },
    expected: 'auto',
    kind: 'margin value',
    name: 'completions in value position with an Emmet declaration on a large template',
    tail: 'margin: /* ; */ m10',
  },
]

function completionsAtEnd(context: TemplateContext): ts.CompletionInfo {
  return createTemplateLanguageService().getCompletionsAtPosition(
    context,
    context.toPosition(context.text.length),
  )
}

function entryNames(completions: ts.CompletionInfo): string[] {
  return completions.entries.map((entry) => entry.name)
}

function defineCompletionCheck({
  excluded,
  expected,
  kind,
  name,
  tail,
}: CompletionCheckCase): ScalingCheck {
  const templateContext = contextForSize((size) => createLargeTemplate(size, tail))
  const controlOffersExcluded = cachedBySize(
    (size) =>
      excluded === undefined ||
      entryNames(
        completionsAtEnd(createTemplateContext(createLargeTemplate(size, excluded.controlTail))),
      ).includes(excluded.entry),
  )
  return defineCheck({
    n: COMPLETIONS_CHECK_N,
    name,
    run: (size) => completionsAtEnd(templateContext(size)),
    verify(completions, size) {
      const names = entryNames(completions)
      const hasControl = controlOffersExcluded(size)
      const includesExcluded = excluded !== undefined && names.includes(excluded.entry)
      if (hasControl && names.includes(expected) && !includesExcluded) {
        return undefined
      }
      return {
        expected:
          `a "${expected}" entry among the ${kind} completions` +
          (excluded === undefined
            ? ''
            : ` and no "${excluded.entry}" entry, with "${excluded.entry}" offered after ` +
              `${JSON.stringify(excluded.controlTail)} in the same template`),
        received:
          `${names.length} entries, first ${JSON.stringify(names.slice(0, 5))}` +
          (includesExcluded ? `, "${excluded.entry}" included` : '') +
          (hasControl || excluded === undefined
            ? ''
            : `, and no "${excluded.entry}" after ${JSON.stringify(excluded.controlTail)}`),
      }
    },
  })
}

/**
 * `ruleCount` rules, each holding a multi-line placeholder as a margin value, then `color:` on its
 * own last line. Every placeholder loses its own line breaks in the substituted virtual document
 * (docs/architecture.md, substitution invariants), unlike createLargeTemplate's completion cases
 * above, which hold no placeholder at all: withTemplateLineBreaks must realign many lines here, so
 * its early return (every template line already ends in "\n") never applies, unlike those cases.
 */
function createManyMultilinePlaceholdersTemplate(ruleCount: number): {
  spans: TemplateSpan[]
  text: string
} {
  const unit = `.rule- { margin: ${MULTI_LINE_PLACEHOLDER}; color: red; }\n`
  const text = unit.repeat(ruleCount) + 'color:'
  return {
    spans: offsetsOf(text, MULTI_LINE_PLACEHOLDER).map((start) => ({
      end: start + MULTI_LINE_PLACEHOLDER.length,
      start,
    })),
    text,
  }
}

const manyMultilinePlaceholdersContextForSize = cachedBySize((size) => {
  const { spans, text } = createManyMultilinePlaceholdersTemplate(size)
  return createTemplateContext(text, spans)
})

/** Inside the first rule's selector `.rule-0` of a diagnostics template. */
const HOVER_POSITION: ts.LineAndCharacter = { character: 1, line: 0 }
const HOVERED_SELECTOR = '.rule-0'
/** The rename fix the first misspelled property must offer. */
const EXPECTED_CODE_FIX_TEXT = 'color'

function firstMisspelledPropertySpan(size: number): TemplateSpan {
  const start = diagnosticsContextForSize(size).text.indexOf(MISSPELLED_PROPERTY)
  return { end: start + MISSPELLED_PROPERTY.length, start }
}

const manyTemplateContextsForSize = cachedBySize((size) =>
  Array.from({ length: size }, (_, index) =>
    createTemplateContext(`.rule-${index} { colr: red; margin: 0; }`),
  ),
)

const checks: readonly ScalingCheck[] = [
  ...substitutionCases.map(({ build, label }) =>
    defineTextCheck(`substitution (${label})`, build, ({ spans, text }) =>
      getTemplateSubstitutions(text, spans),
    ),
  ),
  ...escapeCases.map(({ build, label }) =>
    defineTextCheck(`JavaScript escape replacement (${label})`, build, ({ text }) =>
      replaceJavaScriptEscapes(text),
    ),
  ),
  ...diagnosticsCases.map(defineDiagnosticsCheck),
  defineCheck({
    n: DIAGNOSTICS_TEMPLATE_CHECK_N,
    name: 'diagnostics (many interpolated and genuinely empty rules)',
    run: (size) =>
      createTemplateLanguageService({ lint: { emptyRules: 'error' } }).getSemanticDiagnostics(
        interpolatedEmptyRulesContextForSize(size),
      ),
    verify: (diagnostics, size) =>
      compareOffsets(
        offsetsOf(interpolatedEmptyRulesContextForSize(size).rawText, '.empty-'),
        diagnostics.map((diagnostic) => diagnostic.start),
      ),
  }),
  defineCheck({
    n: FOLDING_CHECK_N,
    name: 'folding (many spans)',
    run: (size) => createTemplateLanguageService().getOutliningSpans(foldingContextForSize(size)),
    verify: (spans, size) =>
      compareOffsets(
        offsetsOf(foldingContextForSize(size).text, '.rule-'),
        spans.map((span) => span.textSpan.start),
      ),
  }),
  defineCheck({
    n: DIAGNOSTICS_TEMPLATE_CHECK_N,
    name: 'hover',
    run: (size) =>
      createTemplateLanguageService().getQuickInfoAtPosition(
        diagnosticsContextForSize(size),
        HOVER_POSITION,
      ),
    /** The hover spans the whole selector and names its class. */
    verify(quickInfo) {
      const className = HOVERED_SELECTOR.slice(1)
      const documentation = quickInfo?.documentation?.map((part) => part.text).join('') ?? ''
      if (
        quickInfo?.textSpan.start === 0 &&
        quickInfo.textSpan.length === HOVERED_SELECTOR.length &&
        documentation.includes(className)
      ) {
        return undefined
      }
      return {
        expected: `a span at offset 0 of length ${HOVERED_SELECTOR.length} documenting "${className}"`,
        received:
          quickInfo === undefined
            ? 'no quick info'
            : `a span at offset ${quickInfo.textSpan.start} of length ${quickInfo.textSpan.length} ` +
              `documenting ${JSON.stringify(documentation.slice(0, 80))}`,
      }
    },
  }),
  ...completionCases.map(defineCompletionCheck),
  defineCheck({
    n: COMPLETIONS_CHECK_N,
    name: 'completions on a large template with many multi-line placeholders',
    run: (size) => completionsAtEnd(manyMultilinePlaceholdersContextForSize(size)),
    verify(completions) {
      const names = entryNames(completions)
      if (names.includes('red')) {
        return undefined
      }
      return {
        expected: 'a "red" entry among the color value completions',
        received: `${names.length} entries, first ${JSON.stringify(names.slice(0, 5))}`,
      }
    },
  }),
  defineCheck({
    n: DIAGNOSTICS_TEMPLATE_CHECK_N,
    name: 'code fixes',
    run(size) {
      const { end, start } = firstMisspelledPropertySpan(size)
      return createTemplateLanguageService().getCodeFixesAtPosition(
        diagnosticsContextForSize(size),
        start,
        end,
      )
    },
    verify(fixes, size) {
      const { end, start } = firstMisspelledPropertySpan(size)
      const hasExpectedFix = fixes.some((fix) =>
        fix.changes.some((change) =>
          change.textChanges.some(
            (textChange) =>
              textChange.newText === EXPECTED_CODE_FIX_TEXT &&
              textChange.span.start === start &&
              textChange.span.length === end - start,
          ),
        ),
      )
      if (hasExpectedFix) {
        return undefined
      }
      return {
        expected: `a fix replacing offset ${start} length ${end - start} with "${EXPECTED_CODE_FIX_TEXT}"`,
        received: `${fixes.length} fixes ${JSON.stringify(fixes.map((fix) => fix.description))}`,
      }
    },
  }),
  defineCheck({
    n: MANY_TEMPLATE_CHECK_N,
    name: 'diagnostics in a many-template file',
    run(size) {
      const service = createTemplateLanguageService()
      return manyTemplateContextsForSize(size).map((context) =>
        service.getSemanticDiagnostics(context),
      )
    },
    verify: (results, size) => compareOneDiagnosticEach(size, results),
  }),
  defineCheck({
    /**
     * Every template above is distinct, so RawValidationCache (docs/architecture.md, Caching)
     * never sees a hit there: this check re-validates the same `size` templates a second time in
     * the same order, all cache hits, so a regression in the hit path itself (for example a
     * per-lookup cost that grows with the number of cached entries, rather than the constant-time
     * lookup a size-bounded LRU map promises) shows up as superlinear growth here even though the
     * cold-path check above stays linear.
     */
    n: MANY_TEMPLATE_CHECK_N,
    name: 'diagnostics in a many-template file (repeated requests, cache hits)',
    run(size) {
      const service = createTemplateLanguageService()
      const contexts = manyTemplateContextsForSize(size)
      const results: ts.Diagnostic[][] = []
      for (const context of contexts) {
        results.push(service.getSemanticDiagnostics(context))
      }
      for (const context of contexts) {
        results.push(service.getSemanticDiagnostics(context))
      }
      return results
    },
    verify: (results, size) => compareOneDiagnosticEach(size * 2, results),
  }),
]

interface SizeTiming {
  bestMs: number
  mismatch: ResultMismatch | undefined
  readonly size: number
}

interface AttemptTiming {
  readonly at4N: SizeTiming
  readonly atN: SizeTiming
  /** Runs per size taken; under RUNS_PER_SIZE when the attempt stopped at EARLY_EXIT_RATIO. */
  readonly runs: number
}

/**
 * Alternates N and 4N samples, keeping each size's minimum positive sample and first mismatch
 * (verification runs inside `measure`, after its clock stops). A coarse CPU clock can report zero
 * for a short sample; zero is kept only until that size produces a positive reading, and an all-zero
 * side still fails as an unmeasurable probe. Alternating spreads a burst of machine load across both
 * sides of the ratio; timing every N sample before every 4N sample lets one burst inflate a single
 * side. Reports each sample's size and attempt before taking it, so a check stopped at its deadline
 * or heap cap names where it was.
 */
function timeInterleaved(
  check: ScalingCheck,
  attemptLabel: string,
  reportProgress: ReportProgress,
): AttemptTiming {
  const atN: SizeTiming = { bestMs: Infinity, mismatch: undefined, size: check.n }
  const at4N: SizeTiming = { bestMs: Infinity, mismatch: undefined, size: check.n * 4 }
  for (let run = 1; run <= RUNS_PER_SIZE; run++) {
    for (const timing of [atN, at4N]) {
      reportProgress({
        stage: `size ${timing.size}, run ${run} of ${RUNS_PER_SIZE}, ${attemptLabel}`,
      })
      const measurement = check.measure(timing.size)
      timing.bestMs = selectMinimumPositiveSample(timing.bestMs, measurement.elapsedMs)
      timing.mismatch ??= measurement.mismatch
    }
    if (
      run >= EARLY_EXIT_MIN_RUNS &&
      atN.bestMs > 0 &&
      at4N.bestMs > EARLY_EXIT_RATIO * atN.bestMs
    ) {
      return { at4N, atN, runs: run }
    }
  }
  return { at4N, atN, runs: RUNS_PER_SIZE }
}

/**
 * Times one check at N and 4N. A ratio outside [MIN_PLAUSIBLE_RATIO, SCALING_THRESHOLD] reports a
 * "retry" line and measures again, up to RATIO_RETRY_COUNT times; the check passes on the first
 * attempt inside the range and fails only when every attempt lands outside it, as the last
 * attempt's side of the range. A wrong result fails at once: it does not depend on timing.
 */
function runTimedCheck(check: ScalingCheck, reportProgress: ReportProgress): CheckResult {
  /** Warm JIT compilation and cachedBySize's fixtures at both sizes before any timed run. */
  for (const size of [check.n, check.n * 4]) {
    reportProgress({ stage: `size ${size}, warmup` })
    check.measure(size)
  }

  for (let attempt = 0; ; attempt++) {
    const attemptLabel = `attempt ${attempt + 1} of ${RATIO_RETRY_COUNT + 1}`
    const { at4N, atN, runs } = timeInterleaved(check, attemptLabel, reportProgress)

    const wrongResult = [atN, at4N].find((timing) => timing.mismatch !== undefined)
    if (wrongResult?.mismatch) {
      return {
        lines: [
          `FAIL ${check.name}: wrong result at size ${wrongResult.size}, so its timing measures ` +
            `nothing: expected ${wrongResult.mismatch.expected}; received ${wrongResult.mismatch.received}`,
        ],
        outcome: 'wrong-result',
      }
    }

    const hasUnmeasurableTiming = atN.bestMs === 0 || at4N.bestMs === 0
    const ratio = at4N.bestMs / atN.bestMs
    const isSuperlinear = !hasUnmeasurableTiming && ratio > SCALING_THRESHOLD
    const isImplausible = hasUnmeasurableTiming || ratio < MIN_PLAUSIBLE_RATIO
    const reading =
      `${check.name}: N=${check.n} ${atN.bestMs.toFixed(3)}ms, 4N=${at4N.size} ` +
      `${at4N.bestMs.toFixed(3)}ms, ratio=${ratio.toFixed(2)} (threshold ${SCALING_THRESHOLD}, ` +
      `floor ${MIN_PLAUSIBLE_RATIO})` +
      (runs < RUNS_PER_SIZE
        ? `, stopped after ${runs} of ${RUNS_PER_SIZE} runs per size above ${EARLY_EXIT_RATIO}`
        : '')
    const attemptsNote = attempt === 0 ? '' : `, ${attemptLabel}`

    if (!isSuperlinear && !isImplausible) {
      return { lines: [`ok   ${reading}${attemptsNote}`], outcome: 'ok' }
    }
    if (attempt === RATIO_RETRY_COUNT) {
      return {
        lines: [`FAIL ${reading}, outside the range on all ${RATIO_RETRY_COUNT + 1} attempts`],
        outcome: isSuperlinear ? 'over-limit' : 'probe-broken',
      }
    }
    reportProgress({
      line:
        `retry ${attempt + 1}/${RATIO_RETRY_COUNT} ${reading}: ` +
        `${
          hasUnmeasurableTiming
            ? 'one size produced no positive CPU-time sample'
            : isSuperlinear
              ? 'above the threshold'
              : 'below the floor'
        }, measuring again`,
    })
  }
}

const HEAP_GUARDRAIL_RULE_COUNT = 50
/**
 * An inert trailing comment, not real declarations: real CSS validation cost dominates this
 * check's wall-clock time and grows faster than linearly with rule count in the underlying CSS
 * language service, while RawValidationCache's own byte estimate (docs/architecture.md, Caching)
 * charges only for raw text length, not for what kind of content fills it. A comment this size
 * makes each edit's template genuinely multi-kilobyte, and its cache entry large enough to tell a
 * count-only cache apart from a byte-bounded one, without paying real-declaration validation cost
 * for every one of those bytes on every edit.
 */
const HEAP_GUARDRAIL_PADDING_LENGTH = 20_000

/** One misspelled property ("colr") per rule, so every edit's template produces HEAP_GUARDRAIL_RULE_COUNT diagnostics; the leading comment and the trailing padding comment make every edit's raw text distinct, forcing a validation-cache miss the way a real keystroke does. */
function buildHeapGuardrailTemplate(editIndex: number): string {
  let text = `/* edit ${editIndex} */\n`
  for (let index = 0; index < HEAP_GUARDRAIL_RULE_COUNT; index++) {
    text += `margin: ${index}px;\ncolr: red;\n`
  }
  text += `/* ${'x'.repeat(HEAP_GUARDRAIL_PADDING_LENGTH)} */\n`
  return text
}

/**
 * The most guardrail entries RawValidationCache can hold before MAX_VALIDATION_CACHE_BYTES evicts:
 * its size estimate charges at least 2 bytes per template character, so this rounds up an upper
 * bound. MAX_VALIDATION_CACHE_ENTRIES is far larger, so the byte budget is the bound under test.
 */
const HEAP_GUARDRAIL_ENTRIES_AT_BUDGET = Math.ceil(
  MAX_VALIDATION_CACHE_BYTES / (2 * buildHeapGuardrailTemplate(0).length),
)
/**
 * Ten times the entries the byte budget holds. A byte-bounded cache stops growing once the budget
 * binds, so its reading stays near the budget; a cache bounded only by entry count keeps every
 * edit, each retaining tens of kilobytes of real heap, and at this length reads more than twice
 * RETAINED_HEAP_THRESHOLD_BYTES (half this length reads too close to the threshold to fail
 * reliably).
 */
const RETAINED_HEAP_EDIT_COUNT = 10 * HEAP_GUARDRAIL_ENTRIES_AT_BUDGET
const RETAINED_HEAP_BUDGET_MULTIPLIER = 3
/** Slack above the raw cache budget for everything else a request retains (the single-entry virtual-document cache, Map bucket overhead). */
const RETAINED_HEAP_BASELINE_SLACK_BYTES = 2 * 1024 * 1024
const RETAINED_HEAP_THRESHOLD_BYTES =
  MAX_VALIDATION_CACHE_BYTES * RETAINED_HEAP_BUDGET_MULTIPLIER + RETAINED_HEAP_BASELINE_SLACK_BYTES
/**
 * How far the retained delta may drop below zero before the probe itself counts as broken (the
 * measured service collected before the "after" reading, or settleHeap not converging). A real
 * reading sits near the cache's budget and repeats to within a few tenths of a megabyte across
 * runs, so a reading below zero by more than this cannot come from noise.
 */
const RETAINED_HEAP_NEGATIVE_TOLERANCE_BYTES = 1024 * 1024
/**
 * The least a working cache retains, so a cache that keeps nothing (which reads under the
 * threshold) fails too. A full cache holds each entry's key as a one-byte-per-character string,
 * while the size estimate charges two bytes per character, so its keys alone retain close to half
 * the byte budget and its diagnostics add more on top. A service with no cache still retains its
 * one virtual document and parsed stylesheet. A third of the budget sits between the two readings,
 * with about the same factor of room to each (switch caching off in RawValidationCache.set to see
 * the uncached reading).
 */
const RETAINED_HEAP_FLOOR_BYTES = MAX_VALIDATION_CACHE_BYTES / 3
const HEAP_GUARDRAIL_WARMUP_EDIT_COUNT = 100
/** Edits between progress reports, so a stopped run names the edit it reached. */
const HEAP_GUARDRAIL_PROGRESS_INTERVAL = 100

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

const NO_BYTECODE_FLUSHING_FLAG = '--no-flush-bytecode'

/**
 * V8 flushes the bytecode of a function left unexecuted across several full collections, at a point
 * that depends on how many collections a run happens to trigger: in a worker, the retained-heap
 * reading then lands several megabytes apart (below zero on some runs) with no change in what the
 * cache holds. V8 flags apply to the whole process, so the flag on the parent covers every worker.
 */
function requireNoBytecodeFlushing(): void {
  if (!process.execArgv.includes(NO_BYTECODE_FLUSHING_FLAG)) {
    throw new Error(
      `The retained-heap guardrail needs Node's ${NO_BYTECODE_FLUSHING_FLAG} flag, or V8's ` +
        'bytecode flushing moves its reading by megabytes between runs: run ' +
        '`corepack yarn test:scaling`, which passes it, instead of invoking this file directly.',
    )
  }
}

/**
 * Retained-heap guardrail for RawValidationCache (src/features/diagnostics.ts, docs/
 * architecture.md, Caching): a cache bounded only by entry count, not by estimated size, can
 * retain far more than MAX_VALIDATION_CACHE_BYTES once its entries are large (many diagnostics
 * against a multi-kilobyte template). Runs RETAINED_HEAP_EDIT_COUNT distinct edits through one
 * StyledTemplateLanguageService's getSemanticDiagnostics and fails if the heap retained after gc
 * exceeds RETAINED_HEAP_THRESHOLD_BYTES or falls below RETAINED_HEAP_FLOOR_BYTES. The readings are
 * the worker's own heap: process.memoryUsage().heapUsed inside a worker thread reports that
 * thread's V8 heap, not the parent's.
 */
async function runRetainedHeapGuardrail(reportProgress: ReportProgress): Promise<CheckResult> {
  const gc = requireGc('test:scaling')
  requireNoBytecodeFlushing()
  /**
   * A throwaway service's edits first, so memory the diagnostics path allocates once on first use
   * and keeps for the life of the process (compiled code and its type feedback, lazily built
   * lookup data) lands before the "before" reading instead of counting as retention.
   */
  reportProgress({ stage: `warmup, ${HEAP_GUARDRAIL_WARMUP_EDIT_COUNT} edits` })
  const warmupService = createTemplateLanguageService()
  for (let index = 0; index < HEAP_GUARDRAIL_WARMUP_EDIT_COUNT; index++) {
    warmupService.getSemanticDiagnostics(
      createTemplateContext(buildHeapGuardrailTemplate(-1 - index)),
    )
  }

  const service = createTemplateLanguageService()
  const before = await settleHeap(gc)

  for (let index = 0; index < RETAINED_HEAP_EDIT_COUNT - 1; index++) {
    if (index % HEAP_GUARDRAIL_PROGRESS_INTERVAL === 0) {
      reportProgress({ stage: `edit ${index + 1} of ${RETAINED_HEAP_EDIT_COUNT}` })
    }
    service.getSemanticDiagnostics(createTemplateContext(buildHeapGuardrailTemplate(index)))
  }
  const finalContext = createTemplateContext(
    buildHeapGuardrailTemplate(RETAINED_HEAP_EDIT_COUNT - 1),
  )
  service.getSemanticDiagnostics(finalContext)

  const after = await settleHeap(gc)
  const retainedBytes = after - before

  /**
   * Reads from `service` again after the "after" gc, so it (and everything it retains, including
   * RawValidationCache) cannot be considered unreachable before that measurement runs: a local
   * variable's last use inside the edit loop above would otherwise let the interpreter end its
   * live range there, making it collectible by the very gc() call meant to measure what it
   * retains. This re-read is a cache hit on the last edit's own context, so it changes nothing
   * about what was measured; it only keeps `service` reachable through the measurement and proves
   * it still answers correctly afterward.
   */
  if (service.getSemanticDiagnostics(finalContext).length === 0) {
    return {
      lines: [
        'FAIL retained-heap guardrail: the measured service stopped returning diagnostics for its ' +
          'own last edit, so the probe is broken rather than measuring a real cache.',
      ],
      outcome: 'probe-broken',
    }
  }

  if (retainedBytes < -RETAINED_HEAP_NEGATIVE_TOLERANCE_BYTES) {
    return {
      lines: [
        `FAIL retained-heap guardrail: heap usage dropped by ${formatMb(-retainedBytes)} after ` +
          `${RETAINED_HEAP_EDIT_COUNT} distinct edits, more than the ` +
          `${formatMb(RETAINED_HEAP_NEGATIVE_TOLERANCE_BYTES)} tolerance allows. A real cache ` +
          'addition cannot free memory the "before" reading did not have; the probe is broken (the ' +
          'measured service was collected before the "after" reading, or settleHeap has not ' +
          'converged) rather than evidence the cache shrank.',
      ],
      outcome: 'probe-broken',
    }
  }

  const isOverLimit = retainedBytes > RETAINED_HEAP_THRESHOLD_BYTES
  const isUnderFloor = retainedBytes < RETAINED_HEAP_FLOOR_BYTES
  const reading =
    `${isOverLimit || isUnderFloor ? 'FAIL' : 'ok  '} retained heap after ` +
    `${RETAINED_HEAP_EDIT_COUNT} distinct edits: ${formatMb(retainedBytes)} (floor ` +
    `${formatMb(RETAINED_HEAP_FLOOR_BYTES)}, threshold ${formatMb(RETAINED_HEAP_THRESHOLD_BYTES)}, ` +
    `negative tolerance ${formatMb(RETAINED_HEAP_NEGATIVE_TOLERANCE_BYTES)})`
  if (isUnderFloor) {
    return {
      lines: [
        reading,
        `FAIL retained-heap guardrail: ${formatMb(retainedBytes)} is below the ` +
          `${formatMb(RETAINED_HEAP_FLOOR_BYTES)} a working validation cache retains, so the cache ` +
          'keeps no entries (RawValidationCache.set in src/features/diagnostics.ts stores nothing, ' +
          'or the diagnostics path no longer reaches it) or the probe measured nothing.',
      ],
      outcome: 'probe-broken',
    }
  }
  return { lines: [reading], outcome: isOverLimit ? 'over-limit' : 'ok' }
}

interface BoundedCheck {
  readonly name: string
  run(reportProgress: ReportProgress): CheckResult | Promise<CheckResult>
}

const boundedChecks: readonly BoundedCheck[] = [
  ...checks.map((check): BoundedCheck => ({
    name: check.name,
    run: (reportProgress) => runTimedCheck(check, reportProgress),
  })),
  { name: 'retained-heap guardrail', run: runRetainedHeapGuardrail },
]

function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

function describeDeadline(deadlineMs: number): string {
  return deadlineMs < CHECK_DEADLINE_MS
    ? `the ${formatSeconds(deadlineMs)} left of the run's ${formatSeconds(RUN_BUDGET_MS)} budget`
    : `its ${formatSeconds(deadlineMs)} wall-clock deadline`
}

/** Runs one check in its own worker and prints its lines as they arrive. */
async function runCheckInWorker(
  entry: string,
  index: number,
  deadlineMs: number,
): Promise<CheckOutcome> {
  const check = boundedChecks[index]
  if (check === undefined) {
    throw new Error(`Scaling check setup: no check at index ${index}.`)
  }
  const location = createProgressLocationTracker()
  const outcome = await runBounded<number, CheckProgress, CheckResult>({
    entry,
    input: index,
    limits: { deadlineMs, heapMb: CHECK_HEAP_CAP_MB },
    onProgress(progress) {
      if ('line' in progress) {
        console.log(progress.line)
      }
      location.onProgress(progress)
    },
  })
  const wall = formatSeconds(outcome.elapsedMs)
  const where = location.location()

  switch (outcome.kind) {
    case 'done': {
      const [summary, ...details] = outcome.result.lines
      console.log(`${summary}, ${wall} wall`)
      for (const line of details) {
        console.log(line)
      }
      return outcome.result.outcome
    }
    case 'deadline':
      console.log(
        `FAIL ${check.name}: stopped at ${describeDeadline(deadlineMs)} ${where}. Its ` +
          'unregressed run takes a small fraction of that even on a loaded machine, so this most ' +
          'likely means a superlinear regression (a quadratic or worse cost, ' +
          'or a loop that never ends) in the operation this check times. See docs/architecture.md ' +
          '(substitution and caching invariants).',
      )
      return 'over-limit'
    case 'heap':
      console.log(
        `FAIL ${check.name}: reached its ${CHECK_HEAP_CAP_MB}MB heap cap ${where}, after ${wall}. ` +
          'Its unregressed run uses a small fraction of that, so this most likely means unbounded ' +
          'retention (a cache or list that never evicts) or an allocation that grows superlinearly ' +
          'with the input in the operation this check exercises. See docs/architecture.md ' +
          '(substitution and caching invariants).',
      )
      return 'over-limit'
    case 'crashed':
      console.log(
        `FAIL ${check.name}: threw ${where}, after ${wall}: ${describeError(outcome.error)}`,
      )
      return 'crashed'
  }
}

async function main() {
  requireGc('test:scaling')
  requireNoBytecodeFlushing()
  if (typeof process.threadCpuUsage !== 'function') {
    throw new Error(
      `The scaling check times with process.threadCpuUsage, which Node ${process.version} lacks: ` +
        'run it on the development Node version in .github/.node-version.',
    )
  }
  const entry = process.argv[1]
  if (entry === undefined) {
    throw new Error(
      'The scaling check runs each check in a worker loaded from its own file, found through ' +
        'process.argv[1], which is empty: run it as `corepack yarn test:scaling`.',
    )
  }
  const filter = parseFilterArgument(process.argv.slice(2))
  const selected = selectChecks(boundedChecks, filter)

  const startedAt = performance.now()
  const outcomes: CheckOutcome[] = []
  for (const { check, index } of selected) {
    const remainingMs = RUN_BUDGET_MS - (performance.now() - startedAt)
    if (remainingMs <= 0) {
      console.log(
        `FAIL ${check.name}: not run, because the checks stopped above spent the run's whole ` +
          `${formatSeconds(RUN_BUDGET_MS)} budget. Fix those first.`,
      )
      outcomes.push('over-limit')
      continue
    }
    const outcome = await runCheckInWorker(entry, index, Math.min(CHECK_DEADLINE_MS, remainingMs))
    outcomes.push(outcome)
  }

  if (outcomes.includes('wrong-result')) {
    console.error(
      'Scaling check failed: at least one hot operation returned a wrong result for its fixture ' +
        '(a feature that throws is caught and returns an empty result, which is also fast at every ' +
        'size). Fix the feature before reading any ratio; the FAIL line above names the check and ' +
        'the expected result.',
    )
  }
  if (outcomes.includes('probe-broken')) {
    console.error(
      'Scaling check failed: at least one probe measured nothing, so its reading cannot be ' +
        'trusted. Either a timed size produced no finite positive CPU-time sample, a hot operation ' +
        `took less than ${MIN_PLAUSIBLE_RATIO}x as long at 4N as at N on all ` +
        `${RATIO_RETRY_COUNT + 1} attempts (the timed call is not doing work that grows with its ` +
        'input: a cache shared across service instances, or an early return; find what short-circuits ' +
        'it), or the retained-heap guardrail produced no valid reading or read below its floor (a ' +
        'validation cache that keeps nothing). The FAIL line above names which.',
    )
  }
  if (outcomes.includes('over-limit')) {
    console.error(
      'Scaling check failed: at least one hot operation grew superlinearly with its input size ' +
        `on all ${RATIO_RETRY_COUNT + 1} attempts or was stopped at its deadline or heap cap, or ` +
        'the diagnostics validation cache retained more than its byte budget. See ' +
        'docs/architecture.md (substitution and caching invariants).',
    )
  }
  if (outcomes.includes('crashed')) {
    console.error(
      'Scaling check failed: at least one check threw outside the language service, which ' +
        'recovers from its own exceptions. The FAIL line above names the check and holds the stack.',
    )
  }
  if (outcomes.some((outcome) => outcome !== 'ok')) {
    process.exitCode = 1
  }
}

if (isMainThread) {
  void main()
} else {
  serveBounded<number, CheckProgress, CheckResult>((index, reportProgress) => {
    const check = boundedChecks[index]
    if (check === undefined) {
      throw new Error(`Scaling check worker: no check at index ${index}.`)
    }
    return check.run(reportProgress)
  })
}
