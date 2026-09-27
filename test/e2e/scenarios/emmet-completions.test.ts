import { assert, describe, it } from 'vitest'

import { bodyOf, startServer, useSharedServer } from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'
import type { TSServer } from '../tsserver-fixture/server'

const marginExpansion = 'margin: 10px 20px;'

/** Opens `source` and returns a reader of the completion names at any of its carets. */
function openMarked(server: TSServer, source: string): (caret: string) => Promise<string[]> {
  const marked = mark(source)
  const file = server.open(marked.text)
  return async (caret) =>
    bodyOf(await server.request('completions', { file, ...marked.at(caret) })).map(
      ({ name }) => name,
    )
}

describe('Emmet Completions', () => {
  const server = useSharedServer()

  const namesAtCaret = (source: string) => openMarked(server(), source)('caret')

  it('should not return Emmet property completions when disabled', async (context) => {
    const disabledServer = startServer(context, { project: 'emmet-disabled-project-fixture' })
    const namesAt = openMarked(disabledServer, 'const q = css`color:⟨css⟩ ; m10-20⟨emmet⟩`')

    /** Positive control in the same session: CSS completions still arrive. */
    assert.include(await namesAt('css'), 'aliceblue')
    assert.notInclude(await namesAt('emmet'), marginExpansion)
  })

  it('should return Emmet property completions for a single-line string', async () => {
    assert.include(await namesAtCaret('const single = css`m10-20⟨caret⟩`'), marginExpansion)
  })

  it('should return Emmet property completions for a multiline string', async () => {
    assert.include(
      await namesAtCaret(['const q = css`', 'm10-20⟨caret⟩', '`'].join('\n')),
      marginExpansion,
    )
  })

  it('should return Emmet property completions for a nested selector', async () => {
    assert.include(
      await namesAtCaret('const q = css`position: relative; &:hover { m10-20⟨caret⟩ }`'),
      marginExpansion,
    )
  })

  it('should return emmet completions when placeholder is used as property', async () => {
    assert.include(
      await namesAtCaret('css`m10-20⟨caret⟩ ; boarder: 1px solid ${"red"};`'),
      marginExpansion,
    )
  })

  it('should return Emmet completions after a placeholder is used as a property', async () => {
    assert.include(
      await namesAtCaret('css`border: 1px solid ${"red"}; m10-20⟨caret⟩`'),
      marginExpansion,
    )
  })

  it('should return Emmet completions between placeholders used as properties', async () => {
    assert.include(
      await namesAtCaret('css`boarder: 1px solid ${"red"}; color: #12⟨caret⟩; margin: ${20}; `'),
      '#121212',
    )
  })

  it('should return emmet completions on tagged template string with placeholder using dotted tag', async () => {
    assert.include(
      await namesAtCaret('css.x`color: #12⟨caret⟩ ; boarder: 1px solid ${"red"};`'),
      '#121212',
    )
  })

  it('should return styled emmet completions inside of nested placeholder', async () => {
    assert.include(
      await namesAtCaret('styled`background: red; ${(() => css`color: #12⟨caret⟩`)()}`;'),
      '#121212',
    )
  })

  it('should handle emmet completions in multiline value placeholder correctly', async () => {
    assert.include(
      await namesAtCaret(['css`margin: ${', '0', '}; color: #12⟨caret⟩`'].join('\n')),
      '#121212',
    )
  })

  it('should handle emmet completions in multiline rule placeholder correctly', async () => {
    assert.include(
      await namesAtCaret(['css`', '${', 'css`margin: 0;`', '}', 'color: #12⟨caret⟩`'].join('\n')),
      '#121212',
    )
  })

  it('should return Emmet completions inside a nested selector', async () => {
    assert.include(
      await namesAtCaret(
        [
          'css`',
          '    color: red;',
          '    &:hover {',
          '        color: #12⟨caret⟩  ',
          '    }',
          '`',
        ].join('\n'),
      ),
      '#121212',
    )
  })

  it('should offer no Emmet declaration in value position, a string, or a comment, and keep it at statement position', async () => {
    const namesAt = openMarked(
      server(),
      'const q = css`display: fl⟨value⟩; content: "w10⟨string⟩"; /* p10⟨comment⟩ */ m10-20⟨statement⟩`',
    )

    const valueNames = await namesAt('value')
    assert.include(valueNames, 'flex')
    assert.notInclude(valueNames, 'float: left;')
    assert.deepEqual(await namesAt('string'), [])
    assert.deepEqual(await namesAt('comment'), [])
    /** Positive control in the same file: statement position still expands. */
    assert.include(await namesAt('statement'), marginExpansion)
  })

  it('should offer no Emmet declaration in a selector, an at-rule prelude, or at the end of an unterminated string', async () => {
    const namesAt = openMarked(
      server(),
      'const q = css`&:hover m10⟨selector⟩ { color: red; } @media m10⟨prelude⟩ { color: red; } m10-20⟨statement⟩`; const r = css`content: "a; @⟨string⟩`',
    )

    const selectorNames = await namesAt('selector')
    assert.include(selectorNames, ':active')
    assert.notInclude(selectorNames, 'margin: 10px;')
    assert.notInclude(await namesAt('prelude'), 'margin: 10px;')
    /** Positive control in the same file: statement position still expands. */
    assert.include(await namesAt('statement'), marginExpansion)
    assert.deepEqual(await namesAt('string'), [])
  })

  it('should mark emmet completions as isIncomplete', async () => {
    const source = mark('const incomplete = css`m10-20⟨caret⟩`')
    const file = server().open(source.text)

    const response = await server().request('completions', { file, ...source.at('caret') })

    assert.include(
      bodyOf(response).map(({ name }) => name),
      marginExpansion,
    )
    assert.deepEqual(response.metadata, { isIncomplete: true })
  })
})
