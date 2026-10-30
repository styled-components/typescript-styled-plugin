import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'

import createPlugin from '../../src/index'
import { pluginIdentity } from '../../src/tsserver/plugin-identity'
import {
  isSupportedTypeScriptVersion,
  TsServerStyledPlugin,
} from '../../src/tsserver/tsserver-plugin'

describe('TsServerStyledPlugin', () => {
  it('should log a configuration change without retaining per-project summaries', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(createPluginCreateInfo(messages))
    messages.length = 0

    plugin.onConfigurationChanged({ tags: ['sty'], validate: 'false' })

    assert.deepEqual(messages, [`[${pluginIdentity}] onConfigurationChanged`])
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

      assert.deepEqual(messages, [`[${pluginIdentity}] onConfigurationChanged`])
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

  it('should share the last valid editor configuration across project plugin instances', () => {
    const firstMessages: string[] = []
    const secondMessages: string[] = []
    const firstProjectPlugin = createPlugin({ typescript: ts })
    const projectService = createProjectService(firstMessages)
    firstProjectPlugin.create(createPluginCreateInfo(firstMessages, { projectService }))
    firstProjectPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    firstProjectPlugin.onConfigurationChanged({
      editorConfiguration: {
        extraTags: 'replacement',
      },
    })

    const secondProjectPlugin = createPlugin({ typescript: ts })
    secondProjectPlugin.create(
      createPluginCreateInfo(secondMessages, {
        config: {
          editorConfiguration: {
            extraTags: 'replacement',
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

  it('should compare a separately constructed project entry by effective settings', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const firstPlugin = createPlugin({ typescript: ts })
    firstPlugin.create(
      createPluginCreateInfo(messages, {
        config: {
          global: true,
          name: '@styled/typescript-styled-plugin',
          tags: ['firstTag'],
          validate: false,
        },
        projectPluginConfiguration: { tags: ['firstTag'], validate: false },
        projectService,
      }),
    )
    const secondPlugin = createPlugin({ typescript: ts })

    secondPlugin.create(
      createPluginCreateInfo(messages, {
        projectPluginConfiguration: { tags: ['secondTag'], validate: true },
        projectService,
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 1, validate: true })
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
        extraTags: 'replacement',
      },
    })

    const secondPlugin = createPlugin({ typescript: ts })
    secondPlugin.create(
      createPluginCreateInfo(messages, {
        config: {
          editorConfiguration: {
            extraTags: 'replacement',
          },
          name: '@styled/typescript-styled-plugin',
        },
        projectPluginConfiguration: { tags: ['secondTag'], validate: false },
        projectService,
      }),
    )

    assert.deepEqual(lastLoggedConfiguration(messages), { tagCount: 1, validate: true })
  })

  it('should refresh once per project service only when effective configuration changes', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const refreshes = [0, 0]
    const services = refreshes.map((_, index) => {
      const plugin = createPlugin({ typescript: ts })
      const service = plugin.create(
        createPluginCreateInfo(messages, {
          projectService,
          refreshDiagnostics: () => refreshes[index]++,
        }),
      )
      return { plugin, service }
    })

    services[0].plugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    assert.deepEqual(refreshes, [1, 0])

    services[1].plugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    services[0].plugin.onConfigurationChanged({ editorConfiguration: { extraTags: 'invalid' } })
    assert.deepEqual(refreshes, [1, 0])
  })

  it('should refresh through a surviving project after another project closes', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const firstPlugin = createPlugin({ typescript: ts })
    let firstRefreshes = 0
    const firstInfo = createPluginCreateInfo(messages, {
      projectService,
      refreshDiagnostics: () => firstRefreshes++,
    })
    firstPlugin.create(firstInfo)
    let secondRefreshes = 0
    const secondPlugin = createPlugin({ typescript: ts })
    secondPlugin.create(
      createPluginCreateInfo(messages, {
        projectService,
        refreshDiagnostics: () => secondRefreshes++,
      }),
    )

    firstPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    assert.strictEqual(firstRefreshes, 1)
    assert.strictEqual(secondRefreshes, 0)
    firstInfo.project.close()
    secondPlugin.onConfigurationChanged(editorEnvelope(['nextTag']))
    assert.strictEqual(firstRefreshes, 1)
    assert.strictEqual(secondRefreshes, 1)
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
    projectPluginConfiguration,
    projectService,
    refreshDiagnostics,
  }: {
    config?: unknown
    projectPluginConfiguration?: Readonly<Record<string, unknown>>
    projectService?: ReturnType<typeof createProjectService>
    refreshDiagnostics?: () => void
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
      close() {},
      getCompilerOptions: () => ({
        plugins: projectPluginEntry ? [projectPluginEntry] : undefined,
      }),
      projectService: projectService ?? createProjectService(messages),
      refreshDiagnostics: refreshDiagnostics ?? (() => {}),
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
