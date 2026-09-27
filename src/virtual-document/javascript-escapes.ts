import type { TemplateContext } from 'typescript-template-language-service-decorator'

import {
  hexDigitsEnd,
  isCssWhitespace,
  isEscapableCharacter,
  isHexDigit,
  isNameCharacter,
  isNameCodeUnit,
  LINE_SEPARATOR,
  LINE_SEPARATOR_CODE,
  MAX_CSS_HEX_DIGITS,
  namesUrlFunction,
  PARAGRAPH_SEPARATOR,
  PARAGRAPH_SEPARATOR_CODE,
} from './css-code-scanner.ts'

/**
 * The template-relative span [start, end) of the raw text one stand-in covers: a run of adjacent
 * escapes (the escaped character after the run included when the stand-in absorbs it), or every run
 * inside one name together with the name characters before and between them, when the padding
 * moved in front of the name.
 */
export interface EscapeRun {
  readonly end: number
  readonly start: number
}

interface TemplateCss {
  readonly escapeRuns: readonly EscapeRun[]
  readonly text: string
}

const cssByContext = new WeakMap<Pick<TemplateContext, 'text'>, TemplateCss>()

function getTemplateCss(context: Pick<TemplateContext, 'text'>): TemplateCss {
  const cached = cssByContext.get(context)
  if (cached !== undefined) {
    return cached
  }
  const escapeRuns: EscapeRun[] = []
  const css = { escapeRuns, text: replaceEscapes(context.text, escapeRuns) }
  cssByContext.set(context, css)
  return css
}

/**
 * `context.text` with JavaScript escapes replaced (replaceJavaScriptEscapes), the one text every
 * reader of a template's CSS structure uses after substitution: the virtual document, the
 * value-shape test, and the stray closing brace search. Kept per TemplateContext, as the value
 * wrapper is, so a request that reaches several of them replaces the escapes once.
 */
export function getTemplateCssText(context: Pick<TemplateContext, 'text'>): string {
  return getTemplateCss(context).text
}

/**
 * The escape runs of `context.text`, in order and never overlapping, from the same pass as
 * getTemplateCssText: a span mapped back from the virtual document is widened to whole runs.
 */
export function getTemplateEscapeRuns(
  context: Pick<TemplateContext, 'text'>,
): readonly EscapeRun[] {
  return getTemplateCss(context).escapeRuns
}

/**
 * The template text the plugin receives is the raw source between the backticks, with every
 * JavaScript escape sequence as written, while styled-components receives the cooked strings, with
 * each escape already resolved to the character it stands for. This replaces each escape with a
 * stand-in of the same length that reads, to the CSS scanner, like its cooked character
 * (docs/architecture.md, Virtual document).
 *
 * A run of adjacent escapes is cooked as a whole, then written right-aligned in its own span with
 * spaces before it: a cooked backslash then still escapes the character after the run, as it does
 * at runtime, and a surrogate pair written as two escapes stays one pair. When the cooked run ends
 * inside a CSS escape (a backslash that escapes what follows, or a hex escape hex digits after the
 * run continue), the padding goes inside or before that CSS escape instead where CSS allows it
 * (joinOpenEscape, joinEscapedCharacter), so it does not split a name, url(), or the escape. Otherwise,
 * inside an unquoted url() argument, the padding is URL_PADDING placed where it joins the url token
 * (splitUrlStandIn). A cooked quote opening the argument's first content (isFreshUrlArgument) makes
 * the whole argument a quoted string instead, so it is read as plain value text, not url content. When
 * the run continues a name, the spaces go in front of the whole name (findNameStart), or, where
 * whitespace there would split a larger token, into a CSS hex escape (hexEscapeLastCharacter). A
 * cooked control character or Unicode line or paragraph separator is written as a space. An invalid
 * escape (the cooked value is `undefined` at runtime) is left as written. Returns `text` itself when
 * it holds no backslash.
 */
export function replaceJavaScriptEscapes(text: string): string {
  return replaceEscapes(text, undefined)
}

/**
 * A name whose stand-in is still being written: `padding` spaces, then `body` (the raw name
 * characters before the first escape run, then each run's cooked text and the raw name characters
 * between runs), covering the raw span [start, end). Kept open so a later run in the same name adds
 * its padding to the same spaces in front instead of splitting the name.
 */
interface OpenName {
  body: string
  end: number
  /** The last run's cooked text ends with a backslash that escapes the raw character at `end`. */
  escapesNext: boolean
  /** The last character of `body`, taken from the stand-in that ends it, so `body`, built by concatenation, is never indexed (reading a character flattens it). */
  lastCharacter: string | undefined
  padding: number
  readonly start: number
}

