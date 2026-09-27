import type { TemplateContext } from 'typescript-template-language-service-decorator'
import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'

import { withTemplateLineBreaks } from '../../src/features/completions'
import { getTemplateSubstitutions } from '../../src/template/template-substitutions'
import { LINE_SEPARATOR } from '../../src/virtual-document/css-code-scanner'
import { StyledVirtualDocumentProvider } from '../../src/virtual-document/styled-virtual-document-provider'
import { createTemplateLineMap } from '../../src/virtual-document/template-line-map'
import { createTemplateContext } from './create-template-context'

describe('withTemplateLineBreaks', () => {
  /**
   * A view whose line-shaped reads (getLineRange, lineCount) came from the un-aligned document
   * while getText and position mapping came from the aligned text would disagree with itself: this
   * pins the real invariant instead (docs/architecture.md, Completions, "Emmet line view").
   */
  it.each([
    ['a multi-line placeholder', 'margin: ${\n  a\n}; color: #12'],
    ['a lone carriage return', 'color: red;\rcolor: #12'],
    ['a line separator inside a string', `content: "a${LINE_SEPARATOR}b"; color: #12`],
  ])(
    'gives a view whose length, positions, and line ranges agree with each other, for %s',
    (_description, rawText) => {
      const context = createSubstitutingContext(rawText)
      const provider = new StyledVirtualDocumentProvider(ts)
      const document = provider.createVirtualDocument(context)
      const lineMap = createTemplateLineMap(context)
      const templateStart = provider.toVirtualDocOffset(0, context)

      const view = withTemplateLineBreaks(document, lineMap, templateStart)

      assert.strictEqual(view.getText().length, document.getText().length)

      for (let offset = 0; offset <= rawText.length; offset++) {
        const virtualPosition = provider.toVirtualDocPosition(context.toPosition(offset))
        assert.strictEqual(
          view.offsetAt(virtualPosition),
          document.offsetAt(virtualPosition),
          `template offset ${offset}`,
        )
      }

      const lines = view.getText().split('\n')
      for (let line = 0; line < view.lineCount; line++) {
        assert.strictEqual(view.getText(view.getLineRange(line)), lines[line], `line ${line}`)
      }
    },
  )
})

/** `rawText` with every `${...}` placeholder actually substituted, unlike create-template-context's fixed `text`. */
function createSubstitutingContext(rawText: string): TemplateContext {
  const base = createTemplateContext(rawText, 'styled.div')
  const spans = Array.from(rawText.matchAll(/\$\{[^}]*\}/g), (match) => ({
    end: match.index + match[0].length,
    start: match.index,
  }))
  let text: string | undefined
  return {
    ...base,
    get text() {
      if (text === undefined) {
        text = spans.length > 0 ? getTemplateSubstitutions(rawText, spans) : rawText
      }
      return text
    },
  }
}
