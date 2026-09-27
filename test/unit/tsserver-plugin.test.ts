import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'

import { pluginIdentity } from '../../src/tsserver/plugin-identity'
import {
  isSupportedTypeScriptVersion,
  TsServerStyledPlugin,
} from '../../src/tsserver/tsserver-plugin'

describe('TsServerStyledPlugin', () => {
  it('should log the resolved configuration after a configuration change', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(createPluginCreateInfo(messages))
    messages.length = 0

    plugin.onConfigurationChanged({ tags: ['sty'], validate: 'false' })

    const configPrefix = `[${pluginIdentity}] config: `
    assert.deepEqual(
      messages.map((message) => (message.startsWith(configPrefix) ? configPrefix : message)),
      [`[${pluginIdentity}] onConfigurationChanged`, configPrefix],
    )
    assert.deepEqual(JSON.parse(messages[1]?.slice(configPrefix.length) ?? ''), {
      emmet: {},
      lint: { emptyRules: 'ignore' },
      tags: ['sty'],
      validate: false,
    })
  })

  it.each([
    ['a bigint', { emmet: { unknownOption: 1n }, tags: ['sty'] }],
    ['a cycle', { emmet: createCycle(), tags: ['sty'] }],
  ])(
    'should apply and log a configuration holding %s JSON cannot represent',
    (_name, configuration) => {
      const messages: string[] = []
      const plugin = new TsServerStyledPlugin(ts)
      plugin.create(createPluginCreateInfo(messages))
      messages.length = 0

      plugin.onConfigurationChanged(configuration)

      const configPrefix = `[${pluginIdentity}] config: `
      assert.deepEqual(
        messages.map((message) => (message.startsWith(configPrefix) ? configPrefix : message)),
        [`[${pluginIdentity}] onConfigurationChanged`, configPrefix],
      )
    },
  )
})

function createCycle(): Record<string, unknown> {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  return cycle
}

/**
 * The fields of PluginCreateInfo the plugin reads: its configuration, the host language service
 * it decorates, and the project service logger its log lines go to. A real tsserver Project needs a
 * running server host, so the rest of the object is left out and the shape is asserted once here.
 */
function createPluginCreateInfo(messages: string[]): ts.server.PluginCreateInfo {
  const host: ts.LanguageServiceHost = {
    fileExists: () => false,
    getCompilationSettings: () => ({}),
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => 'lib.d.ts',
    getScriptFileNames: () => [],
    getScriptSnapshot: () => undefined,
    getScriptVersion: () => '0',
    readFile: () => undefined,
  }
  const pluginCreateInfo = {
    config: {},
    languageService: ts.createLanguageService(host),
    project: {
      projectService: {
        logger: {
          info(message: string) {
            messages.push(message)
          },
        },
      },
    },
  }
  return pluginCreateInfo as unknown as ts.server.PluginCreateInfo
}

describe('isSupportedTypeScriptVersion', () => {
  it.each([
    ['TypeScript 2.9, below the 5.0 floor', '2.9.0', false],
    ['TypeScript 3.9, below the 5.0 floor', '3.9.10', false],
    ['TypeScript 4.9, below the 5.0 floor', '4.9.5', false],
    ['TypeScript 5.0, the floor', '5.0.4', true],
    ['TypeScript 5.9', '5.9.3', true],
    ['TypeScript 6.0', '6.0.0', true],
    ['current TypeScript 6 baseline', '6.0.3', true],
    ['future TypeScript major with no declared upper bound', '7.0.0', true],
    ['prerelease version string on the floor major', '5.0.0-beta', true],
    ['prerelease version string on a future major', '7.1.0-dev.20260925.1', true],
  ])('should return %s support status', (_name, version, supported) => {
    assert.strictEqual(isSupportedTypeScriptVersion({ version }), supported)
  })
})
