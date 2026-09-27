// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import {
  createCodeLookback,
  findNonCodeRuns,
  INSIDE_NON_CODE,
  isLineTerminator,
  isNameCharacter,
  isStatementBoundary,
  isWhitespace,
  LINE_SEPARATOR,
  NO_SIGNIFICANT_CHARACTER,
  type NonCodeRuns,
  PARAGRAPH_SEPARATOR,
  type PreviousSignificant,
} from '../virtual-document/css-code-scanner.ts'
import { replaceJavaScriptEscapes } from '../virtual-document/javascript-escapes.ts'

interface SubstitutionSpan {
  readonly end: number
  readonly start: number
}

export function getTemplateSubstitutions(
  templateText: string,
  substitutionSpans: ReadonlyArray<SubstitutionSpan>,
): string {
  const spans = normalizeSpans(templateText.length, substitutionSpans)
  if (spans.length === 0) {
    return templateText
  }

  const substitutedParts: string[] = []
  /**
   * Every decision below reads the masked text with JavaScript escapes replaced, the characters
   * styled-components receives (docs/architecture.md, Virtual document); the output keeps the
   * raw text between placeholders, which the virtual document replaces the same way.
   */
  const { nonCodeRuns, solidSpans, text: syntaxText } = buildSyntaxText(templateText, spans)
  const boundaryScanner = createSyntaxBoundaryScanner(syntaxText, nonCodeRuns)
  const codeLookback = createCodeLookback(syntaxText, 0)
  const findLineConditionKeyword = createConditionKeywordFinder(syntaxText)
  const findStatementConditionKeyword = createConditionKeywordFinder(syntaxText)
  const scanState = createScanState(syntaxText, nonCodeRuns)
  let lastSpanStart = 0
  let lastOffset = 0
  let previousAtStatementBoundary = false

  for (let spanIndex = 0; spanIndex < spans.length; spanIndex++) {
    const span = spans[spanIndex]
    substitutedParts.push(templateText.slice(lastOffset, span.start))
    if (solidSpans?.[spanIndex]) {
      substitutedParts.push(SOLID_FILL.repeat(span.end - span.start))
      previousAtStatementBoundary = false
      lastSpanStart = span.start
      lastOffset = span.end
      continue
    }
    advanceScanState(scanState, syntaxText, span.start)
    const onlyWhitespaceSinceLineStart = !scanState.sawNonWhitespace
    const previousSignificantOffset = codeLookback.previousSignificant(span.start)
    /**
     * Only whitespace and comments separate this placeholder from the previous one when the
     * nearest significant character before it lies inside the previous placeholder's own span,
     * whose masked filler is code. An empty span, or one inside a comment or string, holds no such
     * character, so the answer then comes from the real character before it.
     */
    const followsPreviousPlaceholder =
      previousSignificantOffset >= lastSpanStart && previousSignificantOffset < lastOffset
    const followsBoundaryCharacter =
      previousSignificantOffset === NO_SIGNIFICANT_CHARACTER ||
      (previousSignificantOffset !== INSIDE_NON_CODE &&
        isStatementBoundary(syntaxText[previousSignificantOffset]))
    const followsStatementBoundary: boolean = followsPreviousPlaceholder
      ? previousAtStatementBoundary
      : followsBoundaryCharacter
    const statementStart = scanState.boundaryOffset + 1
    const syntaxTextSinceBoundary = syntaxText.slice(statementStart, span.start)
    const conditionKeyword =
      findLineConditionKeyword(statementStart) ??
      findStatementConditionKeyword(scanState.statementBoundaryOffset + 1)
    advanceScanState(scanState, syntaxText, span.end)

    const nextSignificantOffset = boundaryScanner.nextNonWhitespace(span.end)
    const nextSignificant = syntaxText[nextSignificantOffset]
    const nameEnd = boundaryScanner.identifierEnd(span.end)
    const characterBefore = syntaxText[span.start - 1]
    const isJoinedToName = nameEnd > span.end || isNameCharacter(characterBefore)
    const { isPropertyNamePosition, isSelectorPosition } = classifyPlaceholderPosition(
      boundaryScanner,
      nameEnd > span.end
        ? boundaryScanner.nextNonWhitespaceAfterName(nameEnd)
        : nextSignificantOffset,
    )
    const atStatementBoundary: boolean =
      followsStatementBoundary && !STATEMENT_SLOT_EXCLUDED_NEXT.has(nextSignificant ?? '')
    const gapStart = skipWhitespaceBackward(syntaxText, span.start, lastOffset)

    substitutedParts.push(
      getSubstitution({
        atRuleCondition: conditionKeyword
          ? getAtRuleConditionShape(syntaxText, conditionKeyword, {
              nextSignificant: nextSignificantOffset,
              previousSignificant: previousSignificantOffset,
              start: span.start,
            })
          : undefined,
        atStatementBoundary,
        characterAfter: syntaxText[span.end],
        followsHash: gapStart > lastOffset && syntaxText[gapStart - 1] === '#',
        followsStatementBoundary,
        isJoinedToName,
        isJoinedToSelectorName: isJoinedToName || SELECTOR_NAME_PREFIXES.has(characterBefore ?? ''),
        isPropertyNamePosition,
        isSelectorPosition,
        nextSignificant,
        onlyWhitespaceSinceLineStart,
        placeholderText: templateText.slice(span.start, span.end),
        syntaxTextSinceBoundary,
      }),
    )
    previousAtStatementBoundary = atStatementBoundary
    lastSpanStart = span.start
    lastOffset = span.end
  }
  substitutedParts.push(templateText.slice(lastOffset))
  return substitutedParts.join('')
}

