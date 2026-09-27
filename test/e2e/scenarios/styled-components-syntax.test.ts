import { assert, describe, it } from 'vitest'

import { bodyOf, startServer, useSharedServer } from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'
import type { TSServer } from '../tsserver-fixture/server'

async function namesAtCaret(server: TSServer, source: string): Promise<string[]> {
  const marked = mark(source)
  const file = server.open(marked.text)
  const response = await server.request('completions', { file, ...marked.at('caret') })
  return bodyOf(response).map(({ name }) => name)
}

describe('Styled-components syntax', () => {
  const server = useSharedServer()

  it.each([
    ['styled.div', 'const Button = styled.div`color:⟨caret⟩`'],
    ['styled(Component)', 'const Button = styled(Component)`color:⟨caret⟩`'],
    ['css', 'const rules = css`color:⟨caret⟩`'],
    ['keyframes', 'const animation = keyframes`0% { color:⟨caret⟩ }`'],
    ['styled.keyframes', 'const animation = styled.keyframes`0% { color:⟨caret⟩ }`'],
    ['createGlobalStyle', 'const GlobalStyle = createGlobalStyle`color:⟨caret⟩`'],
    ['injectGlobal', 'injectGlobal`color:⟨caret⟩`'],
    ['extend', 'const Extended = Button.extend`color:⟨caret⟩`'],
    ['globalCss (Pigment CSS)', 'globalCss`color:⟨caret⟩`'],
  ])('should provide CSS completions for %s', async (_name, source) => {
    assert.include(await namesAtCaret(server(), source), 'aliceblue')
  })

  it('should not infer keyframes semantics from an alias', async () => {
    const source = mark(
      [
        'const kf = keyframes; const animation = kf`0% { color:⟨alias⟩ }`',
        'const direct = keyframes`0% { color:⟨direct⟩ }`',
      ].join('\n'),
    )
    const file = server().open(source.text)

    const alias = await server().request('completions', { file, ...source.at('alias') })
    const direct = await server().request('completions', { file, ...source.at('direct') })

    assert.deepInclude(alias, { message: 'No content available.', success: false })
    /** Positive control in the same file: the configured tag itself still gets CSS values. */
    assert.include(
      bodyOf(direct).map(({ name }) => name),
      'aliceblue',
    )
  })
})

describe('Default tag configuration', () => {
  it('should provide CSS completions for globalCss without an explicit tags list', async (context) => {
    const server = startServer(context, { project: 'default-tags-project-fixture' })

    assert.include(await namesAtCaret(server, 'globalCss`color:⟨caret⟩`'), 'aliceblue')
  })
})
