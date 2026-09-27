import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import { LINE_SEPARATOR_CODE, PARAGRAPH_SEPARATOR_CODE } from './css-code-scanner.ts'
import { type EscapeRun, getTemplateEscapeRuns } from './javascript-escapes.ts'
import type { VirtualDocumentProvider } from './styled-virtual-document-provider.ts'

interface TemplateEnd {
  readonly offset: number
  readonly position: ts.LineAndCharacter
}

/**
 * A template's line-start table, template end, and escape runs, all pure functions of the raw
 * template text: built once per document and threaded through every position a feature
 * translates (docs/architecture.md, "Virtual document", the line map).
 */
export interface TemplateLineMap {
  /** The template's JavaScript escape runs (getTemplateEscapeRuns), which mapped spans never split. */
  readonly escapeRuns: readonly EscapeRun[]
  readonly lineStarts: readonly number[]
  readonly templateEnd: TemplateEnd
}

/** Template-relative offsets [start, end). */
export interface TemplateSpan {
  readonly end: number
  readonly start: number
}

interface TemplateRange {
  readonly end: ts.LineAndCharacter
  readonly start: ts.LineAndCharacter
}

type VirtualPositionMapper = Pick<VirtualDocumentProvider, 'fromVirtualDocPosition'>

const lineMapByContext = new WeakMap<Pick<TemplateContext, 'rawText' | 'text'>, TemplateLineMap>()

const NO_ESCAPE_RUNS: readonly EscapeRun[] = []

/**
 * The TemplateLineMap of context.rawText and the escape runs of context.text, kept per context so
 * the document and every feature reading the same context share one line-start table. The escape
 * runs are read on first use and only when the raw text holds a backslash, since they need the
 * substituted text and a placeholder fill never holds a backslash.
 */
export function createTemplateLineMap(
  context: Pick<TemplateContext, 'rawText' | 'text'>,
): TemplateLineMap {
  const cached = lineMapByContext.get(context)
  if (cached !== undefined) {
    return cached
  }
  const lineStarts = computeLineStarts(context.rawText)
  let escapeRuns: readonly EscapeRun[] | undefined
  const lineMap: TemplateLineMap = {
    /**
     * Reads `context.text` of this closure's own context on first access, whichever later request
     * (a reused line map's own context included) triggers it first: safe only because a caller
     * that can reach a `TemplateLineMap` has always already read this same context's `.text` via
     * `createVirtualDocument` first (docs/architecture.md, "JavaScript escapes", Escape runs).
     */
    get escapeRuns() {
      escapeRuns ??= context.rawText.includes('\\')
        ? getTemplateEscapeRuns(context)
        : NO_ESCAPE_RUNS
      return escapeRuns
    },
    lineStarts,
    templateEnd: {
      offset: context.rawText.length,
      position: offsetToPosition(context.rawText.length, lineStarts),
    },
  }
  lineMapByContext.set(context, lineMap)
  return lineMap
}

/**
 * The position of an offset into a virtual document whose text is `wrapper` followed by the
 * template: an offset inside the wrapper's own (single) line resolves against it, and an offset
 * inside the closing "\n}" clamps to the template end.
 */
export function virtualOffsetToPosition(
  offset: number,
  wrapper: string,
  lineMap: TemplateLineMap,
): ts.LineAndCharacter {
  if (offset < wrapper.length) {
    return { line: 0, character: Math.max(offset, 0) }
  }
  const templateOffset = clamp(offset - wrapper.length, 0, lineMap.templateEnd.offset)
  const { line, character } = offsetToPosition(templateOffset, lineMap.lineStarts)
  return { line: line + 1, character }
}

/** The inverse of virtualOffsetToPosition, clamping the same way. */
export function virtualPositionToOffset(
  position: ts.LineAndCharacter,
  wrapper: string,
  lineMap: TemplateLineMap,
): number {
  if (position.line <= 0) {
    return clamp(position.character, 0, wrapper.length - 1)
  }
  return (
    wrapper.length +
    clampedTemplateOffset({ line: position.line - 1, character: position.character }, lineMap)
  )
}

/**
 * Resolves a virtual document position to a template-relative position for diagnostics, hover,
 * and folding: a position past the template end (the closing "\n}") clamps to the template end,
 * and one inside the opening wrapper is undefined.
 */
export function resolveTemplatePosition(
  provider: VirtualPositionMapper,
  position: ts.LineAndCharacter,
  lineMap: TemplateLineMap,
): ts.LineAndCharacter | undefined {
  const sourcePosition = provider.fromVirtualDocPosition(position)
  if (sourcePosition.line < 0) {
    return undefined
  }
  return isAfter(sourcePosition, lineMap.templateEnd.position)
    ? lineMap.templateEnd.position
    : sourcePosition
}

/**
 * Resolves a virtual document position to a template-relative position for code-fix edits,
 * undefined for any position outside the template body. A position is outside exactly when it does
 * not round-trip through the line-start table unchanged: its character is past the end of its line
 * (spilling into where the next line's offsets live), or its line is past the template's last line.
 */
export function resolveTemplatePositionStrict(
  provider: VirtualPositionMapper,
  position: ts.LineAndCharacter,
  lineMap: TemplateLineMap,
): ts.LineAndCharacter | undefined {
  const sourcePosition = provider.fromVirtualDocPosition(position)
  if (sourcePosition.line < 0) {
    return undefined
  }
  const offset = positionToOffset(sourcePosition, lineMap.lineStarts)
  return offset >= 0 &&
    offset <= lineMap.templateEnd.offset &&
    positionsEqual(sourcePosition, offsetToPosition(offset, lineMap.lineStarts))
    ? sourcePosition
    : undefined
}

