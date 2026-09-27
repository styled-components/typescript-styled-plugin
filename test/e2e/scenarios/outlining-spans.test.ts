import { assert, describe, it } from 'vitest'

import { bodyOf, startServer } from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

describe('Outlining spans', () => {
  it('should return basic CSS outlining spans', async (context) => {
    const server = startServer(context)
    const source = mark(
      ['const q = css`', '⟨a⟩a {', '⟨/a⟩color: red;', '}', '⟨div⟩div {', '⟨/div⟩', '}', '`'].join(
        '\n',
      ),
    )
    const file = server.open(source.text)

    const spans = bodyOf(await server.request('getOutliningSpans', { file }))

    /** TypeScript contributes the first span, for the multiline template literal itself. */
    assert.lengthOf(spans, 3)
    assert.deepEqual(
      spans.slice(1).map(({ textSpan }) => textSpan),
      [source.range('a'), source.range('div')],
    )
  })
})
