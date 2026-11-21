import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'

import { PluginConfigurationManager } from '../../src/configuration/plugin-configuration'
import createPlugin from '../../src/index'
import { EditorConfigurationManager } from '../../src/tsserver/editor-configuration'
import { pluginIdentity, pluginPackageName } from '../../src/tsserver/plugin-identity'
import {
  isSupportedTypeScriptVersion,
  TsServerStyledPlugin,
} from '../../src/tsserver/tsserver-plugin'

const configPrefix = `[${pluginIdentity}] config: `
const defaultTags = new PluginConfigurationManager().config.tags

describe('TsServerStyledPlugin', () => {
  it('should log the resolved configuration after a legacy configuration change', () => {
    const messages: string[] = []
    const plugin = new TsServerStyledPlugin(ts)
    plugin.create(createPluginCreateInfo(messages))
    messages.length = 0

    plugin.onConfigurationChanged({ tags: ['sty'], validate: 'false' })

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

    assert.deepEqual(lastLoggedSettings(messages), {
      tags: ['projectTag', 'editorTag'],
      validate: false,
    })
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

    assert.deepEqual(lastLoggedSettings(messages), {
      tags: ['runtimeTag'],
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

    assert.deepEqual(lastLoggedSettings(messages), {
      tags: defaultTags,
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

    assert.deepEqual(lastLoggedSettings(messages), { tags: defaultTags, validate: true })
  })

  it('should share the last valid editor configuration across project plugin instances', () => {
    const firstMessages: string[] = []
    const secondMessages: string[] = []
    const editorConfiguration = new EditorConfigurationManager()
    const firstProjectPlugin = new TsServerStyledPlugin(ts, () => editorConfiguration)
    firstProjectPlugin.create(createPluginCreateInfo(firstMessages))
    firstProjectPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))
    firstProjectPlugin.onConfigurationChanged({
      editorConfiguration: {
        extraTags: 'replacement',
      },
    })

    const secondProjectPlugin = new TsServerStyledPlugin(ts, () => editorConfiguration)
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
      }),
    )

    assert.deepEqual(secondMessages, [
      `[${pluginIdentity}] Ignored editor configuration: extraTags must be an array.`,
      configPrefix +
        JSON.stringify({
          emmet: {},
          lint: { emptyRules: 'ignore' },
          tags: ['secondTag', 'editorTag'],
          validate: true,
        }),
    ])
  })

  it("should read a project's own plugin entry as its base, not as an editor envelope", () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const create = (projectPluginConfiguration: Readonly<Record<string, unknown>>) => {
      createPlugin({ typescript: ts }).create(
        createPluginCreateInfo(messages, { projectPluginConfiguration, projectService }),
      )
      return lastLoggedSettings(messages)
    }

    assert.deepEqual(create({ tags: ['a'] }), { tags: ['a'], validate: true })
    assert.deepEqual(create({ editorConfiguration: { extraTags: ['leak'] }, tags: ['b'] }), {
      tags: ['b'],
      validate: true,
    })
    assert.deepEqual(create({ tags: ['c'] }), { tags: ['c'], validate: true })
  })

  it('should find the project entry of a plugin loaded under an npm alias', () => {
    const messages: string[] = []
    const projectService = createProjectService(messages)
    const create = (options: Parameters<typeof createPluginCreateInfo>[1]) => {
      createPlugin({ typescript: ts }).create(
        createPluginCreateInfo(messages, { ...options, projectService }),
      )
      return lastLoggedSettings(messages)
    }

    assert.deepEqual(create({ projectPluginConfiguration: { tags: ['a1', 'a2', 'a3'] } }), {
      tags: ['a1', 'a2', 'a3'],
      validate: true,
    })
    assert.deepEqual(
      create({
        pluginName: 'styled-alias',
        projectPluginConfiguration: { tags: ['b'], validate: false },
      }),
      { tags: ['b'], validate: false },
    )
    assert.deepEqual(create({ projectPluginConfiguration: { tags: ['c1'] } }), {
      tags: ['c1'],
      validate: true,
    })
    assert.deepEqual(
      create({
        config: { editorConfiguration: { extraTags: ['editorTag'] }, name: 'styled-alias' },
        pluginName: 'styled-alias',
        projectPluginConfiguration: { tags: ['d'], validate: false },
      }),
      { tags: ['d', 'editorTag'], validate: false },
    )
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

    assert.deepEqual(lastLoggedSettings(secondMessages), {
      tags: ['secondTag'],
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

    assert.deepEqual(lastLoggedSettings(firstMessages), { tags: ['secondTag'], validate: true })
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

    assert.deepEqual(lastLoggedSettings(messages), { tags: ['secondTag'], validate: true })
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

    assert.deepEqual(lastLoggedSettings(messages), { tags: ['runtimeTag'], validate: true })
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

  it.each([
    ['its own earlier decoration', (service: ts.LanguageService) => service],
    ['another plugin wrapping its earlier decoration', wrapLikeAnotherPlugin],
    ['another plugin copying its earlier decoration by descriptor', copyByDescriptor],
  ])('should report each CSS diagnostic once when a reload passes in %s', (_name, wrap) => {
    const fileName = '/main.ts'
    const source = 'const a = styled.div`boarder: 0;`'
    const info = createPluginCreateInfo([], { files: { [fileName]: source } })
    const pluginDiagnostics = (service: ts.LanguageService) =>
      service
        .getSemanticDiagnostics(fileName)
        .filter((diagnostic) => diagnostic.source === pluginIdentity)
        .map(({ length, messageText, start }) => ({ length, messageText, start }))
    const expected = [
      {
        length: 'boarder'.length,
        messageText: "Unknown property: 'boarder'",
        start: source.indexOf('boarder'),
      },
    ]
    const first = createPlugin({ typescript: ts }).create(info)
    const wrapped = wrap(first)
    /** The positive control: the first load reports the diagnostic, also through the wrapper. */
    assert.deepEqual(pluginDiagnostics(first), expected)
    assert.deepEqual(pluginDiagnostics(wrapped), expected)

    const reloaded = createPlugin({ typescript: ts }).create({
      ...info,
      languageService: wrapped,
    })

    assert.deepEqual(pluginDiagnostics(reloaded), expected)
  })

  it('should skip the decorator in a superseded layer that another plugin still wraps', () => {
    const fileName = '/main.ts'
    const info = createPluginCreateInfo([], {
      files: { [fileName]: 'const a = styled.div`boarder: 0;`' },
    })
    /** The decorator reads the program through the project on every template walk. */
    const projectLanguageService = info.project.getLanguageService
    let walks = 0
    info.project.getLanguageService = (...args) => {
      walks++
      return projectLanguageService(...args)
    }
    const first = createPlugin({ typescript: ts }).create(info)
    first.getSemanticDiagnostics(fileName)
    const singleLayerWalks = walks
    const reloaded = createPlugin({ typescript: ts }).create({
      ...info,
      languageService: wrapLikeAnotherPlugin(first),
    })
    walks = 0

    reloaded.getSemanticDiagnostics(fileName)

    /** The positive control: one active layer walks the file. */
    assert.isAbove(singleLayerWalks, 0)
    assert.strictEqual(walks, singleLayerWalks)
  })

  it.each([
    [
      'assigns',
      (service: ts.LanguageService, patch: ts.LanguageService['getSemanticDiagnostics']) => {
        service.getSemanticDiagnostics = patch
      },
    ],
    [
      'defines',
      (service: ts.LanguageService, patch: ts.LanguageService['getSemanticDiagnostics']) => {
        /** By value alone, which on a plain service object only replaces the value. */
        Object.defineProperty(service, 'getSemanticDiagnostics', { value: patch })
      },
    ],
  ])(
    'should keep a method another plugin %s on its earlier layer during a reload',
    (_name, apply) => {
      const fileName = '/main.ts'
      const source = 'const a = styled.div`boarder: 0;`'
      const info = createPluginCreateInfo([], { files: { [fileName]: source } })
      const marker: ts.Diagnostic = {
        category: ts.DiagnosticCategory.Message,
        code: 1,
        file: undefined,
        length: 0,
        messageText: 'patched',
        start: 0,
      }
      const first = createPlugin({ typescript: ts }).create(info)
      /** Patches methods onto the service it receives and returns that same object, as ts-graphql-plugin does. */
      const getSemanticDiagnostics = first.getSemanticDiagnostics
      apply(first, (name) => [...getSemanticDiagnostics(name), marker])

      const reloaded = createPlugin({ typescript: ts }).create({ ...info, languageService: first })

      assert.deepEqual(
        reloaded
          .getSemanticDiagnostics(fileName)
          .filter(
            ({ messageText, source }) => source === pluginIdentity || messageText === 'patched',
          )
          .map(({ messageText, start }) => ({ messageText, start })),
        [
          { messageText: 'patched', start: 0 },
          { messageText: "Unknown property: 'boarder'", start: source.indexOf('boarder') },
        ],
      )
    },
  )

  it('should keep both entries active when a project lists this plugin twice under one name', () => {
    const fileName = '/main.ts'
    const source = 'const a = firstTag`boarder: 0;`; const b = secondTag`boarder: 0;`'
    const info = createPluginCreateInfo([], { files: { [fileName]: source } })
    const entries = ['firstTag', 'secondTag'].map((tag) => ({
      name: '@styled/typescript-styled-plugin',
      tags: [tag],
    }))
    info.project.getCompilerOptions = () => ({ plugins: entries })
    const first = createPlugin({ typescript: ts }).create({ ...info, config: entries[0] })
    const second = createPlugin({ typescript: ts }).create({
      ...info,
      config: entries[1],
      languageService: first,
    })

    assert.deepEqual(
      second
        .getSemanticDiagnostics(fileName)
        .filter((diagnostic) => diagnostic.source === pluginIdentity)
        .map(({ start }) => start),
      [source.indexOf('boarder'), source.lastIndexOf('boarder')].sort((a, b) => a - b),
    )
  })

  it('should retire an entry that a reload no longer enables', () => {
    const fileName = '/main.ts'
    const source = 'const a = firstTag`boarder: 0;`; const b = secondTag`boarder: 0;`'
    const info = createPluginCreateInfo([], {
      files: { [fileName]: source },
      projectService: createProjectService([], []),
    })
    const pluginStarts = (service: ts.LanguageService) =>
      service
        .getSemanticDiagnostics(fileName)
        .filter((diagnostic) => diagnostic.source === pluginIdentity)
        .map(({ start }) => start)
    const entries = ['firstTag', 'secondTag'].map((tag) => ({
      name: pluginPackageName,
      tags: [tag],
    }))
    info.project.getCompilerOptions = () => ({ plugins: entries })
    const first = createPlugin({ typescript: ts }).create({ ...info, config: entries[0] })
    const second = createPlugin({ typescript: ts }).create({
      ...info,
      config: entries[1],
      languageService: first,
    })
    /** The positive control: both entries are active before the reload. */
    assert.deepEqual(pluginStarts(second), [
      source.indexOf('boarder'),
      source.lastIndexOf('boarder'),
    ])

    const remaining = [entries[1]]
    info.project.getCompilerOptions = () => ({ plugins: remaining })
    const reloaded = createPlugin({ typescript: ts }).create({
      ...info,
      config: remaining[0],
      languageService: second,
    })

    assert.deepEqual(pluginStarts(reloaded), [source.lastIndexOf('boarder')])
  })

  it('should keep the layer chain the same depth across repeated reloads of two entries', (context) => {
    const fileName = '/main.ts'
    const source = 'const a = myCss`boarder: 0;`'
    const info = createPluginCreateInfo([], {
      files: { [fileName]: source },
      pluginName: 'styled-alias',
      projectPluginConfiguration: { tags: ['myCss'] },
      projectService: createProjectService([], [pluginPackageName]),
    })
    const stackTraceLimit = Error.stackTraceLimit
    Error.stackTraceLimit = Infinity
    context.onTestFinished(() => {
      Error.stackTraceLimit = stackTraceLimit
    })
    /** The number of frames between a request and the project's own language service. */
    let depth = 0
    const base = info.languageService
    const getSemanticDiagnostics = base.getSemanticDiagnostics
    base.getSemanticDiagnostics = (name) => {
      depth = new Error().stack?.split('\n').length ?? 0
      return getSemanticDiagnostics(name)
    }
    /** One project load: the aliased tsconfig entry, then the global plugin tsserver enables after it. */
    const load = (languageService: ts.LanguageService) => {
      const aliased = createPlugin({ typescript: ts }).create({ ...info, languageService })
      return createPlugin({ typescript: ts }).create({
        ...info,
        config: { global: true, name: pluginPackageName },
        languageService: aliased,
      })
    }
    const diagnoseAndMeasure = (service: ts.LanguageService) => {
      const starts = service
        .getSemanticDiagnostics(fileName)
        .filter((diagnostic) => diagnostic.source === pluginIdentity)
        .map(({ start }) => start)
      return { depth, starts }
    }

    let service = load(base)
    const loaded = diagnoseAndMeasure(service)
    for (let reload = 0; reload < 5; reload++) {
      service = load(service)
    }

    /** The positive control: the first load reports the aliased entry's diagnostic. */
    assert.deepEqual(loaded.starts, [source.indexOf('boarder')])
    assert.isAbove(loaded.depth, 0)
    assert.deepEqual(diagnoseAndMeasure(service), loaded)
  })

  it('should keep an aliased project entry active when a global entry loads after it', () => {
    const fileName = '/main.ts'
    const source = 'const a = myCss`boarder: 0;`'
    const projectService = createProjectService([])
    const info = createPluginCreateInfo([], {
      files: { [fileName]: source },
      pluginName: 'styled-alias',
      projectPluginConfiguration: { tags: ['myCss'] },
      projectService,
    })
    const aliased = createPlugin({ typescript: ts }).create(info)
    const global = createPlugin({ typescript: ts }).create({
      ...info,
      config: { global: true, name: '@styled/typescript-styled-plugin' },
      languageService: aliased,
    })

    assert.deepEqual(
      global
        .getSemanticDiagnostics(fileName)
        .filter((diagnostic) => diagnostic.source === pluginIdentity)
        .map(({ length, messageText, start }) => ({ length, messageText, start })),
      [
        {
          length: 'boarder'.length,
          messageText: "Unknown property: 'boarder'",
          start: source.indexOf('boarder'),
        },
      ],
    )
  })
})

/**
 * Another plugin's layer, binding each method of the service it wraps once, at creation, as
 * typescript-template-language-service-decorator does.
 */
function wrapLikeAnotherPlugin(service: ts.LanguageService): ts.LanguageService {
  const layer: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(service)) {
    layer[name] = typeof value === 'function' ? value.bind(service) : value
  }
  return layer as unknown as ts.LanguageService
}

/** Another plugin's layer that copies the service it wraps property by property, descriptors included. */
function copyByDescriptor(service: ts.LanguageService): ts.LanguageService {
  const layer: Record<string, unknown> = {}
  Object.defineProperties(layer, Object.getOwnPropertyDescriptors(service))
  return layer as unknown as ts.LanguageService
}

function createCycle(): Record<string, unknown> {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  return cycle
}

/**
 * The fields of PluginCreateInfo the plugin reads: its configuration, the host language service
 * it decorates, the project's own language service the decorator reads each file's program from,
 * and the project service logger its log lines go to. A real tsserver Project needs a
 * running server host, so the rest of the object is left out and the shape is asserted once here.
 */
function createPluginCreateInfo(
  messages: string[],
  {
    config,
    files = {},
    pluginName = '@styled/typescript-styled-plugin',
    projectPluginConfiguration,
    projectService,
    refreshDiagnostics,
  }: {
    config?: unknown
    files?: Readonly<Record<string, string>>
    pluginName?: string
    projectPluginConfiguration?: Readonly<Record<string, unknown>>
    projectService?: ReturnType<typeof createProjectService>
    refreshDiagnostics?: () => void
  } = {},
): ts.server.PluginCreateInfo {
  const host: ts.LanguageServiceHost = {
    fileExists: (fileName) => fileName in files,
    getCompilationSettings: () => ({}),
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => 'lib.d.ts',
    getScriptFileNames: () => Object.keys(files),
    getScriptSnapshot: (fileName) =>
      fileName in files ? ts.ScriptSnapshot.fromString(files[fileName]) : undefined,
    getScriptVersion: () => '0',
    readFile: (fileName) => files[fileName],
  }
  const projectPluginEntry = projectPluginConfiguration
    ? {
        name: pluginName,
        ...projectPluginConfiguration,
      }
    : undefined
  const languageService = ts.createLanguageService(host)
  const pluginCreateInfo = {
    config: config ?? projectPluginEntry ?? {},
    languageService,
    project: {
      close() {},
      getCompilerOptions: () => ({
        plugins: projectPluginEntry ? [projectPluginEntry] : undefined,
      }),
      getLanguageService: () => languageService,
      projectService: projectService ?? createProjectService(messages),
      refreshDiagnostics: refreshDiagnostics ?? (() => {}),
    },
  }
  return pluginCreateInfo as unknown as ts.server.PluginCreateInfo
}

function createProjectService(messages: string[], globalPlugins?: ReadonlyArray<string>) {
  return {
    globalPlugins,
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

function lastLoggedSettings(messages: ReadonlyArray<string>): Record<string, unknown> {
  const message = messages.filter((message) => message.startsWith(configPrefix)).at(-1)
  assert.isDefined(message)
  const { tags, validate } = JSON.parse(message.slice(configPrefix.length)) as Record<
    string,
    unknown
  >
  return { tags, validate }
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
