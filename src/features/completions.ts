import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'
import type { CompletionItem, CompletionList, MarkupContent } from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { CompletionItemKind } from 'vscode-languageserver-types'

import type { StyledPluginConfiguration } from '../configuration/plugin-configuration.ts'
import {
  createCodeLookback,
  createCssCodeScanState,
  INSIDE_NON_CODE,
  isNameCharacter,
  isStatementBoundary,
  isWhitespace,
  NO_SIGNIFICANT_CHARACTER,
  nonCodeEnd,
} from '../virtual-document/css-code-scanner.ts'
import type { EscapeRun } from '../virtual-document/javascript-escapes.ts'
import {
  StyledVirtualDocumentProvider,
  type VirtualDocumentProvider,
} from '../virtual-document/styled-virtual-document-provider.ts'
import {
  positionsEqual,
  type TemplateLineMap,
  widenToEscapeRuns,
} from '../virtual-document/template-line-map.ts'
import type { VirtualDocumentSessionProvider } from '../virtual-document/virtual-document-session-provider.ts'
import { markupText } from './markup-text.ts'
import type {
  CssLanguageService,
  EmmetCompletionProvider,
  ScssLanguageService,
} from './styles-language-services.ts'

/**
 * A fresh object per call, never a shared module-level constant: StyledTemplateLanguageService
 * is also the public ./api surface, so a third-party consumer holding and mutating a returned
 * CompletionInfo (appending its own entries, for example) must not corrupt every other empty-
 * template completion result for the rest of the process.
 */
export function createEmptyCompletionInfo(): ts.WithMetadata<ts.CompletionInfo> {
  return {
    entries: [],
    isGlobalCompletion: false,
    isMemberCompletion: false,
    isNewIdentifierLocation: false,
    metadata: { isIncomplete: false },
  }
}

/** The details of an entry the completion list does not hold: its name alone. */
export function createUnknownCompletionEntryDetails(
  typescript: typeof ts,
  name: string,
): ts.CompletionEntryDetails {
  return {
    displayParts: toDisplayParts(name),
    documentation: [],
    kind: typescript.ScriptElementKind.unknown,
    kindModifiers: '',
    name,
    tags: [],
  }
}

interface CompletionResult {
  readonly document: TextDocument
  readonly lineMap: TemplateLineMap
  readonly list: CompletionList
}

export class CompletionsFeature {
  private readonly cache: CompletionsCache
  private nestedAtRuleCatalog?: readonly CompletionItem[]

  public constructor(
    private readonly typescript: typeof ts,
    private readonly virtualDocumentProvider: VirtualDocumentProvider,
    private readonly virtualDocumentSessionProvider: VirtualDocumentSessionProvider,
    private readonly cssLanguageService: CssLanguageService,
    private readonly scssLanguageService: ScssLanguageService,
    private readonly emmetCompletionProvider: EmmetCompletionProvider,
    private readonly getConfiguration: () => StyledPluginConfiguration,
  ) {
    this.cache = new CompletionsCache(virtualDocumentProvider)
  }

  public clearCache() {
    this.cache.clear()
  }

  public getCompletionsAtPosition(
    context: TemplateContext,
    position: ts.LineAndCharacter,
  ): ts.WithMetadata<ts.CompletionInfo> {
    const entry = this.getCompletionEntry(context, position)
    if (!entry) {
      return createEmptyCompletionInfo()
    }
    entry.info ??= translateCompletionListToCompletionInfo(
      this.typescript,
      this.virtualDocumentProvider,
      context,
      entry.result,
    )
    return cloneCompletionInfo(entry.info)
  }

  public getCompletionEntryDetails(
    context: TemplateContext,
    position: ts.LineAndCharacter,
    name: string,
  ): ts.CompletionEntryDetails {
    const item = this.getCompletionEntry(context, position)?.result.list.items.find(
      (candidate) => candidate.label === name,
    )
    return item
      ? translateCompletionItemToCompletionEntryDetails(this.typescript, item)
      : createUnknownCompletionEntryDetails(this.typescript, name)
  }

  private getCompletionEntry(
    context: TemplateContext,
    position: ts.LineAndCharacter,
  ): CompletionsCacheEntry | undefined {
    const cached = this.cache.get(context, position)
    if (cached) {
      return cached
    }
    const result = this.computeCompletions(context, position)
    return result && this.cache.set(context, position, result)
  }

