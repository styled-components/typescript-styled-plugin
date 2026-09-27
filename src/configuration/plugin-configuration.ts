// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export type StyledPluginLintLevel = 'ignore' | 'warning' | 'error'

export interface StyledPluginLintConfiguration {
  readonly argumentsInColorFunction?: StyledPluginLintLevel
  readonly boxModel?: StyledPluginLintLevel
  readonly compatibleVendorPrefixes?: StyledPluginLintLevel
  readonly duplicateProperties?: StyledPluginLintLevel
  readonly emptyRules?: StyledPluginLintLevel
  readonly float?: StyledPluginLintLevel
  readonly fontFaceProperties?: StyledPluginLintLevel
  readonly hexColorLength?: StyledPluginLintLevel
  readonly idSelector?: StyledPluginLintLevel
  readonly ieHack?: StyledPluginLintLevel
  readonly importStatement?: StyledPluginLintLevel
  readonly important?: StyledPluginLintLevel
  readonly propertyIgnoredDueToDisplay?: StyledPluginLintLevel
  readonly universalSelector?: StyledPluginLintLevel
  readonly unknownAtRules?: StyledPluginLintLevel
  readonly unknownProperties?: StyledPluginLintLevel
  readonly unknownVendorSpecificProperties?: StyledPluginLintLevel
  readonly validProperties?: ReadonlyArray<string>
  readonly vendorPrefix?: StyledPluginLintLevel
  readonly zeroUnits?: StyledPluginLintLevel
}

export interface StyledPluginEmmetConfiguration {
  readonly excludeLanguages?: string[]
  readonly preferences?: Readonly<Record<string, unknown>>
  readonly showAbbreviationSuggestions?: boolean
  readonly showExpandedAbbreviation?: string
  readonly showSuggestionsAsSnippets?: boolean
  readonly syntaxProfiles?: Readonly<Record<string, unknown>>
  readonly variables?: Readonly<Record<string, unknown>>
}

/** Partial plugin configuration for a caller building one in code, with closed `lint` and `emmet` shapes. */
export interface StyledPluginConfigurationInput {
  readonly emmet?: StyledPluginEmmetConfiguration
  readonly lint?: StyledPluginLintConfiguration
  readonly tags?: ReadonlyArray<string>
  readonly validate?: boolean
}

/**
 * Fully-resolved plugin configuration, every field always present, matching 1.0.1's published
 * `StyledPluginConfiguration` (`lib/_configuration.d.ts`) exactly: `lint` and `emmet` are the
 * open `{ [key: string]: any }` shape 1.0.1 declared, not the closed
 * `StyledPluginLintConfiguration` / `StyledPluginEmmetConfiguration` interfaces above, so a
 * consumer indexing an arbitrary key (a lint rule or Emmet option this plugin does not yet know
 * about) keeps compiling the way it did against 1.0.1.
 */
export interface StyledPluginConfiguration {
  readonly emmet: { [key: string]: any }
  readonly lint: { [key: string]: any }
  readonly tags: ReadonlyArray<string>
  readonly validate: boolean
}

/** Tag name whose template is a style fragment (`css`), a value-shaped one included. */
export const CSS_TAG_NAME = 'css'

/** Tag name whose template is the body of a keyframes rule. */
export const KEYFRAMES_TAG_NAME = 'keyframes'

/** Tag names whose template's top level is the stylesheet's own top level, not a style rule body. */
export const GLOBAL_STYLE_TAG_NAMES: ReadonlyArray<string> = [
  'createGlobalStyle',
  'globalCss',
  'injectGlobal',
]

export class PluginConfigurationManager {
  private static readonly defaultConfiguration: StyledPluginConfiguration = {
    emmet: {},
    lint: { emptyRules: 'ignore' },
    tags: ['styled', CSS_TAG_NAME, KEYFRAMES_TAG_NAME, ...GLOBAL_STYLE_TAG_NAMES, 'extend'],
    validate: true,
  }

  private readonly updateListeners = new Set<() => void>()
  private configuration: StyledPluginConfiguration = PluginConfigurationManager.defaultConfiguration

  public get config(): StyledPluginConfiguration {
    return this.configuration
  }

