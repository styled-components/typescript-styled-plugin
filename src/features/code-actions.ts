import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'
import type { Command, Range } from 'vscode-css-languageservice'
import { TextEdit } from 'vscode-languageserver-types'

import type { VirtualDocumentProvider } from '../virtual-document/styled-virtual-document-provider.ts'
import {
  fromVirtualDocSpanStrict,
  templateOffsetToPosition,
  type TemplateLineMap,
  type TemplateSpan,
} from '../virtual-document/template-line-map.ts'
import type { VirtualDocumentSessionProvider } from '../virtual-document/virtual-document-session-provider.ts'
import { CSS_DIAGNOSTIC_CODE } from './css-diagnostic-code.ts'
import type { DiagnosticsFeature } from './diagnostics.ts'
import type { ScssLanguageService } from './styles-language-services.ts'

/** The command vscode-css-languageservice wraps every quick fix in (cssCodeActions.js). */
export const CSS_APPLY_CODE_ACTION_COMMAND = '_css.applyCodeAction'

export class CodeActionsFeature {
  public constructor(
    private readonly virtualDocumentProvider: VirtualDocumentProvider,
    private readonly virtualDocumentSessionProvider: VirtualDocumentSessionProvider,
    private readonly scssLanguageService: ScssLanguageService,
    private readonly diagnosticsFeature: DiagnosticsFeature,
  ) {}

  public getCodeFixesAtPosition(
    context: TemplateContext,
    start: number,
    end: number,
    errorCodes: readonly number[] = [CSS_DIAGNOSTIC_CODE],
  ): ts.CodeAction[] {
    if (!errorCodes.includes(CSS_DIAGNOSTIC_CODE)) {
      return []
    }

    const request: TemplateSpan = { end, start }
    const diagnostics = this.diagnosticsFeature
      .getShownDiagnostics(context)
      .filter((shown) => isAskedAbout(shown, request))
      .map((shown) => shown.diagnostic)
    if (diagnostics.length === 0) {
      return []
    }

    const { document, lineMap, stylesheet } =
      this.virtualDocumentSessionProvider.getParsedDocument(context)
    const commands = this.scssLanguageService.doCodeActions(
      document,
      this.toVirtualRange(request, lineMap),
      { diagnostics },
      stylesheet,
    )
    return this.translateCodeActions(context, commands, lineMap)
  }

  private toVirtualRange({ end, start }: TemplateSpan, lineMap: TemplateLineMap): Range {
    return {
      end: this.virtualDocumentProvider.toVirtualDocPosition(
        templateOffsetToPosition(end, lineMap),
      ),
      start: this.virtualDocumentProvider.toVirtualDocPosition(
        templateOffsetToPosition(start, lineMap),
      ),
    }
  }

  private translateCodeActions(
    context: TemplateContext,
    commands: readonly Command[],
    lineMap: TemplateLineMap,
  ): ts.CodeAction[] {
    const actions: ts.CodeAction[] = []
    for (const command of commands) {
      if (command.command !== CSS_APPLY_CODE_ACTION_COMMAND) {
        continue
      }
      /** The edits are the command's third argument (cssCodeActions.js), typed only as `LSPAny`. */
      const edits: unknown = command.arguments?.[2]
      if (!Array.isArray(edits) || !edits.every(TextEdit.is)) {
        continue
      }
      const changes = edits
        .map((edit) => this.translateEdit(context, edit, lineMap))
        .filter((change) => change !== undefined)
      if (changes.length === edits.length) {
        actions.push({ changes, description: command.title })
      }
    }
    return actions
  }

  private translateEdit(
    context: TemplateContext,
    edit: TextEdit,
    lineMap: TemplateLineMap,
  ): ts.FileTextChanges | undefined {
    const span = fromVirtualDocSpanStrict(this.virtualDocumentProvider, edit.range, lineMap)
    if (!span) {
      return undefined
    }
    return {
      fileName: context.fileName,
      textChanges: [
        { newText: edit.newText, span: { length: span.end - span.start, start: span.start } },
      ],
    }
  }
}

/** The rule for which diagnostics a request asks about: docs/architecture.md, "Code fixes". */
function isAskedAbout(diagnostic: TemplateSpan, request: TemplateSpan): boolean {
  if (request.start === request.end) {
    return diagnostic.start <= request.start && request.start < diagnostic.end
  }
  return diagnostic.start < request.end && request.start < diagnostic.end
}
