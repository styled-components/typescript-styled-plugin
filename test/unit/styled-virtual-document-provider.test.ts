import type { TemplateContext } from 'typescript-template-language-service-decorator'
import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'

import { PluginConfigurationManager } from '../../src/configuration/plugin-configuration'
import { StyledTemplateLanguageService } from '../../src/template-language-service'
import {
  createCodeLookback,
  createCssCodeScanState,
  type CssCodeScanState,
  INSIDE_NON_CODE,
  nonCodeEnd,
} from '../../src/virtual-document/css-code-scanner'
import {
  StyledVirtualDocumentProvider,
  type VirtualDocumentProvider,
} from '../../src/virtual-document/styled-virtual-document-provider'
import {
  createTemplateLineMap,
  fromVirtualDocSpan,
  fromVirtualDocSpanStrict,
  resolveTemplatePosition,
  resolveTemplatePositionStrict,
  templateOffsetToPosition,
  widenToEscapeRuns,
} from '../../src/virtual-document/template-line-map'
import { createTemplateContext } from './create-template-context'

describe('StyledVirtualDocumentProvider', () => {
  it('should wrap normal templates in a root rule and map positions in both directions', () => {
    const context = createTemplateContext('color: red;\nmargin: 0;')
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)

    assert.strictEqual(document.getText(), ':root{\ncolor: red;\nmargin: 0;\n}')
    assert.strictEqual(document.lineCount, 4)
    assert.deepEqual(document.positionAt(':root{\n'.length), { line: 1, character: 0 })
    assert.strictEqual(document.offsetAt({ line: 1, character: 0 }), ':root{\n'.length)
    assert.deepEqual(document.positionAt(document.getText().indexOf('margin')), {
      line: 2,
      character: 0,
    })
    assert.strictEqual(
      document.offsetAt({ line: 2, character: 0 }),
      document.getText().indexOf('margin'),
    )
  })

  it.each([
    ['line separator', String.fromCharCode(0x2028)],
    ['paragraph separator', String.fromCharCode(0x2029)],
  ])('should map positions across the Unicode %s', (_description, separator) => {
    const context = createTemplateContext(`color: red;${separator}margin: 0;`)
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)
    const sourceOffset = context.text.indexOf('margin')
    const virtualOffset = provider.toVirtualDocOffset(sourceOffset, context)
    const virtualPosition = provider.toVirtualDocPosition(context.toPosition(sourceOffset))

    assert.deepEqual(document.positionAt(virtualOffset), virtualPosition)
    assert.strictEqual(document.offsetAt(virtualPosition), virtualOffset)
  })

  it('should wrap keyframes templates in a keyframes rule', () => {
    const context = createTemplateContext('0% { opacity: 0; }', 'keyframes')
    const provider = new StyledVirtualDocumentProvider(ts)

    assert.strictEqual(
      provider.createVirtualDocument(context).getText(),
      '@keyframes custom {\n0% { opacity: 0; }\n}',
    )
  })

  it('should use a keyframes wrapper when the tag ends with keyframes', () => {
    const context = createTemplateContext('0% { opacity: 0; }', 'styled.keyframes')
    const provider = new StyledVirtualDocumentProvider(ts)

    assert.strictEqual(
      provider.createVirtualDocument(context).getText(),
      '@keyframes custom {\n0% { opacity: 0; }\n}',
    )
  })

  it('should only use the keyframes wrapper for the exact keyframes tag name', () => {
    const context = createTemplateContext('0% { opacity: 0; }', 'kf')
    const provider = new StyledVirtualDocumentProvider(ts)

    assert.strictEqual(
      provider.createVirtualDocument(context).getText(),
      ':root{\n0% { opacity: 0; }\n}',
    )
  })

  describe('value wrapper for value-shaped css fragments', () => {
    it.each([
      ['a border value', '1px solid red'],
      ['a value after a placeholder filled with whitespace', '      1s linear'],
      ['a multi-line value', '\n  spin 2s linear infinite\n'],
      ['a value with a colon inside parentheses', 'url(http://x/a.png) no-repeat'],
      ['a value with a colon inside a string', '"a:b" 1px'],
      ['a value with a colon inside a comment', '1px /* a: b; {} */ solid'],
      ['a value with a colon inside a line comment', '1px solid // note: a; b\n'],
      ['a number starting with a dot', '.5s ease'],
      ['a single number', '2s'],
      ['a value whose url() holds a comment with ";"', 'url(a/*;*/b.png) no-repeat'],
      ['a value whose url() holds ";"', 'url(a;b.png) no-repeat'],
      ['a value whose url() holds braces', 'url(a{b}.png) no-repeat'],
    ])('should use the value wrapper for %s', (_description, text) => {
      const context = createTemplateContext(text)
      const provider = new StyledVirtualDocumentProvider(ts)

      assert.strictEqual(provider.getVirtualDocumentWrapper(context), ':root{all:\n')
      assert.strictEqual(
        provider.createVirtualDocument(context).getText(),
        `:root{all:\n${text}\n}`,
      )
    })

    /**
     * Each raw template here holds JavaScript escapes, so the document holds their stand-ins
     * (replaceJavaScriptEscapes): a JavaScript `\\` is the CSS backslash that escapes what follows,
     * written as a hex escape (`\22` for the quote) where that keeps the same length.
     */
    it.each([
      [
        'a value with a colon inside a string after a CSS-escaped quote',
        '"a\\\\":b" 1px',
        '"a\\22:b" 1px',
      ],
      ['a value with a CSS-escaped colon after its first word', 'a b\\\\:c', 'a  b\\:c'],
      ['a value whose JavaScript-escaped quotes hold a ";"', '\\"a;b\\" 1px', ' "a;b " 1px'],
    ])('should use the value wrapper for %s', (_description, text, documentText) => {
      const context = createTemplateContext(text)
      const provider = new StyledVirtualDocumentProvider(ts)

      assert.strictEqual(provider.getVirtualDocumentWrapper(context), ':root{all:\n')
      assert.strictEqual(
        provider.createVirtualDocument(context).getText(),
        `:root{all:\n${documentText}\n}`,
      )
    })

    it.each([
      ['a declaration without a semicolon', 'color: red'],
      ['a declaration', 'color: red;'],
      ['a rule', 'a { color: red; }'],
      ['a stray closing brace', '1px }'],
      ['a single identifier (a property name being typed)', '\n  dis\n'],
      ['a custom property name being typed', '--brand'],
      ['a parent selector being typed', '& > a'],
      ['a class selector being typed', '.active'],
      ['an attribute selector being typed', '[disabled]'],
      ['an at-rule being typed', '@media screen'],
      /** The CSS-escaped quote opens no string, so the "{" after it is structural. */
      ['a rule whose selector holds a CSS-escaped quote', 'a\\\\"b { color: red; }'],
      /** The CSS-escaped "/" opens no comment, so the "{" after it is structural. */
      ['a rule whose selector holds a CSS-escaped "/" before "*"', 'a\\\\/*b { color: red; }'],
      ['a single identifier starting with a CSS escape', '\\\\:b'],
      ['a single identifier starting with a hex escape', '\\\\31 0'],
      ['only whitespace', '   '],
      ['an empty template', ''],
    ])('should keep the declaration wrapper for %s', (_description, text) => {
      const context = createTemplateContext(text)

      assert.strictEqual(
        new StyledVirtualDocumentProvider(ts).getVirtualDocumentWrapper(context),
        ':root{\n',
      )
    })

    it.each(['styled.div', 'createGlobalStyle', 'kf'])(
      'should keep the declaration wrapper for a value-shaped %s template',
      (tagName) => {
        const context = createTemplateContext('1px solid red', tagName)

        assert.strictEqual(
          new StyledVirtualDocumentProvider(ts).getVirtualDocumentWrapper(context),
          ':root{\n',
        )
      },
    )

    it('should use the value wrapper for a dotted tag ending in css', () => {
      const context = createTemplateContext('1px solid red', 'styled.css')

      assert.strictEqual(
        new StyledVirtualDocumentProvider(ts).getVirtualDocumentWrapper(context),
        ':root{all:\n',
      )
    })

    it('should map positions through the longer value wrapper and clamp the closing wrapper to the template end', () => {
      const context = createTemplateContext('1px solid red')
      const provider = new StyledVirtualDocumentProvider(ts)
      const document = provider.createVirtualDocument(context)
      const lineMap = createTemplateLineMap(context)
      const wrapperLength = ':root{all:\n'.length

      assert.strictEqual(provider.toVirtualDocOffset(4, context), wrapperLength + 4)
      assert.strictEqual(provider.fromVirtualDocOffset(wrapperLength + 4, context), 4)
      assert.deepEqual(document.positionAt(wrapperLength + 4), { line: 1, character: 4 })
      assert.deepEqual(resolveTemplatePosition(provider, { line: 2, character: 0 }, lineMap), {
        line: 0,
        character: context.text.length,
      })
    })
  })

  it('should only map the template body back from the virtual document', () => {
    const context = createTemplateContext('color: red;')
    const lineMap = createTemplateLineMap(context)
    const provider = new StyledVirtualDocumentProvider(ts)
    const wrapperLength = provider.getVirtualDocumentWrapper(context).length

    assert.strictEqual(provider.fromVirtualDocOffset(wrapperLength - 1, context), -1)
    assert.strictEqual(provider.fromVirtualDocOffset(wrapperLength, context), 0)
    assert.strictEqual(
      provider.fromVirtualDocOffset(wrapperLength + context.text.length, context),
      context.text.length,
    )
    assert.strictEqual(
      provider.fromVirtualDocOffset(wrapperLength + context.text.length + 1, context),
      context.text.length + 1,
    )
    /**
     * Virtual line 0 is the wrapper's own line: it has no source counterpart, so it is rejected
     * rather than mapped to a position; only the closing wrapper clamps (the last assertion).
     */
    assert.strictEqual(
      resolveTemplatePosition(provider, { line: 0, character: 0 }, lineMap),
      undefined,
    )
    assert.deepEqual(resolveTemplatePosition(provider, { line: 1, character: 0 }, lineMap), {
      line: 0,
      character: 0,
    })
    assert.deepEqual(provider.fromVirtualDocPosition({ line: 0, character: 0 }), {
      line: -1,
      character: 0,
    })
    /**
     * Virtual line 2 does not exist in this single-line template (the trailing "\n}" wrapper
     * line): it clamps to the template end instead of being dropped.
     */
    assert.deepEqual(resolveTemplatePosition(provider, { line: 2, character: 0 }, lineMap), {
      line: 0,
      character: 'color: red;'.length,
    })
  })

  it('should validate positions returned by a third-party provider that implements only fromVirtualDocPosition', () => {
    const context = createTemplateContext('color: red;')
    const lineMap = createTemplateLineMap(context)
    const provider = {
      fromVirtualDocPosition(position: ts.LineAndCharacter) {
        return { line: position.line - 1, character: position.character }
      },
    }

    assert.strictEqual(
      resolveTemplatePosition(provider, { line: 0, character: 0 }, lineMap),
      undefined,
    )
    assert.deepEqual(resolveTemplatePosition(provider, { line: 1, character: 0 }, lineMap), {
      line: 0,
      character: 0,
    })
  })

  it('should reject rather than clamp a position outside the template for code-fix edits', () => {
    const context = createTemplateContext('color: red;')
    const lineMap = createTemplateLineMap(context)
    const provider = new StyledVirtualDocumentProvider(ts)

    /** Inside the wrapper prefix (virtual line 0): no source counterpart, must be rejected. */
    assert.strictEqual(
      resolveTemplatePositionStrict(provider, { line: 0, character: 0 }, lineMap),
      undefined,
    )
    /**
     * Past the template end (the trailing "\n}" wrapper line): must be rejected, not clamped,
     * since applying an edit there would rewrite text outside the template.
     */
    assert.strictEqual(
      resolveTemplatePositionStrict(provider, { line: 2, character: 0 }, lineMap),
      undefined,
    )
    /** A genuinely in-range position still resolves normally. */
    assert.deepEqual(resolveTemplatePositionStrict(provider, { line: 1, character: 3 }, lineMap), {
      line: 0,
      character: 3,
    })
  })

  describe('escape runs', () => {
    /** `\x63` (0 to 4) and `\x72` (9 to 13) are the escape runs; `olr: ` sits between them. */
    const text = '\\x63olr: \\x72ed;'
    const provider = new StyledVirtualDocumentProvider(ts)
    const at = (character: number) => ({ line: 1, character })

    it('should record each escape run in the line map', () => {
      assert.deepEqual(createTemplateLineMap(createTemplateContext(text)).escapeRuns, [
        { end: 4, start: 0 },
        { end: 13, start: 9 },
      ])
    })

    it.each([
      ['a range starting inside a run', 2, 6, 0, 6],
      ['a range ending inside a run', 5, 11, 5, 13],
      ['a range with both ends inside runs', 1, 11, 0, 13],
      ['a range touching runs only at their edges', 4, 9, 4, 9],
      ['an empty range inside a run', 2, 2, 0, 4],
    ])(
      'should widen %s to whole runs',
      (_description, startCharacter, endCharacter, expectedStart, expectedEnd) => {
        const lineMap = createTemplateLineMap(createTemplateContext(text))

        assert.deepEqual(
          fromVirtualDocSpan(
            provider,
            { end: at(endCharacter), start: at(startCharacter) },
            lineMap,
          ),
          { end: expectedEnd, start: expectedStart },
        )
      },
    )

    it.each([
      ['a range overlapping a run', 3, 6, false],
      ['an empty range inside a run', 2, 2, false],
      ['a range between runs, touching their edges', 4, 9, true],
      ['an empty range at the start of a run', 9, 9, true],
    ])(
      'should keep a code-fix edit only when it leaves every run whole: %s',
      (_description, startCharacter, endCharacter, isKept) => {
        const lineMap = createTemplateLineMap(createTemplateContext(text))

        assert.deepEqual(
          fromVirtualDocSpanStrict(
            provider,
            { end: at(endCharacter), start: at(startCharacter) },
            lineMap,
          ),
          isKept ? { end: endCharacter, start: startCharacter } : undefined,
        )
      },
    )

    it.each([
      ['an empty span inside a run', 2, 2, { end: 4, start: 0 }],
      ['a span from inside one run to inside the next', 3, 10, { end: 13, start: 0 }],
      ['a span touching runs only at their edges', 4, 9, { end: 9, start: 4 }],
      ['a span after every run', 14, 16, { end: 16, start: 14 }],
      ['a span at the text start', 0, 0, { end: 0, start: 0 }],
    ])('should widen %s by offset', (_description, start, end, expected) => {
      const { escapeRuns } = createTemplateLineMap(createTemplateContext(text))

      assert.deepEqual(widenToEscapeRuns(start, end, escapeRuns), expected)
    })

    it('should leave a span unchanged when the template has no escape runs', () => {
      assert.deepEqual(widenToEscapeRuns(2, 5, []), { end: 5, start: 2 })
    })
  })

  /**
   * Every offset the span helpers return round-trips through templateOffsetToPosition and the
   * context's own toOffset (TypeScript's line map), an instrument independent of the plugin's own
   * line-start table.
   */
  describe('fromVirtualDocSpan and fromVirtualDocSpanStrict', () => {
    const separator = String.fromCharCode(0x2028)
    const paragraph = String.fromCharCode(0x2029)
    const texts: Array<[string, string]> = [
      ['CRLF', 'a {\r\n  color: red;\r\n}'],
      ['a lone CR', 'a {\r  color: red;\r}'],
      ['U+2028 and U+2029', `color: red;${separator}margin: 0;${paragraph}top: 0;`],
      ['escapes over lines', 'co\\x6Cr: red;\n\\x63olr: blue;'],
    ]

    it.each(texts)(
      'should map every range over %s to offsets that round-trip independently',
      (_description, text) => {
        const context = createTemplateContext(text)
        const provider = new StyledVirtualDocumentProvider(ts)
        const lineMap = createTemplateLineMap(context)
        const document = provider.createVirtualDocument(context)
        const roundTrippedOffsetsOf = (span: { end: number; start: number }) => ({
          end: context.toOffset(templateOffsetToPosition(span.end, lineMap)),
          start: context.toOffset(templateOffsetToPosition(span.start, lineMap)),
        })
        let checked = 0
        for (let start = ':root{\n'.length; start <= document.getText().length; start++) {
          for (const length of [0, 1, 3]) {
            const virtualRange = {
              end: document.positionAt(start + length),
              start: document.positionAt(start),
            }
            const span = fromVirtualDocSpan(provider, virtualRange, lineMap)
            const strictSpan = fromVirtualDocSpanStrict(provider, virtualRange, lineMap)

            if (span) {
              assert.deepEqual(roundTrippedOffsetsOf(span), span)
            }
            if (strictSpan) {
              assert.deepEqual(roundTrippedOffsetsOf(strictSpan), strictSpan)
            }
            checked += span ? 1 : 0
          }
        }
        assert.isAbove(checked, text.length)
      },
    )

    it('should reject a span inside the opening wrapper, and a strict span past the template end', () => {
      const context = createTemplateContext('color: red;')
      const provider = new StyledVirtualDocumentProvider(ts)
      const lineMap = createTemplateLineMap(context)
      const wrapperLine = { end: { line: 0, character: 3 }, start: { line: 0, character: 0 } }
      const closingLine = { end: { line: 2, character: 1 }, start: { line: 2, character: 0 } }

      assert.isUndefined(fromVirtualDocSpan(provider, wrapperLine, lineMap))
      assert.isUndefined(fromVirtualDocSpanStrict(provider, wrapperLine, lineMap))
      assert.deepEqual(fromVirtualDocSpan(provider, closingLine, lineMap), { end: 11, start: 11 })
      assert.isUndefined(fromVirtualDocSpanStrict(provider, closingLine, lineMap))
    })
  })

  it('should keep one line map per template context', () => {
    const context = createTemplateContext('color: red;\nmargin: 0;')

    assert.strictEqual(createTemplateLineMap(context), createTemplateLineMap(context))
    assert.notStrictEqual(createTemplateLineMap({ ...context }), createTemplateLineMap(context))
  })

  it('should read the substituted text for escape runs only when the raw text holds a backslash', () => {
    const readsOf = (rawText: string) => {
      let reads = 0
      const base = createTemplateContext(rawText, 'styled.div')
      const context = {
        rawText,
        get text() {
          reads++
          return base.text
        },
      }
      const lineMap = createTemplateLineMap(context)
      const afterBuild = reads
      return { afterBuild, escapeRuns: lineMap.escapeRuns, reads }
    }

    assert.deepEqual(readsOf('color: red;'), { afterBuild: 0, escapeRuns: [], reads: 0 })
    assert.deepEqual(readsOf('co\\x6Cr: red;'), {
      afterBuild: 0,
      /** The name characters before the run join it; the `r` after it does not. */
      escapeRuns: [{ end: 'co\\x6C'.length, start: 0 }],
      reads: 1,
    })
  })

  it('should reuse the last reading only for the same tag kind and raw text', () => {
    const provider = new StyledVirtualDocumentProvider(ts)
    const wrapperOf = (text: string, tagName: string) =>
      provider.getVirtualDocumentWrapper(createTemplateContext(text, tagName))

    assert.deepEqual(
      [
        wrapperOf('1px solid red', 'css'),
        wrapperOf('1px solid red', 'css'),
        wrapperOf('1px solid red', 'styled.div'),
        wrapperOf('1px solid red', 'css'),
        wrapperOf('color: red;', 'css'),
        wrapperOf('color: red;', 'keyframes'),
      ],
      [
        ':root{all:\n',
        ':root{all:\n',
        ':root{\n',
        ':root{all:\n',
        ':root{\n',
        '@keyframes custom {\n',
      ],
    )
  })

  describe('createValueReadingDocument', () => {
    it('should build the value reading of a single-identifier css template', () => {
      const context = createTemplateContext('\n  colr\n')
      const provider = new StyledVirtualDocumentProvider(ts)
      const document = provider.createValueReadingDocument(context)

      assert.strictEqual(document?.getText(), ':root{all:\n\n  colr\n\n}')
      assert.deepEqual(document?.positionAt(':root{all:\n\n  '.length), { line: 2, character: 2 })
      assert.strictEqual(provider.createVirtualDocument(context).getText(), ':root{\n\n  colr\n\n}')
    })

    it.each([
      ['a css declaration', 'color: red;', 'css'],
      ['a value-shaped css template', '1px solid red', 'css'],
      ['a single identifier in a component', 'colr', 'styled.div'],
      ['a single identifier in keyframes', 'colr', 'keyframes'],
    ])('should build no value reading for %s', (_description, text, tagName) => {
      const provider = new StyledVirtualDocumentProvider(ts)

      assert.isUndefined(provider.createValueReadingDocument(createTemplateContext(text, tagName)))
    })
  })

  it('should compute the line map from context.rawText alone, never through context.toPosition/toOffset', () => {
    /**
     * createTemplateLineMap is the only place this mapping direction reads a TemplateContext at
     * all: resolveTemplatePosition/resolveTemplatePositionStrict take the resulting
     * TemplateLineMap, a plain value, not a context, so they cannot reach back into one even if a
     * regression tried. A context whose toPosition/toOffset throw still produces a usable line
     * map, and that line map still resolves positions correctly, proving createTemplateLineMap
     * itself never calls them either. This is what keeps a cached virtual document (reused across
     * requests by canReuseVirtualDocument because the file name, raw text, and reading still
     * match) correct after an edit elsewhere in the file moves
     * the template: the previous request's TemplateContext.toPosition/toOffset answer against
     * the template's old position (StandardTemplateContext memoizes it, typescript-template-
     * language-service-decorator), so a cached line map that still consulted them would map to
     * the wrong span.
     */
    const throwingContext: TemplateContext = {
      ...createTemplateContext('color: red;'),
      toPosition() {
        throw new Error('Debug Failure. Bad line number.')
      },
      toOffset() {
        throw new Error('Debug Failure. Bad line number.')
      },
    }
    const provider: Pick<VirtualDocumentProvider, 'fromVirtualDocPosition'> = {
      fromVirtualDocPosition: (position) => ({
        line: position.line - 1,
        character: position.character,
      }),
    }

    const lineMap = createTemplateLineMap(throwingContext)

    assert.deepEqual(resolveTemplatePosition(provider, { line: 1, character: 3 }, lineMap), {
      line: 0,
      character: 3,
    })
    assert.deepEqual(resolveTemplatePositionStrict(provider, { line: 1, character: 3 }, lineMap), {
      line: 0,
      character: 3,
    })
    /**
     * The opening wrapper (virtual line 0) still has no source counterpart and rejects, exactly
     * as it does for a well-behaved context.
     */
    assert.strictEqual(
      resolveTemplatePosition(provider, { line: 0, character: 0 }, lineMap),
      undefined,
    )
    assert.strictEqual(
      resolveTemplatePositionStrict(provider, { line: 0, character: 0 }, lineMap),
      undefined,
    )
  })

  it('should preserve a Unicode line separator verbatim inside a quoted string value', () => {
    /**
     * A LINE SEPARATOR inside a CSS string value is real string content, not a line break in
     * the template: normalizing it to a real newline breaks the string out of its quotes and
     * reports a spurious syntax error instead of the real one later in the rule.
     */
    const separator = String.fromCharCode(0x2028)
    const context = createTemplateContext('content: "a' + separator + 'b"; colr: red;')
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)

    assert.strictEqual(document.getText(), ':root{\ncontent: "a' + separator + 'b"; colr: red;\n}')
  })

  it('should not treat an apostrophe inside a CSS comment as opening a string', () => {
    /**
     * A quote inside a CSS comment is not a string: CSS comments are not string values, so an
     * unmatched apostrophe there (an English contraction, most commonly) must not disable
     * separator normalization for the rest of the template, matching CSS tokenization, where
     * comments and strings are recognized independently of each other.
     */
    const separator = String.fromCharCode(0x2028)
    const context = createTemplateContext(`/* don't */\ncolor: red;${separator}boarder: 1px;`)
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)

    assert.strictEqual(document.getText(), ":root{\n/* don't */\ncolor: red;\nboarder: 1px;\n}")
  })

  it('should not treat an apostrophe inside a "//" line comment as opening a string', () => {
    /**
     * SCSS (unlike plain CSS) also has "//" line comments. A quote inside one is not a string
     * (matching the block-comment case above), so an unmatched apostrophe there must not disable
     * separator normalization for the rest of the template: the comment ends at the real line
     * break the separator becomes, exactly as it does without the apostrophe.
     */
    const separator = String.fromCharCode(0x2028)
    const withApostrophe = createTemplateContext(`// don't${separator}boarder: 1px;`)
    const withoutApostrophe = createTemplateContext(`// dont${separator}boarder: 1px;`)
    const provider = new StyledVirtualDocumentProvider(ts)

    assert.strictEqual(
      provider.createVirtualDocument(withApostrophe).getText(),
      ":root{\n// don't\nboarder: 1px;\n}",
    )
    assert.strictEqual(
      provider.createVirtualDocument(withoutApostrophe).getText(),
      ':root{\n// dont\nboarder: 1px;\n}',
    )
  })

  it('should not treat "//" inside an unquoted url() as a line comment', () => {
    /**
     * The CSS url() function lexes its unquoted argument as a single token, not general code:
     * "//" there is ordinary URL content, not a comment start. A line-comment scanner blind to
     * this would swallow everything after it up to the next real line break, including
     * "boarder: 1px;" here.
     */
    const separator = String.fromCharCode(0x2028)
    const context = createTemplateContext(`background: url(http://x);${separator}boarder: 1px;`)
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)

    assert.strictEqual(document.getText(), ':root{\nbackground: url(http://x);\nboarder: 1px;\n}')
  })

  it('should end an unterminated string at a real line break, matching CSS tokenization', () => {
    /**
     * A CSS string never spans a real line break unless the newline itself is escaped: an
     * opening quote with no closing quote before the next "\n" is an unterminated string, so
     * normalization must resume there rather than staying "inside a string" (and therefore
     * un-normalized) for the rest of the template.
     */
    const separator = String.fromCharCode(0x2028)
    const context = createTemplateContext(
      `content: "unterminated;\ncolor: red;${separator}boarder: 1px;`,
    )
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)

    assert.strictEqual(
      document.getText(),
      ':root{\ncontent: "unterminated;\ncolor: red;\nboarder: 1px;\n}',
    )
  })

  it('should keep a string open past a CSS-escaped quote, matching CSS tokenization', () => {
    /**
     * The raw `\\` is the CSS backslash that escapes the quote after it, so the first separator
     * here sits inside the string and stays verbatim, while the second, after the real closing
     * quote, becomes "\n".
     */
    const separator = String.fromCharCode(0x2028)
    const context = createTemplateContext(`content: "a\\\\"${separator}b";${separator}color: red;`)
    const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

    assert.strictEqual(document.getText(), `:root{\ncontent: "a \\"${separator}b";\ncolor: red;\n}`)
  })

  it('should read a JavaScript-escaped quote as the quote styled-components receives, which opens a string', () => {
    /** The separator inside the string stays verbatim; the one after it becomes "\n". */
    const separator = String.fromCharCode(0x2028)
    const context = createTemplateContext(`content: \\"a${separator}b\\";${separator}color: red;`)
    const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

    assert.strictEqual(document.getText(), `:root{\ncontent:  "a${separator}b ";\ncolor: red;\n}`)
  })

  it('should keep positions mapped through the source line map after JavaScript escapes', () => {
    const context = createTemplateContext('content: \\"x\\" \\n;\ncolr: red;')
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)
    const sourceOffset = context.rawText.indexOf('colr')
    const virtualOffset = provider.toVirtualDocOffset(sourceOffset, context)

    assert.strictEqual(document.getText(), ':root{\ncontent:  "x "   ;\ncolr: red;\n}')
    assert.deepEqual(document.positionAt(virtualOffset), { line: 2, character: 0 })
    assert.strictEqual(document.offsetAt({ line: 2, character: 0 }), virtualOffset)
  })

  describe('nested block @layer rewrite', () => {
    /** The expected same-length rewrite: spaces over the prelude, "&" on its last character. */
    function rewritten(prelude: string): string {
      return ' '.repeat(prelude.length - 1) + '&'
    }

    it.each([
      ['a named layer', '@layer u ', '{ color: red; }'],
      ['a dotted layer name', '@layer framework.base ', '{ color: red; }'],
      ['an anonymous layer', '@layer ', '{ color: red; }'],
      ['an anonymous layer with no space before its body', '@layer', '{ color: red; }'],
      ['a name followed directly by its body', '@layer u', '{ color: red; }'],
      ['a block comment before the name', '@layer /* c */ u ', '{ color: red; }'],
      ['a block comment right after the keyword', '@layer/* c */u ', '{ color: red; }'],
      ['a block comment holding a brace after the name', '@layer u /* { */ ', '{ color: red; }'],
      ['an anonymous layer holding only a comment', '@layer /* c */ ', '{ color: red; }'],
      ['a keyword in capitals', '@LAYER u ', '{ color: red; }'],
      ['a keyword in mixed case', '@Layer u ', '{ color: red; }'],
      /** The CSS scanner reads every code unit from U+0080 as a name character, U+00A0 included. */
      ['a name holding a non-breaking space', '@layer a b ', '{ color: red; }'],
    ])('should rewrite %s at a component template top level', (_description, prelude, body) => {
      const context = createTemplateContext(`${prelude}${body}`, 'styled.div')
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(document.getText(), `:root{\n${rewritten(prelude)}${body}\n}`)
      assert.strictEqual(document.getText().length, ':root{\n'.length + context.text.length + 2)
    })

    it('should rewrite a nested layer after a url() holding "}", which closes no block', () => {
      const prefix = 'body { background: url(a}b.png); '
      const context = createTemplateContext(
        `${prefix}@layer u { color: red; } }`,
        'createGlobalStyle',
      )
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(
        document.getText(),
        `:root{\n${prefix}${rewritten('@layer u ')}{ color: red; } }\n}`,
      )
    })

    it('should rewrite a layer after a CSS-escaped quote, which opens no string', () => {
      const context = createTemplateContext(
        'content: \\\\"a; @layer u { color: red; }',
        'styled.div',
      )
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(
        document.getText(),
        `:root{\ncontent:  \\"a; ${rewritten('@layer u ')}{ color: red; }\n}`,
      )
    })

    it('should not count a CSS-escaped "{" as opening a block of a global-style template', () => {
      /** The layer stays at the stylesheet top level, where the parser reads a block `@layer` correctly. */
      const context = createTemplateContext(
        '.a\\\\{ @layer u { color: red; } }',
        'createGlobalStyle',
      )
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(document.getText(), `:root{\n .a\\{ @layer u { color: red; } }\n}`)
    })

    it('should leave a CSS-escaped "@", which makes the keyword part of an identifier, untouched', () => {
      const context = createTemplateContext('\\\\@layer u { color: red; }', 'styled.div')
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(document.getText(), `:root{\n\\40layer u { color: red; }\n}`)
    })

    it('should rewrite a layer whose "@" is JavaScript-escaped, since styled-components receives a real "@"', () => {
      const context = createTemplateContext('\\@layer u { color: red; }', 'styled.div')
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(document.getText(), `:root{\n ${rewritten('@layer u ')}{ color: red; }\n}`)
    })

    it('should rewrite a prelude holding a line comment, keeping the line break that ends it', () => {
      const context = createTemplateContext('@layer // c\n  u { color: red; }', 'styled.div')
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(
        document.getText(),
        `:root{\n${' '.repeat('@layer // c'.length)}\n${rewritten('  u ')}{ color: red; }\n}`,
      )
    })

    it('should rewrite a layer nested inside a rule, keeping the prelude line break', () => {
      const context = createTemplateContext(
        '&:hover {\n  @layer u\n  { color: red; }\n}',
        'styled.div',
      )
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      /** The prelude runs from "@" to the "{" on the next line; its line break stays put. */
      assert.strictEqual(
        document.getText(),
        `:root{\n&:hover {\n  ${' '.repeat('@layer u'.length)}\n${rewritten('  ')}{ color: red; }\n}\n}`,
      )
    })

    it('should rewrite a layer inside a rule of a global-style template but not at its top level', () => {
      const text = '@layer base { body { color: red; } }\nbody { @layer u { color: red; } }'
      const context = createTemplateContext(text, 'createGlobalStyle')
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(
        document.getText(),
        `:root{\n${text.replace('@layer u ', rewritten('@layer u '))}\n}`,
      )
    })

    it.each([
      ['the statement form', '@layer a, b;\ncolor: red;'],
      ['a list prelude', '@layer a, b { color: red; }'],
      ['two names separated by a comment', '@layer a /* c */ b { color: red; }'],
      ['an unterminated comment in the prelude', '@layer u /* { color: red; }'],
      ['a lone "/" in the prelude', '@layer u / { color: red; }'],
      ['a longer at-keyword', '@layers u { color: red; }'],
      ['the keyword inside a string', 'content: "@layer u {";'],
      ['the keyword inside a comment', '/* @layer u { */ color: red;'],
    ])('should leave %s untouched', (_description, text) => {
      const context = createTemplateContext(text, 'styled.div')
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(document.getText(), `:root{\n${text}\n}`)
    })

    it('should rewrite the prelude and normalize a Unicode line separator in the same pass', () => {
      const separator = String.fromCharCode(0x2028)
      const context = createTemplateContext(
        `color: red;${separator}@layer u { color: red; }`,
        'styled.div',
      )
      const document = new StyledVirtualDocumentProvider(ts).createVirtualDocument(context)

      assert.strictEqual(
        document.getText(),
        `:root{\ncolor: red;\n${rewritten('@layer u ')}{ color: red; }\n}`,
      )
    })
  })

  it('should map positions across a multi-line template using the source line map', () => {
    const context = createTemplateContext('a {\n  color: red;\n}\ncolr: blue;')
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)
    const sourceOffset = context.rawText.indexOf('colr')
    const virtualOffset = provider.toVirtualDocOffset(sourceOffset, context)
    const virtualPosition = provider.toVirtualDocPosition(context.toPosition(sourceOffset))

    assert.deepEqual(document.positionAt(virtualOffset), virtualPosition)
    assert.strictEqual(document.offsetAt(virtualPosition), virtualOffset)
  })

  it('should reuse a cached document only when the raw (unsubstituted) text matches', () => {
    const provider = new StyledVirtualDocumentProvider(ts)
    const previousContext = createTemplateContext('color: red;')
    const identicalContext = createTemplateContext('color: red;')
    const differentContext = createTemplateContext('color: blue;')

    assert.isTrue(provider.canReuseVirtualDocument(previousContext, identicalContext))
    assert.isFalse(provider.canReuseVirtualDocument(previousContext, differentContext))

    /**
     * Two contexts whose substituted text happens to be identical (equal-length, same-shape
     * interpolations) but whose raw text differs must not be treated as reusable, since their
     * relative line maps are not guaranteed to match.
     */
    const rawA = createTemplateContext('color: ${aa};\ncolr: blue;')
    const rawB: TemplateContext = {
      ...createTemplateContext('color: ${bb};\ncolr: blue;'),
      get text() {
        return rawA.text
      },
    }
    assert.notStrictEqual(rawA.rawText, rawB.rawText)
    assert.strictEqual(rawA.text, rawB.text)
    assert.isFalse(provider.canReuseVirtualDocument(rawA, rawB))
  })

  it.each([
    [
      'a nested and a global-style top level',
      '@layer x { color: red; }',
      'styled.div',
      'createGlobalStyle',
    ],
    ['a single-identifier css fragment and a component', 'colr', 'css', 'styled.div'],
  ])(
    'should not reuse a document across tags that read the same text differently: %s',
    (_description, text, firstTag, secondTag) => {
      const provider = new StyledVirtualDocumentProvider(ts)
      const first = createTemplateContext(text, firstTag)
      const second = createTemplateContext(text, secondTag)

      /** Same wrapper, so only the rest of the reading tells the two apart. */
      assert.strictEqual(
        provider.getVirtualDocumentWrapper(first),
        provider.getVirtualDocumentWrapper(second),
      )
      assert.isFalse(provider.canReuseVirtualDocument(first, second))
      assert.isFalse(provider.canReuseVirtualDocument(second, first))
      assert.isTrue(provider.canReuseVirtualDocument(first, createTemplateContext(text, firstTag)))
    },
  )

  describe('diagnostics for the same text under tags that read it differently', () => {
    const cases: Array<[string, string, Array<[string, string[]]>]> = [
      [
        'a top-level block @layer',
        '@layer x { color: red; }',
        [
          ['styled.div', []],
          ['createGlobalStyle', ['{ expected']],
        ],
      ],
      [
        'a single identifier',
        'colr',
        [
          ['css', []],
          ['styled.div', ['semi-colon expected', 'colon expected']],
        ],
      ],
    ]

    it.each(
      cases.flatMap(([description, text, readings]) => [
        [`${description}, in order`, text, readings],
        [`${description}, reversed`, text, readings.toReversed()],
      ]),
    )('should report each reading its own diagnostics: %s', (_description, text, readings) => {
      const service = new StyledTemplateLanguageService(
        ts,
        new PluginConfigurationManager(),
        new StyledVirtualDocumentProvider(ts),
      )
      const messages = (tagName: string) =>
        service
          .getSemanticDiagnostics(createTemplateContext(text, tagName))
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))

      assert.deepEqual(
        readings.map(([tagName]) => [tagName, messages(tagName)]),
        readings,
      )
    })
  })

  it('should keep mapping correctly through a reused document even when the context that built it has a stale toPosition/toOffset', () => {
    /**
     * Reproduces the reported defect: a request that inserts a line above the template leaves
     * StandardTemplateContext.toPosition/toOffset (typescript-template-language-service-
     * decorator) memoized against the template's old file position, but
     * canReuseVirtualDocument still says the cached document (same fileName, rawText, wrapper)
     * is reusable, since none of those three depend on where the template sits in the file. A
     * document built from a context whose toPosition/toOffset are wrong by a fixed offset (the
     * shape a "line inserted above" edit produces) must still map positions correctly: the
     * document's own positionAt/offsetAt never consult the context that built it once creation
     * finishes.
     */
    const context = createTemplateContext('color: red;\nmargin: 0;')
    const staleContext: TemplateContext = {
      ...context,
      toPosition: (offset) => {
        const real = context.toPosition(offset)
        return { line: real.line + 5, character: real.character }
      },
      toOffset: (position) => context.toOffset({ ...position, line: position.line - 5 }),
    }
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(staleContext)

    const sourceOffset = context.rawText.indexOf('margin')
    const virtualOffset = provider.toVirtualDocOffset(sourceOffset, context)
    const correctVirtualPosition = provider.toVirtualDocPosition(context.toPosition(sourceOffset))

    assert.deepEqual(document.positionAt(virtualOffset), correctVirtualPosition)
    assert.strictEqual(document.offsetAt(correctVirtualPosition), virtualOffset)
  })

  it('should not start a new line at a form feed, which ends a CSS string but is no line terminator for position mapping', () => {
    const context = createTemplateContext('color: red;\fmargin: 0;')
    const provider = new StyledVirtualDocumentProvider(ts)
    const document = provider.createVirtualDocument(context)
    const virtualOffset = provider.toVirtualDocOffset(context.text.indexOf('margin'), context)

    assert.deepEqual(document.positionAt(virtualOffset), { line: 1, character: 12 })
    assert.strictEqual(document.offsetAt({ line: 1, character: 12 }), virtualOffset)
  })
})