/** replaceJavaScriptEscapes, also appending each replaced run's span to `escapeRuns` when given. */
function replaceEscapes(text: string, escapeRuns: EscapeRun[] | undefined): string {
  let runStart = text.indexOf('\\')
  if (runStart === -1) {
    return text
  }

  let result = ''
  let copiedUntil = 0
  let openName: OpenName | undefined
  /**
   * The last character writeStandIn wrote, which ends `result` whenever no name is open and the
   * next run starts a name right where the text written so far ends. Kept apart so `result`, a
   * string built by concatenation, is never indexed (reading a character flattens it).
   */
  let lastStandInCharacter: string | undefined
  const closeName = () => {
    if (openName) {
      result += ' '.repeat(openName.padding) + openName.body
      escapeRuns?.push({ end: openName.end, start: openName.start })
      openName = undefined
    }
  }
  const writeStandIn = (start: number, end: number, standIn: string) => {
    closeName()
    result += text.slice(copiedUntil, start) + standIn
    lastStandInCharacter = standIn[standIn.length - 1]
    escapeRuns?.push({ end, start })
  }

  /** The previous run's answers carried to `copiedUntil`, where it ended (isInsideUnquotedUrl). */
  const readBack: UrlReadBack = { floor: 0, insideUrl: false, openEscape: undefined }
  while (runStart !== -1) {
    const run = readRun(text, runStart)
    if (run === undefined) {
      /** An invalid escape: its backslash and the character after it stay as written. */
      runStart = text.indexOf('\\', runStart + 2)
      continue
    }
    const { cooked, end: runEnd } = run
    const padding = runEnd - runStart - cooked.length
    const escapeStart = openEscapeStart(cooked)
    const escapesNext = escapeStart !== -1 && escapeStart === cooked.length - 1
    readBack.floor = copiedUntil
    const rawInsideUrl = isInsideUnquotedUrl(text, runStart, readBack)
    /**
     * A cooked quote opening the argument's first content makes the whole argument a quoted
     * string, not an unquoted one: `url(\x22\x22)` cooks to `url("")`, a valid quoted url, and so
     * does a run that cooks to pure whitespace immediately followed by a real quote, such as
     * `url(\x20"a")`. Read as plain value text instead (the general branch below), whose
     * spaces-before-the-run padding never manufactures a second token the way url content would.
     */
    const opensQuotedArgument =
      rawInsideUrl &&
      isCssQuoteCharacter(firstNonWhitespaceCharacter(cooked) ?? text[runEnd]) &&
      isFreshUrlArgument(text, runStart, readBack)
    const insideUrl = rawInsideUrl && !opensQuotedArgument
    /**
     * A hex escape already in the cooked text is joined only when hex digits follow the run or,
     * inside a url() argument, where padding after it would split it from its whitespace.
     */
    const joined =
      escapeStart === -1
        ? undefined
        : escapesNext
          ? joinEscapedCharacter(text, runEnd, cooked, padding, insideUrl)
          : isHexDigit(text.charCodeAt(runEnd)) || insideUrl
            ? joinOpenEscape(text, { cooked, end: runEnd, escapeStart, insideUrl, padding })
            : undefined

    if (joined) {
      if (insideUrl) {
        carryUrlState(text, runStart, joined.standIn, readBack)
      }
      writeStandIn(runStart, joined.end, joined.standIn)
      copiedUntil = joined.end
    } else if (insideUrl) {
      const head = escapesNext ? cooked.slice(0, -1) : cooked
      const { body, closesArgument, tail } = splitUrlStandIn(toStandIn(head))
      const fill = URL_PADDING.repeat(padding)
      const backslash = escapesNext ? '\\' : ''
      /**
       * A run that cooks to whitespace alone has no content of its own for the fill to join. Right
       * after a hex escape a previous run left open, the escape takes the first whitespace, so the
       * fill follows it as more of the same token. At the argument's start, the whitespace is
       * leading trivia, so the fill is spaces too.
       */
      const isWhitespaceOnly = body.length === 0 && !closesArgument
      const escapeOpenHere =
        isWhitespaceOnly && openEscapeAt(text, runStart, readBack) !== undefined
      const isLeadingTrivia =
        isWhitespaceOnly && !escapeOpenHere && isFreshUrlArgument(text, runStart, readBack)
      const standIn = escapeOpenHere
        ? `${tail}${fill}${backslash}`
        : isLeadingTrivia
          ? `${' '.repeat(tail.length + padding)}${backslash}`
          : `${body}${fill}${tail}${backslash}`
      carryUrlState(text, runStart, standIn, readBack)
      writeStandIn(runStart, runEnd, standIn)
      copiedUntil = runEnd
    } else {
      const standIn = toStandIn(cooked)
      /**
       * Only a stand-in that starts with a name character or a CSS escape continues the name before
       * it. Before any other character (`colr\x3a red`), the spaces stay between the name and the
       * run, so an edit to the name alone (a rename quick fix) does not touch the run. A stand-in
       * that is exactly "(" right after a name continues it too, since url() takes no whitespace
       * before its "(" (`url\x28a)`); a run that cooks past the "(" keeps its spaces in place, since
       * what follows the "(" is the argument, not more of the name.
       */
      const opensCallAfterName = standIn === '(' && isNameCharacter(text[runStart - 1])
      const continuesName = isNameCharacter(standIn[0]) || standIn[0] === '\\' || opensCallAfterName
      const nameStart = continuesName
        ? findNameStart(text, runStart, copiedUntil, openName?.escapesNext === true)
        : runStart
      const nameEscapesNext = escapesNext && isEscapableCharacter(text[runEnd])
      const continuesOpenName =
        openName !== undefined &&
        nameStart === copiedUntil &&
        (openName.escapesNext || isNameCharacter(openName.lastCharacter))

      if (openName && continuesOpenName) {
        openName.body += text.slice(copiedUntil, runStart) + standIn
        openName.end = runEnd
        openName.escapesNext = nameEscapesNext
        openName.lastCharacter = standIn[standIn.length - 1]
        openName.padding += padding
      } else {
        const before =
          nameStart > copiedUntil
            ? text[nameStart - 1]
            : openName
              ? openName.lastCharacter
              : lastStandInCharacter
        const joinsName = nameStart < runStart
        const paddingMovesInFront = joinsName && isNameBoundary(before)
        const hexStandIn =
          joinsName && !paddingMovesInFront
            ? hexEscapeLastCharacter(text, runEnd, cooked, padding, nameStart, runStart)
            : undefined
        if (hexStandIn !== undefined) {
          writeStandIn(runStart, runEnd, hexStandIn)
        } else {
          const start = paddingMovesInFront ? nameStart : runStart
          closeName()
          result += text.slice(copiedUntil, start)
          openName = {
            body: text.slice(start, runStart) + standIn,
            end: runEnd,
            escapesNext: nameEscapesNext,
            lastCharacter: standIn[standIn.length - 1],
            padding,
            start,
          }
        }
      }
      copiedUntil = runEnd
    }
    /**
     * Outside a url() argument nothing is carried: the next read-back then answers no at the floor
     * whatever escape is open there.
     */
    if (!insideUrl) {
      readBack.insideUrl = false
      readBack.openEscape = undefined
    }
    runStart = text.indexOf('\\', copiedUntil)
  }
  closeName()
  return result + text.slice(copiedUntil)
}

