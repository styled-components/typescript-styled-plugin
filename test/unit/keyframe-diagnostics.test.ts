import type { TemplateContext } from 'typescript-template-language-service-decorator'
import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'

import { PluginConfigurationManager } from '../../src/configuration/plugin-configuration'
import { StyledTemplateLanguageService } from '../../src/template-language-service'
import { getTemplateSubstitutions } from '../../src/template/template-substitutions'
import { LINE_SEPARATOR, PARAGRAPH_SEPARATOR } from '../../src/virtual-document/css-code-scanner'
import { StyledVirtualDocumentProvider } from '../../src/virtual-document/styled-virtual-document-provider'
import { createTemplateContext } from './create-template-context'

/** The misspelling every positive case reports, and nowhere else. */
const MISSPELLED = 'opacitty'

const KEYFRAMES_WRAPPER = '@keyframes custom {\n'
const ROOT_WRAPPER = ':root{\n'

interface ShownDiagnostic {
  readonly length: number
  readonly messageText: string | ts.DiagnosticMessageChain
  readonly start: number
}

function createService(manager = new PluginConfigurationManager()) {
  return new StyledTemplateLanguageService(ts, manager, new StyledVirtualDocumentProvider(ts))
}

function shownDiagnostics(
  text: string,
  tagName = 'css',
  manager = new PluginConfigurationManager(),
): ShownDiagnostic[] {
  return createService(manager)
    .getSemanticDiagnostics(createTemplateContext(text, tagName))
    .map((diagnostic) => {
      const { length, messageText, start } = diagnostic
      if (length === undefined || start === undefined) {
        throw new Error('diagnostic is missing a span')
      }
      return { length, messageText, start }
    })
}

function unknownProperty(
  text: string,
  name = MISSPELLED,
  start = text.indexOf(name),
): ShownDiagnostic {
  return { length: name.length, messageText: `Unknown property: '${name}'`, start }
}

/** Every occurrence of `name`, in source order. A duplicated diagnostic fails the deep equality. */
function unknownProperties(text: string, name: string): ShownDiagnostic[] {
  const found: ShownDiagnostic[] = []
  for (
    let start = text.indexOf(name);
    start !== -1;
    start = text.indexOf(name, start + name.length)
  ) {
    found.push(unknownProperty(text, name, start))
  }
  return found
}

function assertUnknownOnly(text: string, tagName: string, name = MISSPELLED) {
  assert.deepEqual(shownDiagnostics(text, tagName), unknownProperties(text, name))
}

/**
 * A context whose `text` is substituted the way the decorator substitutes it. Unit tests otherwise
 * pass the raw text through as `text` (createTemplateContext).
 */
function createSubstitutingContext(rawText: string, tagName: string): TemplateContext {
  const base = createTemplateContext(rawText, tagName)
  const spans: Array<{ end: number; start: number }> = []
  const node = base.node
  if (ts.isTemplateExpression(node)) {
    const stringStart = node.getStart() + 1
    let spanStart = node.head.end - stringStart - 2
    for (const { literal } of node.templateSpans) {
      spans.push({ end: literal.getStart() - stringStart + 1, start: spanStart })
      spanStart = literal.getEnd() - stringStart - 2
    }
  }
  let text: string | undefined
  return {
    fileName: base.fileName,
    node,
    rawText: base.rawText,
    get text() {
      text ??= getTemplateSubstitutions(base.rawText, spans)
      return text
    },
    toOffset: base.toOffset,
    toPosition: base.toPosition,
    typescript: base.typescript,
  }
}

function documentBody(text: string, wrapper: string): string {
  assert.strictEqual(text.startsWith(wrapper), true)
  assert.strictEqual(text.endsWith('\n}'), true)
  return text.slice(wrapper.length, -'\n}'.length)
}