describe('nonCodeEnd', () => {
  const lineSeparator = String.fromCharCode(0x2028)

  it.each([
    ['an unterminated block comment at the end of the text', 'a /* b', 2, 6],
    ['an unterminated string at the end of the text', 'a "bc', 2, 5],
    ['a string whose last character is a lone backslash', 'a "b\\', 2, 5],
    /** The comment's own terminator (offset 4) is included, so code resumes at "b" (5). */
    ['a "//" line comment ending at U+2028', `// a${lineSeparator}b`, 0, 5],
    ['a "//" line comment ending at a form feed', '// a\fb', 0, 5],
    /** The escape covers "\r" (3) and "\n" (4), so the string runs through its closing quote (6). */
    ['a string holding an escaped CRLF', '"a\\\r\nb"c', 0, 7],
    /** Six hex digits (2 through 7), then the escape takes the LF at 8; the quote at 10 closes. */
    ['a string holding a six-digit hex escape followed by LF', '"\\00004a\nb"c', 0, 11],
    /** A seventh hex digit is ordinary content; the LF after it ends the string (at 9). */
    ['a string whose hex escape stops after six digits', '"\\00004aa\nb"', 0, 9],
    ['a string ended by a form feed', '"a\fb"', 0, 2],
    ['a string ended by an unescaped CR', '"a\rb"', 0, 2],
  ])('should end %s where the CSS scanner does', (_description, text, index, expectedEnd) => {
    assert.strictEqual(nonCodeEnd(text, index, createCssCodeScanState()), expectedEnd)
  })

  it('should return -1 at a code position', () => {
    assert.strictEqual(nonCodeEnd('a / b', 2, createCssCodeScanState()), -1)
  })

  it.each([
    /** The escape covers the quote (1, 2), and the identifier runs on through "x" (3). */
    ['an escaped quote, opening no string', '\\"x; }', 0, 3],
    /** The escape covers the first "/" (1, 2); the second "/" is code, so no comment opens. */
    ['an escaped "/", opening no comment', 'a\\//b', 1, 3],
    ['an escaped "/" before "*", opening no comment', 'a\\/* } */', 1, 3],
    ['an escaped "{"', 'a\\{ b', 1, 3],
    /** The escape's trailing space (3) belongs to it, so the identifier continues through "url" (4 through 6). */
    ['a hex escape followed by a space and more name characters', '\\41 url(//x)', 0, 7],
    ['an escaped backslash', '\\\\"a"', 0, 2],
  ])('should step over %s as one identifier run', (_description, text, index, expectedEnd) => {
    const state = createCssCodeScanState()

    assert.strictEqual(nonCodeEnd(text, index, state), expectedEnd)
    assert.isUndefined(state.url)
  })

  it.each([
    ['before a line feed', 'a\\\nb', 1],
    ['before a form feed', 'a\\\fb', 1],
    ['before a Unicode line separator', `a\\${lineSeparator}b`, 1],
    /** The virtual document follows the template with its closing "\n}", so nothing is escaped. */
    ['at the end of the text', 'a\\', 1],
  ])('should read a backslash %s as plain code', (_description, text, index) => {
    assert.strictEqual(nonCodeEnd(text, index, createCssCodeScanState()), -1)
  })

  it.each([
    ['url(', 'url(//x)', 0, -1],
    ['URL(', 'URL(//x)', 0, -1],
    ['url-prefix(', 'url-prefix(//x)', 0, -1],
    ['an escaped "u" of url(', '\\url(//x)', 0, 4],
    ['an escaped "r" of url(', 'u\\rl(//x)', 0, -1],
    ['a hex-escaped "u" of url(', '\\75 rl(//x)', 0, 6],
    ['url( after a string', '"a"url(//x)', 3, -1],
  ])(
    'should open an unquoted url() argument at %s, as the CSS parser does',
    (_description, text, index, expectedEnd) => {
      const state = createCssCodeScanState()

      assert.strictEqual(nonCodeEnd(text, index, state), expectedEnd)
      assert.isDefined(state.url)
    },
  )

  it.each([
    ['a longer function name', 'image-url(//x)', 6],
    ['a name ending in url', 'myurl(//x)', 2],
    ['a hash', '#url(//x)', 1],
    ['url after a space', 'url (//x)', 0],
  ])('should open no url() argument at %s', (_description, text, index) => {
    const state = createCssCodeScanState()

    assert.strictEqual(nonCodeEnd(text, index, state), -1)
    assert.isUndefined(state.url)
  })

  it('should step over an escaped ")" inside an unquoted url() argument without closing it', () => {
    const state = createCssCodeScanState()
    const text = 'url(a\\)b)'

    assert.strictEqual(nonCodeEnd(text, 0, state), -1)
    assert.strictEqual(nonCodeEnd(text, 5, state), 7)
    assert.isDefined(state.url)
    assert.strictEqual(nonCodeEnd(text, 8, state), -1)
    assert.isUndefined(state.url)
  })

  /**
   * The CSS parser reads a url() argument as trivia (whitespace and block comments), then one
   * token, then trivia again, so a block comment there is a comment only where a token can start:
   * right after "(", after whitespace, or after a string or another comment. Next to url
   * characters, "/" and "*" are part of the url. "//" never opens a comment inside url().
   */
  it.each([
    ['right after "("', 'url(/* ) */a.png)', '/*'],
    ['after whitespace after "("', 'url( /* ) */a.png)', '/*'],
    ['after whitespace after the argument', 'url(a.png /* ) */)', '/*'],
    ['after a string argument', 'url("a"/* ) */)', '/*'],
    ['after another comment', 'url(/* a *//* ) */b)', '/* )'],
  ])('should read a block comment inside url() %s as a comment', (_description, text, marker) => {
    const index = text.indexOf(marker)
    const state = createCssCodeScanState()
    walkCode(text, index, state)

    assert.strictEqual(nonCodeEnd(text, index, state), text.indexOf('*/', index) + 2)
    assert.isDefined(state.url)
  })

  it.each([
    ['right after url characters', 'url(a/* ) */b)', '/*'],
    ['right after an escape that took the space after it', 'url(a\\41 /* ) */b)', '/*'],
    ['as a "//" after "("', 'url(//x)', '//'],
  ])('should read "/" inside url() %s as url content', (_description, text, marker) => {
    const index = text.indexOf(marker)
    const state = createCssCodeScanState()
    walkCode(text, index, state)

    assert.strictEqual(nonCodeEnd(text, index, state), -1)
    assert.isDefined(state.url)
  })

  /** Calls nonCodeEnd at every position before `until`, stepping over each run it returns. */
  function walkCode(text: string, until: number, state: CssCodeScanState) {
    for (let index = 0; index < until;) {
      const end = nonCodeEnd(text, index, state)
      index = end === -1 ? index + 1 : end
    }
  }
})

