import type { server as tsserver } from 'typescript'
import { assert, describe, it } from 'vitest'

import {
  bodyOf,
  startServer,
  unicodeLineBreaks,
  useSharedServer,
} from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

describe('Completions', () => {
  const server = useSharedServer()

  /** Opens `source` and returns the completions at its `⟨caret⟩`. */
  async function completionsAt(source: string): Promise<tsserver.protocol.CompletionEntry[]> {
    const marked = mark(source)
    const file = server().open(marked.text)
    return bodyOf(await server().request('completions', { file, ...marked.at('caret') }))
  }

  async function namesAt(source: string): Promise<string[]> {
    return (await completionsAt(source)).map(({ name }) => name)
  }

  it('should return property value completions for single line string', async () => {
    const names = await namesAt('const single = css`color:⟨caret⟩`')

    assert.includeMembers(names, ['aliceblue', 'rgba'])
  })

  it('should not return SCSS functions in property value completions', async () => {
    const names = await namesAt('const scss = css`color:⟨caret⟩`')

    /** Positive control: the ordinary colors prove the plugin answered and filtered the list. */
    assert.include(names, 'aliceblue')
    assert.notInclude(names, 'darken')
  })

  it('should return property value completions for multiline string', async () => {
    const names = await namesAt(['const q = css`', 'color:⟨caret⟩', '`'].join('\n'))

    assert.include(names, 'aliceblue')
  })

  it.each(unicodeLineBreaks)(
    'should return completions after the Unicode %s',
    async (_description, separator) => {
      const names = await namesAt(`const q = css\`color: red;${separator}color:⟨caret⟩\``)

      assert.include(names, 'aliceblue')
    },
  )

  it('should return property value completions for nested selector', async () => {
    const names = await namesAt('const q = css`position: relative; &:hover { color:⟨caret⟩ }`')

    assert.include(names, 'aliceblue')
  })

  it('should not return css completions on tag', async () => {
    const source = mark(['css.⟨tag⟩``', 'const q = css`color:⟨value⟩`'].join('\n'))
    const file = server().open(source.text)

    const onTag = await server().request('completions', { file, ...source.at('tag') })
    const inTemplate = await server().request('completions', { file, ...source.at('value') })

    assert.deepInclude(onTag, { message: 'No content available.', success: false })
    /** Positive control in the same file: the template after the tag still gets CSS values. */
    assert.include(
      bodyOf(inTemplate).map(({ name }) => name),
      'aliceblue',
    )
  })

  it('should return completions when placeholder is used as property', async () => {
    const names = await namesAt('css`color:⟨caret⟩ ; boarder: 1px solid ${"red"};`')

    assert.include(names, 'aliceblue')
  })

  it('should return completions after a placeholder is used as a property', async () => {
    const names = await namesAt('css`border: 1px solid ${"red"}; color:⟨caret⟩`')

    assert.include(names, 'aliceblue')
  })

  it('should recover from a completions request that throws inside the CSS language service and keep serving later requests', async () => {
    /**
     * The first caret sits at the start of the property name the substitution generates for a
     * placeholder used as a property name followed by a value placeholder: completions there throw
     * inside vscode-css-languageservice (declaration.getProperty is not a function). The plugin
     * must answer with nothing instead of letting the exception reach tsserver, and the session
     * must keep answering.
     */
    const source = mark(
      [
        'const first = css`',
        "  ⟨throws⟩${'prop'}: ${'value'};",
        '`',
        'const second = css`color:⟨later⟩`',
      ].join('\n'),
    )
    const file = server().open(source.text)

    const throwing = await server().request('completions', { file, ...source.at('throws') })
    const later = await server().request('completions', { file, ...source.at('later') })

    assert.deepEqual(bodyOf(throwing), [])
    assert.include(
      bodyOf(later).map(({ name }) => name),
      'aliceblue',
    )
  })

  it('should return completions between placeholders used as properties', async () => {
    const names = await namesAt('css`boarder: 1px solid ${"red"}; color:⟨caret⟩ ; margin: ${20}; `')

    assert.include(names, 'aliceblue')
  })

  it('should return completions on tagged template string with placeholder using dotted tag', async () => {
    const names = await namesAt('css.x`color:⟨caret⟩ ; boarder: 1px solid ${"red"};`')

    assert.include(names, 'aliceblue')
  })

  it('should return js completions inside placeholder', async () => {
    const names = await namesAt('const abc = 123; css`color: ${⟨caret⟩};`')

    assert.include(names, 'abc')
  })

  it('should return js completions at end of placeholder', async () => {
    const names = await namesAt('css`color: ${"red".⟨caret⟩};`')

    assert.include(names, 'substr')
  })

  it('should return styled completions inside of nested placeholder', async () => {
    const names = await namesAt('styled`background: red; ${(() => css`color:⟨caret⟩`)()}`;')

    assert.include(names, 'aliceblue')
  })

  it('should handle multiline value placeholder correctly', async () => {
    const names = await namesAt(['css`margin: ${', '0', '}; color:⟨caret⟩ `'].join('\n'))

    assert.include(names, 'aliceblue')
  })

  it('should handle multiline rule placeholder correctly', async () => {
    const names = await namesAt(
      ['css`', '${', 'css`margin: 0;`', '}', 'color: ⟨caret⟩`'].join('\n'),
    )

    assert.include(names, 'aliceblue')
  })

  it('should return completions when placeholder is used as a selector', async () => {
    const names = await namesAt(
      ['css`${"button"} {', '   color: ⟨caret⟩;', '}', 'color: ;', '`'].join('\n'),
    )

    assert.include(names, 'aliceblue')
  })

  it('should return completions inside a nested selector', async () => {
    const names = await namesAt(
      ['css`', '    color: red;', '    &:hover {', '        color:⟨caret⟩   ', '    }', '`'].join(
        '\n',
      ),
    )

    assert.include(names, 'aliceblue')
  })

  it('should support tag that is a function call', async () => {
    const names = await namesAt('const q = css("bla")`color:⟨caret⟩`')

    assert.includeMembers(names, ['aliceblue', 'rgba'])
  })

  it('should support tag that is a templated function call', async () => {
    const names = await namesAt("const q = css<number>('bla')`color:⟨caret⟩`")

    assert.includeMembers(names, ['aliceblue', 'rgba'])
  })

  it('should offer nested at-rules with documentation for an at-keyword at statement position', async () => {
    const source = mark(
      ['const q = styled.div`', '  color: red;', '  ⟨word⟩@me⟨/word⟩', '`'].join('\n'),
    )
    const file = server().open(source.text)
    const caret = source.range('word').end

    const completions = bodyOf(await server().request('completions', { file, ...caret }))
    const details = bodyOf(
      await server().request('completionEntryDetails', { file, ...caret, entryNames: ['@media'] }),
    )

    const atRules = completions
      .filter((item) => /^@[a-z-]+$/.test(item.name))
      .map(({ insertText, isSnippet, kind, name, replacementSpan }) => ({
        insertText,
        isSnippet,
        kind,
        name,
        replacementSpan,
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
    /** `unknown`: the protocol types `kind` as an enum this file does not load at runtime. */
    assert.deepEqual<unknown>(
      atRules,
      [
        '@container',
        '@counter-style',
        '@font-face',
        '@font-palette-values',
        '@keyframes',
        '@layer',
        '@media',
        '@page',
        '@property',
        '@scope',
        '@starting-style',
        '@supports',
      ].map((name) => ({
        insertText: undefined,
        isSnippet: undefined,
        kind: 'keyword',
        name,
        replacementSpan: source.range('word'),
      })),
    )
    assert.deepEqual(
      details.map(({ name }) => name),
      ['@media'],
    )
    assert.match(
      details.flatMap(({ documentation = [] }) => documentation.map(({ text }) => text)).join(''),
      /media type/i,
    )
  })

  it('should mark color completions with "color" kindModifier', async () => {
    const completions = await completionsAt('const kind = css`color:⟨caret⟩`')

    assert.strictEqual(
      completions.find((item) => item.name === 'aliceblue')?.kindModifiers,
      'color',
    )
  })

  it('should offer property completions in an empty template', async () => {
    const names = await namesAt('const q = styled.div`⟨caret⟩`')

    assert.include(names, 'display')
  })

  it('should get completions inside keyframes blocks', async () => {
    const completions = await completionsAt('const q = keyframes`0% {color:⟨caret⟩`')

    assert.strictEqual(
      completions.find((item) => item.name === 'aliceblue')?.kindModifiers,
      'color',
    )
  })

  it('should never return snippet insertion text, even after the client configures includeCompletionsWithSnippetText like VS Code always does', async (context) => {
    /**
     * VS Code's TypeScript extension always sends includeCompletionsWithSnippetText as true
     * (extensions/typescript-language-features/src/languageFeatures/fileConfigurationManager.ts),
     * so the plugin cannot use that preference to decide whether to emit snippet tab stops. The
     * preference is session-wide, so this test runs its own server.
     */
    const ownServer = startServer(context)
    const source = mark('const q = css`bor⟨caret⟩`')
    const file = ownServer.open(source.text)

    const before = await ownServer.request('completions', { file, ...source.at('caret') })
    const configured = await ownServer.request('configure', {
      preferences: { includeCompletionsWithSnippetText: true },
    })
    const after = await ownServer.request('completions', { file, ...source.at('caret') })

    assert.isTrue(configured.success)
    for (const response of [before, after]) {
      const border = bodyOf(response).find((item) => item.name === 'border')
      assert.isDefined(border)
      assert.isUndefined(border.isSnippet)
      assert.isUndefined(border.insertText)
    }
  })
})
