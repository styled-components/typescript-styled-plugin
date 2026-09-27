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
