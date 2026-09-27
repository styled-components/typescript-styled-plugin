// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'
import { TextDocument } from 'vscode-languageserver-textdocument'

import {
  CSS_TAG_NAME,
  GLOBAL_STYLE_TAG_NAMES,
  KEYFRAMES_TAG_NAME,
} from '../configuration/plugin-configuration.ts'
import {
  commentEnd,
  createCssCodeScanState,
  createScanCandidatePattern,
  identifierEnd,
  isCssWhitespace,
  isLineTerminator,
  isNameCharacter,
  isStatementBoundary,
  isWhitespace,
  LINE_SEPARATOR,
  nonCodeEnd,
  PARAGRAPH_SEPARATOR,
  startsCodeEscape,
} from './css-code-scanner.ts'
import { getTemplateCssText } from './javascript-escapes.ts'
import {
  createTemplateLineMap,
  virtualOffsetToPosition,
  virtualPositionToOffset,
} from './template-line-map.ts'

export interface VirtualDocumentProvider {
  createVirtualDocument(context: TemplateContext): TextDocument
  canReuseVirtualDocument?(previousContext: TemplateContext, context: TemplateContext): boolean
  toVirtualDocPosition(position: ts.LineAndCharacter): ts.LineAndCharacter
  fromVirtualDocPosition(position: ts.LineAndCharacter): ts.LineAndCharacter
  toVirtualDocOffset(offset: number, context: TemplateContext): number
  fromVirtualDocOffset(offset: number, context: TemplateContext): number
  getVirtualDocumentWrapper(context: TemplateContext): string
}

const ROOT_WRAPPER = ':root{\n'
const KEYFRAMES_WRAPPER = '@keyframes custom {\n'
const VALUE_WRAPPER = ':root{all:\n'

export class StyledVirtualDocumentProvider implements VirtualDocumentProvider {
  /**
   * getVirtualDocumentWrapper runs on every offset translation, and the value-wrapper choice scans
   * the substituted text, so each context's reading is kept here, and so is the last one computed:
   * the decorator builds a fresh context per request, and a request on unchanged text reuses it.
   */
  private readonly readingByContext = new WeakMap<TemplateContext, TemplateReading>()
  private lastReading?: {
    readonly rawText: string
    readonly reading: TemplateReading
    readonly tagKind: TagKind
  }

  public constructor(private readonly typescript: typeof ts) {}

  /**
   * The virtual SCSS document for a template (docs/architecture.md, "Virtual document"). Its
   * positionAt/offsetAt read only the template's line map, never the TemplateContext that built
   * it, so a reused document keeps mapping correctly after an edit elsewhere in the file moves the
   * template (docs/architecture.md, "Caching").
   */
  public createVirtualDocument(context: TemplateContext): TextDocument {
    const reading = this.getReading(context)
    return buildVirtualDocument(context, reading.wrapper, reading.topLevelIsNested)
  }

  /**
   * For a `css` template whose text is one identifier, which reads as a value as much as a property
   * name, the same document under the value wrapper, so validation can keep only what both readings
   * report (docs/architecture.md, Virtual document). Undefined for any other template.
   */
  public createValueReadingDocument(context: TemplateContext): TextDocument | undefined {
    const reading = this.getReading(context)
    return reading.isSingleIdentifier
      ? buildVirtualDocument(context, VALUE_WRAPPER, reading.topLevelIsNested)
      : undefined
  }

  /**
   * A cached document's positionAt/offsetAt close over the line map of the *previous* context's
   * raw text, and its text depends on the reading, so reuse requires the same raw text (two
   * placeholders of equal length can substitute to identical context.text while having different
   * line maps) and the same tag kind, of which with the raw text the reading is a pure function.
   */
  public canReuseVirtualDocument(
    previousContext: TemplateContext,
    context: TemplateContext,
  ): boolean {
    return (
      previousContext.fileName === context.fileName &&
      previousContext.rawText === context.rawText &&
      this.getReadingKey(previousContext) === this.getReadingKey(context)
    )
  }

