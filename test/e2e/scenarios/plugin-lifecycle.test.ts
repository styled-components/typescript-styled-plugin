import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import type { server as tsserver } from 'typescript'
import { assert, describe, it } from 'vitest'

import { repositoryRoot } from '../fixture-paths'
import {
  bodyOf,
  pluginDiagnosticCode,
  pluginDiagnostics,
  spansAndText,
  startServer,
} from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'
import { pluginPackageName } from '../tsserver-fixture/server'

describe.concurrent('Plugin lifecycle', () => {
  it('should keep tsserver responsive when a configured plugin can’t be found (a tsserver guard, not this plugin’s own resilience)', async (context) => {
    const server = startServer(context, { project: 'plugin-missing-project-fixture' })
    const source = mark('const value = 1⟨caret⟩')
    const file = server.open(source.text)

    const completions = await server.request('completions', { file, ...source.at('caret') })
    await server.close()

    /**
     * The fixture's tsconfig names a plugin that does not exist, so this plugin never loads here:
     * the successful response shows tsserver's own resilience, which the log line confirms.
     */
    assert.match(server.readLog(), /Failed to load module 'missing-tsserver-plugin'/)
    assert.isTrue(completions.success)
  })

  it('should ignore malformed plugin configuration without crashing tsserver, logging each rejected value', async (context) => {
    const server = startServer(context)
    const source = mark('const q = css`color:⟨caret⟩`')
    const file = server.open(source.text)

    await server.configurePlugin({
      emmet: null,
      lint: { unknownProperties: 0, vendorPrefix: 'off' },
      tag: 'styled',
      tags: 'css',
      validate: 'false',
    })
    const completions = await server.request('completions', { file, ...source.at('caret') })
    await server.close()

    /**
     * Positive control in the same session: a real CSS completion proves the plugin kept
     * answering under the single-string `tags` alias.
     */
    assert.include(
      bodyOf(completions).map(({ name }) => name),
      'aliceblue',
    )
    const log = server.readLog()
    assert.include(
      log,
      'Ignored the plugin setting emmet: it accepts an object of Emmet options; received null. The default applies.',
    )
    assert.include(
      log,
      'Ignored the plugin setting lint.unknownProperties: it accepts "ignore", "warning", or "error"; received 0. The CSS language service\'s own default for this rule applies.',
    )
    assert.include(
      log,
      'Ignored the plugin setting tag: the plugin has no setting with that name. Did you mean tags? The plugin settings are emmet, lint, tags, and validate.',
    )
    assert.notInclude(log, 'Ignored the plugin setting lint.vendorPrefix')
    assert.notInclude(log, 'Ignored the plugin setting tags')
    assert.notInclude(log, 'Ignored the plugin setting validate')
    /** The fixture's tsconfig plugins entry, which tsserver passes whole, carries `name`. */
    assert.notInclude(log, 'Ignored the plugin setting name')
  })

  it('should apply and reset tags through the template decorator configuration', async (context) => {
    const server = startServer(context)
    const source = mark('const q = sty`color:⟨caret⟩`')
    const file = server.open(source.text)
    const complete = () => server.request('completions', { file, ...source.at('caret') })

    const defaultTags = await complete()
    await server.configurePlugin({ tags: ['sty'] })
    const customTags = await complete()
    await server.configurePlugin({})
    const resetTags = await complete()

    assert.isFalse(defaultTags.success)
    /** Positive control in the same session: the configured tag gets CSS values. */
    assert.include(
      bodyOf(customTags).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse(resetTags.success)
  })

  it('should append and clear editor tags without replacing the project base', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    const source = mark(
      'const base = projectTag`boarder: 0; color:⟨base⟩`; const extra = editorTag`boarder: 0; color:⟨extra⟩`',
    )
    const file = server.open(source.text)
    const complete = (name: 'base' | 'extra') =>
      server.request('completions', { file, ...source.at(name) })

    const before = await complete('extra')
    await server.configurePlugin(editorEnvelope(['editorTag', 'projectTag']))
    const baseWithOverlay = await complete('base')
    const extraWithOverlay = await complete('extra')
    const diagnosticsWithOverlay = pluginDiagnostics(
      await server.request('semanticDiagnosticsSync', { file }),
    )
    await server.configurePlugin(editorEnvelope([]))
    const baseAfterClear = await complete('base')
    const extraAfterClear = await complete('extra')

    assert.isFalse(before.success)
    assert.include(
      bodyOf(baseWithOverlay).map(({ name }) => name),
      'aliceblue',
    )
    assert.include(
      bodyOf(extraWithOverlay).map(({ name }) => name),
      'aliceblue',
    )
    assert.deepEqual(diagnosticsWithOverlay, [])
    assert.include(
      bodyOf(baseAfterClear).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse(extraAfterClear.success)
  })

  it('should refresh diagnostics only for effective runtime configuration changes', async (context) => {
    const server = startServer(context)
    const source = mark('const extra = editorTag`⟨property⟩boarder⟨/property⟩: 1px solid black;`')
    const file = server.open(source.text)
    assert.deepEqual(
      pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file })),
      [],
    )
    server.takeProjectsUpdatedInBackgroundEvents()

    const transitions = [
      {
        config: editorEnvelope([]),
        diagnostic: false,
        name: 'initial empty overlay',
        refresh: false,
      },
      {
        config: editorEnvelope(['styled']),
        diagnostic: false,
        name: 'base tag only',
        refresh: false,
      },
      {
        config: editorEnvelope(['editorTag']),
        diagnostic: true,
        name: 'append tag',
        refresh: true,
      },
      {
        config: editorEnvelope([' editorTag ', 'editorTag']),
        diagnostic: true,
        name: 'equivalent overlay',
        refresh: false,
      },
      {
        config: { editorConfiguration: { extraTags: 'invalid' } },
        diagnostic: true,
        name: 'non-array overlay',
        refresh: false,
      },
      {
        config: { editorConfiguration: { extraTags: [1, null, ' '] } },
        diagnostic: true,
        name: 'all-invalid entries',
        refresh: false,
      },
      {
        config: editorEnvelope(['', '   ']),
        diagnostic: true,
        name: 'blank entries',
        refresh: false,
      },
      {
        config: { tags: ['editorTag'], validate: false },
        diagnostic: false,
        name: 'legacy disables validation',
        refresh: true,
      },
      {
        config: { tags: ['editorTag'], validate: 'false' },
        diagnostic: false,
        name: 'equivalent legacy',
        refresh: false,
      },
      {
        config: { tags: ['editorTag'], validate: true },
        diagnostic: true,
        name: 'legacy enables validation',
        refresh: true,
      },
      {
        config: editorEnvelope([]),
        diagnostic: false,
        name: 'empty overlay restores base',
        refresh: true,
      },
      {
        config: editorEnvelope(['editorTag']),
        diagnostic: true,
        name: 'append again',
        refresh: true,
      },
      { config: editorEnvelope([]), diagnostic: false, name: 'clear overlay', refresh: true },
      {
        config: editorEnvelope([]),
        diagnostic: false,
        name: 'already empty overlay',
        refresh: false,
      },
    ]
    for (const { config, diagnostic, name, refresh } of transitions) {
      await server.configurePlugin(config)
      assert.deepEqual(
        server.takeProjectsUpdatedInBackgroundEvents().flatMap(({ body }) => body.openFiles),
        refresh ? [file] : [],
        name,
      )
      assert.deepEqual(
        spansAndText(pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))),
        diagnostic ? [{ ...source.range('property'), text: "Unknown property: 'boarder'" }] : [],
        name,
      )
    }
  })

  it('should keep the last valid overlay after a malformed editor envelope', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    const source = mark(
      'const base = projectTag`color:⟨base⟩`; const extra = editorTag`color:⟨extra⟩`',
    )
    const file = server.open(source.text)
    await server.configurePlugin(editorEnvelope(['editorTag']))

    await server.configurePlugin({
      editorConfiguration: {
        extraTags: 'replacementTag',
      },
    })
    const base = await server.request('completions', { file, ...source.at('base') })
    const extra = await server.request('completions', { file, ...source.at('extra') })

    assert.include(
      bodyOf(base).map(({ name }) => name),
      'aliceblue',
    )
    assert.include(
      bodyOf(extra).map(({ name }) => name),
      'aliceblue',
    )
    assert.include(server.readLog(), 'extraTags must be an array')
  })

  it('should apply editor tags sent before project creation and restore the project base', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    await server.configurePlugin(editorEnvelope(['editorTag']))
    const source = mark(
      'const base = projectTag`color:⟨base⟩`; const extra = editorTag`color:⟨extra⟩`',
    )
    const file = server.open(source.text)

    const base = await server.request('completions', { file, ...source.at('base') })
    const extra = await server.request('completions', { file, ...source.at('extra') })

    assert.include(
      bodyOf(base).map(({ name }) => name),
      'aliceblue',
    )
    assert.include(
      bodyOf(extra).map(({ name }) => name),
      'aliceblue',
    )
  })

  it('should preserve a legacy replacement sent before project creation', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    await server.configurePlugin({ tags: ['runtimeTag'], validate: true })
    const source = mark(
      'const project = projectTag`color:⟨project⟩`; const runtime = runtimeTag`color:⟨runtime⟩`',
    )
    const file = server.open(source.text)

    const project = await server.request('completions', { file, ...source.at('project') })
    const runtime = await server.request('completions', { file, ...source.at('runtime') })

    assert.isFalse(project.success)
    assert.include(
      bodyOf(runtime).map(({ name }) => name),
      'aliceblue',
    )
  })

  it('should apply an empty legacy replacement sent before project creation', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    await server.configurePlugin({})
    const source = mark(
      'const project = projectTag`color:⟨project⟩`; const styledTemplate = styled.div`color:⟨styled⟩`',
    )
    const file = server.open(source.text)

    const project = await server.request('completions', { file, ...source.at('project') })
    const styled = await server.request('completions', { file, ...source.at('styled') })

    assert.isFalse(project.success)
    assert.include(
      bodyOf(styled).map(({ name }) => name),
      'aliceblue',
    )
  })

  it('should let the last dynamic configuration kind replace the previous one', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    const source = mark(
      'const project = projectTag`color:⟨project⟩`; const editor = editorTag`color:⟨editor⟩`; const runtime = runtimeTag`color:⟨runtime⟩`',
    )
    const file = server.open(source.text)
    const complete = (name: 'editor' | 'project' | 'runtime') =>
      server.request('completions', { file, ...source.at(name) })

    await server.configurePlugin(editorEnvelope(['editorTag']))
    assert.isTrue((await complete('editor')).success)

    await server.configurePlugin({ tags: ['runtimeTag'], validate: true })
    assert.isFalse((await complete('project')).success)
    assert.isFalse((await complete('editor')).success)
    assert.isTrue((await complete('runtime')).success)

    await server.configurePlugin(editorEnvelope(['editorTag']))
    assert.isTrue((await complete('project')).success)
    assert.isTrue((await complete('editor')).success)
    assert.isFalse((await complete('runtime')).success)

    await server.configurePlugin({ tags: ['runtimeTag'], validate: true })
    await server.configurePlugin(editorEnvelope([]))
    assert.isTrue((await complete('project')).success)
    assert.isFalse((await complete('editor')).success)
    assert.isFalse((await complete('runtime')).success)
  })

  it('should apply validation configuration changes to diagnostics and code fixes', async (context) => {
    const server = startServer(context)
    const source = mark('const q = css`⟨property⟩boarder⟨/property⟩: 1px solid black;`')
    const file = server.open(source.text)
    const property = source.range('property')
    const diagnose = async () =>
      spansAndText(pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file })))
    /** The plugin's part of each fix; tsserver adds its own `fixName`. */
    const fix = async (): Promise<tsserver.protocol.CodeAction[]> =>
      bodyOf(
        await server.request('getCodeFixes', {
          endLine: property.end.line,
          endOffset: property.end.offset,
          errorCodes: [pluginDiagnosticCode],
          file,
          startLine: property.start.line,
          startOffset: property.start.offset,
        }),
      ).map(({ changes, description }) => ({ changes, description }))
    const expectedDiagnostics = [{ ...property, text: "Unknown property: 'boarder'" }]
    /** vscode-css-languageservice ranks these three by similarity to "boarder". */
    const expectedFixes = ['border', 'border-top', 'border-left'].map((name) => ({
      changes: [{ fileName: file, textChanges: [{ newText: name, ...property }] }],
      description: `Rename to '${name}'`,
    }))

    const enabled = { diagnostics: await diagnose(), fixes: await fix() }
    await server.configurePlugin({ validate: false })
    const disabled = { diagnostics: await diagnose(), fixes: await fix() }
    await server.configurePlugin({})
    const reset = { diagnostics: await diagnose(), fixes: await fix() }

    /** The enabled and reset states are the positive controls for the silent disabled state. */
    assert.deepEqual(enabled, { diagnostics: expectedDiagnostics, fixes: expectedFixes })
    assert.deepEqual(disabled, { diagnostics: [], fixes: [] })
    assert.deepEqual(reset, { diagnostics: expectedDiagnostics, fixes: expectedFixes })
  })

  it('should replace editor tags and validation after a project reload', async (context) => {
    const server = startServer(context)
    const source = mark(
      'const base = styled.div`color:⟨base⟩red;`; const extra = editorTag`⟨property⟩boarder⟨/property⟩: 0; color:⟨extra⟩red;`; const runtime = runtimeTag`color:⟨runtime⟩red;`',
    )
    const file = server.open(source.text)
    const complete = (name: string) => server.request('completions', { file, ...source.at(name) })
    await server.configurePlugin(editorEnvelope(['editorTag']))
    assert.include(
      bodyOf(await complete('extra')).map(({ name }) => name),
      'aliceblue',
    )
    assert.deepEqual(
      spansAndText(pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))),
      [{ ...source.range('property'), text: "Unknown property: 'boarder'" }],
    )

    server.notify('reloadProjects', undefined)
    await complete('extra')
    server.takeProjectsUpdatedInBackgroundEvents()
    await server.configurePlugin({ tags: ['runtimeTag'], validate: false })

    assert.deepEqual(
      server.takeProjectsUpdatedInBackgroundEvents().flatMap(({ body }) => body.openFiles),
      [file],
    )
    assert.include(
      bodyOf(await complete('runtime')).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse((await complete('extra')).success)
    assert.isFalse((await complete('base')).success)
    assert.deepEqual(
      pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file })),
      [],
    )

    await server.configurePlugin(editorEnvelope(['editorTag']))
    assert.deepEqual(
      server.takeProjectsUpdatedInBackgroundEvents().flatMap(({ body }) => body.openFiles),
      [file],
    )
    assert.include(
      bodyOf(await complete('extra')).map(({ name }) => name),
      'aliceblue',
    )
  })

  it('should report diagnostics, code fixes, and outlining spans once after project reloads', async (context) => {
    const server = startServer(context)
    const source = mark(
      ['const q = css`', '⟨rule⟩a {', '⟨/rule⟩⟨property⟩boarder⟨/property⟩: 0;', '}', '`'].join(
        '\n',
      ),
    )
    const file = server.open(source.text)
    const property = source.range('property')
    const results = async () => ({
      diagnostics: spansAndText(
        pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file })),
      ),
      fixes: bodyOf(
        await server.request('getCodeFixes', {
          endLine: property.end.line,
          endOffset: property.end.offset,
          errorCodes: [pluginDiagnosticCode],
          file,
          startLine: property.start.line,
          startOffset: property.start.offset,
        }),
      ).map(({ description }) => description),
      /** TypeScript contributes the first span, for the multiline template literal itself. */
      outlining: bodyOf(await server.request('getOutliningSpans', { file }))
        .slice(1)
        .map(({ textSpan }) => textSpan),
    })
    const expected = {
      diagnostics: [{ ...property, text: "Unknown property: 'boarder'" }],
      /** vscode-css-languageservice ranks these three by similarity to "boarder". */
      fixes: ["Rename to 'border'", "Rename to 'border-top'", "Rename to 'border-left'"],
      outlining: [source.range('rule')],
    }

    const loaded = await results()
    server.notify('reloadProjects', undefined)
    const reloadedOnce = await results()
    server.notify('reloadProjects', undefined)
    const reloadedTwice = await results()

    /** The first load is the positive control for the reloaded results. */
    assert.deepEqual(loaded, expected)
    assert.deepEqual(reloadedOnce, expected)
    assert.deepEqual(reloadedTwice, expected)
  })

  it('should report each entry once after reloads when an aliased entry and a global plugin share a project', async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'styled-alias-global-'))
    context.onTestFinished(() => rmSync(directory, { force: true, recursive: true }))
    mkdirSync(path.join(directory, 'node_modules'))
    symlinkSync(repositoryRoot, path.join(directory, 'node_modules', 'styled-alias'), 'dir')
    writeFileSync(
      path.join(directory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { plugins: [{ name: 'styled-alias', tags: ['myCss'] }] },
        files: ['main.ts'],
      }),
    )
    const server = startServer(context, { globalPlugins: true, pluginProbeLocations: [directory] })
    /** `myCss` is the aliased entry's own tag; `styled` is one of the global entry's default tags. */
    const source = mark(
      'const a = myCss`⟨alias⟩boarder⟨/alias⟩: 0;`; const b = styled.div`⟨global⟩boarder⟨/global⟩: 0;`',
    )
    const file = path.join(directory, 'main.ts')
    /** On disk too: a reload on TypeScript 5.0 rereads the tsconfig `files` from disk. */
    writeFileSync(file, source.text)
    server.notify('open', { file, fileContent: source.text })
    const diagnose = async () =>
      spansAndText(pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file })))
    const expected = ['alias', 'global'].map((name) => ({
      ...source.range(name),
      text: "Unknown property: 'boarder'",
    }))

    const loaded = await diagnose()
    server.notify('reloadProjects', undefined)
    const reloadedOnce = await diagnose()
    server.notify('reloadProjects', undefined)
    const reloadedTwice = await diagnose()

    /** The first load is the positive control: both entries are active. */
    assert.deepEqual(loaded, expected)
    assert.deepEqual(reloadedOnce, expected)
    assert.deepEqual(reloadedTwice, expected)
  })

  it('should isolate project tags, validation, lint, and Emmet in one server', async (context) => {
    const server = startServer(context)
    const source = mark(
      'const base = styled.div`color:⟨base⟩`; const project = projectTag`color:⟨project⟩`; const extra = editorTag`⟨property⟩boarder⟨/property⟩: 0; color:⟨extra⟩`; const abbreviation = editorTag`m10-20⟨emmet⟩`',
    )
    const firstFile = server.open(source.text)
    const secondFile = server.open(source.text, {
      fileName: '../editor-configuration-project-fixture/main.ts',
    })
    const complete = (file: string, name: string) =>
      server.request('completions', { file, ...source.at(name) })
    await complete(secondFile, 'project')
    server.takeProjectsUpdatedInBackgroundEvents()
    await server.configurePlugin(editorEnvelope(['editorTag']))
    assert.deepEqual(
      server.takeProjectsUpdatedInBackgroundEvents().map(({ body }) => body.openFiles),
      [[firstFile, secondFile]],
    )

    for (const file of [firstFile, secondFile]) {
      assert.include(
        bodyOf(await complete(file, 'extra')).map(({ name }) => name),
        'aliceblue',
      )
    }
    assert.include(
      bodyOf(await complete(firstFile, 'base')).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse((await complete(firstFile, 'project')).success)
    assert.include(
      bodyOf(await complete(secondFile, 'project')).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse((await complete(secondFile, 'base')).success)
    assert.include(
      bodyOf(await complete(firstFile, 'emmet')).map(({ name }) => name),
      'margin: 10px 20px;',
    )
    assert.notInclude(
      bodyOf(await complete(secondFile, 'emmet')).map(({ name }) => name),
      'margin: 10px 20px;',
    )
    assert.include(
      pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file: firstFile })).map(
        ({ text }) => text,
      ),
      "Unknown property: 'boarder'",
    )
    assert.deepEqual(
      pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file: secondFile })),
      [],
    )

    const lintSource = mark(
      'const extra = editorTag`⟨property⟩boarder⟨/property⟩: 0; color:⟨extra⟩red;`',
    )
    const lintDirectory = mkdtempSync(path.join(tmpdir(), 'styled-editor-lint-'))
    context.onTestFinished(() => rmSync(lintDirectory, { force: true, recursive: true }))
    writeFileSync(
      path.join(lintDirectory, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          plugins: [
            { lint: { unknownProperties: 'ignore' }, name: '@styled/typescript-styled-plugin' },
          ],
        },
        files: ['main.ts'],
      }),
    )
    const lintFile = path.join(lintDirectory, 'main.ts')
    server.notify('open', { file: lintFile, fileContent: lintSource.text })
    assert.include(
      bodyOf(
        await server.request('completions', { file: lintFile, ...lintSource.at('extra') }),
      ).map(({ name }) => name),
      'aliceblue',
    )
    assert.deepEqual(
      pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file: lintFile })),
      [],
    )

    server.takeProjectsUpdatedInBackgroundEvents()
    await server.configurePlugin(editorEnvelope([]))
    assert.deepEqual(
      server.takeProjectsUpdatedInBackgroundEvents().map(({ body }) => body.openFiles),
      [[firstFile, secondFile, lintFile]],
    )
    assert.include(
      bodyOf(await complete(firstFile, 'base')).map(({ name }) => name),
      'aliceblue',
    )
    assert.include(
      bodyOf(await complete(secondFile, 'project')).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse((await complete(firstFile, 'extra')).success)
    assert.isFalse((await complete(secondFile, 'extra')).success)
    await server.close()
  })

  it("should read editorConfiguration in a project's own plugin entry as neither base nor overlay", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'styled-own-entry-'))
    context.onTestFinished(() => rmSync(directory, { force: true, recursive: true }))
    const server = startServer(context)
    const files = openProjects(server, directory, [
      { name: pluginPackageName, tags: ['a'] },
      { editorConfiguration: { extraTags: ['leak'] }, name: pluginPackageName, tags: ['b'] },
      { name: pluginPackageName, tags: ['c'] },
    ])

    for (const [index, file] of files.entries()) {
      assert.deepEqual(await recognizedTags(server, file), [['a', 'b', 'c'][index]])
    }
    await server.close()
  })

  it('should keep the settings of a plugin loaded under an npm alias in its own project', async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'styled-alias-entry-'))
    context.onTestFinished(() => rmSync(directory, { force: true, recursive: true }))
    mkdirSync(path.join(directory, 'node_modules'))
    symlinkSync(repositoryRoot, path.join(directory, 'node_modules', 'styled-alias'), 'dir')
    const server = startServer(context, { pluginProbeLocations: [directory] })
    const files = openProjects(server, directory, [
      { name: pluginPackageName, tags: ['a1', 'a2', 'a3'] },
      { name: 'styled-alias', tags: ['b'], validate: false },
      { name: pluginPackageName, tags: ['c1'] },
    ])

    assert.deepEqual(await recognizedTags(server, files[0]), ['a1', 'a2', 'a3'])
    assert.deepEqual(await recognizedTags(server, files[1]), ['b'])
    assert.deepEqual(await recognizedTags(server, files[2]), ['c1'])
    const diagnosticTexts = async (file: string) =>
      pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file })).map(
        ({ text }) => text,
      )
    assert.deepEqual(
      await diagnosticTexts(files[0]),
      Array.from({ length: 3 }, () => "Unknown property: 'boarder'"),
    )
    assert.deepEqual(await diagnosticTexts(files[1]), [])
    await server.close()
  })

  it('should keep configuration current when external projects close and reopen', async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'styled-editor-close-'))
    context.onTestFinished(() => rmSync(directory, { force: true, recursive: true }))
    const server = startServer(context, { globalPlugins: true })
    const source = mark(
      'const base = styled.div`color:⟨base⟩red;`; const extra = editorTag`color:⟨extra⟩red;`; const next = nextTag`color:⟨next⟩red;`',
    )
    const projects = ['first', 'second'].map((name) => {
      const file = path.join(directory, `${name}.ts`)
      writeFileSync(file, source.text)
      return {
        file,
        options: {},
        projectFileName: path.join(directory, `${name}.project`),
        rootFiles: [{ fileName: file }],
      }
    })
    const complete = (file: string, name: string) =>
      server.request('completions', { file, ...source.at(name) })
    for (const project of projects) {
      assert.isTrue((await server.request('openExternalProject', project)).success)
      assert.include(
        bodyOf(await complete(project.file, 'base')).map(({ name }) => name),
        'aliceblue',
      )
      assert.isFalse((await complete(project.file, 'extra')).success)
    }

    await server.configurePlugin(editorEnvelope(['editorTag']))
    for (const project of projects) {
      assert.include(
        bodyOf(await complete(project.file, 'extra')).map(({ name }) => name),
        'aliceblue',
      )
    }

    assert.isTrue(
      (
        await server.request('closeExternalProject', {
          projectFileName: projects[0].projectFileName,
        })
      ).success,
    )
    await server.configurePlugin(editorEnvelope(['nextTag']))
    assert.include(
      bodyOf(await complete(projects[1].file, 'next')).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse((await complete(projects[1].file, 'extra')).success)

    assert.isTrue(
      (
        await server.request('closeExternalProject', {
          projectFileName: projects[1].projectFileName,
        })
      ).success,
    )
    await server.configurePlugin(editorEnvelope(['editorTag']))
    assert.isTrue((await server.request('openExternalProject', projects[0])).success)
    assert.include(
      bodyOf(await complete(projects[0].file, 'extra')).map(({ name }) => name),
      'aliceblue',
    )
    assert.isFalse((await complete(projects[0].file, 'next')).success)
  })

  it('should replay an editor overlay in a fresh server before opening a project', async (context) => {
    const source = mark(
      'const base = projectTag`color:⟨base⟩`; const extra = editorTag`color:⟨extra⟩`',
    )
    const results: tsserver.protocol.CompletionEntry[][][] = []
    for (let session = 0; session < 2; session++) {
      const server = startServer(context, { project: 'editor-configuration-project-fixture' })
      if (session === 1) {
        await server.configurePlugin(editorEnvelope(['editorTag']))
      }
      const file = server.open(source.text)
      if (session === 0) {
        await server.configurePlugin(editorEnvelope(['editorTag']))
      }
      const completions = []
      for (const name of ['base', 'extra']) {
        const entries = bodyOf(await server.request('completions', { file, ...source.at(name) }))
        assert.include(
          entries.map(({ name }) => name),
          'aliceblue',
        )
        completions.push(entries)
      }
      results.push(completions)
      await server.close()
    }
    assert.deepEqual(results[1], results[0])
  })

  it.for(['configured', 'inferred'] as const)(
    'should load a global plugin with pre-create editor tags in a %s project',
    async (kind, context) => {
      const directory = mkdtempSync(path.join(tmpdir(), 'styled-global-editor-'))
      context.onTestFinished(() => rmSync(directory, { force: true, recursive: true }))
      if (kind === 'configured') {
        writeFileSync(
          path.join(directory, 'tsconfig.json'),
          '{"compilerOptions":{},"files":["main.ts"]}',
        )
      }
      const server = startServer(context, { globalPlugins: true })
      await server.configurePlugin(editorEnvelope(['editorTag']))
      const source = mark(
        'const base = styled.div`color:⟨base⟩red;`; const extra = editorTag`⟨property⟩boarder⟨/property⟩: 0; color:⟨extra⟩red;`',
      )
      const file = path.join(directory, 'main.ts')
      server.notify('open', { file, fileContent: source.text })
      for (const name of ['base', 'extra']) {
        assert.include(
          bodyOf(await server.request('completions', { file, ...source.at(name) })).map(
            ({ name }) => name,
          ),
          'aliceblue',
        )
      }
      assert.deepEqual(
        spansAndText(pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))),
        [{ ...source.range('property'), text: "Unknown property: 'boarder'" }],
      )
      await server.configurePlugin(editorEnvelope([]))
      assert.include(
        bodyOf(await server.request('completions', { file, ...source.at('base') })).map(
          ({ name }) => name,
        ),
        'aliceblue',
      )
      assert.isFalse((await server.request('completions', { file, ...source.at('extra') })).success)
    },
  )

  it.for([
    [
      'unknownProperties',
      'const q = css`⟨subject⟩boarder⟨/subject⟩: 1px solid black;`',
      "Unknown property: 'boarder'",
    ],
    [
      'unknownAtRules',
      'const q = css`⟨subject⟩@not-a-rule⟨/subject⟩ { color: red; }`',
      'Unknown at rule @not-a-rule',
    ],
  ])(
    'should apply CSS lint levels for %s through plugin configuration',
    async ([rule, sourceText, text], context) => {
      const server = startServer(context)
      const source = mark(sourceText)
      const file = server.open(source.text)

      const categories: Record<string, string[]> = {}
      for (const level of ['ignore', 'warning', 'error']) {
        await server.configurePlugin({ lint: { [rule]: level } })
        const diagnostics = pluginDiagnostics(
          await server.request('semanticDiagnosticsSync', { file }),
        )
        assert.deepEqual(
          spansAndText(diagnostics),
          level === 'ignore' ? [] : [{ ...source.range('subject'), text }],
        )
        categories[level] = diagnostics.map(({ category }) => category)
      }

      /** The warning and error levels are the positive controls for the silent ignore level. */
      assert.deepEqual(categories, { error: ['error'], ignore: [], warning: ['warning'] })
    },
  )

  it('should not report a diagnostic for an empty template even when empty rulesets are linted', async (context) => {
    /**
     * For an empty template, vscode-css-languageservice reports "Do not use empty rulesets" on the
     * synthetic wrapper rule, which has no template counterpart, so the plugin drops it.
     */
    const server = startServer(context)
    const source = mark('const empty = css``; const nested = css`⟨rule⟩a⟨/rule⟩ {}`')
    const file = server.open(source.text)

    await server.configurePlugin({ lint: { emptyRules: 'error' } })
    const diagnostics = pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))

    /**
     * Positive control in the same session: the real empty ruleset in the second template is
     * reported, so the setting took effect and the plugin loaded.
     */
    assert.deepEqual(spansAndText(diagnostics), [
      { ...source.range('rule'), text: 'Do not use empty rulesets' },
    ])
  })

  it('should not report an empty ruleset when its content is an interpolation (#4)', async (context) => {
    const server = startServer(context)
    const source = mark(
      [
        'declare const mixin: string;',
        'const interpolated = css`⟨interpolated⟩a⟨/interpolated⟩ { ${mixin} }`;',
        'const empty = css`⟨empty⟩b⟨/empty⟩ {}`;',
      ].join('\n'),
    )
    const file = server.open(source.text)

    await server.configurePlugin({ lint: { emptyRules: 'error' } })
    const diagnostics = pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))

    assert.deepEqual(spansAndText(diagnostics), [
      { ...source.range('empty'), text: 'Do not use empty rulesets' },
    ])
  })

  it('should apply and reset valid CSS properties through plugin configuration', async (context) => {
    const server = startServer(context)
    const source = mark('const q = css`⟨property⟩brand-tone⟨/property⟩: red;`')
    const file = server.open(source.text)

    await server.configurePlugin({ lint: { validProperties: ['brand-tone'] } })
    const custom = pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))
    await server.configurePlugin({})
    const reset = pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))

    assert.deepEqual(custom, [])
    /** Positive control in the same session: without the setting, the property is reported. */
    assert.deepEqual(spansAndText(reset), [
      { ...source.range('property'), text: "Unknown property: 'brand-tone'" },
    ])
  })

  it('should not activate on a TypeScript host below the 5.0 floor', async (context) => {
    const server = startServer(context, { typescriptPackage: 'typescript-legacy' })
    const source = mark('const q = css`boarder: 1px solid black;`; const r = css`color:⟨caret⟩`')
    const file = server.open(source.text)

    const diagnostics = await server.request('semanticDiagnosticsSync', { file })
    const completions = await server.request('completions', { file, ...source.at('caret') })
    await server.close()

    /**
     * The protocol responses alone cannot tell "the plugin chose not to activate" from "the plugin
     * failed to load": both answer without the plugin's diagnostics and completions. The log line
     * is the control: the plugin loaded, read the host version, and logged its refusal.
     */
    assert.match(
      server.readLog(),
      /\[ts-styled-plugin\] Unsupported TypeScript version .* TypeScript 5\.0 or newer required/,
    )
    assert.deepEqual(pluginDiagnostics(diagnostics), [])
    assert.notInclude(
      bodyOf(completions).map(({ name }) => name),
      'aliceblue',
    )
  })
})