/**
 * Answers, for the syntax-masked text after a placeholder, the questions the statement rule and
 * the property-name and selector branches of getSubstitution ask: where the nearest non-whitespace
 * character after it is, where the name it is joined to ends, and where the next "{", "&", ";",
 * "}", or line terminator at code after it is (the code stops). Each query scans lazily rather than
 * over the whole text up front, and total work stays linear in the text length for any number of
 * placeholders because each query kind remembers its last range: a later query starting inside that
 * range reuses the answer instead of rescanning it, which covers many placeholders followed by ":"
 * on one long line with no "{", many adjacent placeholders forming one name, and many placeholders
 * sharing the same run of whitespace. The nearest significant character before a placeholder comes
 * from a CodeLookback instead. The three non-whitespace queries skip whole comment runs (never
 * strings or unquoted url() arguments, which are significant content), so a comment between a
 * placeholder and the character that decides its role (`${Child} /* note *\/ { color: red; }`,
 * `${p} /* note *\/: red;`) never hides that character.
 */
interface SyntaxBoundaryScanner {
  /** The end of the run of name characters starting at `from` (masked placeholders count). */
  identifierEnd(from: number): number
  nextNonWhitespace(from: number): number
  /** nextNonWhitespace for the end of a name, with its own remembered range. */
  nextNonWhitespaceAfterName(from: number): number
  /** nextNonWhitespace for a line terminator nextSpecial found, with its own remembered range. */
  nextNonWhitespaceAfterLine(from: number): number
  nextSpecial(from: number): CodeStop
  /**
   * nextSpecial for the lines after a selector line ending in ",", which keeps going past each
   * further line ending in ",".
   */
  nextSpecialInList(from: number): CodeStop
  readonly text: string
}

function createSyntaxBoundaryScanner(text: string, runs: NonCodeRuns): SyntaxBoundaryScanner {
  return {
    identifierEnd: createRunScanner(text, (character) => !isNameCharacter(character)),
    nextNonWhitespace: createNonWhitespaceScanner(text, runs),
    nextNonWhitespaceAfterLine: createNonWhitespaceScanner(text, runs),
    nextNonWhitespaceAfterName: createNonWhitespaceScanner(text, runs),
    nextSpecial: createCodeStopScanner(text, runs),
    nextSpecialInList: createListContinuationScanner(createCodeStopScanner(text, runs)),
    text,
  }
}

/**
 * A character that ends the search for a selector's "{" or "&" after a placeholder's ":": that
 * "{" or "&" itself, a line terminator, or a ";" or "}", which ends the statement the ":" is in, so
 * a "{" or "&" after it belongs to a later statement (`padding-${s}: 0; &:hover {`).
 */
function isSelectorScanStop(character: string): boolean {
  return (
    character === '{' ||
    character === '&' ||
    isStatementBoundary(character) ||
    isLineTerminator(character)
  )
}

interface CodeStop {
  /**
   * True when the stop is a line terminator ending a line whose last code character is ",", so a
   * selector list continues past it. Both halves of a CRLF carry the same answer.
   */
  readonly endsListLine: boolean
  /** The stop's offset, or the text length when none follows. */
  readonly offset: number
}

const NO_CODE_STOP: CodeStop = { endsListLine: false, offset: -1 }

/**
 * nextSpecial: the first selector scan stop at code at or after `from`, read character by
 * character, stepping over each non-code run a stop falls in (a text of plain code has none).
 * Every position in [from, answer) is no code stop, so a later query starting inside that range
 * has the same answer: the query remembers it. Any other query starts past the last answer, since
 * each placeholder lies past the previous one, so the index of the next run only moves forward.
 */
function createCodeStopScanner(text: string, runs: NonCodeRuns): (from: number) => CodeStop {
  const { ends, starts } = runs
  let run = 0
  let queryFrom = -1
  let found = NO_CODE_STOP
  return (from) => {
    if (from >= queryFrom && from <= found.offset) {
      return found
    }
    let offset = from
    for (;;) {
      while (offset < text.length && !isSelectorScanStop(text[offset])) {
        offset++
      }
      while (run < ends.length && ends[run] <= offset) {
        run++
      }
      if (run === ends.length || starts[run] > offset) {
        break
      }
      offset = ends[run]
    }
    queryFrom = from
    found = {
      endsListLine:
        isLineTerminator(text[offset]) && lineEndsWithComma(text, offset, runs, run - 1),
      offset,
    }
    return found
  }
}

