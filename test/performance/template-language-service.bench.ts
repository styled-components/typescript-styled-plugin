import { isMainThread } from 'node:worker_threads'

import { Bench } from 'tinybench'

import { formatSeconds, runBounded, serveBounded } from '../../scripts/bounded-worker.ts'
import {
  MAX_VALIDATION_CACHE_BYTES,
  MAX_VALIDATION_CACHE_ENTRIES,
  VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES,
} from '../../src/features/diagnostics.ts'
import {
  createDiagnosticsTemplate,
  createFoldingTemplate,
  createLargeTemplate,
  createTemplateContext,
  createTemplateContextFactory,
  createTemplateLanguageService,
  requireGc,
  settleHeap,
  type TemplateSpan,
} from './template-language-service-fixture.ts'

/**
 * Builds a template whose interpolation placeholders are literal `${...}` text, each span covering
 * the whole placeholder, delimiters included, as the decorator's own placeholder spans do
 * (createTemplateContext): the substituted text then matches what production translates.
 */
function createInterpolatedTemplate(interpolationCount: number): {
  rawText: string
  substitutionSpans: TemplateSpan[]
} {
  const substitutionSpans: TemplateSpan[] = []
  let rawText = ''
  const appendPlaceholder = (expression: string) => {
    const start = rawText.length
    rawText += `\${${expression}}`
    substitutionSpans.push({ end: rawText.length, start })
  }
  for (let index = 0; index < interpolationCount; index++) {
    rawText += `.rule-${index} { color: `
    appendPlaceholder(`value${index}`)
    rawText += '; margin: '
    appendPlaceholder(`space${index}`)
    rawText += '; }\n'
  }
  rawText += 'color:'
  return { rawText, substitutionSpans }
}

/** Inside the first rule's selector. */
const HOVER_POSITION = { character: 1, line: 0 }

/** How many distinct templates the "all cache hits" diagnostics task holds warm at once. */
const MANY_TEMPLATE_COUNT = 20

/** One misspelled property ("colr") per template, each its own file's worth of raw text, distinct from every other so each is its own validation cache entry (src/features/diagnostics.ts, RawValidationCache). */
function createManyTemplateContexts(count: number) {
  return Array.from({ length: count }, (_, index) =>
    createTemplateContext(`.rule-${index} { colr: red; margin: 0; }`),
  )
}

/**
 * Builds every fixture and task. Runs only inside the benchmark's worker: building the cached
 * completion fixture already runs plugin code, which the main thread never does.
 */