  /**
   * Replaces the whole configuration with `config` normalized (docs/architecture.md,
   * Configuration): a rejected value falls back to its default and is reported through `logger`,
   * one message per value.
   */
  public updateFromPluginConfig(config: unknown, logger?: ConfigurationLogger) {
    const reporter = createReporter(logger)
    const defaults = PluginConfigurationManager.defaultConfiguration
    let settings: Readonly<Record<string, unknown>> = {}
    if (isRecord(config)) {
      settings = config
    } else if (config !== undefined && config !== null) {
      reporter.report(
        `Ignored the plugin configuration: it accepts an object of plugin settings; received ${describeValue(config)}. The defaults apply.`,
      )
    }

    this.configuration = {
      emmet:
        normalizeRecord(settings.emmet, 'emmet', 'an object of Emmet options', reporter) ??
        defaults.emmet,
      lint: {
        ...defaults.lint,
        ...normalizeLint(
          normalizeRecord(settings.lint, 'lint', 'an object of lint settings', reporter),
          defaults.lint,
          reporter,
        ),
      },
      tags: normalizeTags(settings.tags, reporter) ?? defaults.tags,
      validate: normalizeBoolean(settings.validate, 'validate', reporter) ?? defaults.validate,
    }
    reportUnknownSettings(settings, reporter)

    for (const listener of this.updateListeners) {
      listener()
    }
  }

  public onUpdatedConfig(listener: () => void) {
    this.updateListeners.add(listener)
  }
}

/** Receives one message per rejected configuration value; the tsserver log in the plugin. */
export interface ConfigurationLogger {
  log(message: string): void
}

interface Reporter {
  report(message: string): void
  /** Logs one rejected setting value; `defaultNote` names what applies instead. */
  reportRejected(name: string, accepted: string, value: unknown, defaultNote?: string): void
}

const VALID_PROPERTIES_SETTING = 'validProperties'

/**
 * Lint settings whose value is a level, keyed so the compiler rejects a level setting added to
 * StyledPluginLintConfiguration but missing here. Every other lint key (validProperties, or a
 * rule this plugin does not know yet) passes through unchanged, so a newer
 * vscode-css-languageservice rule keeps working.
 */
const LINT_LEVEL_SETTINGS: Readonly<
  Record<Exclude<keyof StyledPluginLintConfiguration, typeof VALID_PROPERTIES_SETTING>, true>
> = {
  argumentsInColorFunction: true,
  boxModel: true,
  compatibleVendorPrefixes: true,
  duplicateProperties: true,
  emptyRules: true,
  float: true,
  fontFaceProperties: true,
  hexColorLength: true,
  idSelector: true,
  ieHack: true,
  importStatement: true,
  important: true,
  propertyIgnoredDueToDisplay: true,
  universalSelector: true,
  unknownAtRules: true,
  unknownProperties: true,
  unknownVendorSpecificProperties: true,
  vendorPrefix: true,
  zeroUnits: true,
}

/**
 * Each accepted lint level spelling, lowercase, and the level it names: the levels themselves,
 * plus spellings from other linters whose meaning is unambiguous (`off`, `warn`).
 */
const LINT_LEVEL_SPELLINGS: Readonly<Record<string, StyledPluginLintLevel>> = {
  error: 'error',
  ignore: 'ignore',
  off: 'ignore',
  warn: 'warning',
  warning: 'warning',
}

const BOOLEAN_STRINGS: Readonly<Record<string, boolean>> = { false: false, true: true }

/** The top-level settings the plugin reads, keyed so the compiler rejects one missing here. */
const PLUGIN_SETTINGS: Readonly<Record<keyof StyledPluginConfigurationInput, true>> = {
  emmet: true,
  lint: true,
  tags: true,
  validate: true,
}

const PLUGIN_SETTING_NAMES = Object.keys(PLUGIN_SETTINGS).sort()

/** `a`, `a and b`, or `a, b, and c`. */
const LIST_FORMAT = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

/**
 * Keys tsserver adds to the configuration it passes a plugin, which are not plugin settings:
 * `name` from the tsconfig `plugins` entry, and `global` for a plugin an editor loads globally
 * (docs/tsserver-host.md).
 */
const TSSERVER_PLUGIN_ENTRY_KEYS: ReadonlySet<string> = new Set(['global', 'name'])

/** A misspelled setting name otherwise leaves its setting at the default with no sign of why. */
function reportUnknownSettings(settings: Readonly<Record<string, unknown>>, reporter: Reporter) {
  for (const name of Object.keys(settings)) {
    if (hasOwn(PLUGIN_SETTINGS, name) || TSSERVER_PLUGIN_ENTRY_KEYS.has(name)) {
      continue
    }
    const suggestion = findClosestSettingName(name)
    reporter.report(
      `Ignored the plugin setting ${name}: the plugin has no setting with that name.${
        suggestion ? ` Did you mean ${suggestion}?` : ''
      } The plugin settings are ${LIST_FORMAT.format(PLUGIN_SETTING_NAMES)}.`,
    )
  }
}

/** The setting name a misspelled `name` most likely meant (docs/architecture.md, Configuration), if any. */
function findClosestSettingName(name: string): string | undefined {
  const maximumDistance = Math.max(1, Math.floor(name.length * 0.4))
  const lowercaseName = name.toLowerCase()
  let closest: string | undefined
  let closestDistance = maximumDistance + 1
  for (const candidate of PLUGIN_SETTING_NAMES) {
    const distance = editDistance(lowercaseName, candidate.toLowerCase())
    if (distance < closestDistance) {
      closest = candidate
      closestDistance = distance
    }
  }
  return closest
}