/**
 * True when the line ending at the line terminator at `lineBreak`, at code, has "," as its last
 * code character. Reads back over that one line's trailing whitespace and comments only (the "\r"
 * of a CRLF included), so a blank line ends a list and each line is read once. A string, escape,
 * or url() argument there is a significant character other than ",". `lastRun` is the index of the
 * last run that starts before `lineBreak`, or -1.
 */
function lineEndsWithComma(
  text: string,
  lineBreak: number,
  runs: NonCodeRuns,
  lastRun: number,
): boolean {
  const { ends, isComment, starts } = runs
  let index = lineBreak - 1
  if (text[lineBreak] === '\n' && text[index] === '\r') {
    index--
  }
  let run = lastRun
  while (index >= 0) {
    if (run >= 0 && ends[run] > index) {
      if (!isComment[run]) {
        return false
      }
      index = starts[run] - 1
      run--
      continue
    }
    const character = text[index]
    if (isLineTerminator(character) || !isWhitespace(character)) {
      return character === ','
    }
    index--
  }
  return false
}

/**
 * Returns nextSpecialInList over its own stop scanner. Every line terminator it steps past ends a
 * line whose last code character is ",", and every other position it steps past is no stop, so a
 * later query starting inside the range of the last answer has that same answer: the query
 * remembers it, which keeps a long selector list with a placeholder on every line linear.
 */
function createListContinuationScanner(
  nextStop: (from: number) => CodeStop,
): (from: number) => CodeStop {
  let queryFrom = -1
  let found = NO_CODE_STOP
  return (from) => {
    if (from >= queryFrom && from <= found.offset) {
      return found
    }
    let stop = nextStop(from)
    while (stop.endsListLine) {
      stop = nextStop(stop.offset + 1)
    }
    queryFrom = from
    found = stop
    return stop
  }
}

/**
 * Returns a query for the first offset at or after `from` whose character satisfies `isStop` (the
 * text length when none does). Every character in [from, answer) fails `isStop`, so the answer for
 * any later query starting inside that range is the same: the query remembers its last range and
 * answers such a query without scanning.
 */
function createRunScanner(
  text: string,
  isStop: (character: string) => boolean,
): (from: number) => number {
  let queryFrom = -1
  let found = -1
  return (from) => {
    if (from >= queryFrom && from <= found) {
      return found
    }
    let index = from
    while (index < text.length && !isStop(text[index])) {
      index++
    }
    queryFrom = from
    found = index
    return index
  }
}

/**
 * createRunScanner for the nearest non-whitespace character, with every whole comment run in its
 * way stepped over (never a string or unquoted url() argument, whose first character is already
 * non-whitespace and stops the scan there, significant content). Built on the same plain scanner a
 * template with no non-code run returns outright, so a template with no comment takes the same path
 * as before and pays nothing new. Runs of a comment-free stretch cost the plain scanner's one search;
 * a run only makes the query loop once more per comment it steps over, and the shared run index only
 * moves forward, so total work across every placeholder's queries stays linear in the text length.
 */
function createNonWhitespaceScanner(text: string, runs: NonCodeRuns): (from: number) => number {
  const plainScan = createRunScanner(text, (character) => !isWhitespace(character))
  if (runs.starts.length === 0) {
    return plainScan
  }
  const { ends, isComment, starts } = runs
  let run = 0
  let queryFrom = -1
  let found = -1
  return (from) => {
    if (from >= queryFrom && from <= found) {
      return found
    }
    let offset = from
    for (;;) {
      offset = plainScan(offset)
      while (run < ends.length && ends[run] <= offset) {
        run++
      }
      if (run === ends.length || starts[run] > offset) {
        break
      }
      if (!isComment[run]) {
        break
      }
      offset = ends[run]
    }
    queryFrom = from
    found = offset
    return offset
  }
}

/** The solid fill's one character (docs/architecture.md, substitution invariants). */
const SOLID_FILL = 'x'

interface SyntaxText {
  readonly nonCodeRuns: NonCodeRuns
  /** Indexed like the spans: true for a placeholder that takes the solid fill. Undefined when none does. */
  readonly solidSpans: readonly boolean[] | undefined
  readonly text: string
}

/**
 * The masked text with JavaScript escapes replaced, its non-code runs, and which placeholders take
 * the solid fill (docs/architecture.md, substitution invariants). Every placeholder is masked as
 * "x" over its whole length, so the text before a placeholder, which alone decides whether the
 * placeholder starts inside a run, is already final when the runs are found: one build, one pass.
 */
function buildSyntaxText(templateText: string, spans: ReadonlyArray<SubstitutionSpan>): SyntaxText {
  const text = replaceJavaScriptEscapes(maskSubstitutions(templateText, spans))
  const nonCodeRuns = findNonCodeRuns(text)
  return { nonCodeRuns, solidSpans: findSolidSpans(text, nonCodeRuns, spans), text }
}

/**
 * Which spans start inside a comment, string, or unquoted url() argument run of `text`, not an
 * escape: a run starting with a backslash, whose escape may take the placeholder's first character
 * (an unquoted url() argument whose function name starts with an escape, `\75 rl(`, starts with one
 * too). Spans and runs both ascend, so the run index only moves forward. Undefined when no span
 * does.
 */
