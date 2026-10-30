import { isDeepStrictEqual } from 'node:util'

import {
  type ConfigurationLogger,
  PluginConfigurationManager,
  EDITOR_CONFIGURATION_PROTOCOL_VERSION,
  type StyledPluginConfiguration,
} from '../configuration/plugin-configuration.ts'

const MAX_EDITOR_CONFIGURATION_SOURCE_LENGTH = 128
export const MAX_EDITOR_TAG_COUNT = 64
export const MAX_EDITOR_TAG_LENGTH = 256
export const MAX_EDITOR_TAG_TOTAL_LENGTH = 4_096
const TSSERVER_PLUGIN_ENTRY_KEYS: ReadonlySet<string> = new Set(['global', 'name'])

interface EditorConfigurationListener {
  applyEditorTags(extraTags: ReadonlyArray<string>): void
  applyLegacyConfiguration(config: unknown): void
}

type EditorConfigurationParseResult =
  | { readonly ok: false }
  | { readonly extraTags: ReadonlyArray<string>; readonly ok: true }

type DynamicConfigurationState =
  | { readonly kind: 'editor'; readonly extraTags: ReadonlyArray<string> }
  | { readonly config: StyledPluginConfiguration; readonly kind: 'legacy' }
  | { readonly kind: 'none' }

export class EditorConfigurationManager {
  private state: DynamicConfigurationState = { kind: 'none' }
  private readonly listenerFinalizer = new FinalizationRegistry<
    WeakRef<EditorConfigurationListener>
  >((reference) => this.listeners.delete(reference))
  private readonly listeners = new Set<WeakRef<EditorConfigurationListener>>()

  public addListener(listener: EditorConfigurationListener): void {
    this.forEachListener(() => {})
    const reference = new WeakRef(listener)
    this.listeners.add(reference)
    this.listenerFinalizer.register(listener, reference, reference)
    this.applyState(listener)
  }

  public deactivate(): void {
    this.state = { kind: 'none' }
  }

  public activateLegacy(config: StyledPluginConfiguration, logger?: ConfigurationLogger): void {
    if (this.state.kind === 'legacy' && isDeepStrictEqual(config, this.state.config)) {
      return
    }
    this.state = { config, kind: 'legacy' }
    this.forEachListener((listener) => {
      try {
        listener.applyLegacyConfiguration(config)
      } catch {
        safelyLog(logger, 'Failed to apply legacy configuration to one project.')
      }
    })
  }

  public updateFromPluginConfig(config: unknown, logger?: ConfigurationLogger): boolean {
    let matched: boolean
    try {
      matched =
        config !== null && typeof config === 'object' && hasOwn(config, 'editorConfiguration')
    } catch {
      safelyLog(
        logger,
        'Could not inspect the plugin configuration safely; treating it as legacy configuration.',
      )
      return false
    }
    if (!matched) {
      return false
    }

    let parsed: EditorConfigurationParseResult
    try {
      parsed = parseEditorConfiguration(config, logger)
    } catch {
      safelyLog(logger, 'Ignored editor configuration that could not be read safely.')
      return true
    }
    if (
      !parsed.ok ||
      (this.state.kind === 'editor' && arraysEqual(parsed.extraTags, this.state.extraTags))
    ) {
      return true
    }

    this.state = { extraTags: parsed.extraTags, kind: 'editor' }
    this.forEachListener((listener) => {
      try {
        listener.applyEditorTags(parsed.extraTags)
      } catch {
        safelyLog(logger, 'Failed to apply editor configuration to one project.')
      }
    })
    safelyLog(
      logger,
      `Applied editor configuration v1: ${parsed.extraTags.length} additional tags.`,
    )
    return true
  }