  public toVirtualDocPosition(position: ts.LineAndCharacter): ts.LineAndCharacter {
    return { line: position.line + 1, character: position.character }
  }

  public fromVirtualDocPosition(position: ts.LineAndCharacter): ts.LineAndCharacter {
    return { line: position.line - 1, character: position.character }
  }

  public toVirtualDocOffset(offset: number, context: TemplateContext): number {
    return offset + this.getVirtualDocumentWrapper(context).length
  }

  public fromVirtualDocOffset(offset: number, context: TemplateContext): number {
    return offset - this.getVirtualDocumentWrapper(context).length
  }

  public getVirtualDocumentWrapper(context: TemplateContext): string {
    return this.getReading(context).wrapper
  }

  /**
   * The template's tag kind as a string: everything besides the raw text that its reading, and so
   * its document and diagnostics, depends on. Two contexts with the same raw text and the same key
   * validate alike. Reads only the tag, so a cache key costs no substitution.
   */
  public getReadingKey(context: TemplateContext): string {
    return this.getTagKind(context)
  }

  private getReading(context: TemplateContext): TemplateReading {
    const cached = this.readingByContext.get(context)
    if (cached !== undefined) {
      return cached
    }
    const tagKind = this.getTagKind(context)
    const { lastReading } = this
    const reading =
      lastReading !== undefined &&
      lastReading.tagKind === tagKind &&
      lastReading.rawText === context.rawText
        ? lastReading.reading
        : readTemplate(context, tagKind)
    this.lastReading = { rawText: flattenText(context.rawText), reading, tagKind }
    this.readingByContext.set(context, reading)
    return reading
  }

  private getTagKind(context: TemplateContext): TagKind {
    const parent = context.node.parent
    const tag =
      parent && this.typescript.isTaggedTemplateExpression(parent) ? parent.tag : undefined
    const tagName = getTagName(this.typescript, tag)
    if (tagName === CSS_TAG_NAME) {
      return TagKind.Css
    }
    if (tagName === KEYFRAMES_TAG_NAME) {
      return TagKind.Keyframes
    }
    return tagName !== undefined && GLOBAL_STYLE_TAG_NAMES.includes(tagName)
      ? TagKind.GlobalStyle
      : TagKind.Other
  }
}

/**
 * A copy of `text` that references none of the open file's text: `text` is `context.rawText`, a
 * slice of the whole file, and V8 represents a slice of a long string as a view into its parent.
 * Slicing the leading character back off a concatenation makes V8 flatten that concatenation into a
 * new string first, so the result is at most a view into that fresh copy, one character longer than
 * `text`, never into the file (mirrors flattenCacheKey in src/features/diagnostics.ts).
 */
function flattenText(text: string): string {
  return (' ' + text).slice(1)
}

/** The tag names that read a template differently from any other tag. */
const TagKind = {
  Css: 'css',
  GlobalStyle: 'global-style',
  Keyframes: 'keyframes',
  Other: 'other',
} as const

type TagKind = (typeof TagKind)[keyof typeof TagKind]

/** Everything besides the raw text that shapes a template's document and its diagnostics. */
interface TemplateReading {
  /** A `css` template whose text is one identifier: a value and a property name read it alike. */
  readonly isSingleIdentifier: boolean
  /** A block `@layer` at the template's top level sits in a nested position: every tag but a global-style tag. */
  readonly topLevelIsNested: boolean
  readonly wrapper: string
}

/** Only a `css` template's reading reads its text, the substituted text with escapes replaced. */
function readTemplate(context: TemplateContext, tagKind: TagKind): TemplateReading {
  const shape =
    tagKind === TagKind.Css ? getCssFragmentShape(getTemplateCssText(context)) : undefined
  const wrapper =
    tagKind === TagKind.Keyframes
      ? KEYFRAMES_WRAPPER
      : shape === CssFragmentShape.Value
        ? VALUE_WRAPPER
        : ROOT_WRAPPER
  return {
    isSingleIdentifier: shape === CssFragmentShape.SingleIdentifier,
    topLevelIsNested: tagKind !== TagKind.GlobalStyle,
    wrapper,
  }
}

