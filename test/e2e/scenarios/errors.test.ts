import { readFileSync } from 'node:fs'

import { assert, describe, it } from 'vitest'

import {
  diagnosticsOf,
  pluginDiagnostics,
  spansAndText,
  startServer,
  unicodeLineBreaks,
  useSharedServer,
} from '../tsserver-fixture/helpers'
import { mark } from '../tsserver-fixture/markers'

const cssFunction =
  'function css(strings: TemplateStringsArray, ...values: unknown[]) { return ""; }'

/** A template whose misspelled property must be reported: the positive control for "no error". */
const controlLines = ['const Control = styled.div`', '  ⟨control⟩colr⟨/control⟩: red;', '`']

describe('Errors', () => {
  const server = useSharedServer()

  /** Opens the marked `source` and returns it with the plugin's diagnostics for it. */
  async function diagnose(source: string) {
    const marked = mark(source)
    const file = server().open(marked.text)
    const response = await server().request('semanticDiagnosticsSync', { file })
    return { diagnostics: pluginDiagnostics(response), marked, response }
  }

  const unknownProperty = (marked: ReturnType<typeof mark>, name: string, rangeName = name) => ({
    ...marked.range(rangeName),
    text: `Unknown property: '${name}'`,
  })

  it('should return no semantic diagnostics for valid TypeScript and CSS', async () => {
    const { marked, response } = await diagnose(
      [
        'declare const styled: { div(strings: TemplateStringsArray): string }',
        'function css(x: TemplateStringsArray) { return x; }; const q = css`color: red;`',
        ...controlLines,
      ].join('\n'),
    )

    /** Every diagnostic, TypeScript's included; the control proves the plugin answered. */
    assert.deepEqual(spansAndText(diagnosticsOf(response)), [
      unknownProperty(marked, 'colr', 'control'),
    ])
  })

  it('should return error for unknown property', async () => {
    const { diagnostics, marked } = await diagnose(
      'function css(x: TemplateStringsArray) { return x; }; const q = css`⟨boarder⟩boarder⟨/boarder⟩: 1px solid black;`',
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'boarder')])
  })

  it.each([
    ['an unclosed placeholder after a property', 'const q = css`color: ${'],
    ['an unclosed placeholder at the template start', 'const q = css`${value'],
  ])('should not return CSS errors for %s', async (_description, incomplete) => {
    /** The control comes first: nothing after an unclosed placeholder parses as its own template. */
    const { diagnostics, marked } = await diagnose(
      ['declare const styled: any, value: any', cssFunction, ...controlLines, incomplete].join(
        '\n',
      ),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr', 'control')])
  })

  it('should return errors when error occurs in last position', async () => {
    const { diagnostics, marked } = await diagnose(
      `${cssFunction}; const q = css\`⟨semicolon⟩;⟨/semicolon⟩⟨end⟩\``,
    )

    /**
     * The stray ";" leaves the wrapper's opening rule unclosed, reported on the ";" itself. The
     * parser's cascading "at-rule or selector expected" is always kept; with no "}" in the
     * template to re-anchor to, it stays at the template end.
     */
    assert.deepEqual(spansAndText(diagnostics), [
      { ...marked.range('semicolon'), text: '} expected' },
      { end: marked.at('end'), start: marked.at('end'), text: 'at-rule or selector expected' },
    ])
  })

  it('should report the cascading end-of-template diagnostic from a stray closing brace alongside the real one', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        cssFunction,
        'const q = css`',
        '  color: red;',
        '  ⟨stray⟩}⟨/stray⟩',
        '  margin⟨colon⟩:⟨/colon⟩ 0;',
        '`',
      ].join('\n'),
    )

    /**
     * The stray "}" closes the wrapper rule early, so "margin: 0;" parses outside any rule and
     * reports "{ expected". The cascading "at-rule or selector expected" is kept, re-anchored to
     * the stray "}" that caused it.
     */
    assert.deepEqual(spansAndText(diagnostics), [
      { ...marked.range('stray'), text: 'at-rule or selector expected' },
      { ...marked.range('colon'), text: '{ expected' },
    ])
  })

  it('should report a stray "}" as an error-level diagnostic even when an unrelated lint warning starts after it', async () => {
    /**
     * Everything after the "}" parses (".a { colr: red; }" is valid apart from the misspelled
     * property), so the "colr" warning is not the cascade the brace caused and must not stand in
     * for it.
     */
    const { diagnostics, marked } = await diagnose(
      `${cssFunction}; const q = css\`color: red; ⟨stray⟩}⟨/stray⟩ .a { ⟨colr⟩colr⟨/colr⟩: red; }\``,
    )

    assert.deepEqual(spansAndText(diagnostics), [
      { ...marked.range('stray'), text: 'at-rule or selector expected' },
      unknownProperty(marked, 'colr'),
    ])
    assert.strictEqual(
      diagnostics.find(({ text }) => text === 'at-rule or selector expected')?.category,
      'error',
    )
  })

  it.each([
    ['a trailing stray "}" with nothing after it', 'color: red; ⟨stray⟩}⟨/stray⟩'],
    ['a bare "}" with no other content', '⟨stray⟩}⟨/stray⟩'],
    [
      'a stray "}" followed by a rule that parses cleanly on its own',
      'color: red; ⟨stray⟩}⟨/stray⟩ a { color: blue; }',
    ],
    ['a matched rule followed by an extra, unmatched "}"', 'a { color: red; }⟨stray⟩}⟨/stray⟩'],
  ])(
    /**
     * A stray "}" that is a template's only error is reported, anchored to the brace, rather than
     * dropped as a duplicate of the cascading diagnostic at the template end.
     */
    'should report a stray "}" as a real diagnostic when it is the template\'s only error: %s',
    async (_description, templateText) => {
      const { diagnostics, marked } = await diagnose(
        `${cssFunction}; const q = css\`${templateText}\``,
      )

      assert.deepEqual(spansAndText(diagnostics), [
        { ...marked.range('stray'), text: 'at-rule or selector expected' },
      ])
    },
  )

  it('should report a stray "}" alongside an unrelated diagnostic that starts before it', async () => {
    const { diagnostics, marked } = await diagnose(
      `${cssFunction}; const q = css\`⟨colr⟩colr⟨/colr⟩: red; ⟨stray⟩}⟨/stray⟩\``,
    )

    assert.deepEqual(spansAndText(diagnostics), [
      unknownProperty(marked, 'colr'),
      { ...marked.range('stray'), text: 'at-rule or selector expected' },
    ])
  })

  it('should return error for multiline unknown property #20', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        'function css(x: TemplateStringsArray) { return x; };',
        'const q = css`',
        '⟨boarder⟩boarder⟨/boarder⟩: 1px solid black;',
        '`',
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'boarder')])
  })

  it.each(unicodeLineBreaks)(
    'should map diagnostics after the Unicode %s',
    async (_description, separator) => {
      const { diagnostics, marked } = await diagnose(
        `const q = css\`color: red;${separator}⟨boarder⟩boarder⟨/boarder⟩: 1px solid black;\``,
      )

      assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'boarder')])
    },
  )

  it.each(unicodeLineBreaks)(
    'should map diagnostics after an interpolation containing the Unicode %s',
    async (_description, separator) => {
      const { diagnostics, marked } = await diagnose(
        `const value = 'red'; const q = css\`color: \${${separator}value${separator}};${separator}⟨boarder⟩boarder⟨/boarder⟩: 1px solid black;\``,
      )

      assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'boarder')])
    },
  )

  it.each(unicodeLineBreaks)(
    'should not mistake a Unicode %s inside a quoted string value for a declaration separator',
    async (_description, separator) => {
      /** TypeScript counts the separator as a line break even inside the CSS string. */
      const { diagnostics, marked } = await diagnose(
        `const q = css\`content: "a${separator}b"; ⟨colr⟩colr⟨/colr⟩: red;\``,
      )

      assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr')])
    },
  )

  it('should map diagnostics after a multiline interpolation to the source file', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        `${cssFunction};`,
        'const q = css`',
        '  color: ${',
        '    "red"',
        '  };',
        '  ⟨boarder⟩boarder⟨/boarder⟩: 1px solid black;',
        '`',
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'boarder')])
  })

  it('should map diagnostics after dynamic declaration names and values (#25)', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        'declare const styled: { div(strings: TemplateStringsArray, ...values: unknown[]): string };',
        'declare const varName: string;',
        'declare const value: string;',
        'const StyledComponent = styled.div`',
        '  ${varName}: ${value};',
        '  ⟨boarder⟩boarder⟨/boarder⟩: 1px solid black;',
        '`',
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'boarder')])
  })

  it('should include error for unknown property in selector', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        'const css = {} as { span: (strings: TemplateStringsArray, ...values: unknown[]) => string };',
        'const ListNoteTitle = css.span`',
        '  width: 100%;',
        '  &:hover {',
        '    ⟨noSuch⟩noSuch⟨/noSuch⟩: red;',
        '  }',
        '`;',
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'noSuch')])
  })

  it.each([
    ['used as a selector', ['  ${', '    B', '  }:hover & {', '    color: red;', '  }']],
    ['in a hex color value', ['  color: #${', '    B', '  };']],
    ['used as a mixin', ['  ${', '    B', '  };']],
  ])(
    'should map a diagnostic after a multi-line placeholder %s',
    async (_description, placeholderLines) => {
      const { diagnostics, marked } = await diagnose(
        [
          'const styled = {} as { div: (strings: TemplateStringsArray, ...values: unknown[]) => string }; const B: unknown = 1; const q = styled.div`',
          ...placeholderLines,
          '  ⟨colr⟩colr⟨/colr⟩: blue;',
          '`',
        ].join('\n'),
      )

      assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr')])
    },
  )

  it.each([
    ['a property name with no value or terminator', '\n  margin: 0;\n  color\n'],
    ['a property name with a colon but no value', '\n  color:\n'],
    ['an unclosed rule', '\n  a {\n'],
    ['an unclosed nested at-rule', '\n  @media screen {\n    a { color: red; }\n'],
    ['a bare property name on the template’s only line', 'margin: 0; color'],
    ['an unclosed rule on the template’s only line', 'a {'],
    ['a truncated declaration after a valid one', '\n  color: red;\n  b\n'],
  ])(
    'should report a diagnostic at the template end for %s instead of dropping it',
    async (_description, body) => {
      const { diagnostics, marked } = await diagnose(
        `${cssFunction}; const q = css\`${body}⟨end⟩\``,
      )
      const templateEnd = marked.at('end')

      assert.deepInclude(
        diagnostics.map(({ end, start }) => ({ end, start })),
        { end: templateEnd, start: templateEnd },
      )
      for (const { start } of diagnostics) {
        /** Never past the template end: the wrapper's synthetic closing "}" has no source text. */
        assert.isTrue(
          start.line < templateEnd.line ||
            (start.line === templateEnd.line && start.offset <= templateEnd.offset),
          `expected ${JSON.stringify(start)} to be at or before the template end ${JSON.stringify(templateEnd)}`,
        )
      }
    },
  )

  it('should report an unknown property inside an @layer block', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        'declare const styled: any',
        'const Layered = styled.div`',
        '  @layer utilities {',
        '    ⟨colr⟩colr⟨/colr⟩: red;',
        '  }',
        '`',
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr')])
  })

  /**
   * Each row holds shapes that work at runtime and must report nothing, followed by a control
   * template whose misspelled property must be the only plugin diagnostic, which also proves the
   * plugin loaded and parsed past the row. Backslashes in the file text are JavaScript escapes,
   * as a user writes them.
   */
  it.each([
    ['an empty template', ['function css(x: TemplateStringsArray) { return x; }; const q = css``']],
    [
      'a nested ruleset',
      [
        'function css(x: TemplateStringsArray) { return x; }; const q = css`&:hover { border: 1px solid black; }`',
      ],
    ],
    ['a placeholder in a property', [`${cssFunction}; const q = css\`color: \${"red"};\``]],
    [
      'a placeholder in a property of a multiline template',
      [`${cssFunction}; const q = css\``, '    color: ${"red"};', '`'],
    ],
    [
      'a placeholder at the start followed by semicolons (#22)',
      [
        'function css(...args: unknown[]){}',
        'css`${mixin}; color: blue;`',
        'css`',
        '  ${mixin};',
        '  color: blue;',
        '`',
        'css`',
        '  ${mixin}   ;',
        '  color: blue;',
        '`',
        'css`',
        '  ${mixin};;; ;; ;',
        '  color: blue;',
        '`',
      ],
    ],
    [
      'a placeholder used as a selector (#30)',
      [`${cssFunction}; const q = css\`\${"button"} { color: red;  }\``],
    ],
    [
      'a placeholder used as a complex selector (#30)',
      [
        `${cssFunction};`,
        'function fullWidth() { };',
        'const Button = {};',
        'const q = css`',
        '    display: flex;',
        '    ${fullWidth()};',
        '',
        '    ${Button} {',
        '    width: 100%;',
        '',
        '    &:not(:first-child):not(:last-child) {',
        '        margin-left: 0;',
        '        margin-right: 0;',
        '        border-radius: 0;',
        '    }',
        '    }',
        '`',
      ],
    ],
    [
      'a placeholder used as a selector part (#39)',
      [
        `${cssFunction}; const Content = "button"; const q = css\`& > \${Content} { margin-left: 1px; }\``,
      ],
    ],
    [
      'placeholders in multiple selectors (#39)',
      [
        `${cssFunction}; const q = css\``,
        "    & > ${'content'} {",
        '        color: 1px;',
        '    }',
        '',
        "    & > ${'styledNavBar'} {",
        '        margin-left: ${1};',
        '    }',
        '`',
      ],
    ],
    [
      'a placeholder that spans multiple lines (#44)',
      [
        'const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; const q = css.a`',
        '  color:',
        "    ${'transparent'};",
        '  border-bottom: 1px;',
        '  &:hover {',
        '    color: inherit;',
        '    text-decoration: none;',
        '  }',
        '`',
      ],
    ],
    [
      'a complicated style (#44)',
      [
        'const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; const q = css.a`',
        '  display: flex;',
        '  width: 6rem;',
        '  height: 5rem;',
        '  margin-right: -3px;',
        '  border-right: 3px solid',
        '    ${({ active, theme: { colors } }: { active: boolean; theme: { colors: { yellow: string } } }) =>',
        "                active ? colors.yellow : 'transparent'};",
        '  border-bottom: 1px solid rgba(255, 255, 255, 0.5);',
        '  font-weight: bold;',
        '  font-size: 0.875rem;',
        '  color: white;',
        '  cursor: pointer;',
        '  &:not([href]):not([tabindex]) {',
        '    color: white;',
        '  }',
        '  &:hover {',
        '    color: inherit;',
        '    text-decoration: none;',
        '  }',
        '`',
      ],
    ],
    [
      'a placeholder value followed by a unit (#48)',
      [`${cssFunction}; const width = 1; const q = css\``, '    width: ${width}%;', '`'],
    ],
    [
      'a placeholder as the declaration name (#52)',
      [`${cssFunction}; const q = css\``, "    ${'width'}: 1px;", '`'],
    ],
    [
      'dynamic declaration names and values (#25)',
      [
        'declare const varName: string;',
        'declare const value: string;',
        'const StyledComponent = styled.div`',
        '  ${varName}: ${value};',
        '  --${varName}: ${value};',
        '  --theme-${varName}: ${value};',
        '  --${varName}-${varName}: ${value};',
        '  color: red; --${varName}: ${value};',
        '  --føø-${varName}: ${value};',
        '  :root { --${varName}: ${value}; }',
        '`',
      ],
    ],
    [
      'a placeholder as part of a selector list (#59)',
      [
        `${cssFunction}; const q = css\``,
        "    ${'a'}, ${'button'} {",
        '        width: 1px;',
        '    }',
        '`',
      ],
    ],
    [
      'a placeholder used as an entire declaration inside a nested rule (#54)',
      [
        `${cssFunction}; const q = css\``,
        '    &.buu-foo {',
        "        ${'baseShape'};",
        '        &.active {',
        '            font-size: 2rem;',
        '        }',
        '    }',
        '`',
      ],
    ],
    [
      'adjacent placeholders (#62)',
      [
        'const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; const margin1 = "3px"; const margin2 = "3px"; const q = css.a`',
        '    margin: ${margin1} ${margin2};',
        '`',
      ],
    ],
    [
      'a contextual selector (#71)',
      [
        'const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; const q = css.a`',
        '    html.test & {',
        '        display: none;',
        '    }',
        '`',
      ],
    ],
    [
      'a placeholder used in a contextual selector (#71)',
      [
        "const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; let FlipContainer = 'button'; const q = css.a`",
        '    position: relative;',
        '',
        '    ${FlipContainer}:hover & {',
        '        transform: rotateY(180deg);',
        '    }',
        '`',
      ],
    ],
    [
      'a placeholder with an attribute selector before a contextual "&" (#67)',
      [
        "const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; let OtherStyledElm = 'button'; const q = css.a`",
        '    ${OtherStyledElm}:not([value=""]) + & {',
        '        transform: rotateY(180deg);',
        '    }',
        '`',
      ],
    ],
    [
      'placeholders in a contextual selector list (#67)',
      [
        "const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; let OtherStyledElm = 'button'; const q = css.a`",
        '    ${OtherStyledElm} + &,',
        '    ${OtherStyledElm}:not([value=""]) + & {',
        '        transform: rotateY(180deg);',
        '    }',
        '`',
      ],
    ],
    [
      'a custom tag function (#21)',
      [
        'function css<T>(): (value: unknown) => (strings: TemplateStringsArray) => string { return () => () => ""; }; const q = css<{}>()(window.blur)`',
        '    display: none;',
        '`',
      ],
    ],
    [
      'a sub-ruleset whose only content is a placeholder (#50)',
      [
        'const css = {} as { a: (strings: TemplateStringsArray, ...values: unknown[]) => string }; const q = css.a`',
        '    :nth-of-type(1) {',
        '        ${true ? "display: initial" : "display: hidden"}',
        '    }',
        '`',
      ],
    ],
    [
      'a placeholder before a contextual "&" after a value placeholder (#74)',
      [
        'const css = {} as { span: (strings: TemplateStringsArray, ...values: unknown[]) => string };',
        "const ListNoteItem = 'bla';",
        'const ListNoteTitle = css.span`',
        '    font-weight: bold;',
        '    color: ${(props: { theme: { primaryColor: string } }) => props.theme.primaryColor};',
        '    ${ListNoteItem}:hover & {',
        '        text-decoration: underline;',
        '    }',
        '`;',
      ],
    ],
    [
      'a child selector (#75)',
      [
        'const css = {} as { span: (strings: TemplateStringsArray, ...values: unknown[]) => string };',
        "const ListNoteItem = 'bla';",
        'const ListNoteTitle = css.span`',
        '    width: 100%;',
        '    > ${ListNoteItem}:hover {',
        '        color: red;',
        '    }',
        '`;',
      ],
    ],
    [
      'newer properties (#95, #53)',
      [
        'const css = {} as { span: (strings: TemplateStringsArray, ...values: unknown[]) => string };',
        'const ListNoteTitle = css.span`',
        '    scrollbar-width: 10px;',
        '    scrollbar-color: red;',
        '    scroll-snap-align: initial;',
        '`;',
      ],
    ],
    [
      'object interpolations with nested templates',
      [
        cssFunction,
        'const styles = {',
        '  active: css`color: ${({ theme: { colors } }: { theme: { colors: { primary: string } } }) => colors.primary};`,',
        '}',
        'const q = css`',
        '  ${styles.active}',
        '  &:hover {',
        '    ${css`background: ${({ tone }: { tone: string }) => tone};`}',
        '  }',
        '`',
      ],
    ],
    [
      'styled-components v7 block-position placeholders, nested layers, and value fragments',
      [
        'declare const css: any, kf: any',
        'const SameLineMixin = styled.div`',
        '  color: red; ${mixin}',
        '  margin: 0;',
        '`',
        'const InlineBlockMixin = styled.div`',
        '  &:hover { ${mixin} }',
        '`',
        'const TwoMixins = styled.div`',
        '  ${a} ${b}',
        '  margin: 0;',
        '`',
        'const Layers = styled.div`',
        '  @layer utilities { color: red; }',
        '  &:hover {',
        '    @layer framework.base { color: red; }',
        '  }',
        '  @layer {',
        '    color: red;',
        '  }',
        '`',
        'const Border = css`1px solid red`',
        'const Animation = css`${kf} 1s linear`',
      ],
    ],
    [
      'placeholders joined to property names',
      [
        'const Sides = styled.div`',
        '  padding-${side}: 4px;',
        '  border-${side}-color: red;',
        '  ${side}-top: 0;',
        '  ${side}-width: 1px;',
        '  margin: 0;',
        '`',
      ],
    ],
    [
      'property name placeholders before a later "&" on the same line',
      [
        'const LaterRules = styled.div`',
        '  padding-${side}: 0; &:hover { color: red; }',
        '  ${side}-top: 0; &:focus { color: red; }',
        '  border-${side}-color: red; &:active { color: red; }',
        '  ${side}: 0; &:disabled { color: red; }',
        '`',
      ],
    ],
    [
      'placeholders standing for at-rule conditions',
      [
        'const Queries = styled.div`',
        '  @media screen and ${query} { color: red; }',
        '  @media not all and ${query} { color: red; }',
        '  @supports ${query} { color: red; }',
        '  @supports not ${query} { color: red; }',
        '  @container card ${query} { color: red; }',
        '  @media screen and',
        '    ${query} {',
        '    color: red;',
        '  }',
        '`',
      ],
    ],
    [
      'value placeholders split over lines',
      [
        'const Tracks = styled.div`',
        '  border:',
        '    ${a}',
        '    ${b};',
        '  grid-template-columns:',
        '    ${a}',
        '    ${b};',
        '  margin: 0;',
        '`',
      ],
    ],
    [
      'selector placeholders and a commented @layer prelude',
      [
        'const Selectors = styled.div`',
        '  &.${cls}:hover { color: red; }',
        '  ${Child}:not(:last-child)',
        '  {',
        '    color: red;',
        '  }',
        '  @layer /* base styles */ base {',
        '    color: red;',
        '  }',
        '`',
      ],
    ],
    [
      'JavaScript escapes, read as the characters styled-components receives',
      [
        'const Escapes = styled.div`',
        '  &::before { content: \\"x\\"; }',
        '  &::after { content: \\"a;b\\"; }',
        '  color: red;\\n  margin: 0;',
        '  font-family: \\u{1F600};',
        '  background: url(a\\\\b.png);',
        '  color: red;\\',
        '  margin: 0;',
        '`',
      ],
    ],
    [
      'keyframe selectors, selector lists, media conditions, and url escapes',
      [
        'const Frames = keyframes`',
        '  ${a}% { opacity: 0; }',
        '  to { opacity: 1; }',
        '`',
        'const Lists = styled.div`',
        '  ${Child}:hover,',
        '  ${Child}:focus {',
        '    color: red;',
        '  }',
        '  @media ${query} or ${query} { color: red; }',
        '  /* note */ @media screen and ${query} { color: red; }',
        '  background: url(a\\\\(b\\\\).png);',
        '`',
      ],
    ],
    [
      'JavaScript escapes inside unquoted url() arguments',
      [
        'const UrlEscapes = styled.div`',
        '  background: url(a/\\x41y.png);',
        '  background: url(x\\u0041y.png);',
        '  background: url(foo\\',
        'bar.png);',
        '  margin: 0;',
        '`',
      ],
    ],
    [
      'mixins after JavaScript-escaped characters',
      [
        'const EscapedMixins = styled.div`',
        '  content: "\\"; ${mixin};',
        '  color: red\\; ${mixin};',
        '  &:hover \\{ ${mixin}; }',
        '`',
      ],
    ],
  ])('should report no false error for %s', async (_description, templateLines) => {
    const { diagnostics, marked } = await diagnose(
      [
        'declare const styled: any, keyframes: any, side: any, query: any, a: any, b: any, cls: any, Child: any, mixin: any',
        ...templateLines,
        ...controlLines,
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr', 'control')])
  })

  it('should map a diagnostic after JavaScript escapes to its source position', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        'declare const styled: any',
        'const A = styled.div`',
        '  &::before { content: \\"\\\\f101\\"; } ⟨colr⟩colr⟨/colr⟩: red;',
        '`',
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr')])
  })

  it('should report the cooked name of an escape inside a property name once, over the whole name', async () => {
    const { diagnostics, marked } = await diagnose(
      ['declare const styled: any', 'const A = styled.div`⟨name⟩co\\x6Cr⟨/name⟩: red;`'].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr', 'name')])
  })

  it('should report nothing for a css fragment that is one word, and still report a declaration in one', async () => {
    const { diagnostics, marked } = await diagnose(
      [
        'declare const css: any',
        'declare const x: number',
        'const a = css`none`',
        'const b = css`${x}px`',
        'const c = css`⟨colr⟩colr⟨/colr⟩: red;`',
      ].join('\n'),
    )

    assert.deepEqual(spansAndText(diagnostics), [unknownProperty(marked, 'colr')])
  })

  it('should report a diagnostic instead of throwing for an unclosed template in a file that is not open', async (context) => {
    const closedFileServer = startServer(context, { project: 'closed-file-project-fixture' })
    const unclosedFile = closedFileServer.fixtureFile('unclosed.ts')
    /** The file ends at its template's closing backtick, which is where the template ends. */
    const unclosedText = readFileSync(unclosedFile, 'utf8')
    const templateEnd = mark(`${unclosedText.slice(0, -1)}⟨end⟩\``).at('end')

    /**
     * Only the importing file is opened, so tsserver reads unclosed.ts from disk. The template
     * context asserts on an out-of-range line for a file read this way, unlike an open file's
     * in-memory content.
     */
    closedFileServer.open("import './unclosed'\n", { fileName: 'entry.ts' })
    const response = await closedFileServer.request('semanticDiagnosticsSync', {
      file: unclosedFile,
    })

    assert.deepEqual(spansAndText(pluginDiagnostics(response)), [
      { end: templateEnd, start: templateEnd, text: '} expected' },
    ])
  })
})
