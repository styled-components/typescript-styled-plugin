import { isDeepStrictEqual } from 'node:util'

import {
  type ConfigurationLogger,
  PluginConfigurationManager,
  type StyledPluginConfiguration,
} from '../configuration/plugin-configuration.ts'

const TSSERVER_PLUGIN_ENTRY_KEYS: ReadonlySet<string> = new Set(['global', 'name'])

interface ProjectDiagnostics {
  close(): void
  refreshDiagnostics(): void
}

interface EditorConfigurationListener {
  applyEditorTags(extraTags: ReadonlyArray<string>): boolean
  applyLegacyConfiguration(config: unknown): boolean
  readonly project?: ProjectDiagnostics
}

type EditorConfigurationParseResult =
  | { readonly ok: false }
  | { readonly extraTags: ReadonlyArray<string>; readonly ok: true }

type DynamicConfigurationState =
  | { readonly kind: 'editor'; readonly extraTags: ReadonlyArray<string> }
  | { readonly config: StyledPluginConfiguration; readonly kind: 'legacy' }
  | { readonly kind: 'none' }

interface EditorConfigurationUpdateResult {
  readonly changed: boolean
  readonly matched: boolean
}

export class EditorConfigurationManager {
  private state: DynamicConfigurationState = { kind: 'none' }
  private readonly listeners = new Set<EditorConfigurationListener>()

  public addListener(listener: EditorConfigurationListener): void {
    const project = listener.project
    if (project && !Array.from(this.listeners).some((entry) => entry.project === project)) {
      const close = project.close
      project.close = () => {
        for (const entry of this.listeners) {
          if (entry.project === project) {
            this.listeners.delete(entry)
          }
        }
        project.close = close
        close.call(project)
      }
    }
    this.listeners.add(listener)
    this.applyState(listener)
  }

  public activateLegacy(config: StyledPluginConfiguration, logger?: ConfigurationLogger): boolean {
    if (this.state.kind === 'legacy' && isDeepStrictEqual(config, this.state.config)) {
      return false
    }
    this.state = { config, kind: 'legacy' }
    return this.applyAndRefresh(
      (listener) => listener.applyLegacyConfiguration(config),
      logger,
      'legacy configuration',
    )
  }

  public updateFromPluginConfig(
    config: unknown,
    logger?: ConfigurationLogger,
  ): EditorConfigurationUpdateResult {
    const matched =
      config !== null && typeof config === 'object' && hasOwn(config, 'editorConfiguration')
    if (!matched) {
      return { changed: false, matched: false }
    }

    const parsed = parseEditorConfiguration(config, logger)
    if (
      !parsed.ok ||
      (this.state.kind === 'editor' && arraysEqual(parsed.extraTags, this.state.extraTags))
    ) {
      return { changed: false, matched: true }
    }

    this.state = { extraTags: parsed.extraTags, kind: 'editor' }
    const changed = this.applyAndRefresh(
      (listener) => listener.applyEditorTags(parsed.extraTags),
      logger,
      'editor configuration',
    )
    const tagCount = parsed.extraTags.length
    safelyLog(
      logger,
      `Applied editor configuration: ${tagCount} additional ${tagCount === 1 ? 'tag' : 'tags'}.`,
    )
    return { changed, matched: true }
  }

  private applyAndRefresh(
    apply: (listener: EditorConfigurationListener) => boolean,
    logger: ConfigurationLogger | undefined,
    configurationKind: string,
  ): boolean {
    const listeners = this.listeners
    let changed = false
    for (const listener of listeners) {
      try {
        changed = apply(listener) || changed
      } catch {
        safelyLog(logger, `Failed to apply ${configurationKind} to one project.`)
      }
    }
    if (!changed) {
      return false
    }
    for (const { project } of listeners) {
      if (project) {
        project.refreshDiagnostics()
        break
      }
    }
    return true
  }

  private applyState(listener: EditorConfigurationListener): void {
    if (this.state.kind === 'editor') {
      listener.applyEditorTags(this.state.extraTags)
    } else if (this.state.kind === 'legacy') {
      listener.applyLegacyConfiguration(this.state.config)
    }
  }
}