/**
 * The start of the name the escape run at `runStart` continues: reading back from it over name
 * characters, not past `limit` (where the text already written ends), then over one leading
 * character that belongs to the name's token (`#`, `.`, `@`, `:`, `!`), so the padding in front of
 * a class, id, at-keyword, pseudo-class, or `!important` does not split it from its name. The raw
 * character at `limit` counts as a name character when `limitIsEscaped` (a cooked backslash right
 * before it escapes it). `runStart` when no name comes before the run.
 */
function findNameStart(
  text: string,
  runStart: number,
  limit: number,
  limitIsEscaped: boolean,
): number {
  let start = runStart
  while (
    start > limit &&
    (isNameCodeUnit(text.charCodeAt(start - 1)) || (limitIsEscaped && start - 1 === limit))
  ) {
    start--
  }
  if (start > limit && NAME_LEADERS.has(text[start - 1] ?? '')) {
    start--
  }
  return start
}

/** Characters that open a token whose name follows directly: an id or hash, a class, an at-keyword, a pseudo-class, `!important`. */
const NAME_LEADERS: ReadonlySet<string> = new Set(['#', '.', '@', ':', '!'])

/**
 * True when whitespace may sit right after `character` (the one before a name, undefined at the
 * start of the text) without changing what the CSS around it means: whitespace, the start of the
 * text, or `;`, `{`, `}`, `(`, `,`. A name after any other character (`&.a`, `a:hover`) is joined
 * to it, so moving the padding in front of the name would split that token instead.
 */
function isNameBoundary(character: string | undefined): boolean {
  return (
    character === undefined ||
    isCssWhitespace(character) ||
    character === ';' ||
    character === '{' ||
    character === '}' ||
    character === '(' ||
    character === ','
  )
}

/**
 * The stand-in for an escape run inside a name whose padding cannot move in front of the name:
 * the cooked text with its last character written as a CSS hex escape that fills the padding
 * (`co\x6Cr` after `&.` reads as `co\06cr`), followed directly by the raw text when the character
 * there cannot continue or end a hex escape, or else ended by the one space a hex escape absorbs
 * (`\6c ` before a hex digit). Undefined when that character is not a name character, when the
 * name is a number or hash (`1\x30`, `#f\x66f`, where an escaped digit reads differently), when
 * the cooked text ends with a CSS escape, or when the code does not fit in six hex digits.
 */
