// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { decorateWithTemplateLanguageService } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import { describeValue, PluginConfigurationManager } from '../configuration/plugin-configuration.ts'
import { StyledTemplateLanguageService } from '../template-language-service.ts'
import { getTemplateSettings } from '../template-settings.ts'
import { StyledVirtualDocumentProvider } from '../virtual-document/styled-virtual-document-provider.ts'
import { TsServerLogger } from './tsserver-logger.ts'

export class TsServerStyledPlugin {
  private logger?: TsServerLogger
  private readonly configurationManager = new PluginConfigurationManager()

  public constructor(private readonly typescript: typeof ts) {}

  public create(info: ts.server.PluginCreateInfo): ts.LanguageService {
    const logger = new TsServerLogger(info)
    this.logger = logger
    this.applyConfiguration(info.config, logger)

    if (!isSupportedTypeScriptVersion(this.typescript)) {
      logger.log(
        `Unsupported TypeScript version ${this.typescript.version} detected. TypeScript 5.0 or newer required; the plugin is disabled for this host.`,
      )
      return info.languageService
    }

    /**
     * Passing the tsserver-backed logger here (rather than the languageServiceFactory overload)
     * is what lets StyledTemplateLanguageService log a recovered exception to the real tsserver
     * log; emmetCompletionProvider stays at its default.
     */
    const templateLanguageService = new StyledTemplateLanguageService(
      this.typescript,
      this.configurationManager,
      new StyledVirtualDocumentProvider(this.typescript),
      logger,
    )

    return decorateWithTemplateLanguageService(
      this.typescript,
      info.languageService,
      info.project,
      templateLanguageService,
      getTemplateSettings(this.configurationManager),
      { logger },
    )
  }

  public onConfigurationChanged(config: unknown) {
    const logger = this.logger
    logger?.log('onConfigurationChanged')
    this.applyConfiguration(config, logger)
  }

  private applyConfiguration(config: unknown, logger: TsServerLogger | undefined) {
    this.configurationManager.updateFromPluginConfig(config, logger)
    logger?.log('config: ' + describeValue(this.configurationManager.config))
  }
}

/** The floor and the reason for it: docs/tsserver-host.md, "TypeScript versions". */
export function isSupportedTypeScriptVersion(typescript: Pick<typeof ts, 'version'>): boolean {
  const major = Number.parseInt(typescript.version, 10)
  return major >= 5
}
