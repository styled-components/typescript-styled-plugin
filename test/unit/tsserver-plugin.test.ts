import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'

import createPlugin from '../../src/index'
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
      tagCount: 1,
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

  it('should restore the project base when an editor configuration arrives in create', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(
      createPluginCreateInfo(messages, {
        config: editorEnvelope(['editorTag']),
        projectPluginConfiguration: { tags: ['projectTag'], validate: false },
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(messages), {
      tagCount: 2,
      validate: false,
    })
    assert.notInclude(messages.join('\n'), 'projectTag')
    assert.notInclude(messages.join('\n'), 'editorTag')
  })

  it('should use the default project base when compiler options cannot be read', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)

    assert.doesNotThrow(() =>
      plugin.create(
        createPluginCreateInfo(messages, {
          config: editorEnvelope(['editorTag']),
          getCompilerOptions() {
            throw new Error('compiler options failed')
          },
        }),
      ),
    )
    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 8, validate: true })
    assert.include(
      messages.join('\n'),
      "Could not read the project's compiler options while restoring plugin configuration; using plugin defaults. Check the tsserver host's project implementation.",
    )
  })

  it('should prefer a legacy runtime configuration that arrives before create', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(
      createPluginCreateInfo(messages, {
        config: { tags: ['runtimeTag'], validate: true },
        projectPluginConfiguration: { tags: ['projectTag'], validate: false },
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(messages), {
      tagCount: 1,
      validate: true,
    })
  })

  it('should apply an empty legacy replacement sent before create', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(
      createPluginCreateInfo(messages, {
        config: { name: '@styled/typescript-styled-plugin' },
        projectPluginConfiguration: { tags: ['projectTag'], validate: false },
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(messages), {
      tagCount: 7,
      validate: true,
    })
  })

  it('should let a pre-create empty legacy override replace a shared editor overlay', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const firstPlugin = createPlugin({ typescript: ts })
    firstPlugin.create(createPluginCreateInfo(messages, { projectService }))
    firstPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))

    const secondPlugin = createPlugin({ typescript: ts })
    secondPlugin.create(
      createPluginCreateInfo(messages, {
        config: { name: '@styled/typescript-styled-plugin' },
        projectService,
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 7, validate: true })
  })

  it('should contain a hostile legacy configuration and keep new projects responsive', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const firstPlugin = createPlugin({ typescript: ts })
    firstPlugin.create(createPluginCreateInfo(messages, { projectService }))
    const hostileConfig = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys failed')
        },
      },
    )

    assert.doesNotThrow(() => firstPlugin.onConfigurationChanged(hostileConfig))
    const secondPlugin = createPlugin({ typescript: ts })
    assert.doesNotThrow(() =>
      secondPlugin.create(
        createPluginCreateInfo(messages, {
          projectPluginConfiguration: { tags: ['projectTag'], validate: false },
          projectService,
        }),
      ),
    )
    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 7, validate: true })
  })

  it('should not share a callable nested inside a legacy configuration', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const firstPlugin = createPlugin({ typescript: ts })
    firstPlugin.create(createPluginCreateInfo(messages, { projectService }))

    assert.doesNotThrow(() =>
      firstPlugin.onConfigurationChanged({ emmet: { preferences: () => undefined } }),
    )
    const secondPlugin = createPlugin({ typescript: ts })
    assert.doesNotThrow(() =>
      secondPlugin.create(
        createPluginCreateInfo(messages, {
          projectPluginConfiguration: { tags: ['projectTag'], validate: false },
          projectService,
        }),
      ),
    )
    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 7, validate: true })
  })

  it('should let the last dynamic configuration kind replace the previous one', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(
      createPluginCreateInfo(messages, {
        projectPluginConfiguration: { tags: ['projectTag'], validate: false },
      }),
    )

    plugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    plugin.onConfigurationChanged({ tags: ['runtimeTag'], validate: true })
    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 1, validate: true })

    plugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 2, validate: false })
  })

  it('should restore the project base for an empty overlay after a legacy replacement', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(
      createPluginCreateInfo(messages, {
        projectPluginConfiguration: { tags: ['projectTag'], validate: false },
      }),
    )
    plugin.onConfigurationChanged({ tags: ['runtimeTag'], validate: true })

    plugin.onConfigurationChanged(editorEnvelope([]))

    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 1, validate: false })
  })

  it('should share the last valid editor configuration across project plugin instances', () => {
    const firstMessages: string[] = []
    const secondMessages: string[] = []
    const firstProjectPlugin = createPlugin({ typescript: ts })
    const projectService = createProjectService(firstMessages)
    firstProjectPlugin.create(createPluginCreateInfo(firstMessages, { projectService }))
    firstProjectPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    firstProjectPlugin.onConfigurationChanged({
      editorConfiguration: {
        extraTags: ['replacement'],
        protocolVersion: 2,
        source: 'vscode-styled-components',
      },
    })

    const secondProjectPlugin = createPlugin({ typescript: ts })
    secondProjectPlugin.create(
      createPluginCreateInfo(secondMessages, {
        config: {
          editorConfiguration: {
            extraTags: ['replacement'],
            protocolVersion: 2,
            source: 'vscode-styled-components',
          },
          global: true,
          name: '@styled/typescript-styled-plugin',
        },
        projectPluginConfiguration: { tags: ['secondTag'] },
        projectService,
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(firstMessages), {
      tagCount: 2,
      validate: true,
    })
    assert.notInclude(secondMessages.join('\n'), 'unknown editor configuration envelope fields')
    assert.notInclude(firstMessages.join('\n'), 'editorTag')
    assert.notInclude(firstMessages.join('\n'), 'secondTag')
  })

  it('should isolate editor configuration between project services', () => {
    const firstMessages: string[] = []
    const secondMessages: string[] = []
    const firstProjectPlugin = createPlugin({ typescript: ts })
    firstProjectPlugin.create(createPluginCreateInfo(firstMessages))
    firstProjectPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))

    const secondProjectPlugin = createPlugin({ typescript: ts })
    secondProjectPlugin.create(
      createPluginCreateInfo(secondMessages, {
        projectPluginConfiguration: { tags: ['secondTag'] },
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(secondMessages), {
      tagCount: 1,
      validate: true,
    })
  })

  it('should keep ordinary project entries separate without treating them as legacy overrides', () => {
    const firstMessages: string[] = []
    const projectService = createProjectService(firstMessages)
    const firstPlugin = createPlugin({ typescript: ts })
    firstPlugin.create(
      createPluginCreateInfo(firstMessages, {
        projectPluginConfiguration: { tags: ['firstTag'], validate: false },
        projectService,
      }),
    )
    const secondPlugin = createPlugin({ typescript: ts })
    secondPlugin.create(
      createPluginCreateInfo(firstMessages, {
        projectPluginConfiguration: { tags: ['secondTag'], validate: true },
        projectService,
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(firstMessages), { tagCount: 1, validate: true })
  })

  it('should give a new project the last valid legacy state after an invalid envelope', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const firstPlugin = createPlugin({ typescript: ts })
    firstPlugin.create(
      createPluginCreateInfo(messages, {
        projectPluginConfiguration: { tags: ['firstTag'], validate: false },
        projectService,
      }),
    )
    firstPlugin.onConfigurationChanged({ tags: ['runtimeTag'], validate: true })
    firstPlugin.onConfigurationChanged({
      editorConfiguration: {
        extraTags: ['replacement'],
        protocolVersion: 2,
        source: 'example-editor.css-templates',
      },
    })

    const secondPlugin = createPlugin({ typescript: ts })
    secondPlugin.create(
      createPluginCreateInfo(messages, {
        config: {
          editorConfiguration: {
            extraTags: ['replacement'],
            protocolVersion: 2,
            source: 'example-editor.css-templates',
          },
          name: '@styled/typescript-styled-plugin',
        },
        projectPluginConfiguration: { tags: ['secondTag'], validate: false },
        projectService,
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 1, validate: true })
  })

  it('should keep separate project bases when editor tags change', () => {
    const firstMessages: string[] = []
    const secondMessages: string[] = []
    const projectService = createProjectService(firstMessages)
    const firstPlugin = createPlugin({ typescript: ts })
    firstPlugin.create(
      createPluginCreateInfo(firstMessages, {
        projectPluginConfiguration: { tags: ['firstTag'], validate: false },
        projectService,
      }),
    )
    const secondPlugin = createPlugin({ typescript: ts })
    secondPlugin.create(
      createPluginCreateInfo(secondMessages, {
        projectPluginConfiguration: { tags: ['secondTag'], validate: true },
        projectService,
      }),
    )

    firstPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    secondPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))

    assert.deepEqual(lastLoggedConfiguration(firstMessages, 1), {
      tagCount: 2,
      validate: false,
    })
    assert.deepEqual(lastLoggedConfiguration(firstMessages), {
      tagCount: 2,
      validate: true,
    })
  })
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
function createPluginCreateInfo(
  messages: string[],
  {
    config,
    getCompilerOptions,
    projectPluginConfiguration,
    projectService,
  }: {
    config?: unknown
    getCompilerOptions?: () => ts.CompilerOptions
    projectPluginConfiguration?: Readonly<Record<string, unknown>>
    projectService?: ReturnType<typeof createProjectService>
  } = {},
): ts.server.PluginCreateInfo {
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
  const projectPluginEntry = projectPluginConfiguration
    ? {
        name: '@styled/typescript-styled-plugin',
        ...projectPluginConfiguration,
      }
    : undefined
  const pluginCreateInfo = {
    config: config ?? projectPluginEntry ?? {},
    languageService: ts.createLanguageService(host),
    project: {
      getCompilerOptions:
        getCompilerOptions ??
        (() => ({
          plugins: projectPluginEntry ? [projectPluginEntry] : undefined,
        })),
      projectService: projectService ?? createProjectService(messages),
    },
  }
  return pluginCreateInfo as unknown as ts.server.PluginCreateInfo
}

function createProjectService(messages: string[]) {
  return {
    logger: {
      info(message: string) {
        messages.push(message)
      },
    },
  }
}

function editorEnvelope(extraTags: ReadonlyArray<string>): unknown {
  return {
    editorConfiguration: {
      extraTags,
      protocolVersion: 1,
      source: 'vscode-styled-components',
    },
  }
}

function lastLoggedConfiguration(
  messages: ReadonlyArray<string>,
  fromEnd = 0,
): Record<string, unknown> {
  const configPrefix = `[${pluginIdentity}] config: `
  const message = messages.filter((message) => message.startsWith(configPrefix)).at(-(fromEnd + 1))
  assert.isDefined(message)
  return JSON.parse(message.slice(configPrefix.length)) as Record<string, unknown>
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
