import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'
import type { Hover } from 'vscode-css-languageservice'

import type { VirtualDocumentProvider } from '../virtual-document/styled-virtual-document-provider.ts'
import { fromVirtualDocSpan, type TemplateLineMap } from '../virtual-document/template-line-map.ts'
import type { VirtualDocumentSessionProvider } from '../virtual-document/virtual-document-session-provider.ts'
import { markupText } from './markup-text.ts'
import type { ScssLanguageService } from './styles-language-services.ts'

export class HoverFeature {
  public constructor(
    private readonly typescript: typeof ts,
    private readonly virtualDocumentProvider: VirtualDocumentProvider,
    private readonly virtualDocumentSessionProvider: VirtualDocumentSessionProvider,
    private readonly scssLanguageService: ScssLanguageService,
  ) {}

  public getQuickInfoAtPosition(
    context: TemplateContext,
    position: ts.LineAndCharacter,
  ): ts.QuickInfo | undefined {
    if (context.rawText.length === 0) {
      return undefined
    }

    const { document, lineMap, stylesheet } =
      this.virtualDocumentSessionProvider.getParsedDocument(context)
    const virtualPosition = this.virtualDocumentProvider.toVirtualDocPosition(position)
    const hover = this.scssLanguageService.doHover(document, virtualPosition, stylesheet)
    return hover ? this.translateHover(hover, virtualPosition, lineMap) : undefined
  }

  private translateHover(
    hover: Hover,
    virtualPosition: ts.LineAndCharacter,
    lineMap: TemplateLineMap,
  ): ts.QuickInfo | undefined {
    const span = fromVirtualDocSpan(
      this.virtualDocumentProvider,
      hover.range ?? { end: virtualPosition, start: virtualPosition },
      lineMap,
    )
    if (!span) {
      return undefined
    }

    const length = hover.range
      ? span.end - span.start
      : Math.min(1, lineMap.templateEnd.offset - span.start)
    return {
      displayParts: [],
      documentation: toDisplayParts(hover.contents),
      kind: this.typescript.ScriptElementKind.unknown,
      kindModifiers: '',
      tags: [],
      textSpan: { length, start: span.start },
    }
  }
}

function toDisplayParts(contents: Hover['contents']): ts.SymbolDisplayPart[] {
  if (Array.isArray(contents)) {
    return contents.flatMap(toDisplayParts)
  }
  return [{ kind: 'unknown', text: markupText(contents) }]
}
