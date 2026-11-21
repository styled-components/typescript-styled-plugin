// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { isDeepStrictEqual } from 'node:util'

import { decorateWithTemplateLanguageService } from 'typescript-template-language-service-decorator'
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import {
  describeValue,
  PluginConfigurationManager,
  type StyledPluginConfiguration,
} from '../configuration/plugin-configuration.ts'
import { StyledTemplateLanguageService } from '../template-language-service.ts'
import { getTemplateSettings } from '../template-settings.ts'
import { StyledVirtualDocumentProvider } from '../virtual-document/styled-virtual-document-provider.ts'
import { EditorConfigurationManager, ProjectConfigurationManager } from './editor-configuration.ts'
import { pluginPackageName } from './plugin-identity.ts'
import { TsServerLogger } from './tsserver-logger.ts'

interface Decoration {
  readonly entryKey: string | undefined
  /** True once another plugin assigned a property on the layer, which unwrapping would discard. */
  readonly isPatched: () => boolean
  readonly languageService: ts.LanguageService
}

/** Each language service this plugin returned, mapped to the one it decorates and the entry that asked. */
const decorations = new WeakMap<ts.LanguageService, Decoration>()

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
    const projectConfiguration = readProjectPluginConfiguration(info)
    /**
     * Only a payload tsserver substituted for the project's entry (a pre-project configurePlugin)
     * is dynamic configuration; the project's own entry is the base, whatever keys it holds.
     */
    const isRuntimeConfiguration = !isSameEntry(info.config, projectConfiguration)
    const editorUpdate = isRuntimeConfiguration
      ? editorConfiguration.updateFromPluginConfig(info.config, logger)
      : { changed: false, matched: false }
    const entryKey = readEntryKey(info.config, info.project.getCompilerOptions().plugins)
    const configurationManager = new ProjectConfigurationManager(
      editorConfiguration,
      info.project,
      entryKey,
    )
    configurationManager.updateFromProjectConfig(projectConfiguration, logger)
    if (
      isRuntimeConfiguration &&
      !editorUpdate.matched &&
      isLegacyConfigurationOverride(info.config, projectConfiguration)
    ) {
      const legacyConfiguration = new PluginConfigurationManager()
      legacyConfiguration.updateFromPluginConfig(info.config, logger)
      editorConfiguration.activateLegacy(legacyConfiguration.config, logger)
    }
    logConfiguration(configurationManager.config, logger)

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

    /** A project reload passes the same entry's earlier decoration back in (docs/architecture.md, "Request flow"). */
    const previous = decorations.get(info.languageService)
    const languageService =
      previous !== undefined && previous.entryKey === entryKey && !previous.isPatched()
        ? previous.languageService
        : info.languageService
    /**
     * The layer tsserver keeps. Once a newer layer for the same project and entry supersedes it,
     * it forwards straight to the service it wraps, so a layer still in the chain neither runs the
     * decorator nor keeps it alive (docs/architecture.md, "Request flow"). A layer above this one
     * (the decorator included) binds each method once, when it wraps, so every method here is a
     * stable function that picks the active service on each call.
     */
    let active: ts.LanguageService = decorateWithTemplateLanguageService(
      this.typescript,
      languageService,
      info.project,
      templateLanguageService,
      getTemplateSettings(configurationManager),
      { logger },
    )
    configurationManager.onSuperseded(() => {
      active = languageService
    })
    const forwarders = new Map<PropertyKey, (...args: unknown[]) => unknown>()
    /**
     * Properties another plugin assigns on this layer (ts-graphql-plugin patches the service it
     * receives and returns the same object). Kept here rather than written through to the wrapped
     * service, where a retired layer forwarding to that service would call its own patch again.
     */
    const patches = new Map<PropertyKey, unknown>()
    const layer = new Proxy(languageService, {
      get: (_target, property) => {
        if (patches.has(property)) {
          return patches.get(property)
        }
        const value: unknown = Reflect.get(active, property)
        if (typeof value !== 'function') {
          return value
        }
        let forwarder = forwarders.get(property)
        if (forwarder === undefined) {
          forwarder = (...args) => Reflect.apply(Reflect.get(active, property), active, args)
          forwarders.set(property, forwarder)
        }
        return forwarder
      },
      set: (_target, property, value) => {
        patches.set(property, value)
        return true
      },
    })
    decorations.set(layer, { entryKey, isPatched: () => patches.size > 0, languageService })
    return layer
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
      if (logger) {
        logConfiguration(legacyConfiguration.config, logger)
      }
    }
  }
}

function logConfiguration(config: StyledPluginConfiguration, logger: TsServerLogger): void {
  logger.log('config: ' + describeValue(config))
}

/**
 * tsserver passes the project's own `plugins[]` entry as `PluginCreateInfo.config`, or a
 * pre-project override with that entry's `name` copied onto it, so the entry is found by
 * identity first and then by `config.name`. The name can be an npm alias of this package.
 */
function readProjectPluginConfiguration(info: ts.server.PluginCreateInfo): unknown {
  const plugins = info.project.getCompilerOptions().plugins
  if (!Array.isArray(plugins)) {
    return undefined
  }
  const config: unknown = info.config
  if (plugins.some((entry) => entry === config)) {
    return config
  }
  const name = readPluginName(config) ?? pluginPackageName
  return plugins.find((entry) => isRecord(entry) && entry.name === name)
}

function readPluginName(config: unknown): string | undefined {
  return isRecord(config) && typeof config.name === 'string' ? config.name : undefined
}

/**
 * The entry's name and its position among the project entries of that name: tsserver enables
 * every `plugins[]` entry, so two entries naming this package are both active in one load, while a
 * reload reaches each at the same position. A global entry or a pre-project override is not one of
 * the project's entry objects and counts as the first.
 */
function readEntryKey(config: unknown, plugins: unknown): string | undefined {
  const name = readPluginName(config)
  if (name === undefined) {
    return undefined
  }
  const sameNamed = Array.isArray(plugins)
    ? plugins.filter((entry) => isRecord(entry) && entry.name === name)
    : []
  return `${Math.max(sameNamed.indexOf(config), 0)}:${name}`
}

function isSameEntry(config: unknown, projectConfiguration: unknown): boolean {
  return (
    projectConfiguration !== undefined &&
    (config === projectConfiguration || isDeepStrictEqual(config, projectConfiguration))
  )
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
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
