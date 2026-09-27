import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'
import type { FoldingRange } from 'vscode-css-languageservice'

import type { VirtualDocumentProvider } from '../virtual-document/styled-virtual-document-provider.ts'
import { fromVirtualDocSpan, type TemplateLineMap } from '../virtual-document/template-line-map.ts'
import type { VirtualDocumentSessionProvider } from '../virtual-document/virtual-document-session-provider.ts'
import type { ScssLanguageService } from './styles-language-services.ts'

export class FoldingFeature {
  public constructor(
    private readonly typescript: typeof ts,
    private readonly virtualDocumentProvider: VirtualDocumentProvider,
    private readonly virtualDocumentSessionProvider: VirtualDocumentSessionProvider,
    private readonly scssLanguageService: ScssLanguageService,
  ) {}

  public getOutliningSpans(context: TemplateContext): ts.OutliningSpan[] {
    const { document, lineMap } = this.virtualDocumentSessionProvider.getDocument(context)
    return this.scssLanguageService
      .getFoldingRanges(document)
      .map((range) => this.translateRange(range, lineMap))
      .filter((range) => range !== undefined)
  }

  private translateRange(
    range: FoldingRange,
    lineMap: TemplateLineMap,
  ): ts.OutliningSpan | undefined {
    const span = fromVirtualDocSpan(
      this.virtualDocumentProvider,
      {
        end: { line: range.endLine, character: range.endCharacter ?? 0 },
        start: { line: range.startLine, character: range.startCharacter ?? 0 },
      },
      lineMap,
    )
    if (!span) {
      return undefined
    }
    const textSpan = { length: span.end - span.start, start: span.start }
    return {
      autoCollapse: false,
      bannerText: '',
      hintSpan: textSpan,
      kind: this.typescript.OutliningSpanKind.Code,
      textSpan,
    }
  }
}
