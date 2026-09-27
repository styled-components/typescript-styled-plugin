// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
//
// Original code forked from https://github.com/Quramy/ts-graphql-plugin

import type {
  TemplateContext,
  TemplateLanguageService,
} from 'typescript-template-language-service-decorator'
import type { Logger } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import { PluginConfigurationManager } from './configuration/plugin-configuration.ts'
import { CodeActionsFeature } from './features/code-actions.ts'
import {
  CompletionsFeature,
  createEmptyCompletionInfo,
  createUnknownCompletionEntryDetails,
} from './features/completions.ts'
import { CSS_DIAGNOSTIC_CODE } from './features/css-diagnostic-code.ts'
import { DiagnosticsFeature } from './features/diagnostics.ts'
import { FoldingFeature } from './features/folding.ts'
import { HoverFeature } from './features/hover.ts'
import {
  DefaultEmmetCompletionProvider,
  DefaultStylesLanguageServiceFactory,
} from './features/styles-language-services.ts'
import type {
  CssLanguageService,
  EmmetCompletionProvider,
  StylesLanguageServiceFactory,
  ScssLanguageService,
} from './features/styles-language-services.ts'
import type { VirtualDocumentProvider } from './virtual-document/styled-virtual-document-provider.ts'
import {
  CachedVirtualDocumentSessionProvider,
  type VirtualDocumentSessionProvider,
} from './virtual-document/virtual-document-session-provider.ts'

export class StyledTemplateLanguageService implements TemplateLanguageService {
  private codeActionsFeature?: CodeActionsFeature
  private completionsFeature?: CompletionsFeature
  private readonly configurationManager: PluginConfigurationManager
  private cssLanguageServiceInstance?: CssLanguageService
  private diagnosticsFeature?: DiagnosticsFeature
  private readonly emmetCompletionProvider: EmmetCompletionProvider
  private foldingFeature?: FoldingFeature
  private hoverFeature?: HoverFeature
  private readonly languageServiceFactory: StylesLanguageServiceFactory
  private readonly logger: Logger | undefined
  private scssLanguageServiceInstance?: ScssLanguageService
  private readonly typescript: typeof ts
  private readonly virtualDocumentProvider: VirtualDocumentProvider
  private virtualDocumentSessionProviderInstance?: VirtualDocumentSessionProvider

  public constructor(
    typescript: typeof ts,
    configurationManager: PluginConfigurationManager,
    virtualDocumentProvider: VirtualDocumentProvider,
    logger: Logger,
    emmetCompletionProvider?: EmmetCompletionProvider,
  )
  public constructor(
    typescript: typeof ts,
    configurationManager: PluginConfigurationManager,
    virtualDocumentProvider: VirtualDocumentProvider,
    languageServiceFactory?: StylesLanguageServiceFactory,
    emmetCompletionProvider?: EmmetCompletionProvider,
  )
  public constructor(
    typescript: typeof ts,
    configurationManager: PluginConfigurationManager,
    virtualDocumentProvider: VirtualDocumentProvider,
    loggerOrLanguageServiceFactory?: Logger | StylesLanguageServiceFactory,
    emmetCompletionProvider: EmmetCompletionProvider = new DefaultEmmetCompletionProvider(),
  ) {
    this.typescript = typescript
    this.configurationManager = configurationManager
    this.virtualDocumentProvider = virtualDocumentProvider
    this.languageServiceFactory = isStylesLanguageServiceFactory(loggerOrLanguageServiceFactory)
      ? loggerOrLanguageServiceFactory
      : new DefaultStylesLanguageServiceFactory()
    this.logger = isStylesLanguageServiceFactory(loggerOrLanguageServiceFactory)
      ? undefined
      : loggerOrLanguageServiceFactory
    this.emmetCompletionProvider = emmetCompletionProvider
    configurationManager.onUpdatedConfig(() => {
      this.completionsFeature?.clearCache()
      this.diagnosticsFeature?.clearCache()
      this.cssLanguageServiceInstance?.configure(this.configurationManager.config)
      this.scssLanguageServiceInstance?.configure(this.configurationManager.config)
    })
  }

  public getCompletionsAtPosition(
    context: TemplateContext,
    position: ts.LineAndCharacter,
  ): ts.WithMetadata<ts.CompletionInfo> {
    return this.recover('getCompletionsAtPosition', createEmptyCompletionInfo, () =>
      this.completions.getCompletionsAtPosition(context, position),
    )
  }