function buildVirtualDocument(
  context: TemplateContext,
  wrapper: string,
  topLevelIsNested: boolean,
): TextDocument {
  const contents = `${wrapper}${normalizeVirtualText(getTemplateCssText(context), topLevelIsNested)}\n}`
  const lineMap = createTemplateLineMap(context)

  const positionAt = (offset: number): ts.LineAndCharacter =>
    virtualOffsetToPosition(offset, wrapper, lineMap)
  const offsetAt = (position: ts.LineAndCharacter): number =>
    virtualPositionToOffset(position, wrapper, lineMap)

  /**
   * getLineRange/getEOLCharacters/lineCount are not called by vscode-css-languageservice or
   * by this plugin; a plain document over the literal contents satisfies the TextDocument
   * shape for them without needing template-aware translation.
   */
  const lineDocument = TextDocument.create('untitled://embedded.scss', 'scss', 1, contents)

  return {
    uri: lineDocument.uri,
    languageId: lineDocument.languageId,
    version: lineDocument.version,
    getText: (range) =>
      range ? contents.slice(offsetAt(range.start), offsetAt(range.end)) : contents,
    getLineRange: (line) => lineDocument.getLineRange(line),
    getEOLCharacters: (line) => lineDocument.getEOLCharacters(line),
    get lineCount() {
      return lineDocument.lineCount
    },
    positionAt,
    offsetAt,
  }
}