function hexEscapeLastCharacter(
  text: string,
  runEnd: number,
  cooked: string,
  padding: number,
  nameStart: number,
  runStart: number,
): string | undefined {
  const isPair =
    isLowSurrogate(cooked.charCodeAt(cooked.length - 1)) &&
    isHighSurrogate(cooked.charCodeAt(cooked.length - 2))
  const unitCount = isPair ? 2 : 1
  const codePoint = cooked.codePointAt(cooked.length - unitCount)
  const head = cooked.slice(0, cooked.length - unitCount)
  const leader = text[nameStart] ?? ''
  const nameFirstIndex = NAME_LEADERS.has(leader) ? nameStart + 1 : nameStart
  /** The identifier's first two characters, read across the raw name and the cooked text. */
  const identifierAt = (offset: number) =>
    nameFirstIndex + offset < runStart
      ? text[nameFirstIndex + offset]
      : cooked[nameFirstIndex + offset - runStart]
  const startsNumber =
    isDecimalDigit(identifierAt(0)) || (identifierAt(0) === '-' && isDecimalDigit(identifierAt(1)))
  if (
    codePoint === undefined ||
    !isNameCodeUnit(codePoint) ||
    leader === '#' ||
    startsNumber ||
    endsWithEscapingBackslash(head)
  ) {
    return undefined
  }

  const code = codePoint.toString(16)
  const after = text[runEnd]
  const endsBySpace =
    after === undefined ||
    after === '\\' ||
    isHexDigit(after.charCodeAt(0)) ||
    isCssWhitespace(after)
  const digits = padding + unitCount - (endsBySpace ? 2 : 1)
  if (code.length > digits || digits > MAX_CSS_HEX_DIGITS) {
    return undefined
  }
  return `${toStandIn(head)}\\${code.padStart(digits, '0')}${endsBySpace ? ' ' : ''}`
}

/** True when `cooked` ends with an odd number of backslashes, so its last one escapes what follows. */
function endsWithEscapingBackslash(cooked: string): boolean {
  return countBackslashesBefore(cooked, cooked.length) % 2 === 1
}

interface JoinedStandIn {
  /** Where the raw text resumes. */
  readonly end: number
  readonly standIn: string
}

/**
 * The index of the backslash of the CSS escape `text` ends inside: a backslash with an odd count of
 * backslashes up to it, then at most six hex digits to the end. -1 when `text` ends inside none.
 * Reads only the last characters, so for most cooked text it answers from the last one.
 */
function openEscapeStart(text: string, end = text.length): number {
  let index = end
  const limit = Math.max(0, index - MAX_CSS_HEX_DIGITS)
  while (index > limit && isHexDigit(text.charCodeAt(index - 1))) {
    index--
  }
  return text[index - 1] === '\\' && countBackslashesBefore(text, index) % 2 === 1 ? index - 1 : -1
}

interface OpenEscapeRun {
  readonly cooked: string
  readonly end: number
  /** openEscapeStart of `cooked`. */
  readonly escapeStart: number
  readonly insideUrl: boolean
  readonly padding: number
}

/**
 * The stand-in for an escape run whose cooked text leaves a CSS hex escape open (its backslash in
 * the cooked text, then fewer than six hex digits, or none), when hex digits continue that escape,
 * with the padding spent where it cannot split the escape's digits from each other or from the
 * whitespace the escape takes after them. The escape reads on over the raw hex digits after the run
 * and over any later escape run whose cooked text starts with more of them; such a run joins the
 * stand-in, cooked text and padding included, and the stand-in then covers through it. The padding
 * becomes leading zeros right after the backslash, as long as the zeros and digits stay within the
 * six a CSS hex escape reads; otherwise, inside an unquoted url() argument, URL_PADDING before the
 * backslash. Undefined when the escape reads no hex digit, when neither placement applies, or when
 * a hex escape already in the cooked text is outside a url() and no later run joins it, where the
 * other stand-ins keep their meaning.
 */