function findSolidSpans(
  text: string,
  { ends, starts }: NonCodeRuns,
  spans: ReadonlyArray<SubstitutionSpan>,
): readonly boolean[] | undefined {
  let solidSpans: boolean[] | undefined
  let run = 0
  for (let index = 0; index < spans.length && run < ends.length; index++) {
    const { start } = spans[index]
    while (run < ends.length && ends[run] <= start) {
      run++
    }
    if (run < ends.length && starts[run] <= start && text[starts[run]] !== '\\') {
      solidSpans ??= []
      solidSpans[index] = true
    }
  }
  return solidSpans
}

/**
 * Property-name position is a ":" at `colonPosition` without the selector shape; selector position
 * is a ":" with it: starting at least one character after that ":", the nearest stop at code
 * (createCodeStopScanner) is a "{" or "&", not a ";" or "}" that ends the statement first
 * (`padding-${s}: 0; &:hover {`), with the line-break cases below. `colonPosition` is the first
 * non-whitespace offset after the placeholder, or after the rest of the name it is joined to
 * (`padding-${side}-top:`), computed once per placeholder by the caller.
 */
function classifyPlaceholderPosition(
  scanner: SyntaxBoundaryScanner,
  colonPosition: number,
): { isPropertyNamePosition: boolean; isSelectorPosition: boolean } {
  const { text } = scanner
  if (text[colonPosition] !== ':') {
    return { isPropertyNamePosition: false, isSelectorPosition: false }
  }

  /** A line terminator right after the ":" makes a property name. */
  const afterColon = colonPosition + 1
  if (isLineTerminator(text[afterColon])) {
    return { isPropertyNamePosition: true, isSelectorPosition: false }
  }

  /**
   * A rule body may also open on a later line, with only whitespace before its "{" there
   * (`${B}:not(:last-child)` then `{` on the next line); a declaration's next line never starts
   * with "{". A line ending in "," continues a selector list on the next line (`${C}:hover,` then
   * `${C}:focus {`), where a ";" or "}" before any "{" or "&" marks a declaration value instead
   * (`${prop}: a,` then `b;`).
   */
  const firstStop = scanner.nextSpecial(afterColon + 1)
  const stop = firstStop.endsListLine ? scanner.nextSpecialInList(firstStop.offset + 1) : firstStop
  const special = text[stop.offset]
  const isSelectorPosition =
    special === '{' ||
    special === '&' ||
    (isLineTerminator(special) && text[scanner.nextNonWhitespaceAfterLine(stop.offset)] === '{')
  return { isPropertyNamePosition: !isSelectorPosition, isSelectorPosition }
}

/**
 * State threaded left to right across every placeholder in one pass, so a placeholder's decisions
 * never redo work proportional to its line length (docs/architecture.md, substitution invariants):
 * `sawNonWhitespace` is whether a non-whitespace character has appeared on the current line;
 * `boundaryOffset` is the offset of the most recent ";", "{", or "}" at code on the current line,
 * or of the line terminator that starts the line (-1 on the first line); `statementBoundaryOffset`
 * is the offset of the most recent ";", "{", or "}" at code on any line, or -1. A line terminator
 * or non-whitespace character inside a comment or string still counts for the line facts.
 */
interface ScanState {
  boundaryOffset: number
  cursor: number
  /** The first non-whitespace character at or after an offset. */
  readonly nextNonWhitespace: (from: number) => number
  /** The first line terminator, or ";", "{", or "}" at code, at or after an offset. */
  readonly nextStop: (from: number) => number
  sawNonWhitespace: boolean
  statementBoundaryOffset: number
}

const LINE_TERMINATOR_CLASS = `\\n\\r${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`
const LINE_OR_STATEMENT_BOUNDARY_PATTERN = new RegExp(`[${LINE_TERMINATOR_CLASS};{}]`, 'g')
const LINE_TERMINATOR_PATTERN = new RegExp(`[${LINE_TERMINATOR_CLASS}]`, 'g')
const NON_WHITESPACE_PATTERN = /\S/g

function createScanState(text: string, runs: NonCodeRuns): ScanState {
  const nextLineOrBoundary = createCharacterSearch(text, LINE_OR_STATEMENT_BOUNDARY_PATTERN)
  return {
    boundaryOffset: -1,
    cursor: 0,
    nextNonWhitespace: createCharacterSearch(text, NON_WHITESPACE_PATTERN),
    nextStop:
      runs.starts.length === 0
        ? nextLineOrBoundary
        : createLineOrCodeBoundarySearch(text, runs, nextLineOrBoundary),
    sawNonWhitespace: false,
    statementBoundaryOffset: -1,
  }
}

/**
 * Returns a query for the first offset at or after `from` where `pattern`, a global pattern that
 * matches one UTF-16 code unit, matches (the text length when none does). The query remembers its
 * last range, as createRunScanner does, so queries at increasing offsets read the text once.
 */
function createCharacterSearch(text: string, pattern: RegExp): (from: number) => number {
  const search = new RegExp(pattern)
  let queryFrom = -1
  let found = -1
  return (from) => {
    if (from >= queryFrom && from <= found) {
      return found
    }
    search.lastIndex = from
    queryFrom = from
    found = search.test(text) ? search.lastIndex - 1 : text.length
    return found
  }
}