  private forEachListener(callback: (listener: EditorConfigurationListener) => void): void {
    for (const reference of this.listeners) {
      const listener = reference.deref()
      if (listener) {
        callback(listener)
      } else {
        this.listeners.delete(reference)
      }
    }
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

  public constructor(editorConfiguration: EditorConfigurationManager) {
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

  public applyLegacyConfiguration(config: unknown, logger?: ConfigurationLogger): void {
    super.updateFromPluginConfig(config, logger)
    this.dynamicKind = 'legacy'
    this.legacyConfiguration = super.config
    this.baseConfiguration = super.config
    this.editorTags = []
    this.effectiveConfiguration = this.baseConfiguration
    this.notifyUpdated()
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

  public applyEditorTags(extraTags: ReadonlyArray<string>): void {
    const wasLegacyConfiguration = this.dynamicKind === 'legacy'
    this.dynamicKind = 'editor'
    this.legacyConfiguration = undefined
    this.baseConfiguration = this.projectConfiguration
    const next = mergeEditorTags(this.baseConfiguration, extraTags)
    this.editorTags = extraTags
    if (!wasLegacyConfiguration && arraysEqual(next.tags, this.effectiveConfiguration.tags)) {
      return
    }

    this.effectiveConfiguration = next
    this.notifyUpdated()
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

  const fields = Object.keys(editorConfiguration).filter(
    (name) => name !== 'extraTags' && name !== 'protocolVersion' && name !== 'source',
  )
  if (fields.length) {
    safelyLog(logger, `Ignored unknown editor configuration fields: ${formatList(fields)}.`)
  }

  if (
    !hasOwn(editorConfiguration, 'protocolVersion') ||
    editorConfiguration.protocolVersion !== EDITOR_CONFIGURATION_PROTOCOL_VERSION
  ) {
    safelyLog(
      logger,
      `Ignored editor configuration with unsupported protocolVersion type or value; expected ${EDITOR_CONFIGURATION_PROTOCOL_VERSION}.`,
    )
    return { ok: false }
  }
  if (!hasOwn(editorConfiguration, 'source')) {
    safelyLog(
      logger,
      `Ignored editor configuration source: it must be a non-empty string no longer than ${MAX_EDITOR_CONFIGURATION_SOURCE_LENGTH} UTF-16 code units.`,
    )
    return { ok: false }
  }
  const source = editorConfiguration.source
  if (
    typeof source !== 'string' ||
    source.trim().length === 0 ||
    source.length > MAX_EDITOR_CONFIGURATION_SOURCE_LENGTH
  ) {
    safelyLog(
      logger,
      `Ignored editor configuration source: it must be a non-empty string no longer than ${MAX_EDITOR_CONFIGURATION_SOURCE_LENGTH} UTF-16 code units.`,
    )
    return { ok: false }
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
  let totalLength = 0
  const tagCount: unknown = extraTags.length
  if (
    typeof tagCount !== 'number' ||
    !Number.isInteger(tagCount) ||
    tagCount < 0 ||
    tagCount > MAX_EDITOR_TAG_COUNT
  ) {
    reportResourceLimits(logger)
    return { ok: false }
  }
  for (let index = 0; index < tagCount; index++) {
    const value: unknown = extraTags[index]
    if (typeof value !== 'string') {
      rejectedCount++
      continue
    }
    if (value.length > MAX_EDITOR_TAG_LENGTH) {
      reportResourceLimits(logger)
      return { ok: false }
    }
    totalLength += value.length
    if (totalLength > MAX_EDITOR_TAG_TOTAL_LENGTH) {
      reportResourceLimits(logger)
      return { ok: false }
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

function reportResourceLimits(logger: ConfigurationLogger | undefined): void {
  safelyLog(
    logger,
    `Ignored editor configuration that exceeds resource limits: at most ${MAX_EDITOR_TAG_COUNT} tags, ${MAX_EDITOR_TAG_LENGTH} UTF-16 code units per tag, and ${MAX_EDITOR_TAG_TOTAL_LENGTH} UTF-16 code units total.`,
  )
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