const SEPARATOR_PATTERN = new RegExp(`[${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, 'g')

/** The positions normalizeVirtualText acts on: nonCodeEnd's own, an at-keyword, a brace, and a separator. */
const NORMALIZE_CANDIDATE_PATTERN = createScanCandidatePattern(
  `@{}${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}`,
)

/**
 * Separator normalization and the nested block `@layer` rewrite (docs/architecture.md, "Virtual
 * document"), in one pass that jumps between the positions either can act on and copies each
 * stretch between them unchanged. Skipped when the text holds neither a separator nor `@layer`.
 */
function normalizeVirtualText(text: string, topLevelIsNested: boolean): string {
  const hasSeparator = text.includes(LINE_SEPARATOR) || text.includes(PARAGRAPH_SEPARATOR)
  if (!hasSeparator && !hasLayerKeyword(text)) {
    return text
  }

  let result = ''
  let copiedUntil = 0
  let depth = 0
  const state = createCssCodeScanState()
  const candidates = NORMALIZE_CANDIDATE_PATTERN
  let index = 0
  for (;;) {
    candidates.lastIndex = index
    const match = candidates.exec(text)
    if (match === null) {
      break
    }
    index = match.index
    const character = text[index]
    const end = nonCodeEnd(text, index, state)
    if (end !== -1) {
      if (hasSeparator && character !== '"' && character !== "'") {
        result +=
          text.slice(copiedUntil, index) + text.slice(index, end).replace(SEPARATOR_PATTERN, '\n')
        copiedUntil = end
      }
      index = end
      continue
    }

    if (!state.url && character === '@' && (depth > 0 || topLevelIsNested)) {
      const bodyStart = findLayerBlockBodyStart(text, index)
      if (bodyStart !== undefined) {
        /** Outside whole comments the prelude holds no quote, "/", "(", or ")" (findLayerBlockBodyStart), so skipping it past nonCodeEnd is safe. */
        result += text.slice(copiedUntil, index) + rewriteLayerPrelude(text, index, bodyStart)
        copiedUntil = index = bodyStart
        continue
      }
    }
    if (!state.url && character === '{') {
      depth++
    } else if (!state.url && character === '}') {
      depth--
    } else if (character === LINE_SEPARATOR || character === PARAGRAPH_SEPARATOR) {
      result += `${text.slice(copiedUntil, index)}\n`
      copiedUntil = index + 1
    }
    index++
  }
  return result + text.slice(copiedUntil)
}

const CssFragmentShape = {
  /** Declarations, rules, or nothing: the declaration wrapper. */
  Other: 'other',
  /** One identifier, a value or a property name being typed: the declaration wrapper, for completions. */
  SingleIdentifier: 'single-identifier',
  /** A property value: the value wrapper. */
  Value: 'value',
} as const

type CssFragmentShape = (typeof CssFragmentShape)[keyof typeof CssFragmentShape]

/** The positions getCssFragmentShape acts on: nonCodeEnd's own and the structural characters. */
const FRAGMENT_CANDIDATE_PATTERN = createScanCandidatePattern(';{}:()')

/**
 * How a `css` template's substituted text reads (docs/architecture.md, Virtual document, for the
 * rule): as a single property value, as one identifier, or as declarations or rules. A string's
 * opening quote and a whole escaped run count as significant text, a comment does not. Jumps
 * between the positions that can change the answer, and stops at the first structural character,
 * so an ordinary declaration fragment costs only the scan up to its first ":".
 */
function getCssFragmentShape(text: string): CssFragmentShape {
  let parenthesisDepth = 0
  let firstSignificant = -1
  let lastSignificant = -1
  /** Records the first and last non-whitespace characters of [from, to), all of it plain code. */
  const readPlainCode = (from: number, to: number) => {
    let last = to - 1
    while (last >= from && isWhitespace(text[last])) {
      last--
    }
    if (last < from) {
      return
    }
    lastSignificant = last
    if (firstSignificant === -1) {
      let first = from
      while (isWhitespace(text[first])) {
        first++
      }
      firstSignificant = first
    }
  }
  const state = createCssCodeScanState()
  const candidates = FRAGMENT_CANDIDATE_PATTERN
  let index = 0
  while (index < text.length) {
    candidates.lastIndex = index
    const candidate = candidates.exec(text)?.index ?? text.length
    readPlainCode(index, candidate)
    if (candidate === text.length) {
      break
    }
    index = candidate
    const character = text[index]
    const end = nonCodeEnd(text, index, state)
    if (end !== -1) {
      if (character === '\\' || character === '"' || character === "'") {
        firstSignificant = firstSignificant === -1 ? index : firstSignificant
        lastSignificant = character === '\\' ? end - 1 : index
      }
      index = end
      continue
    }
    if (!state.url && isStatementBoundary(character)) {
      return CssFragmentShape.Other
    }
    if (character === ':' && parenthesisDepth === 0) {
      return CssFragmentShape.Other
    }
    if (character === '(') {
      parenthesisDepth++
    } else if (character === ')') {
      parenthesisDepth = Math.max(parenthesisDepth - 1, 0)
    }
    readPlainCode(index, index + 1)
    index++
  }
  if (firstSignificant === -1 || startsSelectorOrAtRule(text, firstSignificant)) {
    return CssFragmentShape.Other
  }
  return isSingleIdentifier(text, firstSignificant, lastSignificant + 1)
    ? CssFragmentShape.SingleIdentifier
    : CssFragmentShape.Value
}

/**
 * True when [start, end) is one CSS identifier and nothing else (up to two leading "-", then a
 * name-start character or an escape, then name characters and escapes, as the CSS scanner joins
 * them), the shape of a property name mid-typing (`dis`) as much as of a keyword value (`green`).
 */
function isSingleIdentifier(text: string, start: number, end: number): boolean {
  let index = start
  while (index < end && index - start < 2 && text[index] === '-') {
    index++
  }
  const nameStart = text.charCodeAt(index)
  const isNameStart =
    (nameStart >= 0x61 && nameStart <= 0x7a) ||
    (nameStart >= 0x41 && nameStart <= 0x5a) ||
    nameStart === 0x5f ||
    nameStart > 0x7f ||
    (text[index] === '\\' && startsCodeEscape(text, index))
  if (index >= end || !isNameStart) {
    return false
  }
  return identifierEnd(text, index) >= end
}

function startsSelectorOrAtRule(text: string, index: number): boolean {
  const character = text[index]
  if (character === '.') {
    const next = text.charCodeAt(index + 1)
    return !(next >= 0x30 && next <= 0x39)
  }
  return (
    character === '&' ||
    character === '>' ||
    character === '+' ||
    character === '~' ||
    character === '*' ||
    character === '[' ||
    character === '@'
  )
}

/** The at-keyword, matched case-insensitively as the CSS parser matches keywords. Sticky, so it matches at `lastIndex` only. */
const LAYER_KEYWORD_PATTERN = /@layer/iy
const LAYER_KEYWORD_LENGTH = '@layer'.length

/** True when `@layer` appears anywhere in any letter case; "@" is rare in CSS, so this visits few places. */
function hasLayerKeyword(text: string): boolean {
  for (let index = text.indexOf('@'); index !== -1; index = text.indexOf('@', index + 1)) {
    LAYER_KEYWORD_PATTERN.lastIndex = index
    if (LAYER_KEYWORD_PATTERN.test(text)) {
      return true
    }
  }
  return false
}

/**
 * Returns the offset of the "{" that opens a block `@layer` whose keyword starts at `atOffset`, or
 * undefined when the text there is not one: the keyword must be followed by whitespace, a comment,
 * or "{", then at most one layer name (name characters and "." separators) surrounded by
 * whitespace and comments, which separate tokens the way whitespace does. A list prelude, a
 * statement form, an unterminated comment, or any other character (a string, an interpolation's
 * filler that is not a name) leaves the prelude untouched. Scans at most the prelude itself.
 */
function findLayerBlockBodyStart(text: string, atOffset: number): number | undefined {
  LAYER_KEYWORD_PATTERN.lastIndex = atOffset
  if (!LAYER_KEYWORD_PATTERN.test(text)) {
    return undefined
  }
  let index = atOffset + LAYER_KEYWORD_LENGTH
  const afterKeyword = text[index]
  if (afterKeyword !== '{' && afterKeyword !== '/' && !isCssWhitespace(afterKeyword)) {
    return undefined
  }
  let sawName = false
  let nameEnded = false
  for (; index < text.length; index++) {
    const character = text[index]
    if (character === '{') {
      return index
    }
    if (character === '/') {
      const end = commentEnd(text, index)
      if (end === -1) {
        return undefined
      }
      nameEnded ||= sawName
      index = end - 1
      continue
    }
    if (isCssWhitespace(character)) {
      nameEnded ||= sawName
      continue
    }
    if (nameEnded || !isLayerNameCharacter(character)) {
      return undefined
    }
    sawName = true
  }
  return undefined
}

/**
 * Same-length replacement for a block `@layer` prelude spanning [start, end): every character
 * becomes a space except line terminators (kept, with U+2028/U+2029 normalized to "\n" as
 * everywhere else outside strings) and the last non-terminator character, which becomes "&", so
 * `@layer utilities {` becomes spaces followed by `&{`. Hover over the keyword lands on
 * whitespace, the same empty result the parser gives for a well-formed `@layer` keyword.
 */
function rewriteLayerPrelude(text: string, start: number, end: number): string {
  let ampersandOffset = end - 1
  while (ampersandOffset > start && isLineTerminator(text[ampersandOffset])) {
    ampersandOffset--
  }
  let result = ''
  for (let index = start; index < end; index++) {
    const character = text[index]
    if (index === ampersandOffset) {
      result += '&'
    } else if (isLineTerminator(character)) {
      result += character === '\r' ? character : '\n'
    } else {
      result += ' '
    }
  }
  return result
}

/**
 * Name characters plus the "." that separates the segments of a dotted layer name such as
 * `framework.base`. Placeholder filler ("x") qualifies, so `@layer ${name} {` is rewritten too.
 */
function isLayerNameCharacter(character: string): boolean {
  return character === '.' || isNameCharacter(character)
}

function getTagName(typescript: typeof ts, tag: ts.Expression | undefined): string | undefined {
  if (tag && typescript.isIdentifier(tag)) {
    return tag.text
  }
  if (tag && typescript.isPropertyAccessExpression(tag)) {
    return tag.name.text
  }
  return undefined
}