/**
 * Returns a query for the first line terminator, anywhere, or ";", "{", or "}" at code, at or after
 * `from`, for a text with non-code runs. A boundary inside a run gives way to the next line
 * terminator inside that run, if any, and otherwise to the search past the run, so each run is
 * stepped over once rather than boundary by boundary. It remembers its last range, as
 * createRunScanner does; any other query starts past the last answer, so the index of the next run
 * only moves forward.
 */
function createLineOrCodeBoundarySearch(
  text: string,
  runs: NonCodeRuns,
  nextLineOrBoundary: (from: number) => number,
): (from: number) => number {
  const { ends, starts } = runs
  const nextLineTerminator = createCharacterSearch(text, LINE_TERMINATOR_PATTERN)
  let run = 0
  let queryFrom = -1
  let found = -1
  return (from) => {
    if (from >= queryFrom && from <= found) {
      return found
    }
    let offset = nextLineOrBoundary(from)
    while (offset < text.length && !isLineTerminator(text[offset])) {
      while (run < ends.length && ends[run] <= offset) {
        run++
      }
      if (run === ends.length || starts[run] > offset) {
        break
      }
      const lineTerminator = nextLineTerminator(offset + 1)
      if (lineTerminator < ends[run]) {
        offset = lineTerminator
        break
      }
      offset = nextLineOrBoundary(ends[run])
    }
    queryFrom = from
    found = offset
    return offset
  }
}

/**
 * A next non-whitespace character that keeps a placeholder after a statement boundary out of block
 * position: it opens a rule body, follows a property name, continues a selector list, continues
 * a compound or complex selector the placeholder is part of (for example `${Child}.active {`), or
 * makes the placeholder a percentage (a keyframe selector such as `${step}% {`).
 */
const STATEMENT_SLOT_EXCLUDED_NEXT: ReadonlySet<string> = new Set([
  '#',
  '%',
  '&',
  '*',
  '+',
  ',',
  '.',
  ':',
  '>',
  '[',
  '{',
  '~',
])

/**
 * A next non-whitespace character that keeps a placeholder alone on its line out of block
 * position: it opens a rule body, follows a property name, continues a list of values, or makes
 * the placeholder a percentage.
 */
const LINE_SLOT_EXCLUDED_NEXT: ReadonlySet<string> = new Set(['%', ',', ':', '{'])

/**
 * Advances `state.cursor` from where the previous call left it up to `to`, jumping from one stop
 * (a line terminator, or a ";", "{", or "}" at code) to the next and reading whether a stretch
 * between two holds non-whitespace with one search, not one character at a time. A placeholder's
 * own masked span is filler (never ";", "{", or "}"), so only the template's own characters count
 * as boundaries. A CRLF is one line terminator, at its "\n".
 */
function advanceScanState(state: ScanState, syntaxText: string, to: number) {
  let from = state.cursor
  while (from < to) {
    const stop = Math.min(state.nextStop(from), to)
    if (!state.sawNonWhitespace && stop > from) {
      state.sawNonWhitespace = state.nextNonWhitespace(from) < stop
    }
    if (stop === to) {
      from = to
      break
    }
    let index = stop
    if (syntaxText[index] === '\r' && syntaxText[index + 1] === '\n') {
      index++
    }
    if (isLineTerminator(syntaxText[index])) {
      state.sawNonWhitespace = false
    } else {
      state.statementBoundaryOffset = index
      state.sawNonWhitespace = true
    }
    state.boundaryOffset = index
    from = index + 1
  }
  state.cursor = from
}

