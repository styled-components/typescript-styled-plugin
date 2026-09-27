import { assert, describe, it } from 'vitest'

import { bodyOf, startServer } from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

describe('Hover', () => {
  it('should return CSS documentation for a property inside a tagged template', async (context) => {
    const server = startServer(context)
    const source = mark('const q = css`⟨declaration⟩co⟨caret⟩lor: red⟨/declaration⟩;`')
    const file = server.open(source.text)

    const quickInfo = bodyOf(await server.request('quickinfo', { file, ...source.at('caret') }))

    const documentation =
      typeof quickInfo.documentation === 'string'
        ? quickInfo.documentation
        : quickInfo.documentation.map((part) => part.text).join('')
    assert.match(documentation, /Sets the color/i)
    assert.deepEqual({ end: quickInfo.end, start: quickInfo.start }, source.range('declaration'))
  })
})
