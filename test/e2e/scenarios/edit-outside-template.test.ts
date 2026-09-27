import { assert, describe, it } from 'vitest'

import { bodyOf, pluginDiagnostics, startServer } from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'
import type { TSServer } from '../tsserver-fixture/server'

/**
 * Sends a "change" that inserts `insertion` at the `⟨marker⟩` of `source`, and returns the marked
 * source after the edit: the same text with `insertion` placed after that marker, so every other
 * marker shifts exactly as the edit shifts the text it marks.
 */
function insertAt(
  server: TSServer,
  {
    file,
    insertion,
    marker,
    source,
  }: { file: string; insertion: string; marker: string; source: string },
) {
  const { line, offset } = mark(source).at(marker)
  server.notify('change', {
    endLine: line,
    endOffset: offset,
    file,
    insertString: insertion,
    line,
    offset,
  })
  return mark(source.replace(`⟨${marker}⟩`, `⟨${marker}⟩${insertion}`))
}

describe.concurrent('Editing outside a template', () => {
  it('should map diagnostics, hover, and completions to the shifted position after a line is inserted above the template', async (context) => {
    const server = startServer(context)
    const source = [
      '⟨top⟩function css(strings: TemplateStringsArray, ...values: unknown[]) { return ""; }',
      'const q = css`',
      '  ⟨hover⟩color: red⟨/hover⟩;',
      '  ⟨boarder⟩boarder⟨/boarder⟩: 1px solid black;',
      '  ⟨backgr⟩backgr⟨/backgr⟩',
      '`',
    ].join('\n')
    const file = server.open(mark(source).text)

    /**
     * Builds and caches the template's virtual document before the edit: the defect this test
     * targets only surfaces on a reused document, never on one built fresh for the first request.
     */
    await server.request('semanticDiagnosticsSync', { file })
    const after = insertAt(server, {
      file,
      insertion: '// a comment line inserted above the template\n',
      marker: 'top',
      source,
    })

    const diagnostics = pluginDiagnostics(await server.request('semanticDiagnosticsSync', { file }))
    const hover = bodyOf(await server.request('quickinfo', { file, ...after.at('hover') }))
    const completions = bodyOf(
      await server.request('completions', { file, ...after.range('backgr').end }),
    )

    /**
     * The trailing "backgr" line (no colon or terminator) also reports its own end-of-template
     * diagnostics, unrelated to the mapping under test, so only the "boarder" one is asserted.
     */
    const boarder = diagnostics.find(({ text }) => text === "Unknown property: 'boarder'")
    assert.deepEqual({ end: boarder?.end, start: boarder?.start }, after.range('boarder'))
    assert.deepEqual({ end: hover.end, start: hover.start }, after.range('hover'))
    assert.deepEqual(
      completions.find(({ name }) => name === 'background-color')?.replacementSpan,
      after.range('backgr'),
    )
  })

  it('should map hover and completions on the second template to the shifted position after a line is inserted between two templates', async (context) => {
    /**
     * The cache holds one document at a time, keyed by file name, raw text, and wrapper. A whole
     * file sweep (diagnostics, folding) visits every template and rebuilds each one, so it cannot
     * reach the reuse path. Hover and completions resolve one template by cursor position, so the
     * same request on the same template before and after an edit between the templates does.
     */
    const server = startServer(context)
    const source = [
      'function css(strings: TemplateStringsArray, ...values: unknown[]) { return ""; }',
      'const a = css`margin: 0;`',
      '⟨between⟩const b = css`',
      '  ⟨hover⟩color: red⟨/hover⟩;',
      '  ⟨backgr⟩backgr⟨/backgr⟩',
      '`',
    ].join('\n')
    const before = mark(source)
    const file = server.open(before.text)

    /** Caches template b's document with a single-template request. */
    const hoverBefore = bodyOf(await server.request('quickinfo', { file, ...before.at('hover') }))
    const after = insertAt(server, {
      file,
      insertion: '// a comment line inserted between the two templates\n',
      marker: 'between',
      source,
    })

    const hover = bodyOf(await server.request('quickinfo', { file, ...after.at('hover') }))
    const completions = bodyOf(
      await server.request('completions', { file, ...after.range('backgr').end }),
    )

    assert.deepEqual({ end: hoverBefore.end, start: hoverBefore.start }, before.range('hover'))
    assert.deepEqual({ end: hover.end, start: hover.start }, after.range('hover'))
    assert.deepEqual(
      completions.find(({ name }) => name === 'background-color')?.replacementSpan,
      after.range('backgr'),
    )
  })
})