function getSubstitution(context: {
  atRuleCondition: AtRuleConditionShape | undefined
  atStatementBoundary: boolean
  /** The masked character right after the placeholder. */
  characterAfter: string | undefined
  /** A "#" precedes the placeholder, past whitespace, with no other placeholder between. */
  followsHash: boolean
  followsStatementBoundary: boolean
  isJoinedToName: boolean
  isJoinedToSelectorName: boolean
  isPropertyNamePosition: boolean
  isSelectorPosition: boolean
  /** The masked non-whitespace character after the placeholder. */
  nextSignificant: string | undefined
  onlyWhitespaceSinceLineStart: boolean
  placeholderText: string
  syntaxTextSinceBoundary: string
}): string {
  const { placeholderText } = context
  const replacementCharacter = getReplacementCharacter(context)
  /** The fallback for a placeholder too short for its branch's fill. */
  const plainFill = () => fillPlaceholder(placeholderText, replacementCharacter)

  /**
   * Whole-declaration (mixin) placeholder followed by a semicolon, for example
   * `${'color: red'};`. Where the statement rule holds for what precedes it (a declaration
   * boundary past whitespace and comments, or a previous placeholder the statement rule placed in
   * block position), it becomes a dummy declaration ("$a:0" plus padding) so the SCSS parser does
   * not flag the semicolon as unexpected, or "a:0" when the placeholder is too short for "$a:0".
   * Otherwise there is nothing to anchor a dummy declaration to, so it is x-filled like an ordinary
   * value instead: a declaration missing its own semicolon ("color: red\n${'green'};"), or the last
   * line of a value split over lines ("border:\n  ${width}\n  ${style};").
   */
  if (replacementCharacter === ' ' && context.nextSignificant === ';') {
    if (context.followsStatementBoundary) {
      return (
        wrapPlaceholder(placeholderText, { open: '$a:0' }) ??
        wrapPlaceholder(placeholderText, { open: 'a:0' }) ??
        plainFill()
      )
    }
    return fillPlaceholder(placeholderText, 'x')
  }

  /**
   * Placeholder used as a property name, for example `${'color'}: red;`. Replaced with a fake
   * property ("$a" plus padding) so the parser accepts it as a declaration. Inside a custom
   * property's dashed name, for example `--${name}: 1px;`, the "--" prefix must stay intact, so it
   * is x-filled instead. Joined to other name characters, for example `padding-${side}: 0;` or
   * `${side}-top: 0;`, it becomes a Sass interpolation ("#{x}" plus padding), which the parser
   * reads as part of the one property name around it and never lints as an unknown property.
   */
  if (context.isPropertyNamePosition) {
    if (isCustomPropertyName(context.syntaxTextSinceBoundary)) {
      return fillPlaceholder(placeholderText, 'x')
    }
    if (context.isJoinedToName) {
      return (
        wrapPlaceholder(placeholderText, { close: '}', open: '#{x' }) ??
        fillPlaceholder(placeholderText, 'x')
      )
    }
    return wrapPlaceholder(placeholderText, { open: '$a', padding: 'x' }) ?? plainFill()
  }

  /**
   * Placeholder used as a selector or component reference, followed by a pseudo-class/element
   * and a rule body or parent-selector reference, for example `${FlipContainer}:hover & {`.
   * Replaced with "&" (the nesting parent selector) plus padding so the compound selector shape
   * survives. Joined to a name or its prefix, for example `&.${className}:hover {`, it is part of
   * that name instead, so it is x-filled.
   */
  if (context.isSelectorPosition) {
    return context.isJoinedToSelectorName
      ? fillPlaceholder(placeholderText, 'x')
      : (wrapPlaceholder(placeholderText, { open: '&' }) ?? plainFill())
  }

  /**
   * Placeholder standing for a condition in an `@media`, `@supports`, or `@container` prelude
   * (getAtRuleConditionShape), for example `@media screen and ${query} {`. Replaced with a
   * condition the parser accepts in that position: "(x" plus padding and ")" for a media or
   * container condition, "x(" plus padding and ")" for a supports condition, which the parser
   * reads as a function-shaped condition.
   */
  if (context.atRuleCondition === 'parenthesized') {
    return wrapPlaceholder(placeholderText, { close: ')', open: '(x' }) ?? plainFill()
  }
  if (context.atRuleCondition === 'function') {
    return wrapPlaceholder(placeholderText, { close: ')', open: 'x(' }) ?? plainFill()
  }

  /**
   * Placeholder used as a hex color value, right after "#", for example `color: #${1};`. Replaced
   * with "000" (a valid 3-digit hex color) plus padding.
   */
  if (context.followsHash) {
    return wrapPlaceholder(placeholderText, { open: HEX_FILL }) ?? plainFill()
  }

  /** Ordinary property value, for example `color: ${'red'};`. */
  return plainFill()
}

const HEX_FILL = '000'

function getReplacementCharacter(context: {
  atStatementBoundary: boolean
  characterAfter: string | undefined
  nextSignificant: string | undefined
  onlyWhitespaceSinceLineStart: boolean
}): ' ' | '0' | 'x' {
  /**
   * Block position (docs/architecture.md, substitution invariants) is shaped like a whole
   * declaration or mixin: after a statement boundary, for example `color: red; ${mixin}` or
   * `&:hover { ${mixin} }` (the statement rule, `atStatementBoundary`), or alone on its own line,
   * for example `${'color: red;'}` (the line rule).
   */
  if (
    context.atStatementBoundary ||
    (context.onlyWhitespaceSinceLineStart &&
      !LINE_SLOT_EXCLUDED_NEXT.has(context.nextSignificant ?? ''))
  ) {
    return ' '
  }

  /**
   * A numeric placeholder immediately before a "%" unit, for example `width: ${10}%;`, needs a
   * digit so the value still parses as a percentage; every other placeholder (an ordinary
   * property value, for example `color: ${'red'};`) is filled with a plain identifier character.
   */
  return context.characterAfter === '%' ? '0' : 'x'
}

/**
 * The spans every scan in getTemplateSubstitutions walks: within [0, textLength], in ascending
 * order, never overlapping, and never empty, so each lazy scan only moves forward and the output
 * keeps the input length. The decorator supplies spans in exactly that shape (one per "${...}",
 * left to right), so the common case pays one linear check and allocates nothing. A span list from
 * "./api"'s getSubstitutions may be unsorted, overlapping, empty, or out of range: it pays for one
 * copy and one sort, each span is clamped into the text, a span that is empty after clamping is
 * dropped (it substitutes nothing), and overlapping spans merge into their union (spans that only
 * touch stay separate, as adjacent placeholders do). The output depends only on span positions,
 * never on their order, so nothing maps back to the caller's order.
 */