  private computeCompletions(
    context: TemplateContext,
    position: ts.LineAndCharacter,
  ): CompletionResult | undefined {
    const { document, lineMap, stylesheet } =
      this.virtualDocumentSessionProvider.getParsedDocument(context)
    const virtualPosition = this.virtualDocumentProvider.toVirtualDocPosition(position)
    const configuration = this.getConfiguration()
    const templateStart = this.virtualDocumentProvider.toVirtualDocOffset(0, context)
    const emmetItems =
      this.emmetCompletionProvider.doComplete(
        withTemplateLineBreaks(document, lineMap, templateStart),
        virtualPosition,
        configuration.emmet,
      )?.items ?? []
    const text = document.getText()
    const caretOffset = document.offsetAt(virtualPosition)
    const caretPlacement = findCaretPlacement(
      text,
      caretOffset,
      emmetItems.some(expandsToDeclaration),
    )
    if (caretPlacement === CaretPlacement.NonCode) {
      return undefined
    }

    const items = [
      ...this.cssLanguageService.doComplete(document, virtualPosition, stylesheet).items,
      ...filterScssCompletionItems(
        this.scssLanguageService.doComplete(document, virtualPosition, stylesheet).items,
      ),
    ]
    const atKeywordRange = findStatementAtKeywordRange(text, caretOffset, templateStart)
    if (atKeywordRange) {
      const labels = new Set(items.map((item) => item.label))
      const range = {
        end: document.positionAt(atKeywordRange.end),
        start: document.positionAt(atKeywordRange.start),
      }
      for (const atRule of this.getNestedAtRuleCatalog()) {
        if (!labels.has(atRule.label)) {
          items.push({ ...atRule, textEdit: { newText: atRule.label, range } })
        }
      }
    }
    const placedEmmetItems =
      caretPlacement === CaretPlacement.NoDeclaration
        ? emmetItems.filter((item) => !expandsToDeclaration(item))
        : emmetItems
    items.push(...placedEmmetItems)
    return { document, lineMap, list: { isIncomplete: placedEmmetItems.length > 0, items } }
  }

  /**
   * The CSS language service's own top-level at-rule completions for the names in
   * NESTED_AT_RULE_NAMES (docs/architecture.md, Completions), requested on first use: the at-rule
   * data is fixed for the life of the service and independent of configuration.
   */
  private getNestedAtRuleCatalog(): readonly CompletionItem[] {
    if (!this.nestedAtRuleCatalog) {
      const document = TextDocument.create(
        'untitled://nested-at-rules.css',
        'css',
        1,
        AT_KEYWORD_START,
      )
      this.nestedAtRuleCatalog = this.cssLanguageService
        .doComplete(
          document,
          document.positionAt(AT_KEYWORD_START.length),
          this.scssLanguageService.parseStylesheet(document),
        )
        .items.filter((item) => NESTED_AT_RULE_NAMES.has(item.label))
        .map(({ documentation, kind, label }) => ({ documentation, kind, label }))
    }
    return this.nestedAtRuleCatalog
  }
}

const AT_KEYWORD_START = '@'

/**
 * At-rules valid directly inside a style rule, plus the ones styled-components hoists out of a
 * component to the stylesheet's top level that the CSS language service also completes at the
 * top level (docs/architecture.md, Completions).
 */
const NESTED_AT_RULE_NAMES: ReadonlySet<string> = new Set([
  '@container',
  '@counter-style',
  '@font-face',
  '@font-palette-values',
  '@keyframes',
  '@layer',
  '@media',
  '@page',
  '@property',
  '@scope',
  '@starting-style',
  '@supports',
])

/**
 * The [start, end) offsets of the at-keyword around `caretOffset` in the virtual document text
 * (the "@" through the last name character after the caret), when that keyword is code and starts
 * a statement: the nearest significant character before it, at or after `templateStart` and past
 * comments (createCodeLookback), is ";", "{", or "}", or there is none (the template start). Only a
 * caret on an at-keyword pays for the lookback, one forward pass from the template start.
 */
function findStatementAtKeywordRange(
  text: string,
  caretOffset: number,
  templateStart: number,
): { end: number; start: number } | undefined {
  let start = caretOffset
  while (start > templateStart && isNameCharacter(text[start - 1])) {
    start--
  }
  if (start <= templateStart || text[start - 1] !== AT_KEYWORD_START) {
    return undefined
  }
  start--

  const before = createCodeLookback(text, templateStart).previousSignificant(start)
  if (before === INSIDE_NON_CODE) {
    return undefined
  }
  if (before !== NO_SIGNIFICANT_CHARACTER && !isStatementBoundary(text[before])) {
    return undefined
  }

  let end = caretOffset
  while (end < text.length && isNameCharacter(text[end])) {
    end++
  }
  return { end, start }
}