function createBenchmark(reportProgress: (stage: string) => void): Bench {
  const largeTemplate = createLargeTemplate(400)
  const largeTemplateContextFactory = createTemplateContextFactory(largeTemplate)
  const largeTemplatePosition = largeTemplateContextFactory().toPosition(largeTemplate.length)

  const interpolatedTemplate = createInterpolatedTemplate(120)
  const interpolatedContextFactory = createTemplateContextFactory(
    interpolatedTemplate.rawText,
    interpolatedTemplate.substitutionSpans,
  )
  const interpolatedPosition = interpolatedContextFactory().toPosition(
    interpolatedTemplate.rawText.length,
  )

  const cachedContext = createTemplateContext(largeTemplate)
  const cachedService = createTemplateLanguageService()
  const cachedPosition = cachedContext.toPosition(largeTemplate.length)

  reportProgress('building the cached completion fixture')
  cachedService.getCompletionsAtPosition(cachedContext, cachedPosition)

  /**
   * Small and large sizes for diagnostics/hover/folding: every rule has a misspelled property
   * ("colr"), so diagnostic count and folding-range count scale with rule count, exercising
   * translation across many results per request rather than one (the shape
   * fromVirtualDocPosition's per-call line-start recomputation made quadratic in template size
   * times result count; docs/architecture.md, "Virtual document").
   */
  const smallDiagnosticsContextFactory = createTemplateContextFactory(createDiagnosticsTemplate(40))
  const largeDiagnosticsContextFactory = createTemplateContextFactory(
    createDiagnosticsTemplate(1_600),
  )
  const smallFoldingContextFactory = createTemplateContextFactory(createFoldingTemplate(40))
  const largeFoldingContextFactory = createTemplateContextFactory(createFoldingTemplate(1_600))

  const manyTemplateContexts = createManyTemplateContexts(MANY_TEMPLATE_COUNT)
  const manyTemplateService = createTemplateLanguageService()
  reportProgress('warming the many-template diagnostics fixture')
  for (const context of manyTemplateContexts) {
    manyTemplateService.getSemanticDiagnostics(context)
  }

  /** `throws` rethrows a task's exception from run() instead of recording it and printing no row. */
  const benchmark = new Bench({
    iterations: 20,
    throws: true,
    time: 1_000,
    warmupIterations: 5,
    warmupTime: 250,
  })

  /**
   * Every task below reuses a parsed fixture (createTemplateContextFactory's one-time
   * ts.createSourceFile parse), so that parse never lands inside the timed callback, but calls the
   * factory again on every iteration for a fresh `TemplateContext` object with its own unmemoized
   * `text` getter: the decorator gives every request its own context (StandardTemplateContext) even
   * when nothing about the file changed, so a context reused across iterations would hide the cost
   * of computing `text` (a substitution over the raw template, src/template/template-substitutions.ts)
   * behind the first iteration's memoization, never charging it again. A fresh
   * `StyledTemplateLanguageService` (an empty completion/diagnostics cache) is also built per
   * iteration, isolating the plugin's own computation from TypeScript's unrelated parse cost.
   * 'reuses completions at the same position' and the MANY_TEMPLATE_COUNT-templates task below are
   * the deliberate exceptions: both measure a genuinely reused context and service, the warm-cache
   * path a real edit-then-request-again sequence takes.
   */
  benchmark
    .add('completes a large template', () => {
      const service = createTemplateLanguageService()
      service.getCompletionsAtPosition(largeTemplateContextFactory(), largeTemplatePosition)
    })
    .add('completes a template with many interpolations', () => {
      const service = createTemplateLanguageService()
      service.getCompletionsAtPosition(interpolatedContextFactory(), interpolatedPosition)
    })
    .add('reuses completions at the same position', () => {
      cachedService.getCompletionsAtPosition(cachedContext, cachedPosition)
    })
    .add('reports diagnostics for a small template', () => {
      const service = createTemplateLanguageService()
      service.getSemanticDiagnostics(smallDiagnosticsContextFactory())
    })
    .add('reports diagnostics for a large template', () => {
      const service = createTemplateLanguageService()
      service.getSemanticDiagnostics(largeDiagnosticsContextFactory())
    })
    .add('hovers in a small template', () => {
      const service = createTemplateLanguageService()
      service.getQuickInfoAtPosition(smallDiagnosticsContextFactory(), HOVER_POSITION)
    })
    .add('hovers in a large template', () => {
      const service = createTemplateLanguageService()
      service.getQuickInfoAtPosition(largeDiagnosticsContextFactory(), HOVER_POSITION)
    })
    .add('folds a small template', () => {
      const service = createTemplateLanguageService()
      service.getOutliningSpans(smallFoldingContextFactory())
    })
    .add('folds a large template', () => {
      const service = createTemplateLanguageService()
      service.getOutliningSpans(largeFoldingContextFactory())
    })
    .add(`${MANY_TEMPLATE_COUNT} templates, all cache hits`, () => {
      for (const context of manyTemplateContexts) {
        manyTemplateService.getSemanticDiagnostics(context)
      }
    })

  for (const task of benchmark.tasks) {
    task.addEventListener('warmup', () => reportProgress(`task "${task.name}"`))
  }
  return benchmark
}

const productionSourcePrefixLength = 20_000
const PRODUCTION_SHAPE_RULE_COUNT = 20

function createProductionShapeTemplate(index: number): string {
  return createDiagnosticsTemplate(PRODUCTION_SHAPE_RULE_COUNT) + `\n/* ${index} */`
}

/**
 * A fresh 20 KB source string per iteration (`sourcePrefix + template`), sliced down to just the
 * template afterward: `rawText` is then a genuine slice of a larger string, as
 * typescript-template-language-service-decorator produces it from a real open file
 * (StandardTemplateContext), not a freshly concatenated string with no parent to leak. One shared
 * service, not a fresh one per iteration, so its per-service caches (the validation cache,
 * src/features/diagnostics.ts) behave as they do across many requests against one open file:
 * fills, since every iteration's comment makes the template text distinct, then evicts on every
 * iteration once its byte budget binds.
 */
function createProductionShapeIteration(): (index: number) => void {
  const productionService = createTemplateLanguageService()
  return (index) => {
    const source = 'x'.repeat(productionSourcePrefixLength) + createProductionShapeTemplate(index)
    const rawText = source.slice(productionSourcePrefixLength)
    const context = createTemplateContext(rawText)
    productionService.getCompletionsAtPosition(context, context.toPosition(rawText.length))
    productionService.getSemanticDiagnostics(context)
    productionService.getOutliningSpans(context)
  }
}

/**
 * An upper bound on how many production-shape entries the validation cache holds before it first
 * evicts: each entry's size estimate charges at least 2 bytes per template character plus
 * VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES per diagnostic (one per rule), and the real estimate
 * adds the wrapper and each message on top, so the byte budget binds somewhat earlier than this.
 */
