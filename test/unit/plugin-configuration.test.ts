import { assert, describe, it } from 'vitest'

import { PluginConfigurationManager } from '../../src/configuration/plugin-configuration'

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
})

function createLogger() {
  const messages: string[] = []
  return {
    log(message: string) {
      messages.push(message)
    },
    messages,
  }
}
