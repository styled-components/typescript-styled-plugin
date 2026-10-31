// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { isDeepStrictEqual } from 'node:util'

import { decorateWithTemplateLanguageService } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import { describeValue, PluginConfigurationManager } from '../configuration/plugin-configuration.ts'
import { StyledTemplateLanguageService } from '../template-language-service.ts'
import { getTemplateSettings } from '../template-settings.ts'
import { StyledVirtualDocumentProvider } from '../virtual-document/styled-virtual-document-provider.ts'
import { EditorConfigurationManager, ProjectConfigurationManager } from './editor-configuration.ts'
import { pluginPackageName } from './plugin-identity.ts'
import { TsServerLogger } from './tsserver-logger.ts'

export class TsServerStyledPlugin {
  private editorConfiguration?: EditorConfigurationManager
  private logger?: TsServerLogger

  public constructor(
    private readonly typescript: typeof ts,
    private readonly getEditorConfiguration: (
      info: ts.server.PluginCreateInfo,
    ) => EditorConfigurationManager = () => new EditorConfigurationManager(),
  ) {}

  public create(info: ts.server.PluginCreateInfo): ts.LanguageService {
    const logger = new TsServerLogger(info)
    this.logger = logger
    const editorConfiguration = this.getEditorConfiguration(info)
    this.editorConfiguration = editorConfiguration
    const editorUpdate = editorConfiguration.updateFromPluginConfig(info.config, logger)
    const configurationManager = new ProjectConfigurationManager(editorConfiguration, info.project)
    const projectConfiguration = readProjectPluginConfiguration(info)
    configurationManager.updateFromProjectConfig(projectConfiguration, logger)
    if (!editorUpdate.matched && isLegacyConfigurationOverride(info.config, projectConfiguration)) {
      const legacyConfiguration = new PluginConfigurationManager()
      legacyConfiguration.updateFromPluginConfig(info.config, logger)
      editorConfiguration.activateLegacy(legacyConfiguration.config, logger)
    }
    this.logConfigurationSummary(configurationManager, logger)

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
      configurationManager,
      new StyledVirtualDocumentProvider(this.typescript),
      logger,
    )

    return decorateWithTemplateLanguageService(
      this.typescript,
      info.languageService,
      info.project,
      templateLanguageService,
      getTemplateSettings(configurationManager),
      { logger },
    )
  }

  public onConfigurationChanged(config: unknown) {
    const logger = this.logger
    logger?.log('onConfigurationChanged')
    const editorUpdate = this.editorConfiguration?.updateFromPluginConfig(config, logger)
    if (editorUpdate === undefined) {
      return
    }
    if (!editorUpdate.matched) {
      const legacyConfiguration = new PluginConfigurationManager()
      legacyConfiguration.updateFromPluginConfig(config, logger)
      this.editorConfiguration?.activateLegacy(legacyConfiguration.config, logger)
    }
  }

  private logConfigurationSummary(
    manager: ProjectConfigurationManager,
    logger: TsServerLogger,
  ): void {
    const { tags, validate } = manager.config
    logger.log(
      'config: ' +
        describeValue({
          tagCount: tags.length,
          validate,
        }),
    )
  }
}

function readProjectPluginConfiguration(info: ts.server.PluginCreateInfo): unknown {
  const plugins = info.project.getCompilerOptions().plugins
  return Array.isArray(plugins) ? plugins.find(isStyledPluginConfiguration) : undefined
}

function isStyledPluginConfiguration(value: unknown): value is ts.PluginImport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === pluginPackageName
  )
}

function isLegacyConfigurationOverride(config: unknown, projectConfiguration: unknown): boolean {
  if (config === projectConfiguration) {
    return false
  }
  if (projectConfiguration !== undefined) {
    const runtime = new PluginConfigurationManager()
    runtime.updateFromPluginConfig(config)
    const project = new PluginConfigurationManager()
    project.updateFromPluginConfig(projectConfiguration)
    return !isDeepStrictEqual(runtime.config, project.config)
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return true
  }
  const keys = Object.keys(config)
  return !(
    keys.every((name) => name === 'global' || name === 'name') &&
    'global' in config &&
    config.global === true
  )
}

/** The floor and the reason for it: docs/tsserver-host.md, "TypeScript versions". */
export function isSupportedTypeScriptVersion(typescript: Pick<typeof ts, 'version'>): boolean {
  const major = Number.parseInt(typescript.version, 10)
  return major >= 5
}