const PRODUCTION_SHAPE_FILL_BOUND = Math.min(
  MAX_VALIDATION_CACHE_ENTRIES,
  Math.floor(
    MAX_VALIDATION_CACHE_BYTES /
      (2 * createProductionShapeTemplate(0).length +
        PRODUCTION_SHAPE_RULE_COUNT * VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES),
  ),
)
/**
 * h0 lands early in the fill, and h1 at PRODUCTION_SHAPE_FILL_BOUND, past the point where the byte
 * budget first evicts. slope1 (h0 to h1) is therefore mostly fill, each iteration adding one net
 * retained cache entry: the shape a per-entry retention regression (an unflattened cache key
 * holding this iteration's 20 KB parent string, instead of the template it needs) shows up in most
 * directly, with a short stretch of eviction at its end. slope2 (h1 to h2) runs entirely at
 * capacity, evicting one entry per insertion: it reads near zero when eviction releases what it
 * replaces, and stays elevated if the bound stopped enforcing itself or an evicted entry's memory
 * does not fully release.
 */
const PRODUCTION_SHAPE_FIRST_BATCH = 100
const PRODUCTION_SHAPE_BATCH_SIZES: readonly [number, number, number] = [
  PRODUCTION_SHAPE_FIRST_BATCH,
  PRODUCTION_SHAPE_FILL_BOUND - PRODUCTION_SHAPE_FIRST_BATCH,
  PRODUCTION_SHAPE_FILL_BOUND,
]

/**
 * The leak control's slope must clear the no-op control's by at least this factor for the
 * instrument to trust its own numbers: a bare `leakControl.slope2 > noOpControl.slope2` check
 * passes on any measurable difference, including one within GC-timing and JIT-warmup noise, which
 * both controls are equally subject to. The no-op baseline is floored at MINIMUM_NOOP_BASELINE_KB
 * before multiplying, since a baseline that measures at or below zero (plausible for a control that
 * retains nothing) would otherwise make any tiny positive leak slope clear the bar trivially.
 */
const LEAK_CONTROL_MARGIN_FACTOR = 5
const MINIMUM_NOOP_BASELINE_KB = 0.05

interface HeapSlope {
  /** KB/iter between the first and second settle points. */
  slope1: number
  /** KB/iter between the second and third settle points. */
  slope2: number
}

const DEFAULT_HEAP_SLOPE_BATCH_SIZES: readonly [number, number, number] = [100, 200, 400]

/**
 * Bytes-per-iteration slope, not a single before/after `gc()` snapshot: a lone snapshot around one
 * synchronous run conflates real retention with V8 flushing its own one-time load bytecode after
 * warmup, which reads as a spurious multi-megabyte negative delta. Three settle points after
 * growing batches of iterations give two slope samples immune to that one-time cost, since it only
 * shows up once, before the first settle point.
 */
async function measureHeapSlopeKb(
  gc: () => void,
  iteration: (index: number) => void,
  batchSizes: readonly [number, number, number] = DEFAULT_HEAP_SLOPE_BATCH_SIZES,
): Promise<HeapSlope> {
  const [firstBatch, secondBatch, thirdBatch] = batchSizes
  let index = 0
  for (let i = 0; i < firstBatch; i++) iteration(index++)
  const h0 = await settleHeap(gc)
  for (let i = 0; i < secondBatch; i++) iteration(index++)
  const h1 = await settleHeap(gc)
  for (let i = 0; i < thirdBatch; i++) iteration(index++)
  const h2 = await settleHeap(gc)
  return { slope1: (h1 - h0) / secondBatch / 1024, slope2: (h2 - h1) / thirdBatch / 1024 }
}

function formatKb(value: number): string {
  return value.toFixed(2)
}

function formatSlope(slope: HeapSlope): string {
  return `slope1=${formatKb(slope.slope1)} slope2=${formatKb(slope.slope2)}`
}

/**
 * A no-op control (slope must land near zero) and a deliberate-leak control (slope must be clearly
 * positive) prove the instrument can tell a leak from noise, rather than trusting an unvalidated
 * number.
 */