const CaretPlacement = {
  NoDeclaration: 'no-declaration',
  NonCode: 'non-code',
  Other: 'other',
} as const

type CaretPlacement = (typeof CaretPlacement)[keyof typeof CaretPlacement]

/**
 * Classifies the caret in the virtual document text (docs/architecture.md, Completions): NonCode
 * inside a comment or string, the end of an unterminated one included; NoDeclaration where no
 * declaration can start, which is when the last structural code character before the caret (";",
 * "{", "}", or ":", the wrapper included) is ":" (a value, a selector with a pseudo-class, or a
 * media feature), or when the statement it ends starts with an at-keyword (an at-rule prelude);
 * Other everywhere else. The declaration test runs only when `checkDeclarationStart` is set (an
 * Emmet item expands to a declaration). It first tries the nearest structural character before the
 * caret, which is code in the common case, and walks every structural character from the start
 * only when that one lies in a comment or string (a lower lookback query restarts the scan);
 * queries otherwise only move forward, so the classification costs at most two passes over the
 * text before the caret, plus the whitespace and comments that open the caret's statement.
 */
function findCaretPlacement(
  text: string,
  caretOffset: number,
  checkDeclarationStart: boolean,
): CaretPlacement {
  const lookback = createCodeLookback(text, 0)
  const isCodeAt = (index: number) => lookback.previousSignificant(index + 1) === index
  let lastStructuralIndex = -1
  if (checkDeclarationStart) {
    let nearest = caretOffset - 1
    while (nearest >= 0 && !isStructuralCharacter(text[nearest])) {
      nearest--
    }
    if (nearest >= 0 && isCodeAt(nearest)) {
      lastStructuralIndex = nearest
    } else if (nearest >= 0) {
      for (let index = 0; index < nearest; index++) {
        if (isStructuralCharacter(text[index]) && isCodeAt(index)) {
          lastStructuralIndex = index
        }
      }
    }
  }
  if (lookback.previousSignificant(caretOffset) === INSIDE_NON_CODE) {
    return CaretPlacement.NonCode
  }
  if (!checkDeclarationStart) {
    return CaretPlacement.Other
  }
  return text[lastStructuralIndex] === ':' ||
    startsWithAtKeyword(text, lastStructuralIndex + 1, caretOffset)
    ? CaretPlacement.NoDeclaration
    : CaretPlacement.Other
}

/**
 * True when the first code character in [from, to), past whitespace and comments, is "@": the
 * statement there is an at-rule prelude.
 */
function startsWithAtKeyword(text: string, from: number, to: number): boolean {
  const state = createCssCodeScanState()
  let index = from
  while (index < to) {
    const character = text[index]
    if (isWhitespace(character)) {
      index++
      continue
    }
    const commentEnd = character === '/' ? nonCodeEnd(text, index, state) : -1
    if (commentEnd === -1) {
      return character === AT_KEYWORD_START
    }
    index = commentEnd
  }
  return false
}

/**
 * `document` with "\n" at the end of every template line, for Emmet, which reads the caret's line
 * from the text between "\n" characters (`getCurrentLine`, @vscode/emmet-helper) while positions
 * follow the template's own lines (docs/architecture.md, Completions). `document` itself when every
 * template line already ends in "\n" there.
 */
export function withTemplateLineBreaks(
  document: TextDocument,
  { lineStarts }: TemplateLineMap,
  templateStart: number,
): TextDocument {
  const text = document.getText()
  let aligned = ''
  let cursor = 0
  for (let line = 1; line < lineStarts.length; line++) {
    const lineEnd = templateStart + lineStarts[line] - 1
    if (text[lineEnd] !== '\n') {
      aligned += `${text.slice(cursor, lineEnd)}\n`
      cursor = lineEnd + 1
    }
  }
  if (cursor === 0) {
    return document
  }
  aligned += text.slice(cursor)
  return TextDocument.create(document.uri, document.languageId, document.version, aligned)
}

/**
 * An Emmet expansion that is a whole declaration (`float: left;`) rather than a value (`#121212`,
 * `!important`). Emmet labels an item with its expanded text, so the property's ":" marks it.
 */
function expandsToDeclaration(item: CompletionItem): boolean {
  return item.label.includes(':')
}

