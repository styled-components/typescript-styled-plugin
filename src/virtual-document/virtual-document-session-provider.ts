import type { TemplateContext } from 'typescript-template-language-service-decorator'
import type { Stylesheet } from 'vscode-css-languageservice'
import type { TextDocument } from 'vscode-languageserver-textdocument'

import type { ScssLanguageService } from '../features/styles-language-services.ts'
import type { VirtualDocumentProvider } from './styled-virtual-document-provider.ts'
import { createTemplateLineMap, type TemplateLineMap } from './template-line-map.ts'

export interface VirtualDocument {
  readonly document: TextDocument
  readonly lineMap: TemplateLineMap
}

export interface ParsedVirtualDocument extends VirtualDocument {
  readonly stylesheet: Stylesheet
}

/** One cached virtual document per service, reused under canReuseVirtualDocument (docs/architecture.md, "Caching"). */
export interface VirtualDocumentSessionProvider {
  getDocument(context: TemplateContext): VirtualDocument
  getParsedDocument(context: TemplateContext): ParsedVirtualDocument
  /**
   * The cached TemplateLineMap when the cached document is reusable for `context`, otherwise
   * undefined; never builds a document, so a caller that needs only positions (a diagnostics cache
   * hit) neither pays for nor evicts one.
   */
  getReusableLineMap(context: TemplateContext): TemplateLineMap | undefined
}

interface CachedDocument extends VirtualDocument {
  readonly context: TemplateContext
  stylesheet?: Stylesheet
}

export class CachedVirtualDocumentSessionProvider implements VirtualDocumentSessionProvider {
  private cached?: CachedDocument

  public constructor(
    private readonly virtualDocumentProvider: VirtualDocumentProvider,
    private readonly scssLanguageService: ScssLanguageService,
  ) {}

  public getDocument(context: TemplateContext): VirtualDocument {
    const { document, lineMap } = this.ensureDocument(context)
    return { document, lineMap }
  }

  public getParsedDocument(context: TemplateContext): ParsedVirtualDocument {
    const cached = this.ensureDocument(context)
    cached.stylesheet ??= this.scssLanguageService.parseStylesheet(cached.document)
    return { document: cached.document, lineMap: cached.lineMap, stylesheet: cached.stylesheet }
  }

  public getReusableLineMap(context: TemplateContext): TemplateLineMap | undefined {
    return this.reusableCache(context)?.lineMap
  }

  private reusableCache(context: TemplateContext): CachedDocument | undefined {
    const { cached } = this
    return cached && this.virtualDocumentProvider.canReuseVirtualDocument?.(cached.context, context)
      ? cached
      : undefined
  }

  private ensureDocument(context: TemplateContext): CachedDocument {
    const reusable = this.reusableCache(context)
    if (reusable) {
      return reusable
    }
    this.cached = {
      context,
      document: this.virtualDocumentProvider.createVirtualDocument(context),
      lineMap: createTemplateLineMap(context),
    }
    return this.cached
  }
}
