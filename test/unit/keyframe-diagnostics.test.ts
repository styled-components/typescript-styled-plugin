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

    it('should keep the syntax diagnostics for a bare property and not report it as unknown', () => {
      const text = 'opacitty: 0;'
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        { length: 0, messageText: 'at-rule or selector expected', start: text.length },
        { length: MISSPELLED.length, messageText: '} expected', start: 0 },
      ])
    })

    it('should keep the syntax diagnostics for @media and not report the property', () => {
      const text = '@media screen { colr: red; }'
      assert.deepEqual(shownDiagnostics(text, 'keyframes'), [
        { length: 1, messageText: 'at-rule or selector expected', start: text.lastIndexOf('}') },
        { length: '@media'.length, messageText: '} expected', start: text.indexOf('@media') },
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
    it('should report an unknown property when the animation name is an interpolation', () => {
      assertUnknownOnly('@keyframes #{name} { 0% { opacitty: 0; } }', 'styled.div')
    })

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

    it('should report an unknown property when the animation name is an escape', () => {
      assertUnknownOnly('@keyframes \\61 { 0% { opacitty: 0; } }', 'styled.div')
    })

    it('should keep the syntax errors for a single hyphen animation name', () => {
      const text = '@keyframes - { 0% { opacitty: 0; } }'
      assert.deepEqual(shownDiagnostics(text, 'styled.div'), [
        { length: 0, messageText: 'at-rule or selector expected', start: text.length },
        { length: 1, messageText: 'identifier expected', start: text.indexOf('-') },
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
       * Declarations outside the keyframe block are reported in source order. The one inside
       * the block is appended after them.
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
})