function editorEnvelope(extraTags: ReadonlyArray<string>): unknown {
  return {
    editorConfiguration: {
      extraTags,
    },
  }
}

const probeTags = ['a', 'a1', 'a2', 'a3', 'b', 'c', 'c1', 'leak'] as const
const probeSource = mark(
  probeTags.map((tag) => `const ${tag}Value = ${tag}\`⟨${tag}⟩boarder: 0;\``).join('\n'),
)

/** Opens one configured project per plugin entry, each holding `probeSource`. */
function openProjects(
  server: ReturnType<typeof startServer>,
  directory: string,
  entries: ReadonlyArray<Readonly<Record<string, unknown>>>,
): string[] {
  return entries.map((entry, index) => {
    const projectDirectory = path.join(directory, `project-${index}`)
    mkdirSync(projectDirectory)
    writeFileSync(
      path.join(projectDirectory, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { plugins: [entry] }, files: ['main.ts'] }),
    )
    const file = path.join(projectDirectory, 'main.ts')
    server.notify('open', { file, fileContent: probeSource.text })
    return file
  })
}

/** The probe tags whose template gets CSS property completions in `file`. */
async function recognizedTags(
  server: ReturnType<typeof startServer>,
  file: string,
): Promise<string[]> {
  const recognized: string[] = []
  for (const tag of probeTags) {
    const response = await server.request('completions', { file, ...probeSource.at(tag) })
    if (response.success && bodyOf(response).some(({ name }) => name === 'color')) {
      recognized.push(tag)
    }
  }
  return recognized
}
