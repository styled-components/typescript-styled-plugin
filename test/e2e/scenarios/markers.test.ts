import ts from 'typescript'
import { assert, describe, it } from 'vitest'

import { mark } from '../tsserver-fixture/markers'

/** TypeScript's own mapping from a text index to a 1-based protocol position. */
function typescriptLocation(text: string, index: number) {
  const { character, line } = ts
    .createSourceFile('probe.ts', text, ts.ScriptTarget.Latest)
    .getLineAndCharacterOfPosition(index)
  return { line: line + 1, offset: character + 1 }
}

describe('Source markers', () => {
  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
    ['line separator', String.fromCharCode(0x2028)],
    ['paragraph separator', String.fromCharCode(0x2029)],
  ])(
    'should place carets and ranges where TypeScript does after a %s break',
    (_name, lineBreak) => {
      const source = ['⟨first⟩a', 'bc⟨word⟩def⟨/word⟩', '', 'g⟨last⟩'].join(lineBreak)
      const marked = mark(source)
      const text = ['a', 'bcdef', '', 'g'].join(lineBreak)

      assert.strictEqual(marked.text, text)
      assert.deepEqual(marked.at('first'), typescriptLocation(text, 0))
      assert.deepEqual(marked.range('word'), {
        end: typescriptLocation(text, text.indexOf('def') + 3),
        start: typescriptLocation(text, text.indexOf('def')),
      })
      assert.deepEqual(marked.at('last'), typescriptLocation(text, text.length))
    },
  )

  it('should fail loudly on a missing or repeated marker', () => {
    assert.throws(() => mark('a').at('caret'), 'The source has no ⟨caret⟩ marker')
    assert.throws(() => mark('⟨word⟩a').range('word'), 'The source has no ⟨/word⟩ marker')
    assert.throws(() => mark('⟨a⟩x⟨a⟩'), 'The marker ⟨a⟩ appears twice')
  })
})
