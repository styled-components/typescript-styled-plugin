import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'
import type { Diagnostic } from 'vscode-css-languageservice'
import { DiagnosticSeverity } from 'vscode-languageserver-types'

import { pluginIdentity } from '../tsserver/plugin-identity.ts'
import { createCssCodeScanState, nonCodeEnd } from '../virtual-document/css-code-scanner.ts'
import { getTemplateCssText } from '../virtual-document/javascript-escapes.ts'
import {
  StyledVirtualDocumentProvider,
  type VirtualDocumentProvider,
} from '../virtual-document/styled-virtual-document-provider.ts'
import {
  createTemplateLineMap,
  fromVirtualDocSpan,
  type TemplateLineMap,
  type TemplateSpan,
} from '../virtual-document/template-line-map.ts'
import type { VirtualDocumentSessionProvider } from '../virtual-document/virtual-document-session-provider.ts'
import {
  CSS_DIAGNOSTIC_CODE,
  EMPTY_RULESET_DIAGNOSTIC_CODE,
  RULE_OR_SELECTOR_EXPECTED_DIAGNOSTIC_CODE,
} from './css-diagnostic-code.ts'
import type { ScssLanguageService } from './styles-language-services.ts'

/** A CSS diagnostic as the editor shows it: the template span it lands on after mapping and re-anchoring. */
export interface ShownDiagnostic extends TemplateSpan {
  readonly diagnostic: Diagnostic
}

/**
 * Above this many entries, the least recently used raw-validation result is evicted (docs/
 * architecture.md, Caching): unbounded growth would hold every distinct template text a file ever
 * had, across the whole editor session. Exported so tests can size a cache-filling fixture without
 * hard-coding this number.
 */
export const MAX_VALIDATION_CACHE_ENTRIES = 2_000

/**
 * Above this many estimated total bytes across every cached entry, the least recently used entry
 * is evicted, independent of MAX_VALIDATION_CACHE_ENTRIES: a file with few, large templates (many
 * diagnostics against a multi-kilobyte template, edited on every keystroke) can exhaust memory
 * long before the count cap binds, since count alone says nothing about an entry's size. Exported
 * so tests can size a cache-filling fixture without hard-coding this number.
 */
export const MAX_VALIDATION_CACHE_BYTES = 4 * 1024 * 1024

/**
 * Per-diagnostic overhead beyond its message text (the range object, severity, code, and source
 * fields, plus JS engine object bookkeeping), used only to estimate cache memory pressure, not to
 * account for it exactly. Measured by cloning a real vscode-css-languageservice doValidation
 * result (range, message, severity, code, source) into independent copies, forcing gc between
 * growing batches, and dividing the settled retained-heap delta per copy by its diagnostic count,
 * then subtracting each diagnostic's own message bytes (UTF-16 code units times 2) from that
 * per-diagnostic total.
 */
export const VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES = 150

interface Validation {
  readonly diagnostics: readonly Diagnostic[]
  /** The line map that resolves the diagnostics, which a cache hit builds only when one needs mapping. */
  readonly getLineMap: () => TemplateLineMap
}

export class DiagnosticsFeature {
  private readonly validationCache = new RawValidationCache()

  public constructor(
    private readonly typescript: typeof ts,
    private readonly virtualDocumentProvider: VirtualDocumentProvider,
    private readonly virtualDocumentSessionProvider: VirtualDocumentSessionProvider,
    private readonly scssLanguageService: ScssLanguageService,
    private readonly isValidationEnabled: () => boolean,
  ) {}

  /** Lint settings change what doValidation returns for the same text, so a config update invalidates every entry. */
  public clearCache(): void {
    this.validationCache.clear()
  }

  public getSemanticDiagnostics(context: TemplateContext): ts.Diagnostic[] {
    const file = context.node.getSourceFile()
    return this.getShownDiagnostics(context).map(({ diagnostic, end, start }) => ({
      category: translateSeverity(this.typescript, diagnostic.severity),
      code: typeof diagnostic.code === 'number' ? diagnostic.code : CSS_DIAGNOSTIC_CODE,
      file,
      length: end - start,
      messageText: diagnostic.message,
      source: pluginIdentity,
      start,
    }))
  }

