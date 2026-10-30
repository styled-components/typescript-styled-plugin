import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import type { server as tsserver } from 'typescript'
import { assert, describe, it } from 'vitest'

import {
  bodyOf,
  pluginDiagnosticCode,
  pluginDiagnostics,
  spansAndText,
  startServer,
} from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

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

  it('should keep the last valid overlay after a malformed editor envelope', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    const source = mark(
      'const base = projectTag`color:⟨base⟩`; const extra = editorTag`color:⟨extra⟩`',
    )
    const file = server.open(source.text)
    await server.configurePlugin(editorEnvelope(['editorTag']))

    await server.configurePlugin({
      editorConfiguration: {
        extraTags: ['replacementTag'],
        protocolVersion: 2,
        source: 'vscode-styled-components',
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
    assert.include(server.readLog(), 'unsupported protocolVersion type or value')
  })

  it('should accept an overlay from another host integration', async (context) => {
    const server = startServer(context, { project: 'editor-configuration-project-fixture' })
    const source = mark('const extra = editorTag`color:⟨extra⟩`')
    const file = server.open(source.text)

    await server.configurePlugin({
      editorConfiguration: {
        extraTags: ['editorTag'],
        protocolVersion: 1,
        source: 'example-lsp.css-templates',
      },
    })
    const extra = await server.request('completions', { file, ...source.at('extra') })

    assert.include(
      bodyOf(extra).map(({ name }) => name),
      'aliceblue',
    )
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
    await server.configurePlugin({ tags: ['runtimeTag'], validate: false })

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
    await server.configurePlugin(editorEnvelope(['editorTag']))

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

    await server.configurePlugin(editorEnvelope([]))
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
      protocolVersion: 1,
      source: 'vscode-styled-components',
    },
  }
}