export class ProjectConfigurationManager
  extends PluginConfigurationManager
  implements EditorConfigurationListener
{
  private baseConfiguration: StyledPluginConfiguration
  private effectiveConfiguration: StyledPluginConfiguration
  private editorTags: ReadonlyArray<string> = []
  private dynamicKind: DynamicConfigurationState['kind'] = 'none'
  private legacyConfiguration: StyledPluginConfiguration | undefined
  private projectConfiguration: StyledPluginConfiguration
  private readonly projectUpdateListeners = new Set<() => void>()

  public constructor(
    editorConfiguration: EditorConfigurationManager,
    public readonly project?: ProjectDiagnostics,
  ) {
    super()
    this.baseConfiguration = super.config
    this.effectiveConfiguration = super.config
    this.projectConfiguration = super.config
    editorConfiguration.addListener(this)
  }

  public override get config(): StyledPluginConfiguration {
    return this.effectiveConfiguration
  }

  public override updateFromPluginConfig(config: unknown, logger?: ConfigurationLogger): void {
    this.applyLegacyConfiguration(config, logger)
  }

  public applyLegacyConfiguration(config: unknown, logger?: ConfigurationLogger): boolean {
    const previous = this.effectiveConfiguration
    super.updateFromPluginConfig(config, logger)
    this.dynamicKind = 'legacy'
    this.legacyConfiguration = super.config
    this.baseConfiguration = super.config
    this.editorTags = []
    this.effectiveConfiguration = this.baseConfiguration
    if (isDeepStrictEqual(previous, this.effectiveConfiguration)) {
      return false
    }
    this.notifyUpdated()
    return true
  }

  public updateFromProjectConfig(config: unknown, logger?: ConfigurationLogger): void {
    super.updateFromPluginConfig(config, logger)
    this.projectConfiguration = super.config
    if (this.dynamicKind === 'legacy' && this.legacyConfiguration) {
      this.baseConfiguration = this.legacyConfiguration
      this.effectiveConfiguration = this.baseConfiguration
    } else {
      this.baseConfiguration = this.projectConfiguration
      this.effectiveConfiguration = mergeEditorTags(this.baseConfiguration, this.editorTags)
    }
    this.notifyUpdated()
  }

  public override onUpdatedConfig(listener: () => void): void {
    this.projectUpdateListeners.add(listener)
  }

  public applyEditorTags(extraTags: ReadonlyArray<string>): boolean {
    const previous = this.effectiveConfiguration
    this.dynamicKind = 'editor'
    this.legacyConfiguration = undefined
    this.baseConfiguration = this.projectConfiguration
    const next = mergeEditorTags(this.baseConfiguration, extraTags)
    this.editorTags = extraTags
    if (isDeepStrictEqual(previous, next)) {
      return false
    }

    this.effectiveConfiguration = next
    this.notifyUpdated()
    return true
  }

  private notifyUpdated(): void {
    for (const listener of this.projectUpdateListeners) {
      listener()
    }
  }
}

function parseEditorConfiguration(
  value: unknown,
  logger: ConfigurationLogger | undefined,
): EditorConfigurationParseResult {
  if (value === null || typeof value !== 'object' || !hasOwn(value, 'editorConfiguration')) {
    return { ok: false }
  }
  if (!isPlainRecord(value)) {
    safelyLog(logger, 'Ignored editor configuration envelope: it must be a plain object.')
    return { ok: false }
  }

  const envelopeFields = Object.keys(value).filter(
    (name) => name !== 'editorConfiguration' && !TSSERVER_PLUGIN_ENTRY_KEYS.has(name),
  )
  if (envelopeFields.length) {
    safelyLog(
      logger,
      `Ignored unknown editor configuration envelope fields: ${formatList(envelopeFields)}.`,
    )
  }

  const editorConfiguration = value.editorConfiguration
  if (!isPlainRecord(editorConfiguration)) {
    safelyLog(logger, 'Ignored editor configuration: editorConfiguration must be a plain object.')
    return { ok: false }
  }

  const fields = Object.keys(editorConfiguration).filter((name) => name !== 'extraTags')
  if (fields.length) {
    safelyLog(logger, `Ignored unknown editor configuration fields: ${formatList(fields)}.`)
  }

  if (!hasOwn(editorConfiguration, 'extraTags')) {
    safelyLog(logger, 'Ignored editor configuration: extraTags must be an array.')
    return { ok: false }
  }

  const extraTags = editorConfiguration.extraTags
  if (!Array.isArray(extraTags)) {
    safelyLog(logger, 'Ignored editor configuration: extraTags must be an array.')
    return { ok: false }
  }

  const normalized: string[] = []
  const seen = new Set<string>()
  let rejectedCount = 0
  for (let index = 0; index < extraTags.length; index++) {
    const value: unknown = extraTags[index]
    if (typeof value !== 'string') {
      rejectedCount++
      continue
    }
    const tag = value.trim()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      normalized.push(tag)
    }
  }
  if (rejectedCount) {
    safelyLog(
      logger,
      `Ignored ${rejectedCount} non-string ${rejectedCount === 1 ? 'entry' : 'entries'} in editorConfiguration.extraTags.`,
    )
  }
  if (extraTags.length > 0 && normalized.length === 0) {
    safelyLog(
      logger,
      'Ignored editor configuration: a non-empty extraTags array must contain at least one non-empty string.',
    )
    return { ok: false }
  }
  return { extraTags: normalized, ok: true }
}

function mergeEditorTags(
  base: StyledPluginConfiguration,
  extraTags: ReadonlyArray<string>,
): StyledPluginConfiguration {
  if (!extraTags.length) {
    return base
  }
  const tags = [...base.tags]
  const seen = new Set(tags)
  for (const tag of extraTags) {
    if (!seen.has(tag)) {
      seen.add(tag)
      tags.push(tag)
    }
  }
  return { ...base, tags }
}

function arraysEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function formatList(values: ReadonlyArray<string>): string {
  return new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(values)
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function safelyLog(logger: ConfigurationLogger | undefined, message: string): void {
  try {
    logger?.log(message)
  } catch {
    /** Logging is best effort; the normalized configuration is what matters. */
  }
}