async function measureHeapSlopes(
  gc: () => void,
  reportProgress: (stage: string) => void,
): Promise<string> {
  reportProgress('retained heap slope (production shape)')
  const productionShape = await measureHeapSlopeKb(
    gc,
    createProductionShapeIteration(),
    PRODUCTION_SHAPE_BATCH_SIZES,
  )

  reportProgress('retained heap slope (no-op control)')
  const noOpControl = await measureHeapSlopeKb(gc, (index) => {
    void (index + 1)
  })

  reportProgress('retained heap slope (leak control)')
  const leaked: unknown[] = []
  const leakControl = await measureHeapSlopeKb(gc, (index) => {
    leaked.push(createProductionShapeTemplate(index))
  })

  const report =
    `Retained heap slope (production shape): ${formatSlope(productionShape)} KB/iter\n` +
    `Retained heap slope (no-op control):     ${formatSlope(noOpControl)} KB/iter\n` +
    `Retained heap slope (leak control):      ${formatSlope(leakControl)} KB/iter`

  /**
   * Compares the later, more-settled sample (slope2) rather than the average: a transient
   * per-closure JIT cost inflates slope1 for every shape, including the no-op control, and would
   * otherwise make the leak control look less clearly separated from noise than it is. Requires a
   * margin over a floored baseline, not just "greater than", so noise alone cannot pass this check.
   */
  const requiredLeakSlope =
    Math.max(noOpControl.slope2, MINIMUM_NOOP_BASELINE_KB) * LEAK_CONTROL_MARGIN_FACTOR
  if (leakControl.slope2 <= requiredLeakSlope) {
    throw new Error(
      `The heap-slope instrument itself looks broken: the leak control (${formatKb(leakControl.slope2)} KB/iter) ` +
        `did not measure clearly above the no-op control (${formatKb(noOpControl.slope2)} KB/iter): expected at ` +
        `least ${LEAK_CONTROL_MARGIN_FACTOR}x it (floored at ${formatKb(MINIMUM_NOOP_BASELINE_KB)} KB/iter), ` +
        `${formatKb(requiredLeakSlope)} KB/iter. Fix the probe before trusting its numbers.\n` +
        report,
    )
  }
  return report
}

interface BenchmarkReport {
  readonly heapSlopes: string
  readonly table: ReturnType<Bench['table']>
}

/**
 * The whole benchmark runs in one worker thread (scripts/bounded-worker.ts), so every task shares
 * the warm JIT state a single process gives it, stopped at BENCHMARK_DEADLINE_MS of wall time or
 * BENCHMARK_HEAP_CAP_MB of heap. A healthy run, even on a loaded machine, takes a small fraction of
 * the deadline and needs a small fraction of the cap, so either stop means a hot operation or a
 * cache regressed badly enough that a before-and-after comparison would be meaningless.
 */
const BENCHMARK_DEADLINE_MS = 5 * 60_000
const BENCHMARK_HEAP_CAP_MB = 1024

async function runBenchmark(reportProgress: (stage: string) => void): Promise<BenchmarkReport> {
  const gc = requireGc('benchmark')
  const benchmark = createBenchmark(reportProgress)
  await benchmark.run()
  const table = benchmark.table()
  const heapSlopes = await measureHeapSlopes(gc, reportProgress)
  return { heapSlopes, table }
}

async function main() {
  requireGc('benchmark')
  const entry = process.argv[1]
  if (entry === undefined) {
    throw new Error(
      'The benchmark runs in a worker loaded from its own file, found through process.argv[1], ' +
        'which is empty: run it as `corepack yarn benchmark`.',
    )
  }
  const outcome = await runBounded<undefined, string, BenchmarkReport>({
    entry,
    input: undefined,
    limits: { deadlineMs: BENCHMARK_DEADLINE_MS, heapMb: BENCHMARK_HEAP_CAP_MB },
  })
  const where =
    outcome.kind === 'done' || outcome.lastProgress === undefined
      ? 'while loading'
      : `during ${outcome.lastProgress}`

  switch (outcome.kind) {
    case 'done':
      console.table(outcome.result.table)
      console.log(outcome.result.heapSlopes)
      return
    case 'deadline':
      console.error(
        `Benchmark stopped at its ${formatSeconds(BENCHMARK_DEADLINE_MS)} wall-clock deadline ` +
          `${where}. A healthy run takes a small fraction of that, so this most likely means a ` +
          'superlinear regression (a quadratic or worse cost, or a loop that never ends) in that ' +
          'operation; `corepack yarn test:scaling` names the hot operation. See ' +
          'docs/architecture.md (substitution and caching invariants).',
      )
      break
    case 'heap':
      console.error(
        `Benchmark reached its ${BENCHMARK_HEAP_CAP_MB}MB heap cap ${where}, after ` +
          `${formatSeconds(outcome.elapsedMs)}. A healthy run needs a small fraction of that, so ` +
          'this most likely means unbounded retention (a cache that never evicts) or an ' +
          'allocation that grows superlinearly with the input. See docs/architecture.md (caching ' +
          'invariants).',
      )
      break
    case 'crashed':
      console.error(`Benchmark failed ${where}:`, outcome.error)
      break
  }
  process.exitCode = 1
}

if (isMainThread) {
  void main()
} else {
  serveBounded<undefined, string, BenchmarkReport>((_input, reportProgress) =>
    runBenchmark(reportProgress),
  )
}