  public getCompletionEntryDetails(
    context: TemplateContext,
    position: ts.LineAndCharacter,
    name: string,
  ): ts.CompletionEntryDetails {
    return this.recover(
      'getCompletionEntryDetails',
      () => createUnknownCompletionEntryDetails(this.typescript, name),
      () => this.completions.getCompletionEntryDetails(context, position, name),
    )
  }

  public getQuickInfoAtPosition(
    context: TemplateContext,
    position: ts.LineAndCharacter,
  ): ts.QuickInfo | undefined {
    return this.recover(
      'getQuickInfoAtPosition',
      () => undefined,
      () => this.hover.getQuickInfoAtPosition(context, position),
    )
  }

  public getSemanticDiagnostics(context: TemplateContext): ts.Diagnostic[] {
    return this.recover(
      'getSemanticDiagnostics',
      () => [],
      () => this.diagnostics.getSemanticDiagnostics(context),
    )
  }

  public getSupportedCodeFixes(): number[] {
    return [CSS_DIAGNOSTIC_CODE]
  }

  public getCodeFixesAtPosition(
    context: TemplateContext,
    start: number,
    end: number,
    errorCodes?: readonly number[],
  ): ts.CodeAction[] {
    return this.recover(
      'getCodeFixesAtPosition',
      () => [],
      () => this.codeActions.getCodeFixesAtPosition(context, start, end, errorCodes),
    )
  }

  public getOutliningSpans(context: TemplateContext): ts.OutliningSpan[] {
    return this.recover(
      'getOutliningSpans',
      () => [],
      () => this.folding.getOutliningSpans(context),
    )
  }

  /** Exception recovery for every entry point (docs/architecture.md, "Exception recovery"). */
  private recover<T>(method: string, fallback: () => T, run: () => T): T {
    try {
      return run()
    } catch (error) {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
      this.logger?.log(`${method} threw and was recovered: ${message}`)
      return fallback()
    }
  }

  private get codeActions(): CodeActionsFeature {
    this.codeActionsFeature ??= new CodeActionsFeature(
      this.virtualDocumentProvider,
      this.virtualDocumentSessionProvider,
      this.scssLanguageService,
      this.diagnostics,
    )
    return this.codeActionsFeature
  }

  private get completions(): CompletionsFeature {
    this.completionsFeature ??= new CompletionsFeature(
      this.typescript,
      this.virtualDocumentProvider,
      this.virtualDocumentSessionProvider,
      this.cssLanguageService,
      this.scssLanguageService,
      this.emmetCompletionProvider,
      () => this.configurationManager.config,
    )
    return this.completionsFeature
  }

  private get cssLanguageService(): CssLanguageService {
    this.cssLanguageServiceInstance ??= this.configured(
      this.languageServiceFactory.createCssLanguageService(),
    )
    return this.cssLanguageServiceInstance
  }

  private get diagnostics(): DiagnosticsFeature {
    this.diagnosticsFeature ??= new DiagnosticsFeature(
      this.typescript,
      this.virtualDocumentProvider,
      this.virtualDocumentSessionProvider,
      this.scssLanguageService,
      () => this.configurationManager.config.validate,
    )
    return this.diagnosticsFeature
  }

  private get folding(): FoldingFeature {
    this.foldingFeature ??= new FoldingFeature(
      this.typescript,
      this.virtualDocumentProvider,
      this.virtualDocumentSessionProvider,
      this.scssLanguageService,
    )
    return this.foldingFeature
  }

  private get hover(): HoverFeature {
    this.hoverFeature ??= new HoverFeature(
      this.typescript,
      this.virtualDocumentProvider,
      this.virtualDocumentSessionProvider,
      this.scssLanguageService,
    )
    return this.hoverFeature
  }

  private get scssLanguageService(): ScssLanguageService {
    this.scssLanguageServiceInstance ??= this.configured(
      this.languageServiceFactory.createScssLanguageService(),
    )
    return this.scssLanguageServiceInstance
  }

  private get virtualDocumentSessionProvider(): VirtualDocumentSessionProvider {
    this.virtualDocumentSessionProviderInstance ??= new CachedVirtualDocumentSessionProvider(
      this.virtualDocumentProvider,
      this.scssLanguageService,
    )
    return this.virtualDocumentSessionProviderInstance
  }

  private configured<Service extends CssLanguageService | ScssLanguageService>(
    service: Service,
  ): Service {
    service.configure(this.configurationManager.config)
    return service
  }
}

function isStylesLanguageServiceFactory(
  value: Logger | StylesLanguageServiceFactory | undefined,
): value is StylesLanguageServiceFactory {
  return value !== undefined && 'createCssLanguageService' in value
}