/**
 * Resolves a virtual document range to template offsets the way resolveTemplatePosition resolves
 * each end, widened to whole escape runs (a diagnostic on `\x63olr` underlines all of it, not
 * `3olr`). Used for diagnostics, hover, and folding.
 */
export function fromVirtualDocSpan(
  provider: VirtualPositionMapper,
  range: TemplateRange,
  lineMap: TemplateLineMap,
): TemplateSpan | undefined {
  const start = resolveTemplatePosition(provider, range.start, lineMap)
  const end = resolveTemplatePosition(provider, range.end, lineMap)
  if (!start || !end) {
    return undefined
  }
  return widenToEscapeRuns(
    positionToOffset(start, lineMap.lineStarts),
    positionToOffset(end, lineMap.lineStarts),
    lineMap.escapeRuns,
  )
}

/**
 * Resolves a code-fix edit range to template offsets the way resolveTemplatePositionStrict
 * resolves each end, undefined when it overlaps an escape run (or, when empty, sits inside one):
 * the edit's text is written for the stand-in, so applied to the escape as written it would
 * corrupt it (`\x63olr` renamed to `color` edits `3olr` into `\x6color`).
 */
export function fromVirtualDocSpanStrict(
  provider: VirtualPositionMapper,
  range: TemplateRange,
  lineMap: TemplateLineMap,
): TemplateSpan | undefined {
  const startPosition = resolveTemplatePositionStrict(provider, range.start, lineMap)
  const endPosition = resolveTemplatePositionStrict(provider, range.end, lineMap)
  if (!startPosition || !endPosition) {
    return undefined
  }
  const start = positionToOffset(startPosition, lineMap.lineStarts)
  const end = positionToOffset(endPosition, lineMap.lineStarts)
  const run = findFirstRunEndingAfter(start, lineMap.escapeRuns)
  return run && run.start < end ? undefined : { end, start }
}

/** Widens template offsets [start, end) so neither lies strictly inside an escape run. */
export function widenToEscapeRuns(
  start: number,
  end: number,
  escapeRuns: readonly EscapeRun[],
): TemplateSpan {
  const startRun = findFirstRunEndingAfter(start, escapeRuns)
  const endRun = findFirstRunEndingAfter(end, escapeRuns)
  return {
    end: endRun && endRun.start < end ? endRun.end : end,
    start: startRun && startRun.start < start ? startRun.start : start,
  }
}

/** Binary search for the first run whose end is past `offset`, the only run that can hold it. */
function findFirstRunEndingAfter(
  offset: number,
  escapeRuns: readonly EscapeRun[],
): EscapeRun | undefined {
  let low = 0
  let high = escapeRuns.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (escapeRuns[mid].end > offset) {
      high = mid
    } else {
      low = mid + 1
    }
  }
  return escapeRuns[low]
}

/**
 * A template-relative offset as a template-relative position, clamped into the template, for a
 * feature that maps toward the virtual document without TemplateContext.toPosition.
 */
export function templateOffsetToPosition(
  offset: number,
  lineMap: TemplateLineMap,
): ts.LineAndCharacter {
  return offsetToPosition(clamp(offset, 0, lineMap.templateEnd.offset), lineMap.lineStarts)
}

/** The offset of a template-relative position, clamped into [template start, template end]. */
function clampedTemplateOffset(position: ts.LineAndCharacter, lineMap: TemplateLineMap): number {
  const { lineStarts, templateEnd } = lineMap
  if (isAfter(position, templateEnd.position)) {
    return templateEnd.offset
  }
  return clamp(positionToOffset(position, lineStarts), 0, templateEnd.offset)
}

/**
 * Line starts matching TypeScript's own line-terminator rules (docs/tsserver-host.md): "\r\n", a
 * lone "\n", a lone "\r", U+2028, and U+2029 each start a new line. Implemented here because the
 * host's computeLineStarts is not part of its public, typed surface on every supported version.
 */
function computeLineStarts(text: string): number[] {
  const lineStarts = [0]
  let position = 0
  while (position < text.length) {
    const charCode = text.charCodeAt(position)
    position++
    if (charCode === CARRIAGE_RETURN_CODE) {
      if (text.charCodeAt(position) === LINE_FEED_CODE) {
        position++
      }
      lineStarts.push(position)
    } else if (
      charCode === LINE_FEED_CODE ||
      charCode === LINE_SEPARATOR_CODE ||
      charCode === PARAGRAPH_SEPARATOR_CODE
    ) {
      lineStarts.push(position)
    }
  }
  return lineStarts
}

const CARRIAGE_RETURN_CODE = 0x0d
const LINE_FEED_CODE = 0x0a

function offsetToPosition(offset: number, lineStarts: readonly number[]): ts.LineAndCharacter {
  const line = findLine(offset, lineStarts)
  return { line, character: offset - lineStarts[line] }
}

function positionToOffset(position: ts.LineAndCharacter, lineStarts: readonly number[]): number {
  return lineStarts[clamp(position.line, 0, lineStarts.length - 1)] + position.character
}

/** Binary search for the last line whose start is at or before the offset. */
function findLine(offset: number, lineStarts: readonly number[]): number {
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (lineStarts[mid] <= offset) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  return low
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isAfter(left: ts.LineAndCharacter, right: ts.LineAndCharacter): boolean {
  return left.line > right.line || (left.line === right.line && left.character > right.character)
}

export function positionsEqual(left: ts.LineAndCharacter, right: ts.LineAndCharacter): boolean {
  return left.line === right.line && left.character === right.character
}