function joinOpenEscape(text: string, run: OpenEscapeRun): JoinedStandIn | undefined {
  const openEscape = run.cooked.length - 1 - run.escapeStart
  const rawDigitsEnd = hexDigitsEnd(text, run.end, MAX_CSS_HEX_DIGITS - openEscape)
  let read = openEscape + rawDigitsEnd - run.end
  let end = run.end
  let padding = run.padding
  let joinedCooked = ''
  const later =
    read < MAX_CSS_HEX_DIGITS && text[rawDigitsEnd] === '\\'
      ? readJoinedRuns(text, rawDigitsEnd, read)
      : undefined
  if (later) {
    joinedCooked = text.slice(run.end, rawDigitsEnd) + later.cooked
    end = later.end
    padding += later.padding
    read = later.read
  }
  if (read === 0 || (openEscape > 0 && !run.insideUrl && !later)) {
    return undefined
  }

  const before = toStandIn(run.cooked.slice(0, run.escapeStart))
  const escape = toStandIn(run.cooked.slice(run.escapeStart + 1) + joinedCooked)
  if (read + padding <= MAX_CSS_HEX_DIGITS) {
    return { end, standIn: `${before}\\${'0'.repeat(padding)}${escape}` }
  }
  return run.insideUrl
    ? { end, standIn: `${before}${URL_PADDING.repeat(padding)}\\${escape}` }
    : undefined
}

/**
 * The escape runs from `start` on that continue a CSS hex escape which has read `read` hex digits:
 * each run whose cooked text starts with more of them, with the raw hex digits between. The last
 * joined run's cooked text may go on past its digits. `read` counts the raw digits after the last
 * joined run too, which stay outside it. Undefined when the run at `start` joins nothing.
 */
function readJoinedRuns(
  text: string,
  start: number,
  read: number,
): { cooked: string; end: number; padding: number; read: number } | undefined {
  let cooked = ''
  let joinedEnd = start
  let end = start
  let padding = 0
  let count = read
  while (count < MAX_CSS_HEX_DIGITS && text[end] === '\\') {
    const next = readRun(text, end)
    const leadingDigits = next ? hexDigitsEnd(next.cooked, 0, MAX_CSS_HEX_DIGITS - count) : 0
    if (!next || leadingDigits === 0) {
      break
    }
    count += leadingDigits
    padding += next.end - end - next.cooked.length
    cooked += text.slice(joinedEnd, end) + next.cooked
    joinedEnd = next.end
    if (leadingDigits < next.cooked.length) {
      break
    }
    end = hexDigitsEnd(text, joinedEnd, MAX_CSS_HEX_DIGITS - count)
    count += end - joinedEnd
  }
  return joinedEnd === start ? undefined : { cooked, end: joinedEnd, padding, read: count }
}

/**
 * The stand-in for an escape run whose `cooked` text ends with a backslash, which at runtime
 * escapes the character at `runEnd`, with the run's `padding` spent inside that CSS escape rather
 * than as spaces that would split the name or url() around it. Before hex digits, the padding
 * becomes leading zeros, as long as the digits and zeros stay within the six a CSS hex escape
 * reads; when a backslash follows those digits, a later escape run may continue them, which
 * joinOpenEscape handles, and when that join does not fit, the zeros cover this run alone. Before
 * any other character, that character becomes its own hex code
 * padded to fill the room, as long as the code fits and what follows it neither continues the hex
 * digits nor is whitespace a hex escape would absorb (the end of the text and another escape count
 * as unsafe). Undefined when none applies.
 */
function joinEscapedCharacter(
  text: string,
  runEnd: number,
  cooked: string,
  padding: number,
  insideUrl: boolean,
): JoinedStandIn | undefined {
  const head = cooked.slice(0, -1)
  const hexDigitCount = hexDigitsEnd(text, runEnd, MAX_CSS_HEX_DIGITS) - runEnd
  const joined =
    hexDigitCount > 0 && text[runEnd + hexDigitCount] === '\\'
      ? joinOpenEscape(text, {
          cooked,
          end: runEnd,
          escapeStart: cooked.length - 1,
          insideUrl,
          padding,
        })
      : undefined
  if (joined) {
    return joined
  }
  if (hexDigitCount > 0) {
    return hexDigitCount + padding <= MAX_CSS_HEX_DIGITS
      ? { end: runEnd, standIn: `${toStandIn(head)}\\${'0'.repeat(padding)}` }
      : undefined
  }

  const escaped = text.charCodeAt(runEnd)
  const after = text[runEnd + 1]
  const code = escaped.toString(16)
  const room = padding + 1
  const isSafe =
    !isHighSurrogate(escaped) &&
    !isLowSurrogate(escaped) &&
    !isCssWhitespace(text[runEnd]) &&
    code.length <= room &&
    after !== undefined &&
    after !== '\\' &&
    !isHexDigit(after.charCodeAt(0)) &&
    !isCssWhitespace(after)
  return isSafe
    ? { end: runEnd + 1, standIn: `${toStandIn(head)}\\${code.padStart(room, '0')}` }
    : undefined
}

/**
 * The padding of an escape run inside an unquoted url() argument: a character a url token holds,
 * where a space would end the token.
 */
const URL_PADDING = '_'