describe('unknown properties inside keyframes', () => {
  describe('a keyframes tag, whose body is the keyframe rule', () => {
    it.each([
      ['keyframes', 'keyframes'],
      ['styled.keyframes', 'styled.keyframes'],
      ['a property access ending in keyframes', 'foo.keyframes'],
      ['an instantiation expression on styled.keyframes', 'styled.keyframes<{ x: string }>'],
    ])('should report an unknown property in a percent block for %s', (_label, tagName) => {
      assertUnknownOnly('0% { opacitty: 0; }', tagName)
    })

    it.each([
      ['from', 'from { opacitty: 0; }'],
      ['to', 'to { opacitty: 0; }'],
      ['100%', '100% { opacitty: 0; }'],
      ['a decimal percent', '12.5% { opacitty: 0; }'],
      ['a leading-dot percent', '.5% { opacitty: 0; }'],
      ['a percent list', '0%, 50% { opacitty: 0; }'],
      ['from and to', 'from, to { opacitty: 0; }'],
      ['a mixed selector list', 'from, 50%, to { opacitty: 0; }'],
      ['a comment in the selector', '0% /* x */ { opacitty: 0; }'],
      ['a multiline block', '0% {\n  opacitty: 0;\n}'],
      ['a CRLF block', '0% {\r\n  opacitty: 0;\r\n}'],
      ['a line separator', `0% {${LINE_SEPARATOR}opacitty: 0; }`],
      ['a paragraph separator', `0% {${PARAGRAPH_SEPARATOR}opacitty: 0; }`],
    ])('should report an unknown property for a %s selector', (_label, text) => {
      assertUnknownOnly(text, 'keyframes')
    })

    it('should report only the misspelled property when a block holds a known one too', () => {
      const text = 'from { width: 0%; opacitty: 1; }'
      assertUnknownOnly(text, 'keyframes')
    })

    it('should report only the block that is misspelled', () => {
      const text = '0% { opacity: 0; } 100% { opacitty: 1; }'
      assertUnknownOnly(text, 'keyframes')
    })

    it('should keep the syntax diagnostic for an empty value and add nothing else', () => {
      const text = '0% { color: }'
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        { length: 1, messageText: 'property value expected', start: text.indexOf('}') },
      ])
    })

    it('should keep the syntax diagnostics for an unclosed block and report the unknown property', () => {
      const text = '0% { opacitty: 0;'
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        { length: 0, messageText: '} expected', start: text.length },
        unknownProperty(text),
      ])
    })

    it('should report a bare unknown property in addition to the syntax diagnostics', () => {
      const text = 'opacitty: 0;'
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        { length: 0, messageText: 'at-rule or selector expected', start: text.length },
        { length: MISSPELLED.length, messageText: '} expected', start: 0 },
        unknownProperty(text),
      ])
    })

    it('should keep the syntax diagnostics for a bare known property', () => {
      const text = 'opacity: 0;'
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        { length: 0, messageText: 'at-rule or selector expected', start: text.length },
        { length: 'opacity'.length, messageText: '} expected', start: 0 },
      ])
    })
  })

  describe('a nested @keyframes rule, in every other tag the plugin handles', () => {
    /** Not a keyframes tag: the call form and every styled, css, global, and extra tag. */
    const tags = [
      ['styled.div', 'styled.div'],
      ['styled(Button)', 'styled(Button)'],
      ['styled.div.attrs({})', 'styled.div.attrs({})'],
      ['styled(Button).attrs({})', 'styled(Button).attrs({})'],
      ['styled.button.attrs({ type: "button" })', 'styled.button.attrs({ type: "button" })'],
      ['styled.div<{ color: string }>', 'styled.div<{ color: string }>'],
      ['css', 'css'],
      ['createGlobalStyle', 'createGlobalStyle'],
      ['injectGlobal', 'injectGlobal'],
      ['globalCss', 'globalCss'],
      ['Button.extend', 'Button.extend'],
      ['a configured extra tag', 'myTag'],
      ['keyframes()', 'keyframes()'],
      ['styled.keyframes()', 'styled.keyframes()'],
    ] as const

    it.each(tags)(
      'should report an unknown property inside @keyframes for %s',
      (_label, tagName) => {
        const text = '@keyframes fade {\n  0% { opacitty: 0; }\n}'
        assertUnknownOnly(text, tagName)
      },
    )

    it.each([
      ['@media', '@media screen {\n  @keyframes fade {\n    0% { opacitty: 0; }\n  }\n}'],
      ['@layer', '@layer utilities {\n  @keyframes fade {\n    0% { opacitty: 0; }\n  }\n}'],
      [
        'two @keyframes rules',
        '@keyframes a {\n  from { opacity: 0; }\n}\n@keyframes b {\n  to { opacitty: 1; }\n}',
      ],
      ['@KEYFRAMES', '@KEYFRAMES fade {\n  0% { opacitty: 0; }\n}'],
    ])('should report an unknown property inside %s', (label, text) => {
      const diagnostics = shownDiagnostics(text, 'styled.div')
      if (label === '@KEYFRAMES') {
        assert.deepEqual(diagnostics, [
          {
            length: '@KEYFRAMES'.length,
            messageText: "Always define standard rule '@keyframes' when defining keyframes.",
            start: 0,
          },
          unknownProperty(text),
        ])
        return
      }
      assert.deepEqual(diagnostics, [unknownProperty(text)])
    })
  })

  describe('animation names and selectors the keyframes parser accepts', () => {
    it.each([
      ['an interpolation', '@keyframes #{name} { 0% { opacitty: 0; } }'],
      ['a variable interpolation', '@keyframes #{$name} { 0% { opacitty: 0; } }'],
      ['an interpolation with inner spaces', '@keyframes #{ $name } { 0% { opacitty: 0; } }'],
      [
        'a name joined after an interpolation',
        '@keyframes #{direction}slide { 0% { opacitty: 0; } }',
      ],
      [
        'a name joined before an interpolation',
        '@keyframes slide#{direction} { 0% { opacitty: 0; } }',
      ],
      ['two interpolations', '@keyframes #{a}#{b} { 0% { opacitty: 0; } }'],
      ['an interpolation between identifiers', '@keyframes a#{b}c { 0% { opacitty: 0; } }'],
      ['a string inside the interpolation', '@keyframes #{"x}y"} { 0% { opacitty: 0; } }'],
      ['a url brace inside the interpolation', '@keyframes #{url(a}b)} { 0% { opacitty: 0; } }'],
      ['a comment brace inside the interpolation', '@keyframes #{/*}*/} { 0% { opacitty: 0; } }'],
    ])('should report an unknown property for %s in the animation name', (_label, text) => {
      assertUnknownOnly(text, 'styled.div')
    })

    it.each(['---', '--', '-'.repeat(20_000)])(
      'should report an unknown property for a dash-only animation name',
      (name) => {
        assertUnknownOnly(`@keyframes ${name} { 0% { opacitty: 0; } }`, 'styled.div')
      },
    )

    it.each([
      ['an interpolated selector', 'keyframes', '#{name} { opacitty: 0; }'],
      ['from joined to an interpolation', 'keyframes', 'from#{n} { opacitty: 0; }'],
      ['a selector list', 'keyframes', '0%, #{n} { opacitty: 0; }'],
      ['a nested interpolation', 'styled.div', '@keyframes fade { #{a #{b}} { opacitty: 0; } }'],
      ['a prefixed interpolation', 'styled.div', '@keyframes fade { pre#{name} { opacitty: 0; } }'],
    ])('should report an unknown property for %s', (_label, tagName, text) => {
      assertUnknownOnly(text, tagName)
    })

    it('should keep a property interpolation silent and still report the next property', () => {
      const text = '@keyframes fade { 0% { #{x} : 0; opacitty: 1; } }'
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [unknownProperty(text)])
    })

    it('should not report a declaration that sits inside an interpolation', () => {
      const text = '@keyframes fade {\n  #{\n    colr: red;\n  }\n}'
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        { length: 1, messageText: 'at-rule or selector expected', start: text.lastIndexOf('}') },
        { length: 2, messageText: '} expected', start: text.indexOf('#{') },
      ])
    })

    it('should not treat an escape that continues the at-keyword as @keyframes', () => {
      const keyword = '@keyframes\\61bounce'
      const text = `${keyword} { 0% { opacitty: 0; } }`
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        { length: keyword.length, messageText: `Unknown at rule ${keyword}`, start: 0 },
      ])
    })

    it('should report an unknown property when the animation name is an escape', () => {
      assertUnknownOnly('@keyframes \\61 { 0% { opacitty: 0; } }', 'styled.div')
    })

    it('should keep the syntax errors when a space splits the animation name', () => {
      const text = '@keyframes fade #{name} { 0% { opacitty: 0; } }'
      const ruleBrace = text.indexOf('{', text.indexOf('#{name}') + '#{name}'.length)
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        {
          length: 1,
          messageText: 'at-rule or selector expected',
          start: text.indexOf('}', text.indexOf(MISSPELLED)),
        },
        { length: 1, messageText: '} expected', start: ruleBrace },
        { length: 2, messageText: '{ expected', start: text.indexOf('#{') },
      ])
    })

    it('should keep the syntax errors for a single hyphen animation name', () => {
      const text = '@keyframes - { 0% { opacitty: 0; } }'
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        { length: 0, messageText: 'at-rule or selector expected', start: text.length },
        { length: 1, messageText: 'identifier expected', start: text.indexOf('-') },
      ])
    })

    it('should keep the syntax errors for a percent glued to an interpolation and report the property', () => {
      const text = '0%#{n} { opacitty: 0; }'
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        {
          length: 1,
          messageText: 'at-rule or selector expected',
          start: text.indexOf('{', text.indexOf('#{') + '#{'.length),
        },
        { length: 1, messageText: 'at-rule or selector expected', start: text.lastIndexOf('}') },
        { length: 2, messageText: '} expected', start: text.indexOf('0%') },
        { length: 1, messageText: '{ expected', start: text.indexOf(':') },
        unknownProperty(text),
      ])
    })
  })

  describe('shapes that must not gain a diagnostic', () => {
    it.each([
      ['a known property', '0% { opacity: 0; }'],
      ['from and to with known properties', 'from { opacity: 0; } to { opacity: 1; }'],
      ['a known vendor-prefixed property', '0% { -webkit-transform: scale(1); }'],
      ['an unknown vendor-prefixed property', '0% { -webkit-opacitty: 0; }'],
      ['a custom property', '0% { --foo: 1; }'],
      ['a substituted property name', '0% { $axx: 0; }'],
      ['a sass interpolation', '0% { #{x} : 0; }'],
      ['an empty template', ''],
      ['whitespace', '  \n  '],
      ['an empty block', '0% { }'],
    ])('should report nothing for %s in a keyframes tag', (_label, text) => {
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [])
    })

    it('should report a from selector outside @keyframes once', () => {
      assertUnknownOnly('from { opacitty: 0; }', 'styled.div')
    })

    it('should keep the syntax errors for a percent block that is not inside @keyframes', () => {
      const text = '0% { opacitty: 0; }'
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        { length: 1, messageText: 'at-rule or selector expected', start: text.lastIndexOf('}') },
        { length: 2, messageText: '} expected', start: 0 },
      ])
    })

    it.each([
      ['keyframes()', 'keyframes()'],
      ['styled.keyframes()', 'styled.keyframes()'],
    ])('should not treat %s as a keyframes tag', (_label, tagName) => {
      const block = '0% { opacitty: 0; }'
      assert.deepEqual(shownDiagnostics(block, tagName), [
        { length: 1, messageText: 'at-rule or selector expected', start: block.lastIndexOf('}') },
        { length: 2, messageText: '} expected', start: 0 },
      ])
      assertUnknownOnly('opacitty: 0;', tagName)
    })

    it('should not report a property written inside a vendor-prefixed keyframes at-rule', () => {
      const text = '@-webkit-keyframes fade { 0% { opacitty: 0; } }'
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        {
          length: '@-webkit-keyframes'.length,
          messageText: "Always define standard rule '@keyframes' when defining keyframes.",
          start: 0,
        },
      ])
    })

    it.each([
      ['a string', 'content: "@keyframes fade { 0% { opacitty: 0; } }";\ncolr: red;'],
      ['a comment', '/* @keyframes fade { 0% { opacitty: 0; } } */\ncolr: red;'],
      ['an unquoted url', 'background: url(@keyframes.png);\ncolr: red;'],
    ])('should ignore @keyframes inside %s and still report a real property', (_label, text) => {
      assertUnknownOnly(text, 'styled.div', 'colr')
    })

    it('should report each real occurrence once when one is inside @keyframes and one is not', () => {
      const text = 'colr: red;\n@keyframes a {\n  from { colr: red; }\n}\ncolr: red;'
      const first = text.indexOf('colr')
      const inside = text.indexOf('colr', first + 'colr'.length)
      const last = text.lastIndexOf('colr')
      /**
       * The two declarations outside the keyframe block come from the main reading, in source
       * order. The one inside the block is added from the property reading.
       */
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        unknownProperty(text, 'colr', first),
        unknownProperty(text, 'colr', last),
        unknownProperty(text, 'colr', inside),
      ])
    })

    it('should widen a JavaScript escape in a keyframe property to the whole name', () => {
      /** `\x6C` is "l", so the cooked name is `colr`. */
      const name = 'co\\x6Cr'
      const text = `0% { ${name}: 0; }`
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        { length: name.length, messageText: "Unknown property: 'colr'", start: text.indexOf(name) },
      ])
    })

    it('should not report placeholders inside a keyframes tag, and still report the control', () => {
      const text = [
        '${a}% { opacity: 0; }',
        'from { ${prop}: 0; }',
        '0% { ${mixin} }',
        '100% { colr: red; }',
      ].join('\n')
      const context = createSubstitutingContext(text, 'keyframes')
      const diagnostics = createService().getSemanticDiagnostics(context)
      assert.deepEqual(
        diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
        [{ length: 4, messageText: "Unknown property: 'colr'", start: text.indexOf('colr') }],
      )
    })

    it('should not report placeholders inside a nested @keyframes rule, and still report the control', () => {
      const text = [
        '@keyframes ${name} {',
        '  ${step}% { opacity: 0; }',
        '  from { ${prop}: 0; }',
        '  to { colr: red; }',
        '}',
      ].join('\n')
      const context = createSubstitutingContext(text, 'styled.div')
      const diagnostics = createService().getSemanticDiagnostics(context)
      assert.deepEqual(
        diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
        [{ length: 4, messageText: "Unknown property: 'colr'", start: text.indexOf('colr') }],
      )
    })
  })

  describe('lint settings', () => {
    it('should suppress a property listed in validProperties and still report another', () => {
      const manager = new PluginConfigurationManager()
      manager.updateFromPluginConfig({ lint: { validProperties: ['opacitty'] } })
      const text = '0% { opacitty: 0; colr: 1; }'
      assert.deepEqual(shownDiagnostics(text, 'keyframes', manager), [
        unknownProperty(text, 'colr'),
      ])
    })

    it('should suppress unknown properties when the lint is ignore, and keep syntax errors', () => {
      const manager = new PluginConfigurationManager()
      manager.updateFromPluginConfig({ lint: { unknownProperties: 'ignore' } })
      assert.deepEqual(shownDiagnostics('0% { opacitty: 0; }', 'keyframes', manager), [])
      const emptyValue = '0% { color: }'
      assert.deepEqual(shownDiagnostics(emptyValue, 'keyframes', manager), [
        { length: 1, messageText: 'property value expected', start: emptyValue.indexOf('}') },
      ])
    })

    it('should report an unknown vendor-prefixed property when that lint is a warning', () => {
      const manager = new PluginConfigurationManager()
      manager.updateFromPluginConfig({ lint: { unknownVendorSpecificProperties: 'warning' } })
      const name = '-webkit-opacitty'
      const text = `0% { ${name}: 0; }`
      assert.deepEqual(shownDiagnostics(text, 'keyframes', manager), [
        {
          length: name.length,
          messageText: 'Unknown vendor specific property.',
          start: text.indexOf(name),
        },
      ])
    })
  })

  describe('completions, hover, and code fixes stay on the keyframes document', () => {
    it('should complete a color inside a keyframe block', () => {
      const text = '0% { color:'
      const context = createTemplateContext(text, 'keyframes')
      const aliceblue = createService()
        .getCompletionsAtPosition(context, context.toPosition(text.length))
        .entries.find((entry) => entry.name === 'aliceblue')

      assert.strictEqual(aliceblue?.kindModifiers, 'color')
      assert.deepEqual(aliceblue?.replacementSpan, { length: 0, start: text.length })
    })

    it('should hover a property inside a keyframe block', () => {
      const text = '0% { opacity: 0; }'
      const context = createTemplateContext(text, 'keyframes')
      const hover = createService().getQuickInfoAtPosition(
        context,
        context.toPosition(text.indexOf('opacity') + 1),
      )

      assert.deepEqual(hover?.textSpan, {
        length: 'opacity: 0'.length,
        start: text.indexOf('opacity'),
      })
      assert.match(ts.displayPartsToString(hover?.documentation), /Opacity of an element/i)
    })

    it('should rename an unknown property inside a keyframe block', () => {
      const text = '0% { opacitty: 0; }'
      const start = text.indexOf(MISSPELLED)
      const fixes = createService().getCodeFixesAtPosition(
        createTemplateContext(text, 'keyframes'),
        start,
        start,
      )
      const rename = fixes.find((fix) => fix.description === "Rename to 'opacity'")

      assert.deepEqual(rename?.changes[0]?.textChanges, [
        { newText: 'opacity', span: { length: MISSPELLED.length, start } },
      ])
    })

    it('should rename an unknown property inside a nested @keyframes rule', () => {
      const text = '@keyframes fade {\n  0% { opacitty: 0; }\n}'
      const start = text.indexOf(MISSPELLED)
      const fixes = createService().getCodeFixesAtPosition(
        createTemplateContext(text, 'styled.div'),
        start,
        start,
      )
      const rename = fixes.find((fix) => fix.description === "Rename to 'opacity'")

      assert.deepEqual(rename?.changes[0]?.textChanges, [
        { newText: 'opacity', span: { length: MISSPELLED.length, start } },
      ])
    })
  })

  describe('the property-reading document', () => {
    it('should rewrite keyframe preludes without moving the property or changing the main document', () => {
      const provider = new StyledVirtualDocumentProvider(ts)
      const text = '0% { opacitty: 0; }\nfrom { opacity: 0; }'
      const context = createTemplateContext(text, 'keyframes')
      const main = provider.createVirtualDocument(context)
      const property = provider.createKeyframePropertyReadingDocument(context)

      assert.match(main.getText(), /^@keyframes custom \{\n/)
      assert.isDefined(property)
      const mainBody = documentBody(main.getText(), KEYFRAMES_WRAPPER)
      const propertyBody = documentBody(property.getText(), ROOT_WRAPPER)
      assert.strictEqual(propertyBody.length, mainBody.length)
      assert.strictEqual(propertyBody.indexOf(MISSPELLED), mainBody.indexOf(MISSPELLED))
      assert.strictEqual(propertyBody.includes('0%'), false)
      assert.strictEqual(propertyBody.includes('@keyframes'), false)
      assert.strictEqual(provider.createVirtualDocument(context).getText(), main.getText())
    })

    it('should rewrite a nested @keyframes rule and leave a keyword in a string', () => {
      const provider = new StyledVirtualDocumentProvider(ts)
      const text = 'content: "@keyframes";\n@keyframes fade {\n  0% { opacitty: 0; }\n}'
      const context = createTemplateContext(text, 'styled.div')
      const main = provider.createVirtualDocument(context)
      const property = provider.createKeyframePropertyReadingDocument(context)

      assert.isDefined(property)
      const mainBody = documentBody(main.getText(), ROOT_WRAPPER)
      const propertyBody = documentBody(property.getText(), ROOT_WRAPPER)
      assert.strictEqual(propertyBody.length, mainBody.length)
      assert.strictEqual(propertyBody.indexOf(MISSPELLED), text.indexOf(MISSPELLED))
      assert.strictEqual(propertyBody.includes('content: "@keyframes"'), true)
      assert.strictEqual(propertyBody.includes('@keyframes fade'), false)
    })

    it('should skip the property reading when the text has no standard @keyframes rule', () => {
      const provider = new StyledVirtualDocumentProvider(ts)
      const plain = createTemplateContext('color: red;', 'styled.div')
      const quoted = createTemplateContext(
        'content: "@keyframes fade { 0% { opacitty: 0; } }";',
        'css',
      )

      assert.isUndefined(provider.createKeyframePropertyReadingDocument(plain))
      assert.isUndefined(provider.createKeyframePropertyReadingDocument(quoted))
    })
  })
})
