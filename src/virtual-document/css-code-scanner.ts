/**
 * The boundary scanner and the character predicates of CSS tokenization that every structural
 * reader of template text shares (docs/architecture.md, "Virtual document", the boundary scanner).
 */

export const LINE_SEPARATOR_CODE = 0x2028
export const PARAGRAPH_SEPARATOR_CODE = 0x2029

/**
 * Built with String.fromCharCode rather than an escape sequence in source text, so the line
 * separator and paragraph separator code points never appear as raw characters in any file.
 */
export const LINE_SEPARATOR = String.fromCharCode(LINE_SEPARATOR_CODE)
export const PARAGRAPH_SEPARATOR = String.fromCharCode(PARAGRAPH_SEPARATOR_CODE)

/**
 * A code unit the CSS scanner accepts inside an identifier (vscode-css-languageservice's
 * `_identChar`): ASCII letters, digits, "-", "_", and every code unit from U+0080 up, except U+2028
 * and U+2029, which are line terminators here (the virtual document turns them into "\n").
 */
export function isNameCodeUnit(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d ||
    code === 0x5f ||
    (code >= 0x80 && code !== LINE_SEPARATOR_CODE && code !== PARAGRAPH_SEPARATOR_CODE)
  )
}

export function isNameCharacter(character: string | undefined): boolean {
  return character !== undefined && isNameCodeUnit(character.charCodeAt(0))
}

export function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  )
}

/** The end of the run of at most `maxDigits` hex digits starting at `start`. */
export function hexDigitsEnd(text: string, start: number, maxDigits: number): number {
  let end = start
  while (end - start < maxDigits && isHexDigit(text.charCodeAt(end))) {
    end++
  }
  return end
}

/** The characters that start a new line for position mapping: "\n", "\r", U+2028, and U+2029. */
export function isLineTerminator(character: string | undefined): boolean {
  return (
    character === '\n' ||
    character === '\r' ||
    character === LINE_SEPARATOR ||
    character === PARAGRAPH_SEPARATOR
  )
}

/**
 * A line break in the sense the CSS tokenizer uses to end an unterminated string or a "//" comment
 * and to close an escape: "\n", "\r", or "\f". U+2028 and U+2029 do not count, since the CSS scanner
 * reads them as ordinary characters: inside a string they stay verbatim, ordinary content.
 */
function isLineBreak(character: string | undefined): boolean {
  return character === '\n' || character === '\r' || character === '\f'
}

/**
 * A line break outside a string, where a "//" line comment ends and a backslash escapes nothing:
 * a CSS line break or a Unicode line or paragraph separator, which the virtual document turns
 * into "\n" before the CSS scanner sees it.
 */
function isCodeLineBreak(character: string | undefined): boolean {
  return isLineBreak(character) || isLineTerminator(character)
}

/** The whitespace the CSS scanner reads between tokens outside strings: space, tab, and its line breaks. */
export function isCssWhitespace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || isCodeLineBreak(character)
}

/** True when a backslash before `character`, outside a string, escapes it: it exists and is no line break. */
export function isEscapableCharacter(character: string | undefined): boolean {
  return character !== undefined && !isCodeLineBreak(character)
}

/** A code character that ends or opens a statement: ";", "{", or "}". */
export function isStatementBoundary(character: string | undefined): boolean {
  return character === ';' || character === '{' || character === '}'
}

const WHITESPACE_PATTERN = /\s/

/** The `\s` class, leaving only non-ASCII characters to the regular expression. */
export function isWhitespace(character: string | undefined): boolean {
  if (character === undefined) {
    return false
  }
  const code = character.charCodeAt(0)
  if (code < 0x80) {
    return code === 0x20 || (code >= 0x09 && code <= 0x0d)
  }
  return WHITESPACE_PATTERN.test(character)
}

/**
 * Scanner state nonCodeEnd carries between positions: the unquoted url() argument open at the
 * current position, from the start of its function name through the closing ")". Every character
 * while it is open is url content to a structural reader: a ";", "{", or "}" there is part of the
 * url token.
 */
export interface CssCodeScanState {
  url?: UnquotedUrlArgument
}