/** The Levenshtein distance: the fewest single-character insertions, deletions, and substitutions. */
function editDistance(left: string, right: string): number {
  let previousRow = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const row = [leftIndex]
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution =
        previousRow[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      row.push(Math.min(previousRow[rightIndex] + 1, row[rightIndex - 1] + 1, substitution))
    }
    previousRow = row
  }
  return previousRow[right.length]
}

/** `Object.hasOwn` is missing on the Node 14 runtime floor (docs/tsserver-host.md). */
function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function normalizeLint(
  lint: Readonly<Record<string, unknown>> | undefined,
  defaults: Readonly<Record<string, unknown>>,
  reporter: Reporter,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(lint ?? {})) {
    if (name === VALID_PROPERTIES_SETTING) {
      const validProperties = normalizeValidProperties(value, reporter)
      if (validProperties) {
        normalized[name] = validProperties
      }
      continue
    }
    if (!hasOwn(LINT_LEVEL_SETTINGS, name)) {
      normalized[name] = value
      continue
    }
    const level = typeof value === 'string' ? toLintLevel(value) : undefined
    if (level) {
      normalized[name] = level
      continue
    }
    const pluginDefault = hasOwn(defaults, name) ? defaults[name] : undefined
    reporter.reportRejected(
      `lint.${name}`,
      '"ignore", "warning", or "error"',
      value,
      typeof pluginDefault === 'string'
        ? `The plugin default, "${pluginDefault}", applies.`
        : "The CSS language service's own default for this rule applies.",
    )
  }
  return normalized
}

/** A lint level spelling in any letter case, as the level it names. */
function toLintLevel(value: string): StyledPluginLintLevel | undefined {
  const lowercase = value.toLowerCase()
  return hasOwn(LINT_LEVEL_SPELLINGS, lowercase) ? LINT_LEVEL_SPELLINGS[lowercase] : undefined
}

function normalizeValidProperties(
  value: unknown,
  reporter: Reporter,
): ReadonlyArray<string> | undefined {
  if (typeof value === 'string') {
    return [value]
  }
  if (!Array.isArray(value)) {
    reporter.reportRejected(
      `lint.${VALID_PROPERTIES_SETTING}`,
      'a list of property names, such as ["margin-vertical"]',
      value,
    )
    return undefined
  }
  const names: string[] = []
  const rejected: unknown[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      names.push(item)
    } else {
      rejected.push(item)
    }
  }
  if (rejected.length) {
    reporter.report(
      `Ignored part of the plugin setting lint.${VALID_PROPERTIES_SETTING}: it accepts a list of property names; received the entries ${LIST_FORMAT.format(rejected.map(describeValue))}, which are not strings.`,
    )
  }
  return names
}

function normalizeTags(value: unknown, reporter: Reporter): ReadonlyArray<string> | undefined {
  if (typeof value === 'string') {
    return [value]
  }
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
    return value
  }
  if (value !== undefined) {
    reporter.reportRejected('tags', 'a list of tag names, such as ["styled", "css"]', value)
  }
  return undefined
}

function normalizeBoolean(value: unknown, name: string, reporter: Reporter): boolean | undefined {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string' && hasOwn(BOOLEAN_STRINGS, value)) {
    return BOOLEAN_STRINGS[value]
  }
  if (value !== undefined) {
    reporter.reportRejected(name, 'true or false', value)
  }
  return undefined
}

function normalizeRecord(
  value: unknown,
  name: string,
  accepted: string,
  reporter: Reporter,
): Readonly<Record<string, unknown>> | undefined {
  if (isRecord(value)) {
    return value
  }
  if (value !== undefined) {
    reporter.reportRejected(name, accepted, value)
  }
  return undefined
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Configuration arrives from tsserver as parsed JSON, but `./api` callers can pass anything, so
 * describing a value never throws: a value JSON cannot represent (a bigint, a cycle) falls back
 * to String, and one whose conversion throws is described generically.
 */
export function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    try {
      return String(value)
    } catch {
      return 'a value that cannot be displayed'
    }
  }
}

/**
 * A failing logger must not stop the configuration from applying: normalization runs inside
 * tsserver's plugin creation and configurePlugin handling, where a throw fails the request.
 */
function createReporter(logger: ConfigurationLogger | undefined): Reporter {
  const report = (message: string) => {
    try {
      logger?.log(message)
    } catch {
      /** Logging is best effort; the normalized configuration is what matters. */
    }
  }
  return {
    report,
    reportRejected(name, accepted, value, defaultNote = 'The default applies.') {
      report(
        `Ignored the plugin setting ${name}: it accepts ${accepted}; received ${describeValue(value)}. ${defaultNote}`,
      )
    },
  }
}
