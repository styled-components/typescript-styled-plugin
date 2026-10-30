import assert from 'node:assert/strict'

import * as ts from 'typescript/lib/tsserverlibrary.js'

import {
  EditorConfigurationManager,
  ProjectConfigurationManager,
} from '../../src/tsserver/editor-configuration.ts'
import { TsServerStyledPlugin } from '../../src/tsserver/tsserver-plugin.ts'

function requireGc(): () => void {
  const gc = globalThis.gc
  if (!gc) {
    throw new Error('This probe needs --expose-gc.')
  }
  return gc
}

const gc = requireGc()

async function main(): Promise<void> {
  const messages: string[] = []
  const projectService = {
    logger: {
      info(message: string) {
        messages.push(message)
      },
    },
  }
  const editorConfiguration = new EditorConfigurationManager()
  const getEditorConfiguration = (info: ts.server.PluginCreateInfo) => {
    assert.equal(info.project.projectService, projectService)
    return editorConfiguration
  }
  const survivingPlugin = new TsServerStyledPlugin(ts, getEditorConfiguration)
  const survivingService = survivingPlugin.create(
    createPluginCreateInfo(projectService, { tags: ['survivingTag'] }),
  )
  const survivingProject = [...getListeners(editorConfiguration)][0]?.deref()
  assert.ok(survivingProject)
  let survivingUpdates = 0
  survivingProject.onUpdatedConfig(() => survivingUpdates++)

  function createDiscardedProject() {
    const plugin = new TsServerStyledPlugin(ts, getEditorConfiguration)
    plugin.create(createPluginCreateInfo(projectService, { tags: ['discardedTag'] }))
    const registration = [...getRegistrations(plugin)][0]
    assert.ok(registration)
    assert.ok(registration.logger.deref())
    assert.ok(registration.manager.deref())
    return registration
  }

  for (let round = 0; round < 3; round++) {
    const discardedProjects = Array.from({ length: 32 }, createDiscardedProject)
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setImmediate(resolve))
      gc()
      if (discardedProjects.every(({ logger, manager }) => !logger.deref() && !manager.deref())) {
        break
      }
    }
    for (const { logger, manager } of discardedProjects) {
      assert.equal(logger.deref(), undefined, 'the discarded project logger must be collectible')
      assert.equal(manager.deref(), undefined, 'the discarded project manager must be collectible')
    }
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      getListeners(editorConfiguration).size,
      1,
      'dead listener shells must be finalized',
    )
  }

  survivingPlugin.onConfigurationChanged(editorEnvelope(['editorTag']))

  assert.deepEqual(survivingProject.config.tags, ['survivingTag', 'editorTag'])
  assert.equal(survivingUpdates, 1)
  assert.equal(
    getListeners(editorConfiguration).size,
    1,
    'the discarded project listener registration must be removed',
  )
  assert.ok(survivingService.getProgram)
  assert.ok(messages.length > 0)
}

function createPluginCreateInfo(
  projectService: object,
  projectPluginConfiguration: Readonly<Record<string, unknown>>,
): ts.server.PluginCreateInfo {
  const projectPluginEntry = {
    name: '@styled/typescript-styled-plugin',
    ...projectPluginConfiguration,
  }
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
  return {
    config: projectPluginEntry,
    languageService: ts.createLanguageService(host),
    project: {
      getCompilerOptions: () => ({ plugins: [projectPluginEntry] }),
      projectService,
    },
  } as unknown as ts.server.PluginCreateInfo
}

function editorEnvelope(extraTags: ReadonlyArray<string>): unknown {
  return {
    editorConfiguration: {
      extraTags,
      protocolVersion: 1,
      source: 'lifecycle-test',
    },
  }
}

function getListeners(
  editorConfiguration: EditorConfigurationManager,
): ReadonlySet<WeakRef<ProjectConfigurationManager>> {
  return (
    editorConfiguration as unknown as {
      listeners: ReadonlySet<WeakRef<ProjectConfigurationManager>>
    }
  ).listeners
}

function getRegistrations(plugin: TsServerStyledPlugin): ReadonlySet<{
  readonly logger: WeakRef<object>
  readonly manager: WeakRef<ProjectConfigurationManager>
}> {
  return (
    plugin as unknown as {
      projectConfigurations: ReturnType<typeof getRegistrations>
    }
  ).projectConfigurations
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