/**
 * Splits a stand-in written inside an unquoted url() argument where URL_PADDING goes: before the
 * first ")" that closes the argument, or before the end, and there before any CSS whitespace that
 * ends the url token. Filler after that whitespace would read as a second, invalid token, and filler
 * after the ")" would land outside the argument, splitting whatever follows it. A ")" a backslash
 * escapes, or whitespace a CSS escape takes (after a backslash, or after a hex escape's digits), is
 * url content and stays in `body`. `closesArgument` is true when `tail` holds that ")".
 */
function splitUrlStandIn(standIn: string): {
  body: string
  closesArgument: boolean
  tail: string
} {
  const closeIndex = indexOfUnescapedCloseParenthesis(standIn)
  let end = closeIndex === -1 ? standIn.length : closeIndex
  while (end > 0 && isCssWhitespace(standIn[end - 1]) && openEscapeStart(standIn, end - 1) === -1) {
    end--
  }
  return {
    body: standIn.slice(0, end),
    closesArgument: closeIndex !== -1,
    tail: standIn.slice(end),
  }
}

/** The index of the first ")" in `text` that no backslash right before it escapes, or -1 when none. */
function indexOfUnescapedCloseParenthesis(text: string): number {
  let index = text.indexOf(')')
  while (index !== -1 && countBackslashesBefore(text, index) % 2 === 1) {
    index = text.indexOf(')', index + 1)
  }
  return index
}

/**
 * A CSS escape still open at a position of the text CSS reads: the number of hex digits it has
 * read after its backslash (0 right after the backslash), or undefined when no escape is open.
 */
type OpenEscape = number | undefined

/** What the previous escape run leaves at the raw text right after it, where the next read-back stops. */
interface UrlReadBack {
  /** Where the previous run ended (`copiedUntil`), 0 before the first run. */
  floor: number
  /** The raw text at `floor` is inside an unquoted url() argument. */
  insideUrl: boolean
  /** The CSS escape the previous run's stand-in leaves open at `floor`, carried only after a run inside a url() argument. */
  openEscape: OpenEscape
}

/**
 * True when the escape run starting at `runStart` sits inside an unquoted url() or url-prefix()
 * argument: reading back from it over url characters, with a character a CSS escape takes counted
 * as url content, reaches the "(" of a function with that name (isUrlFunctionName), with only
 * whitespace allowed right after that "(". A quote, a paren, or whitespace anywhere else, none of
 * them taken by an escape, answers no. Reading stops at `readBack.floor`, where the previous run
 * ended, and answers `readBack.insideUrl`, that run's own answer carried past its cooked text: runs
 * are read left to right, so each stretch of text is read once, and a previous run's raw characters
 * are never read as url content.
 */
function isInsideUnquotedUrl(text: string, runStart: number, readBack: UrlReadBack): boolean {
  const { floor, openEscape } = readBack
  for (let index = runStart - 1; index >= floor; index--) {
    const character = text[index]
    const isQuote = isCssQuoteCharacter(character)
    const isWhitespace = !isQuote && !isParen(character) && isCssWhitespace(character)
    if (!isQuote && !isWhitespace && !isParen(character)) {
      continue
    }
    /** Only a run inside a url() argument carries an open escape (UrlReadBack). */
    if (openEscape !== undefined && isTakenByEscape(text, index, readBack)) {
      continue
    }
    if (isWhitespace) {
      while (index >= floor && isCssWhitespace(text[index])) {
        index--
      }
      return (
        index >= floor &&
        text[index] === '(' &&
        (openEscape === undefined || !isTakenByEscape(text, index, readBack)) &&
        isUrlFunctionName(text, index)
      )
    }
    return character === '(' && isUrlFunctionName(text, index)
  }
  return readBack.insideUrl
}

function isParen(character: string | undefined): boolean {
  return character === '(' || character === ')'
}

/** A quote character, the kind vscode-css-languageservice reads a CSS string from. */
function isCssQuoteCharacter(character: string | undefined): boolean {
  return character === '"' || character === "'"
}

/** `text`'s first non-whitespace character, or undefined when `text` holds none (including empty). */
function firstNonWhitespaceCharacter(text: string): string | undefined {
  for (let index = 0; index < text.length; index++) {
    if (!isCssWhitespace(text[index])) {
      return text[index]
    }
  }
  return undefined
}

/**
 * True when only whitespace, if anything, lies between `runStart` and the "(" of the still-open
 * unquoted url() argument isInsideUnquotedUrl already found it inside: the run is the argument's
 * first content, so a cooked quote there opens the argument as a real CSS string rather than
 * continuing an unquoted token (docs/architecture.md, JavaScript escapes). A previous run's open CSS
 * escape (readBack.openEscape) already wrote real content, so this answers no without scanning: only
 * a run that wrote nothing but content characters keeps an escape open past its own cooked text.
 */