interface UnquotedUrlArgument {
  /** Where a block comment can open: right after "(", or after the last string or comment. */
  commentAllowedAt: number
  /** Where the last escape ended: whitespace an escape took is no token boundary. */
  escapeEnd: number
  readonly openParenthesis: number
}

export function createCssCodeScanState(): CssCodeScanState {
  return {}
}

/**
 * The comment, string, escape, and url() boundary scanner (docs/architecture.md, "Virtual
 * document"). It updates `state` for the character at `index`, then returns the end (exclusive) of
 * the run starting there that the caller must step over as a unit, or -1 when `index` is plain
 * code. A run is a block comment, a "//" line comment, a quoted string, or an escaped run, which is
 * code: the rest of the identifier an escape outside a string starts or continues, or inside an
 * unquoted url() argument the escape alone. Call it in order at every code position where it can
 * act (createScanCandidatePattern); a caller may skip a stretch of code holding none of those,
 * since the calls there would return -1 and change nothing.
 */
export function nonCodeEnd(text: string, index: number, state: CssCodeScanState): number {
  const character = text[index]
  if (character === '"' || character === "'") {
    const end = stringEnd(text, index, character)
    if (state.url) {
      state.url.commentAllowedAt = end
    }
    return end
  }
  const isEscape = character === '\\' && startsCodeEscape(text, index)
  if (state.url) {
    return urlArgumentRunEnd(text, index, state, state.url, isEscape)
  }
  if (character === '/') {
    return commentEnd(text, index)
  }
  if (!isEscape && character !== 'u' && character !== 'U') {
    return -1
  }
  const startsIdentifier = !continuesToken(text[index - 1])
  const urlParenthesis = startsIdentifier ? findUrlArgumentParenthesis(text, index) : -1
  if (urlParenthesis !== -1) {
    state.url = {
      commentAllowedAt: urlParenthesis + 1,
      escapeEnd: -1,
      openParenthesis: urlParenthesis,
    }
  }
  return isEscape ? identifierEnd(text, index) : -1
}

/**
 * nonCodeEnd inside an unquoted url() argument, which the CSS parser reads as trivia, one token,
 * then trivia again: a block comment opens only where a token could start (right after "(", after
 * a string or comment, or after whitespace no escape took), and "/" or "*" next to url characters
 * is url content. "//" opens no comment here (SCSSScanner.comment checks `!this.inURL`). An
 * escape steps over its own characters; an unescaped ")" closes the argument.
 */
function urlArgumentRunEnd(
  text: string,
  index: number,
  state: CssCodeScanState,
  url: UnquotedUrlArgument,
  isEscape: boolean,
): number {
  const character = text[index]
  if (isEscape) {
    url.escapeEnd = escapeEnd(text, index, isCodeLineBreak)
    return url.escapeEnd
  }
  if (character === ')') {
    state.url = undefined
    return -1
  }
  const opensComment =
    character === '/' &&
    text[index + 1] === '*' &&
    (index === url.commentAllowedAt ||
      (index !== url.escapeEnd && isCssWhitespace(text[index - 1])))
  if (!opensComment) {
    return -1
  }
  const end = commentEnd(text, index)
  url.commentAllowedAt = end
  return end
}

/**
 * The positions where nonCodeEnd can act, a superset: a quote or "/" can start a string or
 * comment, a backslash starts an escape, ")" closes an unquoted url() argument, and a "u" followed
 * by "r" or by an escape can start the name `url` that opens one. Matched case-insensitively, as
 * CSS matches the url() function name.
 */