  /**
   * The diagnostics the editor shows for a template (docs/architecture.md, "Diagnostics"): the one
   * list both diagnostics and code fixes read, empty while validation is off.
   */
  public getShownDiagnostics(context: TemplateContext): ShownDiagnostic[] {
    if (!this.isValidationEnabled()) {
      return []
    }

    const { diagnostics, getLineMap } = this.validate(context)
    if (diagnostics.length === 0) {
      return []
    }

    const lineMap = getLineMap()
    const templateEnd = context.rawText.length
    let strayBraceOffset: number | undefined
    let hasSearchedStrayBrace = false
    const shown: ShownDiagnostic[] = []
    for (const diagnostic of diagnostics) {
      const span = fromVirtualDocSpan(this.virtualDocumentProvider, diagnostic.range, lineMap)
      if (!span) {
        continue
      }
      const reportsWrapperClose =
        diagnostic.code === RULE_OR_SELECTOR_EXPECTED_DIAGNOSTIC_CODE && span.start === templateEnd
      if (reportsWrapperClose && !hasSearchedStrayBrace) {
        strayBraceOffset = findStrayClosingBraceOffset(getTemplateCssText(context))
        hasSearchedStrayBrace = true
      }
      const anchor = reportsWrapperClose ? strayBraceOffset : undefined
      const start = anchor ?? span.start
      const end = anchor === undefined ? span.end : anchor + 1
      shown.push({ diagnostic, end, start })
    }
    return shown
  }

  /** Raw validation results and the line map that resolves them, from RawValidationCache when it holds the template. */
  private validate(context: TemplateContext): Validation {
    /** Only the built-in provider's documents are proven pure functions of the cache key (docs/architecture.md, "Caching"). */
    const styledProvider =
      this.virtualDocumentProvider instanceof StyledVirtualDocumentProvider
        ? this.virtualDocumentProvider
        : undefined
    const cacheKey =
      styledProvider &&
      buildValidationCacheKey(styledProvider.getReadingKey(context), context.rawText)
    const cachedDiagnostics =
      cacheKey === undefined ? undefined : this.validationCache.peek(cacheKey)
    if (cachedDiagnostics) {
      /** A hit builds no document, and so never evicts the session's cached one. */
      return {
        diagnostics: cachedDiagnostics,
        getLineMap: () =>
          this.virtualDocumentSessionProvider.getReusableLineMap(context) ??
          createTemplateLineMap(context),
      }
    }

    const { document, lineMap, stylesheet } =
      this.virtualDocumentSessionProvider.getParsedDocument(context)
    let diagnostics = this.scssLanguageService.doValidation(document, stylesheet)
    const valueReading = styledProvider?.createValueReadingDocument(context)
    if (valueReading) {
      const valueDiagnostics = this.scssLanguageService.doValidation(
        valueReading,
        this.scssLanguageService.parseStylesheet(valueReading),
      )
      diagnostics = diagnostics.filter((diagnostic) =>
        valueDiagnostics.some((other) => isSameDiagnostic(diagnostic, other)),
      )
    }
    if (styledProvider) {
      diagnostics = filterEmptyRulesWithInterpolations(
        this.typescript,
        context,
        diagnostics,
        lineMap,
        styledProvider,
      )
    }
    if (cacheKey !== undefined) {
      this.validationCache.set(cacheKey, diagnostics)
    }
    return { diagnostics, getLineMap: () => lineMap }
  }
}

interface RuleBody {
  readonly end: number
  readonly start: number
}

interface OpenRuleBody {
  end?: number
  readonly start: number
}

/**
 * Drops empty-rules lint findings for rules whose bodies hold a template interpolation:
 * styled-components can turn that interpolation into declarations at runtime, so the rule is not
 * provably empty. The filter runs before validation caching, preserving cache-hit laziness.
 */
function filterEmptyRulesWithInterpolations(
  typescript: typeof ts,
  context: TemplateContext,
  diagnostics: Diagnostic[],
  lineMap: TemplateLineMap,
  virtualDocumentProvider: VirtualDocumentProvider,
): Diagnostic[] {
  if (!diagnostics.some(({ code }) => code === EMPTY_RULESET_DIAGNOSTIC_CODE)) {
    return diagnostics
  }
  const interpolationSpans = getInterpolationSpans(typescript, context)
  if (interpolationSpans.length === 0) {
    return diagnostics
  }
  const cssText = getTemplateCssText(context)
  const ruleBodies = findRuleBodies(cssText)
  return diagnostics.filter((diagnostic) => {
    if (diagnostic.code !== EMPTY_RULESET_DIAGNOSTIC_CODE) {
      return true
    }
    const selectorSpan = fromVirtualDocSpan(virtualDocumentProvider, diagnostic.range, lineMap)
    const body = selectorSpan && findNextRuleBody(ruleBodies, selectorSpan.end)
    if (!body) {
      return true
    }
    return !containsInterpolation(body, interpolationSpans)
  })
}