function isFreshUrlArgument(text: string, runStart: number, readBack: UrlReadBack): boolean {
  if (readBack.openEscape !== undefined) {
    return false
  }
  let index = runStart - 1
  while (index >= readBack.floor && isCssWhitespace(text[index])) {
    index--
  }
  return index >= readBack.floor && text[index] === '('
}

/**
 * True when a CSS escape takes the raw character at `index` (a quote, paren, or whitespace): the
 * escape `openEscape` left open at `floor`, continued by the raw hex digits between `floor` and
 * `index`, either escapes that character directly (a backslash right before a character other than
 * a line break) or is a hex escape of at most six digits, which takes one whitespace after them. A
 * CRLF counts as one whitespace. Raw text past `floor` holds no escape of its own: every valid
 * JavaScript escape there would have been part of a run.
 */
function isTakenByEscape(text: string, index: number, { floor, openEscape }: UrlReadBack): boolean {
  if (openEscape === undefined) {
    return false
  }
  const character = text[index]
  const start = character === '\n' && text[index - 1] === '\r' ? index - 1 : index
  const digitCount = start - floor
  if (digitCount < 0 || hexDigitsEnd(text, floor, digitCount) !== start) {
    return false
  }
  const readDigits = openEscape + digitCount
  return readDigits === 0
    ? isEscapableCharacter(character)
    : isCssWhitespace(character) && readDigits <= MAX_CSS_HEX_DIGITS
}

/**
 * The CSS escape open at `runStart`: the one `openEscape` left open at `floor`, when only hex digits
 * it still reads lie between.
 */
function openEscapeAt(
  text: string,
  runStart: number,
  { floor, openEscape }: UrlReadBack,
): OpenEscape {
  if (openEscape === undefined) {
    return undefined
  }
  const digitCount = runStart - floor
  const readDigits = openEscape + digitCount
  return readDigits <= MAX_CSS_HEX_DIGITS && hexDigitsEnd(text, floor, digitCount) === runStart
    ? readDigits
    : undefined
}

/**
 * Updates `readBack` past a run inside a url() argument from the stand-in written for it, read as
 * written, so padding inside a CSS escape counts as its digits. Reads `readBack` as the previous
 * run left it before overwriting it.
 */
function carryUrlState(
  text: string,
  runStart: number,
  standIn: string,
  readBack: UrlReadBack,
): void {
  const scan = scanUrlStandIn(standIn, openEscapeAt(text, runStart, readBack))
  readBack.insideUrl = !scan.endsUrl
  readBack.openEscape = scan.openEscape
}

interface CookedUrlScan {
  /** The argument or its token ends inside the text and no later character reopens it. */
  readonly endsUrl: boolean
  /** The CSS escape left open after the text. */
  readonly openEscape: OpenEscape
}

/**
 * Reads a stand-in written inside an unquoted url() argument as url content, from the CSS escape
 * `openEscape` open before it. CSS whitespace no escape takes ends the current token, and a later
 * character reopens it: the stand-in of a run that starts the argument can open with whitespace
 * before its first token. A quote or paren no escape takes ends the argument for good. Other
 * characters (U+00A0, U+3000, U+FEFF, and the rest of the JavaScript `\s` class that CSS does not
 * count as whitespace) are url content.
 */
function scanUrlStandIn(standIn: string, openEscape: OpenEscape): CookedUrlScan {
  let open = openEscape
  let isOpen = open !== undefined
  for (let index = 0; index < standIn.length; index++) {
    const character = standIn[index]
    if (open !== undefined) {
      if (open < MAX_CSS_HEX_DIGITS && isHexDigit(standIn.charCodeAt(index))) {
        open++
        isOpen = true
        continue
      }
      const readDigits = open
      open = undefined
      if (readDigits === 0) {
        isOpen = isEscapableCharacter(character)
        continue
      }
      if (isCssWhitespace(character)) {
        index += character === '\r' && standIn[index + 1] === '\n' ? 1 : 0
        continue
      }
    }
    if (isCssQuoteCharacter(character) || isParen(character)) {
      return { endsUrl: true, openEscape: undefined }
    }
    if (character === '\\') {
      open = 0
    }
    isOpen = !isCssWhitespace(character)
  }
  return { endsUrl: !isOpen, openEscape: open }
}

/** The number of backslashes in the text right before `index`. */
function countBackslashesBefore(text: string, index: number): number {
  let count = 0
  while (text[index - 1 - count] === '\\') {
    count++
  }
  return count
}

/**
 * True when the raw name right before the "(" at `parenIndex` is `url` or `url-prefix`, compared
 * case-insensitively, and starts a token (no name character, "#", "@", or backslash before it).
 * The name is read from the raw text, so a name written with an escape inside or directly before
 * it is not `url`.
 */