describe('createCodeLookback', () => {
  it('should skip comments, count a string at its opening quote, and report offsets inside non-code', () => {
    const text = 'a; /* b; */ "c;" // d;\n  e'
    const lookback = createCodeLookback(text, 0)

    assert.strictEqual(lookback.previousSignificant(0), -1)
    /** Inside the block comment (3 through 10). */
    assert.strictEqual(lookback.previousSignificant(6), INSIDE_NON_CODE)
    assert.strictEqual(lookback.previousSignificant(8), INSIDE_NON_CODE)
    /** Past the comment, the ";" at 1 is the nearest code character. */
    assert.strictEqual(lookback.previousSignificant(12), 1)
    /** Past the string (12 through 15), its opening quote. */
    assert.strictEqual(lookback.previousSignificant(17), 12)
    /** Past the line comment (17 through its "\n" at 22), still the string. */
    assert.strictEqual(lookback.previousSignificant(25), 12)
    assert.strictEqual(lookback.previousSignificant(26), 25)
  })

  it('should answer a query below the previous one by starting over', () => {
    const text = 'a; b /* c */'
    const lookback = createCodeLookback(text, 0)

    assert.strictEqual(lookback.previousSignificant(text.length), 3)
    assert.strictEqual(lookback.previousSignificant(3), 1)
  })

  it('should read "//" inside an unquoted url() as code, not a comment', () => {
    const text = 'url(http://x) a'
    const lookback = createCodeLookback(text, 0)

    assert.strictEqual(lookback.previousSignificant(14), 12)
  })

  it('should count an escape as significant code at its backslash, never as the character it escapes', () => {
    const text = 'a\\; b'
    const lookback = createCodeLookback(text, 0)

    /** Inside the escape (1, 2), the backslash itself, not the ";" a statement test would match. */
    assert.strictEqual(lookback.previousSignificant(2), 1)
    assert.strictEqual(lookback.previousSignificant(1), 0)
    assert.strictEqual(lookback.previousSignificant(text.length - 1), 1)
  })

  it.each([
    ['a string cut off by a line break', 'a "b\nc', 4],
    ['a string cut off by the end of the text', 'a "b', 4],
    ['a string whose last character is an escaped quote', 'a "b\\"', 6],
    ['a block comment with no closing', 'a /* b', 6],
    ['a block comment ending in a lone star', 'a /*/', 5],
    ['a line comment cut off by the end of the text', 'a // b', 6],
  ])('should read a query at the end of %s as inside it', (_description, text, end) => {
    const lookback = createCodeLookback(text, 0)

    assert.strictEqual(lookback.previousSignificant(end), INSIDE_NON_CODE)
    assert.strictEqual(lookback.previousSignificant(end - 1), INSIDE_NON_CODE)
  })

  it('should keep scanning past an unterminated string after a query at its end', () => {
    const text = 'a "b\nc'
    const lookback = createCodeLookback(text, 0)

    assert.strictEqual(lookback.previousSignificant(4), INSIDE_NON_CODE)
    assert.strictEqual(lookback.previousSignificant(text.length), 5)
  })

  it.each([
    ['before a line break', 'a "b"\nc', 5],
    ['at the end of the text', 'a "b"', 5],
    ['after a hex escape', 'a "\\22"', 7],
    ['after an escaped backslash', 'a "\\\\"', 6],
  ])(
    'should read a query at the end of a closed string %s as after it, at its opening quote',
    (_description, text, end) => {
      assert.strictEqual(createCodeLookback(text, 0).previousSignificant(end), 2)
    },
  )

  it.each([
    ['a block comment', 'a; /**/', 7],
    ['a line comment', 'a; // b\n', 8],
  ])('should read a query at the end of a closed %s as after it', (_description, text, end) => {
    assert.strictEqual(createCodeLookback(text, 0).previousSignificant(end), 1)
  })

  it('should start at the given offset, ignoring characters before it', () => {
    const text = ':root{\n  @'
    const lookback = createCodeLookback(text, ':root{\n'.length)

    assert.strictEqual(lookback.previousSignificant(text.length - 1), -1)
  })
})