function normalizeSpans(
  textLength: number,
  spans: ReadonlyArray<SubstitutionSpan>,
): ReadonlyArray<SubstitutionSpan> {
  if (isNormalized(textLength, spans)) {
    return spans
  }
  const sorted = spans
    .map((span) => {
      const start = Math.max(0, Math.min(textLength, span.start))
      return { end: Math.max(start, Math.min(textLength, span.end)), start }
    })
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: SubstitutionSpan[] = []
  for (const span of sorted) {
    const last = merged[merged.length - 1]
    if (last && span.start < last.end) {
      merged[merged.length - 1] = { end: Math.max(last.end, span.end), start: last.start }
    } else {
      merged.push(span)
    }
  }
  return merged
}

/** True when every span lies in [0, textLength], is not empty, and starts at or after the previous one's end. */
function isNormalized(textLength: number, spans: ReadonlyArray<SubstitutionSpan>): boolean {
  let previousEnd = 0
  for (const span of spans) {
    if (span.start < previousEnd || span.end <= span.start || span.end > textLength) {
      return false
    }
    previousEnd = span.end
  }
  return true
}

/**
 * Builds the masked text from slices of `templateText` between spans plus a masked copy of each
 * span's own characters, so a long template with few placeholders pays for the placeholders'
 * length plus one slice per gap between them, never a per-character rewrite of the whole text.
 * `spans` come from normalizeSpans. Every span gets the solid fill.
 */
function maskSubstitutions(templateText: string, spans: ReadonlyArray<SubstitutionSpan>): string {
  let result = ''
  let cursor = 0
  for (const { end, start } of spans) {
    result += templateText.slice(cursor, start) + SOLID_FILL.repeat(end - start)
    cursor = end
  }
  result += templateText.slice(cursor)
  return result
}

/** `replacementCharacter` over every UTF-16 code unit of `placeholderText`, line terminators included. */
function fillPlaceholder(placeholderText: string, replacementCharacter: string): string {
  return replacementCharacter.repeat(placeholderText.length)
}

/**
 * True when a placeholder scanned as a property name sits inside a custom property's dashed name,
 * for example `--${name}: 1px;`. `syntaxTextSinceBoundary` is the masked text from the nearest
 * preceding declaration boundary (";", "{", "}", or the current line's start) to the placeholder,
 * so a "--" left over from an earlier declaration on the same line never leaks in.
 */
function isCustomPropertyName(syntaxTextSinceBoundary: string): boolean {
  return /^\s*--/.test(syntaxTextSinceBoundary)
}

/**
 * Same-length stand-in for `placeholderText`: `open`, then `padding` repeated, then `close`.
 * Undefined when the placeholder is shorter than `open` and `close` together.
 */
function wrapPlaceholder(
  placeholderText: string,
  { close = '', open, padding = ' ' }: { close?: string; open: string; padding?: string },
): string | undefined {
  const paddingLength = placeholderText.length - open.length - close.length
  return paddingLength < 0 ? undefined : open + padding.repeat(paddingLength) + close
}

/** A character right before a selector placeholder that makes the placeholder part of a name: `.${a}`, `#${a}`, `&${a}`, `:${a}`. */
const SELECTOR_NAME_PREFIXES: ReadonlySet<string> = new Set(['#', '&', '.', ':'])

/**
 * How a placeholder standing for an at-rule condition is filled: "parenthesized" for a media or
 * container condition, "function" for a supports condition.
 */
type AtRuleConditionShape = 'function' | 'parenthesized'

/**
 * The at-rules whose preludes take conditions, matched where a statement starts, after its leading
 * whitespace and comments (case-insensitive, as CSS matches at-keywords). Sticky, so it matches at
 * `lastIndex` only.
 */
const CONDITION_AT_RULE_PATTERN = /@(container|media|supports)/iy

type ConditionAtRule = 'container' | 'media' | 'supports'

const CONDITION_AT_RULES: ReadonlySet<string> = new Set<ConditionAtRule>([
  'container',
  'media',
  'supports',
])

function isConditionAtRule(name: string): name is ConditionAtRule {
  return CONDITION_AT_RULES.has(name)
}

const CONDITION_COMBINATORS: ReadonlySet<string> = new Set(['and', 'not', 'or'])

/** A condition at-keyword that starts a statement, and the offset just past it. */
interface ConditionKeyword {
  readonly keyword: ConditionAtRule
  readonly keywordEnd: number
}

/**
 * Returns a query for the condition at-keyword (`@media`, `@supports`, `@container`) that starts
 * the statement at `statementStart`, after optional whitespace and comments, or undefined. The
 * query remembers its last answer, so the many placeholders of one statement read its leading
 * whitespace and comments once.
 */
