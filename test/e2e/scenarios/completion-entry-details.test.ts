import { assert, describe, it } from 'vitest'

import { bodyOf, startServer } from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

describe('CompletionEntryDetails', () => {
  it('should return details for color completion', async (context) => {
    const server = startServer(context)
    const source = mark('const q = css`color:⟨caret⟩`')
    const file = server.open(source.text)

    const details = bodyOf(
      await server.request('completionEntryDetails', {
        file,
        ...source.at('caret'),
        entryNames: ['blue'],
      }),
    )

    assert.deepEqual(
      details.map(({ documentation, name }) => ({ documentation, name })),
      [{ documentation: [{ kind: 'text', text: '#0000ff' }], name: 'blue' }],
    )
  })
})