const SCAN_STATE_CANDIDATE_PATTERN = /["'/)\\]|u[r\\]/gi

/**
 * The stretches of a text where a structural character (";", "{", "}", "&", a line terminator)
 * decides nothing, in ascending order and never overlapping: comments, strings, escaped runs, and
 * unquoted url() arguments (from the url function name through its ")", or to the end of the text
 * when unclosed). A "//" comment's run ends before the line terminator that ends it, which is a
 * line break at code. `isComment` tells a comment, which a reader of the line's last code
 * character reads past, from the rest, which are significant characters.
 */
export interface NonCodeRuns {
  readonly ends: readonly number[]
  readonly isComment: readonly boolean[]
  readonly starts: readonly number[]
}

const NON_CODE_RUN_CANDIDATE_PATTERN = new RegExp(SCAN_STATE_CANDIDATE_PATTERN)

/**
 * Finds a text's NonCodeRuns with one forward walk that calls nonCodeEnd only at the positions
 * where it can act, so a text of plain code costs one search that finds few or no candidates.
 */
export function findNonCodeRuns(text: string): NonCodeRuns {
  const starts: number[] = []
  const ends: number[] = []
  const isComment: boolean[] = []
  const state = createCssCodeScanState()
  const candidates = NON_CODE_RUN_CANDIDATE_PATTERN
  let urlStart = -1
  let cursor = 0
  for (;;) {
    candidates.lastIndex = cursor
    const index = candidates.exec(text)?.index
    if (index === undefined) {
      break
    }
    const wasInUrl = state.url !== undefined
    const end = nonCodeEnd(text, index, state)
    cursor = end === -1 ? index + 1 : end
    if (!wasInUrl && state.url !== undefined) {
      urlStart = index
    }
    if (wasInUrl || state.url !== undefined) {
      if (state.url === undefined) {
        starts.push(urlStart)
        ends.push(index + 1)
        isComment.push(false)
      }
      continue
    }
    if (end === -1) {
      continue
    }
    const opensComment = text[index] === '/'
    const endsAtLineTerminator =
      opensComment && text[index + 1] === '/' && isLineTerminator(text[end - 1])
    starts.push(index)
    ends.push(endsAtLineTerminator ? end - 1 : end)
    isComment.push(opensComment)
  }
  if (state.url !== undefined) {
    starts.push(urlStart)
    ends.push(text.length)
    isComment.push(false)
  }
  return { ends, isComment, starts }
}

/**
 * A global, case-insensitive pattern matching every position where nonCodeEnd can act, plus each
 * of `characters` (character-class members that need no escaping), for a reader that jumps from
 * one candidate to the next with `lastIndex` instead of visiting every character.
 */
export function createScanCandidatePattern(characters: string): RegExp {
  return new RegExp(`${SCAN_STATE_CANDIDATE_PATTERN.source}|[${characters}]`, 'gi')
}

/** An offset into the text a CodeLookback reads. */
type TextOffset = number & { readonly brand: 'TextOffset' }

/** CodeLookback.previousSignificant's answer when no significant character precedes the query. */
export const NO_SIGNIFICANT_CHARACTER = -1

/** CodeLookback.previousSignificant's answer when the queried offset lies inside a comment or a string. */
export const INSIDE_NON_CODE = -2

export type PreviousSignificant =
  | TextOffset
  | typeof NO_SIGNIFICANT_CHARACTER
  | typeof INSIDE_NON_CODE

/**
 * Finds the nearest significant character before an offset: the last non-whitespace code
 * character, where a comment is skipped, a string counts as one significant character at its
 * opening quote, an escaped run at its backslash, and an unquoted url() argument at its "(" (a
 * query inside the argument answers that "("). Walks forward with nonCodeEnd from `start`,
 * remembering where it stopped, so a series of queries at increasing offsets costs one pass over
 * the text in total; a query below the previous one starts over from `start`.
 */
export interface CodeLookback {
  /** The offset of that character in [start, before), NO_SIGNIFICANT_CHARACTER, or INSIDE_NON_CODE. */
  previousSignificant(before: number): PreviousSignificant
}

function toTextOffset(index: number): TextOffset {
  return index as TextOffset
}

export function createCodeLookback(text: string, start: number): CodeLookback {
  let state = createCssCodeScanState()
  const candidates = new RegExp(SCAN_STATE_CANDIDATE_PATTERN)
  let cursor = start
  let lastSignificant: PreviousSignificant = NO_SIGNIFICANT_CHARACTER
  /** The first candidate at or after `cursor` (text.length when none), kept so queries between two candidates search once. */
  let nextCandidate = -1
  /** The comment or string starting at runStart, kept so repeated queries inside it scan it once. */
  let runStart = -1
  let runEnd = -1

  /** True when `index` lies inside an open unquoted url() argument, past its "(". */
  const isInsideUrlArgument = (index: number) =>
    state.url !== undefined && index > state.url.openParenthesis

  /** Records the last non-whitespace character in [from, to), all of it plain code, up to an open url() argument's "(". */
  const skipPlainCode = (from: number, to: number) => {
    const end = state.url ? Math.min(to, state.url.openParenthesis + 1) : to
    for (let index = end - 1; index >= from; index--) {
      if (!isWhitespace(text[index])) {
        lastSignificant = toTextOffset(index)
        return
      }
    }
  }

  return {
    previousSignificant(before) {
      if (before < cursor) {
        state = createCssCodeScanState()
        cursor = start
        lastSignificant = NO_SIGNIFICANT_CHARACTER
        nextCandidate = -1
      }
      while (cursor < before) {
        if (nextCandidate < cursor) {
          candidates.lastIndex = cursor
          nextCandidate = candidates.exec(text)?.index ?? text.length
        }
        if (nextCandidate >= before) {
          skipPlainCode(cursor, before)
          cursor = before
          break
        }
        skipPlainCode(cursor, nextCandidate)
        cursor = nextCandidate
        const end = cursor === runStart ? runEnd : nonCodeEnd(text, cursor, state)
        const insideUrl = isInsideUrlArgument(cursor)
        if (end === -1) {
          lastSignificant = insideUrl ? lastSignificant : toTextOffset(cursor)
          cursor++
          continue
        }
        runStart = cursor
        runEnd = end
        const isEscapedRun = text[cursor] === '\\'
        if (end > before || (end === before && isUnterminatedRun(text, cursor, end))) {
          /** An escaped run is code, so a query inside one sees its own first character (or its url() argument's "("), left uncommitted so a later query at `cursor` still sees what precedes it. */
          if (!isEscapedRun) {
            return INSIDE_NON_CODE
          }
          return insideUrl ? lastSignificant : toTextOffset(cursor)
        }
        if (!insideUrl && (isEscapedRun || text[cursor] === '"' || text[cursor] === "'")) {
          lastSignificant = toTextOffset(cursor)
        }
        cursor = end
      }
      return lastSignificant
    },
  }
}

/**
 * True when the comment or string run [start, end) nonCodeEnd returned has no closing delimiter,
 * so a caret at its end still types into it: a string that ended at a line break or the end of the
 * text rather than at its matching quote, a block comment with no closing star and slash, or a line
 * comment the text ends inside. A string's closing quote is its last character with an even count
 * of backslashes before it: those backslashes pair up into escaped backslashes.
 */
function isUnterminatedRun(text: string, start: number, end: number): boolean {
  const first = text[start]
  if (first === '/') {
    return text[start + 1] === '*'
      ? end - start < 4 || text[end - 2] !== '*' || text[end - 1] !== '/'
      : !isCodeLineBreak(text[end - 1])
  }
  if (first !== '"' && first !== "'") {
    return false
  }
  if (end - 1 <= start || text[end - 1] !== first) {
    return true
  }
  let backslashes = 0
  while (end - 2 - backslashes > start && text[end - 2 - backslashes] === '\\') {
    backslashes++
  }
  return backslashes % 2 === 1
}

/** An unterminated block comment runs to the end of the text; a line comment ends after its terminator. -1 when `index` opens neither. */
export function commentEnd(text: string, index: number): number {
  const next = text[index + 1]
  if (next === '*') {
    const close = text.indexOf('*/', index + 2)
    return close === -1 ? text.length : close + 2
  }
  if (next === '/') {
    let end = index + 2
    while (end < text.length && !isCodeLineBreak(text[end])) {
      end++
    }
    return end < text.length ? end + 1 : end
  }
  return -1
}

/**
 * A string ends after its matching quote, or before an unescaped line break (isLineBreak), which is
 * then code again. A backslash starts an escape (escapeEnd).
 */
function stringEnd(text: string, index: number, quote: string): number {
  let end = index + 1
  while (end < text.length) {
    const character = text[end]
    if (isLineBreak(character)) {
      return end
    }
    if (character === '\\') {
      end = escapeEnd(text, end, isLineBreak)
      continue
    }
    end++
    if (character === quote) {
      return end
    }
  }
  return end
}

/** The most hex digits a CSS escape reads. */
export const MAX_CSS_HEX_DIGITS = 6

/**
 * The end (exclusive) of the escape whose backslash is at `index`, as vscode-css-languageservice's
 * scanner reads one: up to six hex digits plus one optional space, tab, or line break after them;
 * otherwise the one character after the backslash, where a line break is a whole `\r\n` pair.
 * `isBreak` names the line breaks of the text being scanned: isLineBreak inside a string (which
 * keeps U+2028 and U+2029 verbatim), isCodeLineBreak outside one.
 */
function escapeEnd(
  text: string,
  index: number,
  isBreak: (character: string | undefined) => boolean,
): number {
  const end = hexDigitsEnd(text, index + 1, MAX_CSS_HEX_DIGITS)
  if (end > index + 1) {
    const next = text[end]
    return next === ' ' || next === '\t' ? end + 1 : lineBreakEnd(text, end, isBreak)
  }
  if (end >= text.length) {
    return end
  }
  return isBreak(text[end]) ? lineBreakEnd(text, end, isBreak) : end + 1
}

/** The end of the line break at `index` (a `\r\n` pair counts as one), or `index` when there is none. */
function lineBreakEnd(
  text: string,
  index: number,
  isBreak: (character: string | undefined) => boolean,
): number {
  const character = text[index]
  if (character === '\r' && text[index + 1] === '\n') {
    return index + 2
  }
  return isBreak(character) ? index + 1 : index
}

/**
 * True when the backslash at `index`, outside a string or comment, starts an escape: the CSS
 * scanner escapes no line break there, and in the virtual document a backslash at the end of the
 * template text is followed by the closing wrapper's line break, so it escapes nothing either.
 */
export function startsCodeEscape(text: string, index: number): boolean {
  return isEscapableCharacter(text[index + 1])
}

/**
 * The end of the identifier continuing at `index`: name characters and escapes, as the CSS
 * scanner joins them into one identifier token.
 */
export function identifierEnd(text: string, index: number): number {
  let end = index
  while (end < text.length) {
    if (text[end] === '\\' && startsCodeEscape(text, end)) {
      end = escapeEnd(text, end, isCodeLineBreak)
    } else if (isNameCodeUnit(text.charCodeAt(end))) {
      end++
    } else {
      break
    }
  }
  return end
}

/** Longest identifier that opens an unquoted url() argument: `url-prefix`. */
const MAX_URL_FUNCTION_NAME_LENGTH = 'url-prefix'.length

/**
 * The offset of the "(" after the identifier starting at `index` when that identifier names a
 * function whose argument the CSS parser reads as an unquoted URL: its name, with escapes decoded
 * and compared case-insensitively, is `url` or `url-prefix`, and "(" follows it directly. So
 * `\75 rl(` opens one and `image-url(` does not; -1 otherwise. The caller has checked that `index`
 * starts an identifier.
 */
function findUrlArgumentParenthesis(text: string, index: number): number {
  let name = ''
  let end = index
  while (end < text.length && name.length <= MAX_URL_FUNCTION_NAME_LENGTH) {
    if (text[end] === '\\' && startsCodeEscape(text, end)) {
      const next = escapeEnd(text, end, isCodeLineBreak)
      name += decodeEscape(text, end)
      end = next
    } else if (isNameCodeUnit(text.charCodeAt(end))) {
      name += text[end]
      end++
    } else {
      break
    }
  }
  return text[end] === '(' && namesUrlFunction(name) ? end : -1
}

/**
 * True when `name`, compared case-insensitively, is `url` or `url-prefix`: a function whose
 * argument the CSS parser reads as an unquoted URL.
 */
export function namesUrlFunction(name: string): boolean {
  const lowerName = name.toLowerCase()
  return lowerName === 'url' || lowerName === 'url-prefix'
}

/**
 * The character an escape whose backslash is at `index` stands for, as the CSS scanner decodes it:
 * a hex escape's code unit (none for zero), otherwise the escaped character itself.
 */
function decodeEscape(text: string, index: number): string {
  const end = hexDigitsEnd(text, index + 1, MAX_CSS_HEX_DIGITS)
  if (end === index + 1) {
    return text[end] ?? ''
  }
  const value = parseInt(text.slice(index + 1, end), 16)
  return value === 0 ? '' : String.fromCharCode(value)
}

/**
 * True when a character before a name makes that name part of a longer token, so it starts no
 * identifier: a name character, or the "#" of a hash or "@" of an at-keyword.
 */
function continuesToken(character: string | undefined): boolean {
  return character === '#' || character === '@' || isNameCharacter(character)
}