function isStructuralCharacter(character: string | undefined): boolean {
  return isStatementBoundary(character) || character === ':'
}

/**
 * The last computed completions, reused for a request at the same position when
 * canReuseVirtualDocument holds for the context that computed them: every value the translated
 * CompletionInfo holds (replacement spans, the template-end bound) is a pure function of what that
 * rule proves equal, so `info` stays correct for a different, reusable context too.
 */
interface CompletionsCacheEntry {
  readonly context: TemplateContext
  info?: ts.WithMetadata<ts.CompletionInfo>
  readonly position: ts.LineAndCharacter
  readonly result: CompletionResult
}

class CompletionsCache {
  private entry?: CompletionsCacheEntry

  public constructor(private readonly virtualDocumentProvider: VirtualDocumentProvider) {}

  public get(
    context: TemplateContext,
    position: ts.LineAndCharacter,
  ): CompletionsCacheEntry | undefined {
    const { entry } = this
    return entry &&
      positionsEqual(position, entry.position) &&
      (this.virtualDocumentProvider.canReuseVirtualDocument?.(entry.context, context) ?? false)
      ? entry
      : undefined
  }

  public set(
    context: TemplateContext,
    position: ts.LineAndCharacter,
    result: CompletionResult,
  ): CompletionsCacheEntry {
    this.entry = { context, position, result }
    return this.entry
  }

  public clear() {
    this.entry = undefined
  }
}

/**
 * Returns a shallow copy of a translated CompletionInfo, with a fresh entries array of
 * shallow-copied entry objects (and, for an entry that has one, a shallow-copied
 * replacementSpan): CompletionsCache returns the same underlying CompletionInfo to every request
 * at the same position (docs/architecture.md, "Caching"), so every caller, cached or not, gets
 * its own object graph it can freely mutate (appending an entry, renaming one, sorting the list)
 * without corrupting the cached original or a later caller's result. ./api exposes
 * StyledTemplateLanguageService directly to third-party consumers who may reasonably do exactly
 * that; typescript-template-language-service-decorator's own translateCompletionInfo and
 * translateCompletionEntry already shallow-copy the info and every entry before returning them to
 * a tsserver caller, so this only matters for a direct ./api caller (node_modules/typescript-
 * template-language-service-decorator/lib/template-language-service-decorator.js).
 */
function cloneCompletionInfo(
  info: ts.WithMetadata<ts.CompletionInfo>,
): ts.WithMetadata<ts.CompletionInfo> {
  return {
    ...info,
    entries: info.entries.map((entry) => ({
      ...entry,
      ...(entry.replacementSpan ? { replacementSpan: { ...entry.replacementSpan } } : {}),
    })),
    metadata: info.metadata ? { ...info.metadata } : info.metadata,
  }
}

function filterScssCompletionItems(items: readonly CompletionItem[]): CompletionItem[] {
  return items.filter(
    (item) => item.kind === CompletionItemKind.Function && item.label.startsWith(':'),
  )
}

/** Per-list values every entry's translation reads: the template's virtual-document offsets and escape runs. */
interface TemplateBounds {
  readonly end: number
  readonly escapeRuns: readonly EscapeRun[]
  readonly start: number
  toTemplateOffset(virtualOffset: number): number
}

function translateCompletionListToCompletionInfo(
  typescript: typeof ts,
  virtualDocumentProvider: VirtualDocumentProvider,
  context: TemplateContext,
  { document, lineMap, list }: CompletionResult,
): ts.WithMetadata<ts.CompletionInfo> {
  const start = virtualDocumentProvider.toVirtualDocOffset(0, context)
  /**
   * The built-in provider maps offsets by a fixed shift, so each entry subtracts it; any other
   * provider keeps its own mapping, which the public contract does not require to be a shift.
   */
  const isShiftMapped = virtualDocumentProvider instanceof StyledVirtualDocumentProvider
  const template: TemplateBounds = {
    end: isShiftMapped
      ? start + context.rawText.length
      : virtualDocumentProvider.toVirtualDocOffset(context.rawText.length, context),
    escapeRuns: lineMap.escapeRuns,
    start,
    toTemplateOffset: isShiftMapped
      ? (offset) => offset - start
      : (offset) => virtualDocumentProvider.fromVirtualDocOffset(offset, context),
  }
  const entries: ts.CompletionEntry[] = []
  for (const item of list.items) {
    const entry = translateCompletionEntry({ document, item, template, typescript })
    if (entry) {
      entries.push(entry)
    }
  }

  return {
    entries,
    isGlobalCompletion: false,
    isMemberCompletion: false,
    isNewIdentifierLocation: false,
    metadata: { isIncomplete: list.isIncomplete },
  }
}

