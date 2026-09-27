import { assert, describe, it } from 'vitest'

import { bodyOf, useSharedServer } from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

describe('Script kinds', () => {
  const server = useSharedServer()

  it.each([
    ['JavaScript', 'script-kind-js.js', 'JS'],
    ['TypeScript', 'main.ts', 'TS'],
    ['JSX', 'script-kind-jsx.jsx', 'JSX'],
    ['TSX', 'script-kind-tsx.tsx', 'TSX'],
  ] as const)('should provide CSS completions in %s', async (name, fileName, scriptKindName) => {
    const source = mark(`const q = css\`color:⟨caret⟩\` // ${name}`)
    const file = server().open(source.text, { fileName, scriptKindName })

    const completions = bodyOf(
      await server().request('completions', { file, ...source.at('caret') }),
    )

    const aliceblue = completions.find((item) => item.name === 'aliceblue')
    assert.isDefined(aliceblue)
    assert.deepEqual(aliceblue.replacementSpan, {
      end: source.at('caret'),
      start: source.at('caret'),
    })
  })
})
