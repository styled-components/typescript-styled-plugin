import { execFileSync } from 'node:child_process'
import path from 'node:path'

import { assert, describe, it } from 'vitest'

import { PluginConfigurationManager } from '../../src/configuration/plugin-configuration'
import {
  EditorConfigurationManager,
  ProjectConfigurationManager,
} from '../../src/tsserver/editor-configuration'

describe('PluginConfigurationManager', () => {
  it('should expose the complete default tag list', () => {
    const manager = new PluginConfigurationManager()

    assert.deepEqual(manager.config.tags, [
      'styled',
      'css',
      'keyframes',
      'createGlobalStyle',
      'globalCss',
      'injectGlobal',
      'extend',
    ])
  })

  it('should merge lint settings while preserving defaults', () => {
    const manager = new PluginConfigurationManager()
    manager.updateFromPluginConfig({ lint: { unknownProperties: 'error' } })

    assert.deepEqual(manager.config.lint, {
      emptyRules: 'ignore',
      unknownProperties: 'error',
    })
  })

  it('should reset omitted settings to their defaults on configuration changes', () => {
    const manager = new PluginConfigurationManager()
    manager.updateFromPluginConfig({
      emmet: { showAbbreviationSuggestions: false },
      tags: ['sty'],
      validate: false,
    })
    manager.updateFromPluginConfig({})

    assert.deepEqual(manager.config.tags, [
      'styled',
      'css',
      'keyframes',
      'createGlobalStyle',
      'globalCss',
      'injectGlobal',
      'extend',
    ])
    assert.strictEqual(manager.config.validate, true)
    assert.deepEqual(manager.config.emmet, {})
  })

  it('should ignore malformed runtime configuration values and log each one', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig({ emmet: null, lint: [], tags: 5, validate: 'no' }, logger)

    assert.deepEqual(manager.config, new PluginConfigurationManager().config)
    assert.deepEqual(logger.messages, [
      'Ignored the plugin setting emmet: it accepts an object of Emmet options; received null. The default applies.',
      'Ignored the plugin setting lint: it accepts an object of lint settings; received []. The default applies.',
      'Ignored the plugin setting tags: it accepts a list of tag names, such as ["styled", "css"]; received 5. The default applies.',
      'Ignored the plugin setting validate: it accepts true or false; received "no". The default applies.',
    ])
  })

  it('should accept unambiguous shorthand values without logging', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig(
      {
        lint: {
          unknownProperties: 'off',
          validProperties: 'margin-vertical',
          vendorPrefix: 'warn',
        },
        tags: 'sty',
        validate: 'false',
      },
      logger,
    )

    assert.deepEqual(manager.config, {
      emmet: {},
      lint: {
        emptyRules: 'ignore',
        unknownProperties: 'ignore',
        validProperties: ['margin-vertical'],
        vendorPrefix: 'warning',
      },
      tags: ['sty'],
      validate: false,
    })
    assert.deepEqual(logger.messages, [])
  })

  it('should accept the string "true" for validate without logging', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig({ validate: false })
    manager.updateFromPluginConfig({ validate: 'true' }, logger)

    assert.strictEqual(manager.config.validate, true)
    assert.deepEqual(logger.messages, [])
  })

  it('should drop an invalid lint level, keep the valid ones, and log the default that applies', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig(
      { lint: { emptyRules: 'fatal', unknownProperties: 0, zeroUnits: 'error' } },
      logger,
    )

    assert.deepEqual(manager.config.lint, { emptyRules: 'ignore', zeroUnits: 'error' })
    assert.deepEqual(logger.messages, [
      'Ignored the plugin setting lint.emptyRules: it accepts "ignore", "warning", or "error"; received "fatal". The plugin default, "ignore", applies.',
      'Ignored the plugin setting lint.unknownProperties: it accepts "ignore", "warning", or "error"; received 0. The CSS language service\'s own default for this rule applies.',
    ])
  })

  it('should accept a lint level or alias in any letter case without logging', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig(
      {
        lint: {
          emptyRules: 'Error',
          unknownProperties: 'OFF',
          vendorPrefix: 'Warn',
          zeroUnits: 'Warning',
        },
      },
      logger,
    )

    assert.deepEqual(manager.config.lint, {
      emptyRules: 'error',
      unknownProperties: 'ignore',
      vendorPrefix: 'warning',
      zeroUnits: 'warning',
    })
    assert.deepEqual(logger.messages, [])
  })

  it('should keep the string entries of lint.validProperties and log the rest', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig(
      { lint: { validProperties: ['margin-vertical', 1, null] } },
      logger,
    )

    assert.deepEqual(manager.config.lint, {
      emptyRules: 'ignore',
      validProperties: ['margin-vertical'],
    })
    assert.deepEqual(logger.messages, [
      'Ignored part of the plugin setting lint.validProperties: it accepts a list of property names; received the entries 1 and null, which are not strings.',
    ])
  })

  it('should list three or more rejected lint.validProperties entries with an Oxford comma', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig({ lint: { validProperties: [1, 'gap', null, true] } }, logger)

    assert.deepEqual(manager.config.lint, { emptyRules: 'ignore', validProperties: ['gap'] })
    assert.deepEqual(logger.messages, [
      'Ignored part of the plugin setting lint.validProperties: it accepts a list of property names; received the entries 1, null, and true, which are not strings.',
    ])
  })

  it('should keep the default Emmet options object when emmet is rejected', () => {
    const manager = new PluginConfigurationManager()
    manager.updateFromPluginConfig({ emmet: 'on' })

    assert.strictEqual(manager.config.emmet, new PluginConfigurationManager().config.emmet)
  })

  it('should drop a lint.validProperties value that is neither a list nor a string and log it', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig({ lint: { validProperties: { a: 1 } } }, logger)

    assert.deepEqual(manager.config.lint, { emptyRules: 'ignore' })
    assert.deepEqual(logger.messages, [
      'Ignored the plugin setting lint.validProperties: it accepts a list of property names, such as ["margin-vertical"]; received {"a":1}. The default applies.',
    ])
  })

  it('should reject a tag list holding a non-string entry and log it', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig({ tags: ['styled', 1] }, logger)

    assert.deepEqual(manager.config.tags, new PluginConfigurationManager().config.tags)
    assert.deepEqual(logger.messages, [
      'Ignored the plugin setting tags: it accepts a list of tag names, such as ["styled", "css"]; received ["styled",1]. The default applies.',
    ])
  })

  it('should copy tag arrays so delayed hostile methods cannot reach language requests', () => {
    const manager = new PluginConfigurationManager()
    const tags = new Proxy(['styled'], {
      get(target, property, receiver) {
        if (property === 'some') {
          throw new Error('late tags failure')
        }
        return Reflect.get(target, property, receiver)
      },
    })

    manager.updateFromPluginConfig({ tags })

    assert.notStrictEqual(manager.config.tags, tags)
    assert.doesNotThrow(() => manager.config.tags.some((tag) => tag === 'styled'))
  })

  it('should deeply copy Emmet containers while preserving cycles', () => {
    const manager = new PluginConfigurationManager()
    const emmet: Record<string, unknown> = { preferences: { compact: true } }
    emmet.self = emmet

    manager.updateFromPluginConfig({ emmet })

    assert.notStrictEqual(manager.config.emmet, emmet)
    assert.deepEqual(manager.config.emmet.preferences, { compact: true })
    assert.strictEqual(manager.config.emmet.self, manager.config.emmet)
  })

  it.each(['emmet', 'lint'] as const)(
    'should preserve own __proto__ fields in %s without changing snapshot prototypes',
    (setting) => {
      const manager = new PluginConfigurationManager()
      const record: Record<string, unknown> = JSON.parse(
        '{"__proto__":{"showExpandedAbbreviation":"never"},"nested":{"__proto__":{"hidden":true}}}',
      )

      manager.updateFromPluginConfig({ [setting]: record })

      const snapshot = manager.config[setting]
      assert.strictEqual(Object.getPrototypeOf(snapshot), Object.prototype)
      assert.isTrue(Object.prototype.hasOwnProperty.call(snapshot, '__proto__'))
      assert.isUndefined(snapshot.showExpandedAbbreviation)
      assert.deepEqual(snapshot.__proto__, { showExpandedAbbreviation: 'never' })
      assert.notStrictEqual(snapshot.__proto__, record.__proto__)
      assert.strictEqual(Object.getPrototypeOf(snapshot.nested), Object.prototype)
      assert.deepEqual(Object.keys(snapshot.nested), ['__proto__'])
      assert.isUndefined(snapshot.nested.hidden)
    },
  )

  it.each([
    ['an Emmet callable', { emmet: { preferences: createHostileCallable() } }],
    ['an unknown lint callable', { lint: { futureRule: createHostileCallable() } }],
  ])('should reject %s instead of retaining a host callable', (_description, config) => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()

    manager.updateFromPluginConfig(config, logger)

    assert.deepEqual(manager.config, new PluginConfigurationManager().config)
    assert.include(logger.messages.join('\n'), 'could not be read safely')
  })

  it('should log a top-level configuration that is not an object', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig('styled', logger)

    assert.deepEqual(manager.config, new PluginConfigurationManager().config)
    assert.deepEqual(logger.messages, [
      'Ignored the plugin configuration: it accepts an object of plugin settings; received "styled". The defaults apply.',
    ])
  })

  it('should describe a value that JSON cannot represent', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig({ validate: 1n }, logger)

    assert.deepEqual(logger.messages, [
      'Ignored the plugin setting validate: it accepts true or false; received 1. The default applies.',
    ])
  })

  it.each([
    ['a function', () => true, '() => true'],
    ['a symbol', Symbol('on'), 'Symbol(on)'],
  ])(
    'should describe %s, which JSON leaves undefined, with String',
    (_description, value, text) => {
      const manager = new PluginConfigurationManager()
      const logger = createLogger()
      manager.updateFromPluginConfig({ validate: value }, logger)

      assert.deepEqual(logger.messages, [
        `Ignored the plugin setting validate: it accepts true or false; received ${text}. The default applies.`,
      ])
    },
  )

  it('should apply the configuration and never throw when the logger throws', () => {
    const manager = new PluginConfigurationManager()
    const throwingLogger = {
      log() {
        throw new Error('log failed')
      },
    }

    assert.doesNotThrow(() =>
      manager.updateFromPluginConfig({ tags: 5, validate: false }, throwingLogger),
    )
    assert.strictEqual(manager.config.validate, false)
  })

  it('should use defaults when a hostile configuration cannot be read safely', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    const hostileConfig = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys failed')
        },
      },
    )

    assert.doesNotThrow(() => manager.updateFromPluginConfig(hostileConfig, logger))
    assert.deepEqual(manager.config, new PluginConfigurationManager().config)
    assert.include(logger.messages.join('\n'), 'could not be read safely')
  })

  it.each([null, undefined])(
    'should use defaults for an absent top-level configuration',
    (config) => {
      const manager = new PluginConfigurationManager()
      manager.updateFromPluginConfig(config)

      assert.deepEqual(manager.config, new PluginConfigurationManager().config)
    },
  )

  it.each([
    ['a missing letter', { tag: ['sty'] }, 'tag', 'tags'],
    ['a longer word', { validation: false }, 'validation', 'validate'],
    ['different letter case', { Tags: ['sty'] }, 'Tags', 'tags'],
    /** Case-sensitive, every letter differs; only a case-insensitive distance finds `tags`. */
    ['every letter in capitals', { TAGS: ['sty'] }, 'TAGS', 'tags'],
    ['an extra letter', { lints: {} }, 'lints', 'lint'],
  ])(
    'should ignore a misspelled setting name with %s, log it, and suggest the setting it resembles',
    (_description, config, name, suggestion) => {
      const manager = new PluginConfigurationManager()
      const logger = createLogger()
      manager.updateFromPluginConfig(config, logger)

      assert.deepEqual(manager.config, new PluginConfigurationManager().config)
      assert.deepEqual(logger.messages, [
        `Ignored the plugin setting ${name}: the plugin has no setting with that name. Did you mean ${suggestion}? The plugin settings are emmet, lint, tags, and validate.`,
      ])
    },
  )

  it('should log an unknown setting name that resembles no setting without a suggestion', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig({ showErrors: true, validate: false }, logger)

    assert.strictEqual(manager.config.validate, false)
    assert.deepEqual(logger.messages, [
      'Ignored the plugin setting showErrors: the plugin has no setting with that name. The plugin settings are emmet, lint, tags, and validate.',
    ])
  })

  it('should not log the keys tsserver itself adds to a plugin configuration', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    manager.updateFromPluginConfig(
      { global: true, name: '@styled/typescript-styled-plugin', tag: ['sty'] },
      logger,
    )

    assert.deepEqual(logger.messages, [
      'Ignored the plugin setting tag: the plugin has no setting with that name. Did you mean tags? The plugin settings are emmet, lint, tags, and validate.',
    ])
  })

  it('should preserve unknown object settings from runtime configuration without logging', () => {
    const manager = new PluginConfigurationManager()
    const logger = createLogger()
    const runtimeConfiguration: unknown = {
      emmet: { futureOption: true },
      lint: { futureRule: 'off' },
    }
    manager.updateFromPluginConfig(runtimeConfiguration, logger)

    assert.deepEqual(manager.config.lint, {
      emptyRules: 'ignore',
      futureRule: 'off',
    } as unknown)
    assert.deepEqual(manager.config.emmet, { futureOption: true } as unknown)
    assert.deepEqual(logger.messages, [])
  })

  it('should append normalized editor tags without changing the project configuration', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    manager.updateFromProjectConfig({
      emmet: { showExpandedAbbreviation: 'never' },
      lint: { unknownProperties: 'ignore' },
      tags: ['css', 'projectTag'],
      validate: false,
    })

    editorConfiguration.updateFromPluginConfig({
      editorConfiguration: {
        extraTags: [' globalStyle ', 'projectTag', '', 'globalStyle', 'styledNative'],
        protocolVersion: 1,
        source: 'vscode-styled-components',
      },
    })

    assert.deepEqual(manager.config, {
      emmet: { showExpandedAbbreviation: 'never' },
      lint: { emptyRules: 'ignore', unknownProperties: 'ignore' },
      tags: ['css', 'projectTag', 'globalStyle', 'styledNative'],
      validate: false,
    })
  })

  it('should clear only editor tags when the overlay sends an empty list', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    manager.updateFromProjectConfig({ tags: ['projectTag'] })
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    editorConfiguration.updateFromPluginConfig(editorEnvelope([]))

    assert.deepEqual(manager.config.tags, ['projectTag'])
  })

  it('should clear editor tags for a legacy runtime replacement', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    manager.updateFromProjectConfig({ tags: ['projectTag'] })
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    editorConfiguration.deactivate()
    manager.updateFromPluginConfig({ tags: ['runtimeTag'], validate: false })

    assert.deepEqual(manager.config.tags, ['runtimeTag'])
    assert.strictEqual(manager.config.validate, false)
  })

  it('should broadcast a legacy snapshot to every surviving project manager', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const first = new ProjectConfigurationManager(editorConfiguration)
    const second = new ProjectConfigurationManager(editorConfiguration)
    first.updateFromProjectConfig({ tags: ['firstTag'] })
    second.updateFromProjectConfig({ tags: ['secondTag'], validate: false })
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))
    const legacy = new PluginConfigurationManager()
    legacy.updateFromPluginConfig({ tags: ['runtimeTag'], validate: false })

    editorConfiguration.activateLegacy(legacy.config)

    assert.deepEqual(first.config, legacy.config)
    assert.deepEqual(second.config, legacy.config)

    editorConfiguration.updateFromPluginConfig(editorEnvelope([]))
    assert.deepEqual(first.config.tags, ['firstTag'])
    assert.isTrue(first.config.validate)
    assert.deepEqual(second.config.tags, ['secondTag'])
    assert.isFalse(second.config.validate)
  })

  it('should broadcast equivalent legacy snapshots only once across project callbacks', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const updates = [0, 0, 0]
    const managers = updates.map((_, index) => {
      const manager = new ProjectConfigurationManager(editorConfiguration)
      manager.onUpdatedConfig(() => updates[index]++)
      return manager
    })
    const input = { emmet: { preferences: { compact: true } }, tags: ['runtimeTag'] }
    const send = () => {
      for (const _manager of managers) {
        const normalized = new PluginConfigurationManager()
        normalized.updateFromPluginConfig(input)
        editorConfiguration.activateLegacy(normalized.config)
      }
    }

    send()
    assert.deepEqual(updates, [1, 1, 1])

    input.emmet.preferences.compact = false
    send()
    assert.deepEqual(updates, [2, 2, 2])
    for (const manager of managers) {
      assert.deepEqual(manager.config.emmet, { preferences: { compact: false } })
    }
  })

  it('should restore the project base when an editor overlay follows a legacy replacement', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    manager.updateFromProjectConfig({ tags: ['projectTag'], validate: false })
    editorConfiguration.deactivate()
    manager.updateFromPluginConfig({ tags: ['runtimeTag'], validate: true })

    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    assert.deepEqual(manager.config.tags, ['projectTag', 'editorTag'])
    assert.strictEqual(manager.config.validate, false)
  })

  it('should restore the project base when an empty editor overlay follows a legacy replacement', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    manager.updateFromProjectConfig({ tags: ['projectTag'], validate: false })
    editorConfiguration.deactivate()
    manager.updateFromPluginConfig({ tags: ['runtimeTag'], validate: true })

    editorConfiguration.updateFromPluginConfig(editorEnvelope([]))

    assert.deepEqual(manager.config.tags, ['projectTag'])
    assert.strictEqual(manager.config.validate, false)
  })

  it('should notify once when switching from an editor overlay to a legacy replacement', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    manager.updateFromProjectConfig({ tags: ['projectTag'] })
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))
    let updates = 0
    manager.onUpdatedConfig(() => updates++)

    editorConfiguration.deactivate()
    manager.updateFromPluginConfig({ tags: ['runtimeTag'] })

    assert.strictEqual(updates, 1)
    assert.deepEqual(manager.config.tags, ['runtimeTag'])
  })

  it('should not notify for the same normalized editor tags', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    let updates = 0
    manager.onUpdatedConfig(() => updates++)

    editorConfiguration.updateFromPluginConfig(editorEnvelope([' editorTag ', 'editorTag']))
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    assert.strictEqual(updates, 1)
  })

  it.each([{ extraTags: [] }, { extraTags: ['projectTag'] }])(
    'should not notify when the first overlay leaves the effective configuration unchanged: $extraTags',
    ({ extraTags }) => {
      const editorConfiguration = new EditorConfigurationManager()
      const manager = new ProjectConfigurationManager(editorConfiguration)
      manager.updateFromProjectConfig({ tags: ['projectTag'], validate: false })
      const initialConfiguration = manager.config
      let updates = 0
      manager.onUpdatedConfig(() => updates++)

      editorConfiguration.updateFromPluginConfig(editorEnvelope(extraTags))

      assert.strictEqual(updates, 0)
      assert.strictEqual(manager.config, initialConfiguration)

      editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))
      assert.strictEqual(updates, 1)
      assert.deepEqual(manager.config.tags, ['projectTag', 'editorTag'])
      assert.isFalse(manager.config.validate)
    },
  )

  it.each([
    ['an unknown protocol', editorEnvelope(['replacement'], { protocolVersion: 2 })],
    ['an empty source', editorEnvelope(['replacement'], { source: '  ' })],
    ['a non-string source', editorEnvelope(['replacement'], { source: 1 })],
    ['an overlong source', editorEnvelope(['replacement'], { source: 'x'.repeat(129) })],
    ['a non-array tag value', editorEnvelope('replacement')],
  ])('should preserve the last valid editor tags for %s', (_description, config) => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    const logger = createLogger()
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    editorConfiguration.updateFromPluginConfig(config, logger)

    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
    assert.strictEqual(logger.messages.length, 1)
  })

  it('should discard non-string editor tag entries and report one summary', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    const logger = createLogger()

    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag', 1, null]), logger)

    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
    assert.deepEqual(logger.messages, [
      'Ignored 2 non-string entries in editorConfiguration.extraTags.',
      'Applied editor configuration v1: 1 additional tags.',
    ])
  })

  it('should accept another editor integration source', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)

    editorConfiguration.updateFromPluginConfig(
      editorEnvelope(['editorTag'], { source: 'example-editor.css-templates' }),
    )

    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
  })

  it('should replace one integration source overlay with another instead of accumulating them', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    editorConfiguration.updateFromPluginConfig(
      editorEnvelope(['firstTag'], { source: 'first-editor.css-templates' }),
    )

    editorConfiguration.updateFromPluginConfig(
      editorEnvelope(['secondTag'], { source: 'second-editor.css-templates' }),
    )

    assert.notInclude(manager.config.tags, 'firstTag')
    assert.deepEqual(manager.config.tags.slice(-1), ['secondTag'])
  })

  it('should apply editor configuration even when the logger throws', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    const throwingLogger = {
      log() {
        throw new Error('log failed')
      },
    }

    assert.doesNotThrow(() =>
      editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag', 1]), throwingLogger),
    )
    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
  })

  it.each([
    ['too many entries', Array.from({ length: 65 }, (_, index) => `tag-${index}`)],
    ['an overlong entry', ['x'.repeat(257)]],
    ['an overlong whitespace entry', [' '.repeat(257)]],
    ['an excessive total size', Array.from({ length: 17 }, () => 'x'.repeat(256))],
  ])('should preserve the last valid editor tags for %s', (_description, extraTags) => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    const logger = createLogger()
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    editorConfiguration.updateFromPluginConfig(editorEnvelope(extraTags), logger)

    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
    assert.include(logger.messages.join('\n'), 'resource limits')
  })

  it('should ignore a custom array iterator and enforce the captured array length', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    const extraTags: string[] = []
    let iteratorCalled = false
    extraTags[Symbol.iterator] = function* () {
      iteratorCalled = true
      for (let index = 0; index < 65; index++) {
        yield `tag-${index}`
      }
      return undefined
    }

    editorConfiguration.updateFromPluginConfig(editorEnvelope(extraTags))

    assert.isFalse(iteratorCalled)
    assert.deepEqual(manager.config.tags, new PluginConfigurationManager().config.tags)
  })

  it('should reject a non-primitive array length snapshot without reading array entries', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    const target: string[] = []
    let indexedReads = 0
    const extraTags = new Proxy(target, {
      get(array, property, receiver) {
        if (property === 'length') {
          return {
            [Symbol.toPrimitive]() {
              return 0
            },
          }
        }
        if (typeof property === 'string' && /^\d+$/.test(property)) {
          indexedReads++
        }
        return Reflect.get(array, property, receiver)
      },
    })

    editorConfiguration.updateFromPluginConfig(editorEnvelope(extraTags))

    assert.strictEqual(indexedReads, 0)
    assert.deepEqual(manager.config.tags, new PluginConfigurationManager().config.tags)
  })

  it('should validate one source snapshot', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    let reads = 0
    const protocol = {
      extraTags: ['editorTag'],
      protocolVersion: 1,
      get source() {
        reads++
        return reads === 1 ? 'example-editor.css-templates' : 'x'.repeat(129)
      },
    }

    editorConfiguration.updateFromPluginConfig({ editorConfiguration: protocol })

    assert.strictEqual(reads, 1)
    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
  })

  it.each([
    [
      'a throwing editorConfiguration getter',
      Object.defineProperty({}, 'editorConfiguration', {
        get() {
          throw new Error('getter failed')
        },
      }),
    ],
    [
      'a throwing ownKeys proxy',
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('ownKeys failed')
          },
        },
      ),
    ],
  ])('should reject %s without throwing', (_description, config) => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    assert.doesNotThrow(() => editorConfiguration.updateFromPluginConfig(config))
    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
  })

  it('should route an unreadable editor marker through legacy normalization', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))
    const config = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('descriptor failed')
        },
      },
    )

    assert.isFalse(editorConfiguration.updateFromPluginConfig(config))
    manager.updateFromPluginConfig(config)

    assert.deepEqual(manager.config, new PluginConfigurationManager().config)
  })

  it('should reject inherited protocol fields', () => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))
    const inherited = Object.create({
      extraTags: ['replacement'],
      protocolVersion: 1,
      source: 'vscode-styled-components',
    })

    editorConfiguration.updateFromPluginConfig({ editorConfiguration: inherited })

    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
  })

  it.each([
    ['an array envelope', Object.assign([], { editorConfiguration: {} })],
    [
      'a class instance envelope',
      new (class {
        public readonly editorConfiguration = {}
      })(),
    ],
  ])('should match but reject %s', (_description, config) => {
    const editorConfiguration = new EditorConfigurationManager()
    const manager = new ProjectConfigurationManager(editorConfiguration)
    editorConfiguration.updateFromPluginConfig(editorEnvelope(['editorTag']))

    assert.isTrue(editorConfiguration.updateFromPluginConfig(config))
    assert.deepEqual(manager.config.tags.slice(-1), ['editorTag'])
  })
})

describe('EditorConfigurationManager lifecycle', () => {
  it('should release discarded projects while continuing to update a surviving project', () => {
    execFileSync(
      process.execPath,
      [
        '--expose-gc',
        '--experimental-transform-types',
        '--no-warnings',
        path.join(process.cwd(), 'test/unit/editor-configuration-lifecycle.probe.ts'),
      ],
      { stdio: 'pipe', timeout: 10_000 },
    )
  })
})

function editorEnvelope(
  extraTags: unknown,
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    editorConfiguration: {
      extraTags,
      protocolVersion: 1,
      source: 'example-editor.css-templates',
      ...overrides,
    },
  }
}

function createLogger() {
  const messages: string[] = []
  return {
    log(message: string) {
      messages.push(message)
    },
    messages,
  }
}

function createHostileCallable(): () => void {
  return new Proxy(() => {}, {
    ownKeys() {
      throw new Error('late callable failure')
    },
  })
}