function getInterpolationSpans(
  typescript: typeof ts,
  context: TemplateContext,
): readonly TemplateSpan[] {
  const { node } = context
  if (!typescript.isTemplateExpression(node)) {
    return []
  }
  const templateStart = node.getStart() + 1
  let start = node.head.end - templateStart - 2
  return node.templateSpans.map(({ literal }) => {
    const end = literal.getStart() - templateStart + 1
    const span = { end, start }
    start = literal.getEnd() - templateStart - 2
    return span
  })
}

function findRuleBodies(text: string): readonly RuleBody[] {
  const state = createCssCodeScanState()
  const bodies: OpenRuleBody[] = []
  const openBodies: OpenRuleBody[] = []
  for (let index = 0; index < text.length;) {
    const end = nonCodeEnd(text, index, state)
    if (end !== -1) {
      index = end
      continue
    }
    const character = text[index]
    if (!state.url) {
      if (character === '{') {
        const body = { start: index + 1 }
        bodies.push(body)
        openBodies.push(body)
      } else if (character === '}') {
        const body = openBodies.pop()
        if (body) {
          body.end = index
        }
      }
    }
    index++
  }
  for (const body of openBodies) {
    body.end = text.length
  }
  return bodies.filter((body): body is RuleBody => body.end !== undefined)
}

function findNextRuleBody(bodies: readonly RuleBody[], selectorEnd: number): RuleBody | undefined {
  let low = 0
  let high = bodies.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (bodies[middle].start <= selectorEnd) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return bodies[low]
}

function containsInterpolation(
  body: RuleBody,
  interpolationSpans: readonly TemplateSpan[],
): boolean {
  let low = 0
  let high = interpolationSpans.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (interpolationSpans[middle].start < body.start) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  const interpolation = interpolationSpans[low]
  return interpolation !== undefined && interpolation.end <= body.end
}

/**
 * The stray closing brace (docs/architecture.md, "Diagnostics"): the first "}" in the template's CSS
 * text with no matching opener, read with the boundary scanner, or undefined when every "}" is
 * matched.
 */
function findStrayClosingBraceOffset(text: string): number | undefined {
  let depth = 0
  const state = createCssCodeScanState()
  for (let index = 0; index < text.length;) {
    const end = nonCodeEnd(text, index, state)
    if (end !== -1) {
      index = end
      continue
    }
    const character = text[index]
    if (state.url) {
      index++
      continue
    }
    if (character === '{') {
      depth++
    } else if (character === '}') {
      depth--
      if (depth < 0) {
        return index
      }
    }
    index++
  }
  return undefined
}

/** Same code, message, and range: one diagnostic under both readings of a single-identifier fragment. */
function isSameDiagnostic(left: Diagnostic, right: Diagnostic): boolean {
  return (
    left.code === right.code &&
    left.message === right.message &&
    left.range.start.line === right.range.start.line &&
    left.range.start.character === right.range.start.character &&
    left.range.end.line === right.range.end.line &&
    left.range.end.character === right.range.end.character
  )
}

function translateSeverity(
  typescript: typeof ts,
  severity: DiagnosticSeverity | undefined,
): ts.DiagnosticCategory {
  switch (severity) {
    case DiagnosticSeverity.Information:
    case DiagnosticSeverity.Hint:
      return typescript.DiagnosticCategory.Message
    case DiagnosticSeverity.Warning:
      return typescript.DiagnosticCategory.Warning
    case DiagnosticSeverity.Error:
    default:
      return typescript.DiagnosticCategory.Error
  }
}

interface ValidationCacheEntry {
  readonly diagnostics: readonly Diagnostic[]
  /** The flattened key this entry was stored under, so a recency touch re-inserts under it rather than under the lookup key. */
  readonly key: string
  readonly sizeBytes: number
}

