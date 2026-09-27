import type { server as tsserver } from 'typescript'
import { assert, describe, it } from 'vitest'

import {
  bodyOf,
  pluginDiagnosticCode,
  unicodeLineBreaks,
  useSharedServer,
} from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

const renameToBorder = "Rename to 'border'"

describe('Code fixes', () => {
  const server = useSharedServer()

  /** The code fixes tsserver offers for `span` of `file`, answering `errorCodes`. */
  async function fixesAt(
    file: string,
    { end, start }: tsserver.protocol.TextSpan,
    errorCodes = [pluginDiagnosticCode],
  ): Promise<tsserver.protocol.CodeAction[]> {
    const response = await server().request('getCodeFixes', {
      endLine: end.line,
      endOffset: end.offset,
      errorCodes,
      file,
      startLine: start.line,
      startOffset: start.offset,
    })
    return bodyOf(response)
  }

  const at = (source: ReturnType<typeof mark>, caret: string) => ({
    end: source.at(caret),
    start: source.at(caret),
  })

  const descriptions = (fixes: readonly tsserver.protocol.CodeAction[]) =>
    fixes.map(({ description }) => description)

  it('should return a code fix for a misspelled property', async () => {
    const source = mark('const misspelled = css`b⟨caret⟩oarder: 1px solid black;`')
    const file = server().open(source.text)

    /** vscode-css-languageservice ranks these three by similarity to "boarder". */
    assert.deepEqual(descriptions(await fixesAt(file, at(source, 'caret'))), [
      renameToBorder,
      "Rename to 'border-top'",
      "Rename to 'border-left'",
    ])
  })

  it('should return a code fix when the cursor is at the diagnostic start', async () => {
    const source = mark('const atStart = css`⟨caret⟩boarder: 1px solid black;`')
    const file = server().open(source.text)

    assert.include(descriptions(await fixesAt(file, at(source, 'caret'))), renameToBorder)
  })

  it('should not return CSS code fixes for unrelated diagnostic codes', async () => {
    const source = mark('const unrelated = css`b⟨caret⟩oarder: 1px solid black;`')
    const file = server().open(source.text)

    assert.deepEqual(await fixesAt(file, at(source, 'caret'), [2304]), [])
    /**
     * Positive control in the same session: the same position with this plugin's own code returns
     * the fix, so the empty result above comes from the errorCodes filter.
     */
    assert.include(descriptions(await fixesAt(file, at(source, 'caret'))), renameToBorder)
  })

  it('should not return code fixes for correctly spelled properties', async () => {
    const spelled = mark('const spelled = css`b⟨caret⟩order: 1px solid black;`')
    const misspelled = mark('const misspelledJs = css`b⟨caret⟩oarder: 1px solid black;`')
    const spelledFile = server().open(spelled.text)
    const misspelledFile = server().open(misspelled.text, {
      fileName: 'script-kind-js.js',
      scriptKindName: 'JS',
    })

    assert.deepEqual(await fixesAt(spelledFile, at(spelled, 'caret')), [])
    /** Positive control in the same session: a misspelled property in a second open file. */
    assert.include(
      descriptions(await fixesAt(misspelledFile, at(misspelled, 'caret'))),
      renameToBorder,
    )
  })

  it('should not return a code fix whose edit would split a JavaScript escape', async () => {
    /** `\x62` is "b": the property reads `boarder` at runtime, but a rename would edit `2oarder`. */
    const escaped = mark('const escaped = css`⟨name⟩\\x62oarder⟨/name⟩: 1px solid black;`')
    const plain = mark('const plain = css`⟨name⟩boarder⟨/name⟩: 1px solid black;`')
    const escapedFile = server().open(escaped.text, {
      fileName: 'script-kind-js.js',
      scriptKindName: 'JS',
    })
    const plainFile = server().open(plain.text)

    assert.deepEqual(await fixesAt(escapedFile, escaped.range('name')), [])
    /** Positive control in the same session: the same property written without the escape. */
    assert.include(descriptions(await fixesAt(plainFile, plain.range('name'))), renameToBorder)
  })

  it('should map a code fix after a multiline interpolation to the source file', async () => {
    const source = mark(
      [
        'function css(strings: TemplateStringsArray, ...values: unknown[]) { return ""; }',
        'const q = css`',
        '  color: ${',
        '    "red"',
        '  };',
        '  ⟨name⟩boarder⟨/name⟩: 1px solid black;',
        '`',
      ].join('\n'),
    )
    const file = server().open(source.text)

    const fix = (await fixesAt(file, source.range('name'))).find(
      ({ description }) => description === renameToBorder,
    )

    assert.deepEqual(fix?.changes, [
      { fileName: file, textChanges: [{ newText: 'border', ...source.range('name') }] },
    ])
  })

  it.each(unicodeLineBreaks)(
    'should map a code fix after the Unicode %s',
    async (_description, separator) => {
      const source = mark(
        `const q = css\`color: red;${separator}⟨name⟩boarder⟨/name⟩: 1px solid black;\``,
      )
      const file = server().open(source.text)

      const fix = (await fixesAt(file, source.range('name'))).find(
        ({ description }) => description === renameToBorder,
      )

      assert.deepEqual(fix?.changes, [
        { fileName: file, textChanges: [{ newText: 'border', ...source.range('name') }] },
      ])
    },
  )

  it('should only return a spelling code fix when the range includes the misspelled property', async () => {
    /**
     * A zero-width request range is a point. A point exactly at the diagnostic's exclusive end is
     * after the property, not at its last character.
     */
    const source = mark('const q = css⟨before⟩`boa⟨inside⟩rder⟨after⟩: 1px solid black;`')
    const file = server().open(source.text)

    assert.deepEqual(await fixesAt(file, at(source, 'before')), [])
    /** Positive control in the same file: a point inside the property returns the fix. */
    assert.include(descriptions(await fixesAt(file, at(source, 'inside'))), renameToBorder)
    assert.deepEqual(await fixesAt(file, at(source, 'after')), [])
  })
})