function translateCompletionItemToCompletionEntryDetails(
  typescript: typeof ts,
  item: CompletionItem,
): ts.CompletionEntryDetails {
  return {
    displayParts: toDisplayParts(item.detail),
    documentation: toDisplayParts(item.documentation),
    kind: translateCompletionItemKind(typescript, item.kind),
    kindModifiers: getKindModifiers(item),
    name: item.label,
    tags: [],
  }
}

interface CompletionEntryTranslation {
  readonly document: TextDocument
  readonly item: CompletionItem
  readonly template: TemplateBounds
  readonly typescript: typeof ts
}

/**
 * Never sets insertText or isSnippet, matching 1.0.1's translateCompetionEntry exactly (lib/
 * _language-service.js), which built an entry from name/kind/kindModifiers/sortText/
 * replacementSpan alone and left insertion to the client's own handling of an entry's name. A
 * snippet-format item's insertText (for example `border: ${1:1px} ${2:solid} ${3:black};$0`) is
 * only safe for a client that renders its tab stops, and tsserver's
 * includeCompletionsWithSnippetText preference, the only signal for that, is not trustworthy:
 * VS Code's TypeScript extension always sends it as true regardless of whether the actual editor
 * surface renders snippets, so honoring it would insert raw tab-stop syntax into every VS Code
 * user's buffer instead of the entry's name.
 */
function translateCompletionEntry({
  document,
  item,
  template,
  typescript,
}: CompletionEntryTranslation): ts.CompletionEntry | undefined {
  const textEdit = item.textEdit
  const range = textEdit && ('range' in textEdit ? textEdit.range : textEdit.replace)
  const start = range ? document.offsetAt(range.start) : 0
  const end = range ? document.offsetAt(range.end) : 0
  if (range && (start < template.start || end < start || end > template.end)) {
    return undefined
  }

  const entry: ts.CompletionEntry = {
    kind: translateCompletionItemKind(typescript, item.kind),
    kindModifiers: getKindModifiers(item),
    name: item.label,
    sortText: item.sortText || item.label,
  }
  if (range) {
    const source = widenToEscapeRuns(
      template.toTemplateOffset(start),
      template.toTemplateOffset(end),
      template.escapeRuns,
    )
    entry.replacementSpan = {
      length: source.end - source.start,
      start: source.start,
    }
  }
  return entry
}

function translateCompletionItemKind(
  typescript: typeof ts,
  kind: CompletionItemKind | undefined,
): ts.ScriptElementKind {
  switch (kind) {
    case CompletionItemKind.Method:
      return typescript.ScriptElementKind.memberFunctionElement
    case CompletionItemKind.Function:
      return typescript.ScriptElementKind.functionElement
    case CompletionItemKind.Constructor:
      return typescript.ScriptElementKind.constructorImplementationElement
    case CompletionItemKind.Field:
    case CompletionItemKind.Variable:
      return typescript.ScriptElementKind.variableElement
    case CompletionItemKind.Class:
      return typescript.ScriptElementKind.classElement
    case CompletionItemKind.Interface:
      return typescript.ScriptElementKind.interfaceElement
    case CompletionItemKind.Module:
      return typescript.ScriptElementKind.moduleElement
    case CompletionItemKind.Property:
      return typescript.ScriptElementKind.memberVariableElement
    case CompletionItemKind.Unit:
    case CompletionItemKind.Value:
    case CompletionItemKind.Color:
      return typescript.ScriptElementKind.constElement
    case CompletionItemKind.Enum:
      return typescript.ScriptElementKind.enumElement
    case CompletionItemKind.Keyword:
      return typescript.ScriptElementKind.keyword
    case CompletionItemKind.Reference:
      return typescript.ScriptElementKind.alias
    case CompletionItemKind.File:
      return typescript.ScriptElementKind.moduleElement
    case CompletionItemKind.Snippet:
    case CompletionItemKind.Text:
    default:
      return typescript.ScriptElementKind.unknown
  }
}

function getKindModifiers(item: CompletionItem): string {
  return item.kind === CompletionItemKind.Color ? 'color' : ''
}

function toDisplayParts(text: string | MarkupContent | undefined): ts.SymbolDisplayPart[] {
  return text ? [{ kind: 'text', text: markupText(text) }] : []
}
