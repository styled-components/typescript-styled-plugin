import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'
import type { TextDocument } from 'vscode-languageserver-textdocument'

import {
  DefaultStylesLanguageServiceFactory,
  type ScssLanguageService,
} from '../../src/features/styles-language-services'
import { StyledVirtualDocumentProvider } from '../../src/virtual-document/styled-virtual-document-provider'
import { createTemplateLineMap } from '../../src/virtual-document/template-line-map'
import { CachedVirtualDocumentSessionProvider } from '../../src/virtual-document/virtual-document-session-provider'
import { createTemplateContext } from './create-template-context'

describe('CachedVirtualDocumentSessionProvider', () => {
  it('should reuse the same line map only when the virtual document is reusable', () => {
    /** A reusable document never recomputes its line-start table (docs/architecture.md, "Virtual document"). */
    const sessionProvider = createSessionProvider()
    const first = createTemplateContext('color: red;\nmargin: 0;')
    const second = { ...first }
    const third = createTemplateContext('padding: 0;')

    const firstLineMap = sessionProvider.getDocument(first).lineMap
    const secondLineMap = sessionProvider.getDocument(second).lineMap
    const thirdLineMap = sessionProvider.getDocument(third).lineMap

    assert.strictEqual(secondLineMap, firstLineMap)
    assert.notStrictEqual(thirdLineMap, firstLineMap)
  })

  it('should compute a line map whose template end matches the raw text length', () => {
    const sessionProvider = createSessionProvider()
    const context = createTemplateContext('a {\n  color: red;\n}\ncolr: blue;')

    const { lineMap } = sessionProvider.getDocument(context)

    assert.deepEqual(lineMap.lineStarts, [0, 4, 18, 20])
    assert.deepEqual(lineMap.templateEnd, {
      offset: context.rawText.length,
      position: { line: 3, character: 'colr: blue;'.length },
    })
  })

  it('should recompute the line map after a raw-text change invalidates the cached document', () => {
    const sessionProvider = createSessionProvider()
    const first = createTemplateContext('color: red;')
    const second = createTemplateContext('color: red;\nmargin: 0;')

    sessionProvider.getDocument(first)
    const secondLineMap = sessionProvider.getDocument(second).lineMap

    assert.strictEqual(secondLineMap.templateEnd.offset, second.rawText.length)
  })

  it('should share one line map per template context with the document built from it', () => {
    const sessionProvider = createSessionProvider()
    const context = createTemplateContext('color: red;\nmargin: 0;')

    const { document, lineMap } = sessionProvider.getParsedDocument(context)

    assert.strictEqual(lineMap, createTemplateLineMap(context))
    assert.strictEqual(sessionProvider.getDocument(context).lineMap, lineMap)
    assert.strictEqual(sessionProvider.getDocument(context).document, document)
  })

  it('should expose the cached line map only for a reusable document, without building one', () => {
    const sessionProvider = createSessionProvider()
    const first = createTemplateContext('color: red;\nmargin: 0;')
    const other = createTemplateContext('padding: 0;')

    assert.isUndefined(sessionProvider.getReusableLineMap(first))

    const firstLineMap = sessionProvider.getDocument(first).lineMap

    assert.strictEqual(sessionProvider.getReusableLineMap({ ...first }), firstLineMap)
    assert.isUndefined(sessionProvider.getReusableLineMap(other))
    assert.strictEqual(sessionProvider.getDocument(first).lineMap, firstLineMap)
  })

  it('should parse a new stylesheet when the document changes, and reuse it while the document is reused', () => {
    const scssLanguageService =
      new DefaultStylesLanguageServiceFactory().createScssLanguageService()
    const parsedTexts: string[] = []
    const recordingService: ScssLanguageService = {
      ...scssLanguageService,
      parseStylesheet(document: TextDocument) {
        parsedTexts.push(document.getText())
        return scssLanguageService.parseStylesheet(document)
      },
    }
    const sessionProvider = new CachedVirtualDocumentSessionProvider(
      new StyledVirtualDocumentProvider(ts),
      recordingService,
    )
    const first = createTemplateContext('color: red;')
    const other = createTemplateContext('margin: 0;')

    const firstParsed = sessionProvider.getParsedDocument(first)
    const reused = sessionProvider.getParsedDocument({ ...first })
    const otherParsed = sessionProvider.getParsedDocument(other)

    assert.strictEqual(reused.stylesheet, firstParsed.stylesheet)
    assert.notStrictEqual(otherParsed.stylesheet, firstParsed.stylesheet)
    assert.deepEqual(parsedTexts, [':root{\ncolor: red;\n}', ':root{\nmargin: 0;\n}'])
  })

  it.each([
    ['styled.div', 'createGlobalStyle'],
    ['createGlobalStyle', 'styled.div'],
  ])(
    'should build a new document for the same text under a tag that reads it differently, %s then %s',
    (firstTag, secondTag) => {
      const sessionProvider = createSessionProvider()
      const text = '@layer x { color: red; }'
      const nested = `:root{\n${' '.repeat('@layer x '.length - 1)}&{ color: red; }\n}`
      const topLevel = `:root{\n${text}\n}`
      const expected = (tagName: string) => (tagName === 'styled.div' ? nested : topLevel)

      const firstDocument = sessionProvider.getDocument(
        createTemplateContext(text, firstTag),
      ).document
      const secondDocument = sessionProvider.getDocument(
        createTemplateContext(text, secondTag),
      ).document

      assert.strictEqual(firstDocument.getText(), expected(firstTag))
      assert.strictEqual(secondDocument.getText(), expected(secondTag))
    },
  )
})

function createSessionProvider(): CachedVirtualDocumentSessionProvider {
  return new CachedVirtualDocumentSessionProvider(
    new StyledVirtualDocumentProvider(ts),
    new DefaultStylesLanguageServiceFactory().createScssLanguageService(),
  )
}