function isUrlFunctionName(text: string, parenIndex: number): boolean {
  let nameStart = parenIndex
  while (nameStart > 0 && isNameCharacter(text[nameStart - 1])) {
    nameStart--
  }
  const before = text[nameStart - 1]
  return (
    before !== '#' &&
    before !== '@' &&
    before !== '\\' &&
    namesUrlFunction(text.slice(nameStart, parenIndex))
  )
}

/** The escape run whose first backslash is at `start`: adjacent escapes, cooked as a whole. Undefined when the first escape is invalid. */
function readRun(text: string, start: number): { cooked: string; end: number } | undefined {
  let end = start
  let cooked = ''
  for (let escape = readEscape(text, end); escape; escape = readEscape(text, end)) {
    cooked += escape.value
    end = escape.end
  }
  return end === start ? undefined : { cooked, end }
}

interface Escape {
  readonly end: number
  readonly value: string
}

/**
 * Reads the template escape sequence whose backslash is at `index`, following the ECMAScript
 * TemplateCharacter grammar: a line continuation (cooked to nothing), a single-character escape,
 * `\0` not followed by a digit, `\x` with two hex digits, `\u` with four hex digits or a braced code
 * point, or any other character standing for itself. Undefined when there is no backslash at
 * `index` or the escape is invalid.
 */
function readEscape(text: string, index: number): Escape | undefined {
  if (text[index] !== '\\') {
    return undefined
  }
  const next = text[index + 1]
  if (next === undefined) {
    return undefined
  }
  if (next === '\r') {
    return { end: text[index + 2] === '\n' ? index + 3 : index + 2, value: '' }
  }
  if (next === '\n' || next === LINE_SEPARATOR || next === PARAGRAPH_SEPARATOR) {
    return { end: index + 2, value: '' }
  }
  const singleEscape = SINGLE_ESCAPES.get(next)
  if (singleEscape !== undefined) {
    return { end: index + 2, value: singleEscape }
  }
  if (next === '0') {
    return isDecimalDigit(text[index + 2]) ? undefined : { end: index + 2, value: '\0' }
  }
  if (isDecimalDigit(next)) {
    return undefined
  }
  if (next === 'x') {
    return readHexEscape(text, index + 2, 2)
  }
  if (next === 'u') {
    return text[index + 2] === '{'
      ? readCodePointEscape(text, index + 3)
      : readHexEscape(text, index + 2, 4)
  }
  const isSurrogatePair =
    isHighSurrogate(next.charCodeAt(0)) && isLowSurrogate(text.charCodeAt(index + 2))
  const end = isSurrogatePair ? index + 3 : index + 2
  return { end, value: text.slice(index + 1, end) }
}

/** Exactly `digitCount` hex digits starting at `start`, as one UTF-16 code unit. */
function readHexEscape(text: string, start: number, digitCount: number): Escape | undefined {
  const end = hexDigitsEnd(text, start, digitCount)
  return end === start + digitCount
    ? { end, value: String.fromCharCode(parseInt(text.slice(start, end), 16)) }
    : undefined
}

/** One or more hex digits starting at `start` and a closing "}", naming a code point up to U+10FFFF. */
function readCodePointEscape(text: string, start: number): Escape | undefined {
  const index = hexDigitsEnd(text, start, Number.POSITIVE_INFINITY)
  if (index === start || text[index] !== '}') {
    return undefined
  }
  const codePoint = parseInt(text.slice(start, index), 16)
  return codePoint > MAX_CODE_POINT
    ? undefined
    : { end: index + 1, value: String.fromCodePoint(codePoint) }
}

/** A control character (below U+0020, and U+007F) or a Unicode line or paragraph separator. */
const BLANK_PATTERN = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`,
  'g',
)

/**
 * The cooked text with every control character and Unicode line or paragraph separator as a space.
 * Most cooked runs are one or two characters with no blank, which a code-unit scan answers without
 * running the expression (measured faster than an unconditional replace for runs that short).
 */
function toStandIn(cooked: string): string {
  for (let index = 0; index < cooked.length; index++) {
    if (isBlankCode(cooked.charCodeAt(index))) {
      return cooked.replace(BLANK_PATTERN, ' ')
    }
  }
  return cooked
}

/** A code unit BLANK_PATTERN matches. */
function isBlankCode(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    code === LINE_SEPARATOR_CODE ||
    code === PARAGRAPH_SEPARATOR_CODE
  )
}

/** The characters after a backslash that stand for a different character: `\b`, `\f`, `\n`, `\r`, `\t`, `\v`. */
const SINGLE_ESCAPES: ReadonlyMap<string, string> = new Map([
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
  ['v', '\v'],
])

const MAX_CODE_POINT = 0x10ffff

function isDecimalDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9'
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