function createConditionKeywordFinder(
  syntaxText: string,
): (statementStart: number) => ConditionKeyword | undefined {
  const pattern = new RegExp(CONDITION_AT_RULE_PATTERN)
  const skipLeadingNonCode = createLeadingNonCodeSkipper(syntaxText)
  let lastStart = -1
  let lastAnswer: ConditionKeyword | undefined
  return (statementStart) => {
    if (statementStart === lastStart) {
      return lastAnswer
    }
    const keywordStart = skipLeadingNonCode(statementStart)
    pattern.lastIndex = keywordStart
    const match = pattern.exec(syntaxText)
    const keyword = match?.[1]?.toLowerCase()
    const keywordEnd = keywordStart + (match?.[0].length ?? 0)
    lastStart = statementStart
    lastAnswer =
      keyword !== undefined &&
      isConditionAtRule(keyword) &&
      !isNameCharacter(syntaxText[keywordEnd])
        ? { keyword, keywordEnd }
        : undefined
    return lastAnswer
  }
}

/**
 * Returns a query for the offset after the whitespace, block comments, and `//` line comments that
 * start at `from`. An unterminated block comment is not skipped, so no at-keyword is found behind
 * it. The search for a comment's closing "*\/" remembers its last range, as createRunScanner does,
 * so a text full of statements that each open a comment reads each stretch once.
 */
function createLeadingNonCodeSkipper(text: string): (from: number) => number {
  let closeQueryFrom = -1
  let closeFound = -2
  const findClose = (from: number): number => {
    const isInsideLastRange = closeFound === -1 ? from >= closeQueryFrom : from <= closeFound
    if (from >= closeQueryFrom && isInsideLastRange) {
      return closeFound
    }
    closeQueryFrom = from
    closeFound = text.indexOf('*/', from)
    return closeFound
  }
  return (from) => {
    let index = from
    for (;;) {
      while (index < text.length && isWhitespace(text[index])) {
        index++
      }
      if (text[index] !== '/') {
        return index
      }
      if (text[index + 1] === '*') {
        const close = findClose(index + 2)
        if (close === -1) {
          return index
        }
        index = close + 2
      } else if (text[index + 1] === '/') {
        index += 2
        while (index < text.length && !isLineTerminator(text[index]) && text[index] !== '\f') {
          index++
        }
      } else {
        return index
      }
    }
  }
}

/**
 * Whether a placeholder starting at `placeholderStart` stands for a condition in the prelude that
 * `conditionKeyword` opens, where anything but a condition is a parse error: after a separate
 * `and`, `or`, or `not` in `@media`, `@supports`, or `@container`; right after `@supports`; or right
 * after the container name in `@container name ${query}`; or right after `@media` and before a
 * separate `or`, which follows only a condition, never a media type. Any other placeholder right
 * after `@media` or `@container` stays an identifier, which already reads as a media type or a
 * container name. The gap before the placeholder is whitespace and comments, read by the caller's
 * CodeLookback (`previousSignificant`, the offset of the last code character before it); the word
 * before that gap is read back to the at-keyword at most, and the word after the placeholder (from
 * `nextSignificant`) only right after `@media`, so each stretch of text is read for at most the two
 * placeholders after it. A line start inside a block comment counts as a statement start, so the
 * at-keyword itself can sit inside a comment the CodeLookback skips (`/* a` then `@supports *\/`
 * on the next line, before a placeholder), which leaves no code character before the placeholder
 * at all.
 */
function getAtRuleConditionShape(
  syntaxText: string,
  { keyword, keywordEnd }: ConditionKeyword,
  placeholder: { nextSignificant: number; previousSignificant: PreviousSignificant; start: number },
): AtRuleConditionShape | undefined {
  const conditionShape: AtRuleConditionShape = keyword === 'supports' ? 'function' : 'parenthesized'
  if (
    placeholder.previousSignificant === INSIDE_NON_CODE ||
    placeholder.previousSignificant === NO_SIGNIFICANT_CHARACTER
  ) {
    return undefined
  }
  const wordEnd = Math.max(placeholder.previousSignificant + 1, keywordEnd)
  if (wordEnd === placeholder.start) {
    return undefined
  }
  if (wordEnd === keywordEnd) {
    if (keyword === 'supports') {
      return conditionShape
    }
    return keyword === 'media' && isWordAt(syntaxText, placeholder.nextSignificant, 'or')
      ? conditionShape
      : undefined
  }
  let wordStart = wordEnd
  while (wordStart > keywordEnd && isNameCharacter(syntaxText[wordStart - 1])) {
    wordStart--
  }
  if (CONDITION_COMBINATORS.has(syntaxText.slice(wordStart, wordEnd).toLowerCase())) {
    return conditionShape
  }
  const isContainerName =
    keyword === 'container' &&
    wordStart < wordEnd &&
    skipWhitespaceBackward(syntaxText, wordStart, keywordEnd) === keywordEnd
  return isContainerName ? conditionShape : undefined
}

/** True when `word` starts at `index`, compared case-insensitively, with no name character after it. */
function isWordAt(text: string, index: number, word: string): boolean {
  return (
    text.slice(index, index + word.length).toLowerCase() === word &&
    !isNameCharacter(text[index + word.length])
  )
}

/** The offset after the last non-whitespace character in [floor, from), or `floor` when there is none. */
function skipWhitespaceBackward(text: string, from: number, floor: number): number {
  let index = from
  while (index > floor && isWhitespace(text[index - 1])) {
    index--
  }
  return index
}