/**
 * Least-recently-used cache of raw vscode diagnostics (never translated ts.Diagnostics, which hold
 * a `file: SourceFile` and must not outlive the request that produced them) keyed by a template's
 * reading key plus its own raw, unsubstituted text (docs/architecture.md, Caching). A hit skips
 * both the parse and the validation. Bounded by both MAX_VALIDATION_CACHE_ENTRIES and
 * MAX_VALIDATION_CACHE_BYTES, whichever binds first; a single entry estimated larger than
 * MAX_VALIDATION_CACHE_BYTES is never cached, since no eviction could ever make room for it.
 */
export class RawValidationCache {
  private readonly entries = new Map<string, ValidationCacheEntry>()
  private totalBytes = 0

  /** The cached result for `rawKey`, now the most recently used, or undefined on a miss. */
  public peek(rawKey: string): readonly Diagnostic[] | undefined {
    const cached = this.entries.get(rawKey)
    if (!cached) {
      return undefined
    }
    this.entries.delete(cached.key)
    this.entries.set(cached.key, cached)
    return cached.diagnostics
  }

  /**
   * Stores a freshly computed result for `rawKey`, evicting the least recently used entries first
   * until the new entry fits under both caps. Rejects (without evicting anything) an entry whose
   * own estimated size already exceeds MAX_VALIDATION_CACHE_BYTES.
   */
  public set(rawKey: string, diagnostics: readonly Diagnostic[]): void {
    const key = flattenCacheKey(rawKey)
    const sizeBytes = estimateEntryBytes(key, diagnostics)
    if (sizeBytes > MAX_VALIDATION_CACHE_BYTES) {
      return
    }

    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.totalBytes -= previous.sizeBytes
    }

    for (const [oldestKey, oldestEntry] of this.entries) {
      if (!this.exceedsCaps(sizeBytes)) {
        break
      }
      this.entries.delete(oldestKey)
      this.totalBytes -= oldestEntry.sizeBytes
    }

    this.entries.set(key, { diagnostics, key, sizeBytes })
    this.totalBytes += sizeBytes
  }

  public clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }

  private exceedsCaps(incomingSizeBytes: number): boolean {
    return (
      this.entries.size >= MAX_VALIDATION_CACHE_ENTRIES ||
      this.totalBytes + incomingSizeBytes > MAX_VALIDATION_CACHE_BYTES
    )
  }
}

/**
 * Estimates an entry's retained bytes as the key length plus, per diagnostic, its message length,
 * both counted as UTF-16 code units times 2 bytes, plus the fixed per-diagnostic overhead
 * (VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES). An estimate, not an exact accounting: close enough
 * to keep RawValidationCache's total retained size within a low single-digit-megabyte budget
 * regardless of how many diagnostics one template produces.
 */
function estimateEntryBytes(key: string, diagnostics: readonly Diagnostic[]): number {
  let sizeBytes = key.length * 2
  for (const diagnostic of diagnostics) {
    sizeBytes += diagnostic.message.length * 2 + VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES
  }
  return sizeBytes
}

/**
 * A copy of `key` that references none of the open file's text (docs/architecture.md, Caching, for
 * the measurement behind this defensive step): `key` is built from `context.rawText`, a slice of the
 * whole file, and V8 represents a slice of a long string as a view into its parent. Slicing the
 * leading character back off a concatenation makes V8 flatten that concatenation into a new string
 * first, so the result is at most a view into that fresh copy, one character longer than `key`,
 * never into the file. Pure UTF-16 code-unit concatenation, unlike a UTF-8 round trip, needs no
 * Node-only `Buffer` (this file is reachable from `./api`) and never rewrites an unpaired surrogate
 * to U+FFFD, so two templates that differ only in one keep distinct keys.
 */
function flattenCacheKey(key: string): string {
  return (' ' + key).slice(1)
}

/**
 * Length-prefixes the reading key so two different (reading key, rawText) pairs never concatenate
 * to the same key: plain concatenation collides whenever one reading key is a prefix of another's
 * own text plus its rawText ("a" with "bc" and "ab" with "c" both read "abc"). The decimal digits
 * before the first ":" say exactly how many characters that follow belong to the reading key, and
 * a decimal length never contains ":".
 */
export function buildValidationCacheKey(readingKey: string, rawText: string): string {
  return `${readingKey.length}:${readingKey}${rawText}`
}
