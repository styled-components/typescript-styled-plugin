import { assert, describe, it } from 'vitest'

import { getTemplateSubstitutions } from '../../src/template/template-substitutions'

describe('substituter', () => {
  it('should replace property value with x', () => {
    assert.deepEqual(
      performSubstitutions(['width: 1px;', `color: \${'red'};`, 'color: red;'].join('\n')),
      ['width: 1px;', `color: xxxxxxxx;`, 'color: red;'].join('\n'),
    )
  })

  it('should insert whitespace when placeholder is used an entire property', () => {
    assert.deepEqual(
      performSubstitutions(['width: 1px;', `\${'color: red;'}`, 'color: red;'].join('\n')),
      ['width: 1px;', `                `, 'color: red;'].join('\n'),
    )
  })

  it('should insert a false property when placeholder is used an entire property with trailing semi-colon', () => {
    assert.deepEqual(
      performSubstitutions(['width: 1px;', `\${'color: red'};`, 'color: red;'].join('\n')),
      ['width: 1px;', `$a:0           ;`, 'color: red;'].join('\n'),
    )
  })

  it('should add a zero for percent units', () => {
    assert.deepEqual(performSubstitutions('width: ${10}%;'), 'width: 00000%;')
  })

  it('should replace an empty placeholder on the final line without a trailing newline', () => {
    assert.deepEqual(performSubstitutions('color: ${}'), 'color: xxx')
  })

  it('should preserve length for an empty placeholder used as an entire declaration', () => {
    const value = '${};'
    const result = performSubstitutions(value)

    assert.strictEqual(result, 'a:0;')
    assert.strictEqual(result.length, value.length)
  })

  it('should replace property with fake property when placeholder is used in name (#52)', () => {
    assert.deepEqual(
      performSubstitutions(['width: 1px;', `\${123}: 1px;`, 'color: red;'].join('\n')),
      ['width: 1px;', `$axxxx: 1px;`, 'color: red;'].join('\n'),
    )
  })

  it('should insert x for placeholder used as rule', () => {
    assert.deepEqual(
      performSubstitutions(['${"button"} {', 'color: ${"red"};', '}'].join('\n')),
      ['xxxxxxxxxxx {', 'color: xxxxxxxx;', '}'].join('\n'),
    )
  })

  it('should insert x for placeholder used as part of a rule (#59)', () => {
    assert.deepEqual(
      performSubstitutions(['${"button"}, ${"a"} {', 'color: ${"red"};', '}'].join('\n')),
      ['xxxxxxxxxxx, xxxxxx {', 'color: xxxxxxxx;', '}'].join('\n'),
    )
  })

  it('should fake out property name when inside nested rule (#54)', () => {
    assert.deepEqual(
      performSubstitutions(
        [
          '&.buu-foo {',
          '  ${"baseShape"};',
          '  &.active {',
          '    font-size: 2rem;',
          '  }',
          '}',
        ].join('\n'),
      ),
      ['&.buu-foo {', '  $a:0          ;', '  &.active {', '    font-size: 2rem;', '  }', '}'].join(
        '\n',
      ),
    )
  })

  it('should add zeros for color units (#60)', () => {
    assert.deepEqual(performSubstitutions('color: #${1};'), 'color: #000 ;')
  })

  it.each([
    ['an empty hex placeholder', '${}'],
    ['a short hex placeholder', '${a}'],
    ['a long hex placeholder', '${longValue}'],
  ])('should preserve length for %s', (_description, placeholder) => {
    assert.deepEqual(
      performSubstitutions(`color: #${placeholder};`),
      `color: #000${' '.repeat(Math.max(placeholder.length - 3, 0))};`,
    )
  })

  it('should replace adjacent variables with x (#62)', () => {
    assert.deepEqual(
      performSubstitutions(
        [`margin: \${'1px'}\${'1px'};`, `padding: \${'1px'} \${'1px'};`].join('\n'),
      ),
      [`margin: xxxxxxxxxxxxxxxx;`, `padding: xxxxxxxx xxxxxxxx;`].join('\n'),
    )
  })

  it('should replace placeholder that spans multiple lines with x (#44)', () => {
    assert.deepEqual(
      performSubstitutions(['background:', `  $\{'transparent'};`].join('\n')),
      ['background:', '  xxxxxxxxxxxxxxxx;'].join('\n'),
    )
  })

  /**
   * At runtime the interpolated value holds none of the placeholder's source line breaks, so every
   * fill writes over them too (docs/architecture.md, substitution invariants).
   */
  it.each([
    ['a line feed', '\n', 'color: xxxxxxxxxxxx;'],
    ['a CRLF', '\r\n', 'color: xxxxxxxxxxxxxx;'],
    ['a carriage return', '\r', 'color: xxxxxxxxxxxx;'],
    ['a line separator', '\u2028', 'color: xxxxxxxxxxxx;'],
    ['a paragraph separator', '\u2029', 'color: xxxxxxxxxxxx;'],
  ])(
    'should fill %s inside a multi-line value placeholder with the fill character',
    (_description, lineTerminator, expected) => {
      const value = `color: \${${lineTerminator}  color${lineTerminator}};`

      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it('should substitute placeholders after a multiline placeholder in their own context', () => {
    const value = ['color: ${', '  color', '};', 'width: ${10}%;'].join('\n')

    assert.strictEqual(
      performSubstitutions(value),
      ['color: xxxxxxxxxxxx;', 'width: 00000%;'].join('\n'),
    )
  })

  it.each([
    ['pseudo class', ':not(:first-child) {'],
    ['pseudo element', '::before {'],
  ])('should replace a component selector followed by a %s', (_description, suffix) => {
    const placeholder = '${Component}'
    assert.deepEqual(
      performSubstitutions(`${placeholder}${suffix}`),
      `&${' '.repeat(placeholder.length - 1)}${suffix}`,
    )
  })

  it.each([
    '--${name}',
    '--theme-${name}',
    '--${namespace}-${name}',
    ':root { --${name}',
    'color: red; --${name}',
    '--føø-${name}',
    '--\\66 oo-${name}',
  ])('should replace an interpolation in the custom property name %s', (propertyName) => {
    assert.deepEqual(
      performSubstitutions(`${propertyName}: 1px;`),
      `${propertyName.replace(/\$\{[^}]*\}/g, (placeholder) => 'x'.repeat(placeholder.length))}: 1px;`,
    )
  })

  it('should replace dynamic declaration names followed by dynamic values (#25)', () => {
    const propertyName = '${varName}'
    const propertyValue = '${value}'

    assert.deepEqual(
      performSubstitutions(`${propertyName}: ${propertyValue};`),
      `$a${'x'.repeat(propertyName.length - 2)}: ${'x'.repeat(propertyValue.length)};`,
    )
  })

  it('should keep the CRLF after a multi-line value placeholder following a dynamic declaration name (#25)', () => {
    const value = ['${varName}: ${', '  value', '};', 'color: red;'].join('\r\n')

    assert.deepEqual(
      performSubstitutions(value),
      ['$axxxxxxxx: xxxxxxxxxxxxxx;', 'color: red;'].join('\r\n'),
    )
  })

  it('should bound syntax masking to the template text', () => {
    const value = '${name}: 1px;'
    const result = getTemplateSubstitutions(value, [{ start: 0, end: Number.MAX_SAFE_INTEGER }])

    assert.strictEqual(result, ' '.repeat(value.length))
    assert.strictEqual(result.length, value.length)
  })

  /** The published ./api getTemplateSettings().getSubstitutions accepts any span list. */
  it('should substitute spans given out of order as it does the same spans in order', () => {
    const value = 'color: ${a}; margin: ${b};'
    const spans = getSpans(value)

    assert.strictEqual(
      getTemplateSubstitutions(value, spans.slice().reverse()),
      getTemplateSubstitutions(value, spans),
    )
    assert.strictEqual(getTemplateSubstitutions(value, spans), 'color: xxxx; margin: xxxx;')
  })

  it.each([
    [
      'overlapping spans, read as their union',
      [
        { start: 7, end: 10 },
        { start: 8, end: 11 },
      ],
    ],
    [
      'a span inside another',
      [
        { start: 7, end: 11 },
        { start: 8, end: 9 },
      ],
    ],
    ['a span starting before the text', [{ start: -3, end: 11 }]],
    [
      'a span starting past the text',
      [
        { start: 7, end: 11 },
        { start: 40, end: 50 },
      ],
    ],
  ])('should keep the text length for %s', (_description, spans) => {
    const value = 'color: ${a}; margin: 0;'
    const result = getTemplateSubstitutions(value, spans)

    assert.strictEqual(result.length, value.length)
    assert.strictEqual(result.slice(11), value.slice(11))
  })

  /** Spans shorter than a branch's fill, as `./api`'s getSubstitutions accepts them. */
  it.each([
    ['an empty span in selector position', ' :hover {}', { start: 1, end: 1 }, ' :hover {}'],
    ['a one-character property name', 'a: 1; b:red', { start: 6, end: 7 }, 'a: 1; x:red'],
    ['a one-character hex color', 'color: #a;', { start: 8, end: 9 }, 'color: #x;'],
    ['a one-character mixin before ";"', 'a;\nb;', { start: 3, end: 4 }, 'a;\n ;'],
  ])('should fall back to a plain fill for %s', (_description, value, span, expected) => {
    assert.strictEqual(getTemplateSubstitutions(value, [span]), expected)
  })

  it.each([
    ['a mixin before ";"', '', ';'],
    ['a property name', '', ': 1px;'],
    ['a property name joined to a name', 'padding-', ': 1px;'],
    ['a selector', '', ':hover & {'],
    ['a hex color', 'color: #', ';'],
    ['an @media condition', '@media screen and ', ' {'],
    ['an @supports condition', '@supports ', ' {'],
  ])(
    'should keep the text length for %s placeholder of every short length',
    (_description, before, after) => {
      for (let length = 0; length <= 6; length++) {
        const value = `${before}${'y'.repeat(length)}${after}`
        const span = { start: before.length, end: before.length + length }

        assert.strictEqual(getTemplateSubstitutions(value, [span]).length, value.length)
      }
    },
  )

  it('should preserve UTF-16 length for substitutions containing surrogate pairs', () => {
    const value = '${"😀"}: ${value};'
    const result = performSubstitutions(value)

    assert.strictEqual(result.length, value.length)
    assert.strictEqual(result, '$axxxxx: xxxxxxxx;')
  })

  it('should preserve template text when there are no substitutions', () => {
    const value = 'color: red; 😀'

    assert.strictEqual(getTemplateSubstitutions(value, []), value)
  })

  it('should preserve dynamic pseudo selectors after component interpolations', () => {
    const component = '${Component}'
    const pseudo = '${pseudo}'

    assert.deepEqual(
      performSubstitutions(`${component}:${pseudo} { color: red; }`),
      `&${' '.repeat(component.length - 1)}:${'x'.repeat(pseudo.length)} { color: red; }`,
    )
  })

  it.each([
    ['with spaces before its semicolon', '   ;'],
    ['with a semicolon on the next line', '\n;'],
  ])('should use a dummy property for a mixin %s', (_description, suffix) => {
    const placeholder = '${mixin}'
    assert.deepEqual(
      performSubstitutions(`${placeholder}${suffix}`),
      `$a:0${' '.repeat(placeholder.length - 4)}${suffix}`,
    )
  })

  it('should replace placeholder used in contextual selector (#71)', () => {
    assert.deepEqual(
      performSubstitutions(
        [
          'position: relative;',
          '',
          '${FlipContainer}:hover & {',
          '   transform: rotateY(180deg);',
          '}',
        ].join('\n'),
      ),
      [
        'position: relative;',
        '',
        '&               :hover & {',
        '   transform: rotateY(180deg);',
        '}',
      ].join('\n'),
    )
  })

  it('should write the dummy declaration of a multi-line mixin placeholder over its line breaks', () => {
    const value = ['${', '    m', '};'].join('\n')

    assert.strictEqual(performSubstitutions(value), '$a:0      ;')
  })

  it('should write the selector fill of a multi-line placeholder over its line breaks', () => {
    const value = ['${', '    B', '}:hover & {', '    color: red;', '}'].join('\n')

    assert.strictEqual(
      performSubstitutions(value),
      ['&         :hover & {', '    color: red;', '}'].join('\n'),
    )
  })

  it.each([
    ['right after "${"', ['color: #${', '    x', '};'], 'color: #000       ;'],
    ['after the first line', ['color: #${x', '  }', ';'], 'color: #000    \n;'],
  ])(
    'should write the hex color fill of a multi-line placeholder broken %s over its line breaks',
    (_description, lines, expected) => {
      assert.strictEqual(performSubstitutions(lines.join('\n')), expected)
    },
  )

  it.each([
    ['line feed', '\n'],
    ['carriage return + line feed', '\r\n'],
    ['carriage return', '\r'],
    ['line separator', ' '],
    ['paragraph separator', ' '],
  ])(
    'should treat a placeholder followed by a colon and a %s as a property name, not a selector, when a rule body follows on a later line',
    (_description, lineTerminator) => {
      /**
       * A line terminator right after the colon makes a property name ("$a" prefix), never a
       * selector ("&" fill), even though a "{" appears on the next line.
       */
      const value = `\${A}:${lineTerminator}a{`

      const result = getTemplateSubstitutions(value, [
        { start: value.indexOf('${'), end: value.indexOf('}') + 1 },
      ])

      assert.strictEqual(result, `$axx:${lineTerminator}a{`)
      assert.strictEqual(result.length, value.length)
    },
  )

  it('should still treat a placeholder followed by a colon and a rule body as a selector when nothing but ordinary characters separates them', () => {
    const value = '${A}:  a{'

    const result = getTemplateSubstitutions(value, [
      { start: value.indexOf('${'), end: value.indexOf('}') + 1 },
    ])

    assert.strictEqual(result, '&   :  a{')
    assert.strictEqual(result.length, value.length)
  })

  it.each([
    ['after a declaration on the same line', 'color: red; ${mixin}\nmargin: 0;'],
    ['inside a one-line rule body', '&:hover { ${mixin} }\nmargin: 0;'],
    ['after a closing brace on the same line', 'a { color: red; } ${mixin}\nmargin: 0;'],
    ['twice on one line after a declaration line', 'color: red;\n${a} ${b}\nmargin: 0;'],
    ['at the template start before a declaration', '${mixin} color: red;'],
    ['after a declaration and a block comment', 'color: red; /* note */ ${mixin}'],
    ['after a block comment at the template start', '/* note */ ${mixin}'],
    /**
     * The first placeholder is placed by the line rule; the second follows it, and the statement
     * rule reaches past the line comment to the ";" for the first, which passes block position on.
     */
    ['twice on one line after a declaration and a line comment', 'color: red; // note\n${a} ${b}'],
  ])('should fill a block-position placeholder %s with whitespace', (_description, value) => {
    assert.strictEqual(
      performSubstitutions(value),
      value.replace(/\$\{[^}]*\}/g, (placeholder) => ' '.repeat(placeholder.length)),
    )
  })

  it('should use a dummy declaration for a second mixin on one line followed by a semicolon', () => {
    const value = '${rule1} ${rule2};'

    assert.strictEqual(performSubstitutions(value), `${' '.repeat(8)} $a:0${' '.repeat(4)};`)
  })

  it('should use a dummy declaration for a mixin followed by a semicolon after a declaration on the same line', () => {
    const value = 'width: 1px; ${mixin};'

    assert.strictEqual(performSubstitutions(value), `width: 1px; $a:0${' '.repeat(4)};`)
  })

  it('should use a dummy declaration for a mixin followed by a semicolon after a declaration and a block comment', () => {
    const value = 'color: red; /* note */ ${mixin};'

    assert.strictEqual(performSubstitutions(value), `color: red; /* note */ $a:0${' '.repeat(4)};`)
  })

  it('should fill a placeholder after a comment that holds another placeholder as a block, and the one inside the comment as a value', () => {
    const value = 'color: red; /* ${a} */ ${b}'

    assert.strictEqual(performSubstitutions(value), `color: red; /* xxxx */ ${' '.repeat(4)}`)
  })

  it('should x-fill a placeholder inside a string even after a ";" in that string', () => {
    const value = 'content: "a; ${b}";'

    assert.strictEqual(performSubstitutions(value), 'content: "a; xxxx";')
  })

  it('should fill a mixin after a declaration whose value holds escaped quotes with whitespace', () => {
    /** The escaped quotes open no string, so the ";" before the mixin ends a statement. */
    const value = 'content: \\"x\\"; ${mixin}'

    assert.strictEqual(performSubstitutions(value), `content: \\"x\\"; ${' '.repeat(8)}`)
  })

  it('should x-fill a placeholder after a CSS-escaped ";", which ends no statement', () => {
    /** The raw `\\` cooks to one backslash, which escapes the ";" in CSS. */
    const value = 'a\\\\; ${b}'

    assert.strictEqual(performSubstitutions(value), 'a\\\\; xxxx')
  })

  /**
   * Each raw backslash below is a JavaScript escape, which styled-components receives cooked, so
   * the substitution reads the character it stands for.
   */
  it.each([
    [
      'a string closed by a JavaScript-escaped quote',
      'content: "\\"; ${mixin};',
      'content: "\\"; $a:0    ;',
    ],
    ['a JavaScript-escaped ";"', 'color: red\\; ${mixin};', 'color: red\\; $a:0    ;'],
    ['a JavaScript-escaped "{"', '&:hover \\{ ${mixin}; }', '&:hover \\{ $a:0    ; }'],
    [
      'a declaration, when a JavaScript-escaped ";" follows it',
      'color: red; ${mixin}\\;',
      'color: red; $a:0    \\;',
    ],
  ])('should read a mixin after %s as a dummy declaration', (_description, value, expected) => {
    assert.strictEqual(performSubstitutions(value), expected)
  })

  it('should keep a value placeholder after a line-start placeholder in value position', () => {
    /**
     * The first placeholder is alone on its line (line rule) but continues the `padding:` value,
     * so it never passes block position on: the second stays an x-filled value.
     */
    const value = 'padding:\n  ${a} ${b};'

    assert.strictEqual(performSubstitutions(value), `padding:\n  ${' '.repeat(4)} xxxx;`)
  })

  it.each([
    ['a compound selector', '.active { color: blue; }'],
    ['a parent selector', ' & { color: blue; }'],
    ['a child combinator', ' > span { color: blue; }'],
    ['an attribute selector', '[disabled] { color: blue; }'],
    ['a universal selector', ' * { color: blue; }'],
    ['an adjacent sibling combinator', ' + a { color: blue; }'],
    ['a general sibling combinator', ' ~ a { color: blue; }'],
    ['an id selector', '#id { color: blue; }'],
    ['a rule body', ' { color: blue; }'],
    ['a selector list', ', a { color: blue; }'],
  ])(
    'should keep a placeholder after a statement boundary x-filled when %s follows it',
    (_description, suffix) => {
      const value = `color: red; \${Child}${suffix}`

      assert.strictEqual(performSubstitutions(value), `color: red; ${'x'.repeat(8)}${suffix}`)
    },
  )

  it('should skip a comment between a placeholder and the "{" that follows it, keeping it x-filled the same as without the comment', () => {
    const control = 'color: red; ${Child} { color: blue; }'
    const withComment = 'color: red; ${Child} /* note */ { color: blue; }'

    assert.strictEqual(
      performSubstitutions(control),
      `color: red; ${'x'.repeat(8)} { color: blue; }`,
    )
    assert.strictEqual(
      performSubstitutions(withComment),
      `color: red; ${'x'.repeat(8)} /* note */ { color: blue; }`,
    )
  })

  it('should treat a string between a placeholder and the "{" that follows it as significant, not skip it like a comment', () => {
    const value = 'color: red; ${Child} "note" { color: blue; }'

    assert.strictEqual(
      performSubstitutions(value),
      `color: red; ${' '.repeat(8)} "note" { color: blue; }`,
    )
  })

  it('should not treat a boundary character inside a placeholder as a statement boundary', () => {
    const value = "color: ${';'} ${b}\nmargin: 0;"

    assert.strictEqual(performSubstitutions(value), `color: ${'x'.repeat(6)} xxxx\nmargin: 0;`)
  })

  it.each([
    ['after a name prefix', 'padding-${s}: 4px;', 'padding-#{x}: 4px;'],
    ['after a longer name prefix', 'margin-${side}: 4px;', 'margin-#{x   }: 4px;'],
    ['between name parts', 'border-${side}-color: red;', 'border-#{x   }-color: red;'],
    ['before a name suffix', '${side}-top: 0;', '#{x   }-top: 0;'],
    ['before a short name suffix', '${s}-width: 4px;', '#{x}-width: 4px;'],
    ['twice in one name', '${a}-${b}: 1px;', '#{x}-#{x}: 1px;'],
    ['twice adjacent in one name', '${a}${b}-x: 1px;', '#{x}#{x}-x: 1px;'],
    [
      'after a declaration on the same line',
      'color: red; ${side}-top: 0;',
      'color: red; #{x   }-top: 0;',
    ],
    ['with whitespace before the colon', 'padding-${s} : 4px;', 'padding-#{x} : 4px;'],
    ['on its own line', 'color: red;\n${side}-top: 0;', 'color: red;\n#{x   }-top: 0;'],
    [
      'after a name prefix, before "&" later on the line',
      'padding-${s}: 0; &:hover { color: red; }',
      'padding-#{x}: 0; &:hover { color: red; }',
    ],
    [
      'before a name suffix, before "&" later on the line',
      '${s}-top: 0; &:hover { color: red; }',
      '#{x}-top: 0; &:hover { color: red; }',
    ],
    [
      'between name parts, before "&" later on the line',
      'border-${s}-color: red; &:hover { color: red; }',
      'border-#{x}-color: red; &:hover { color: red; }',
    ],
    [
      'after a name prefix, before "{" later on the line',
      'padding-${s}: 0; a { color: red; }',
      'padding-#{x}: 0; a { color: red; }',
    ],
  ])(
    'should read a placeholder joined to a property name %s as a Sass interpolation',
    (_description, value, expected) => {
      const result = performSubstitutions(value)

      assert.strictEqual(result, expected)
      assert.strictEqual(result.length, value.length)
    },
  )

  it.each([
    ['";" then "&"', '${p}: 0; &:hover { color: red; }', '$axx: 0; &:hover { color: red; }'],
    ['";" then "{"', '${p}: 0; a { color: red; }', '$axx: 0; a { color: red; }'],
    [
      '"}" then "&"',
      '&:focus { ${p}: 0 } &:hover { color: red; }',
      '&:focus { $axx: 0 } &:hover { color: red; }',
    ],
  ])(
    'should read a whole property name placeholder as a property name when %s follow on its line',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    ['"&" after a pseudo-class', '${B}:hover & { color: red; }', '&   :hover & { color: red; }'],
    [
      'a pseudo-class function before "{"',
      '${C}:not(.a) { color: red; }',
      '&   :not(.a) { color: red; }',
    ],
    ['a later "{" after "&:hover"', '&:hover ${C} { color: red; }', '&:hover xxxx { color: red; }'],
  ])('should keep a selector placeholder followed by %s', (_description, value, expected) => {
    assert.strictEqual(performSubstitutions(value), expected)
  })

  it('should read a non-ASCII space after a placeholder as a name character, as the CSS scanner does', () => {
    const value = '${a} b: 1px;'

    assert.strictEqual(performSubstitutions(value), '#{x} b: 1px;')
  })

  it('should write the Sass interpolation of a multi-line placeholder joined to a property name over its line breaks', () => {
    const value = 'padding-${\n  s\n}: 4px;'

    assert.strictEqual(performSubstitutions(value), 'padding-#{x    }: 4px;')
  })

  it('should x-fill a placeholder joined to a custom property name, before or after', () => {
    assert.strictEqual(performSubstitutions('--${a}-b: 1px;'), '--xxxx-b: 1px;')
    assert.strictEqual(performSubstitutions('--x-${a}: 1px;'), '--x-xxxx: 1px;')
  })

  it.each([
    ['a value after a name prefix', 'transition: padding-${s} 1s;', 'transition: padding-xxxx 1s;'],
    ['a value before a unit', 'width: ${w}px;', 'width: xxxxpx;'],
    ['a whole property name', '${prop}: 1px;', '$axxxxx: 1px;'],
    [
      'a mixin before a declaration on its own line',
      '${mixin}\n-webkit-x: 1;',
      '        \n-webkit-x: 1;',
    ],
  ])('should leave %s to its own branch', (_description, value, expected) => {
    assert.strictEqual(performSubstitutions(value), expected)
  })

  it.each([
    ['after "and" in @media', '@media screen and ${q} {', '@media screen and (x )'],
    ['after "not all and" in @media', '@media not all and ${q} {', '@media not all and (x )'],
    ['after "or" in @media', '@media (a) or ${q} {', '@media (a) or (x )'],
    [
      'after "and" in a longer placeholder',
      '@media screen and ${query} {',
      '@media screen and (x     )',
    ],
    ['in @media written in capitals', '@MEDIA screen AND ${q} {', '@MEDIA screen AND (x )'],
    ['right after @supports', '@supports ${q} {', '@supports x( )'],
    ['after "not" in @supports', '@supports not ${q} {', '@supports not x( )'],
    [
      'after "and" in @supports',
      '@supports (display: grid) and ${q} {',
      '@supports (display: grid) and x( )',
    ],
    ['after a container name', '@container card ${q} {', '@container card (x )'],
    ['after "and" in @container', '@container card (a) and ${q} {', '@container card (a) and (x )'],
    [
      'after a container name that is a placeholder',
      '@container ${n} ${q} {',
      '@container xxxx (x )',
    ],
    [
      'after a declaration on the same line',
      'color: red; @media screen and ${q} {',
      'color: red; @media screen and (x )',
    ],
    ['on its own line after "and"', '@media screen and\n    ${q} {', '@media screen and\n    (x )'],
    [
      'after "and" at the start of its own line',
      '@media screen\n  and ${q} {',
      '@media screen\n  and (x )',
    ],
    ['on its own line after @supports', '@supports\n  ${q} {', '@supports\n  x( )'],
    [
      'on its own line after a container name',
      '@container card\n  ${q} {',
      '@container card\n  (x )',
    ],
    [
      'on its own line after "and" inside a rule',
      '&:hover {\n  @media screen and\n    ${q} {',
      '&:hover {\n  @media screen and\n    (x )',
    ],
    [
      'after a declaration missing its semicolon on the line before',
      'color: red\n@media screen and ${q} {',
      'color: red\n@media screen and (x )',
    ],
    ['on both sides of "or" in @media', '@media ${q} or ${q} {', '@media (x ) or (x )'],
    ['before "OR" in @media', '@media ${q} OR (a) {', '@media (x ) OR (a)'],
    [
      'in @media after a block comment',
      '/* x */ @media screen and ${q} {',
      '/* x */ @media screen and (x )',
    ],
    [
      'in @media after a line comment on the line before a prelude split over lines',
      'color: red; // x\n  @media screen and\n  ${q} {',
      'color: red; // x\n  @media screen and\n  (x )',
    ],
    [
      'after a comment between "and" and the placeholder',
      '@media screen and /* x */ ${q} {',
      '@media screen and /* x */ (x )',
    ],
  ])(
    'should fill an at-rule condition placeholder %s so it parses as a condition',
    (_description, value, expectedPrefix) => {
      const result = performSubstitutions(`${value} color: red; }`)

      assert.strictEqual(result, `${expectedPrefix} { color: red; }`)
    },
  )

  it('should write the condition fill of a multi-line at-rule condition placeholder over its line breaks', () => {
    const value = '@media screen and ${\n  q\n} { color: red; }'

    assert.strictEqual(performSubstitutions(value), '@media screen and (x     ) { color: red; }')
  })

  it.each([
    [
      'a media type right after @media',
      '@media ${q} { color: red; }',
      '@media xxxx { color: red; }',
    ],
    [
      'a media type before "and"',
      '@media ${q} and (max-width: 2px) {}',
      '@media xxxx and (max-width: 2px) {}',
    ],
    ['each query in a list', '@media ${a}, ${b} {}', '@media xxxx, xxxx {}'],
    [
      'a container name or query right after @container',
      '@container ${q} {}',
      '@container xxxx {}',
    ],
    [
      'a container name before its query',
      '@container ${n} (min-width: 1px) {}',
      '@container xxxx (min-width: 1px) {}',
    ],
    [
      'a placeholder joined to the word before it',
      '@media screen and${q} {}',
      '@media screen andxxxx {}',
    ],
    ['a placeholder after a non-condition at-rule', '@page ${q} {}', '@page xxxx {}'],
    ['a media type on its own line after @media', '@media\n  ${q} {}', '@media\n  xxxx {}'],
    [
      'a value on the line after a finished at-rule prelude',
      '@media screen and (a) { color:\n  ${q}; }',
      '@media screen and (a) { color:\n  xxxx; }',
    ],
    ['a longer at-keyword', '@mediax and ${q} {}', '@mediax and xxxx {}'],
    ['a media type before a word starting with "or"', '@media ${q} orx {}', '@media xxxx orx {}'],
    [
      'a placeholder inside a comment after "and"',
      '@media screen and /* ${q} */ (a) {}',
      '@media screen and /* xxxx */ (a) {}',
    ],
    [
      'a placeholder after an unterminated comment',
      '/* x @media screen and ${q} {}',
      '/* x @media screen and xxxx {}',
    ],
    [
      'a placeholder after a comment between a word that is not a combinator and it',
      '@media screen /* and */ ${q} {}',
      '@media screen /* and */ xxxx {}',
    ],
    /** Only a comment precedes the placeholder, so the at-keyword starts no statement. */
    [
      'a placeholder after an at-keyword inside a line comment',
      '// a; @supports\n${q} {}',
      '// a; @supports\nxxxx {}',
    ],
    /** The line start inside the comment is a statement start, but only a comment precedes the placeholder. */
    [
      'a placeholder after an at-keyword inside a block comment over lines',
      '/* a\n@supports */ ${q} {}',
      '/* a\n@supports */ xxxx {}',
    ],
  ])('should x-fill %s', (_description, value, expected) => {
    assert.strictEqual(performSubstitutions(value), expected)
  })

  it.each([
    [
      'a border value',
      'border:\n    ${a}\n    ${b};\ncolor: red;',
      'border:\n        \n    xxxx;\ncolor: red;',
    ],
    [
      'a grid track list',
      'grid-template-columns:\n  ${a}\n  ${b};',
      'grid-template-columns:\n      \n  xxxx;',
    ],
  ])(
    'should keep %s split over lines a value, not a dummy declaration',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    ['two mixins on separate lines at the template start', '${a}\n${b};', '    \n$a:0;'],
    [
      'a mixin on the next line after a mixin after a declaration',
      'color: red; ${a}\n${b};',
      'color: red;     \n$a:0;',
    ],
  ])('should still pass block position on for %s', (_description, value, expected) => {
    assert.strictEqual(performSubstitutions(value), expected)
  })

  it.each([
    ['a class selector', '&.${cls}:hover { color: red; }', '&.xxxxxx:hover { color: red; }'],
    ['an id selector', '#${id}:hover { color: red; }', '#xxxxx:hover { color: red; }'],
    ['a class name suffix', '&.is-${s}:hover { color: red; }', '&.is-xxxx:hover { color: red; }'],
    ['a parent selector suffix', '&${s}:hover { color: red; }', '&xxxx:hover { color: red; }'],
    ['a name suffix after it', '${B}-x:hover { color: red; }', 'xxxx-x:hover { color: red; }'],
  ])(
    'should x-fill a selector placeholder joined to %s instead of using "&"',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    [
      'on the next line',
      '${B}:not(:last-child)\n  {\n    color: red;\n  }',
      '&   :not(:last-child)\n  {\n    color: red;\n  }',
    ],
    ['after a CRLF', '${B}:hover\r\n{ color: red; }', '&   :hover\r\n{ color: red; }'],
    ['after blank lines', '${B}:hover\n\n  { color: red; }', '&   :hover\n\n  { color: red; }'],
    [
      'on the next line, past a comment',
      '${B}:hover\n  /* note */ { color: red; }',
      '&   :hover\n  /* note */ { color: red; }',
    ],
  ])(
    'should read a placeholder followed by a pseudo-class as a selector when its rule body opens %s',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it('should keep a placeholder followed by a pseudo-class a property name when a string, not a comment, sits before the next line', () => {
    const value = '${B}:hover\n  "note" { color: red; }'

    assert.strictEqual(performSubstitutions(value), '$axx:hover\n  "note" { color: red; }')
  })

  it.each([
    ['a keyframe selector at the template start', '${a}% { opacity: 0; }', '0000% { opacity: 0; }'],
    [
      'a keyframe selector after another keyframe block',
      '0% { opacity: 0; }\n  ${a}% { opacity: 1; }',
      '0% { opacity: 0; }\n  0000% { opacity: 1; }',
    ],
    [
      'a keyframe selector alone on its line',
      '\n  ${a}% { opacity: 0; }',
      '\n  0000% { opacity: 0; }',
    ],
    ['a value alone on its line', 'width:\n  ${a}%;', 'width:\n  0000%;'],
  ])('should fill a placeholder before "%" in %s with zeros', (_description, value, expected) => {
    assert.strictEqual(performSubstitutions(value), expected)
  })

  it.each([
    [
      'another placeholder with a pseudo-class',
      '${C}:hover,\n  ${C}:focus {\n    color: red;\n  }',
      '&   :hover,\n  &   :focus {\n    color: red;\n  }',
    ],
    [
      'a parent selector with a pseudo-class',
      '${C}:hover,\n  &:focus-visible {\n    color: red;\n  }',
      '&   :hover,\n  &:focus-visible {\n    color: red;\n  }',
    ],
    [
      'several lines ending in ","',
      '${C}:hover,\n  ${C}:focus,\n  ${C}:active {',
      '&   :hover,\n  &   :focus,\n  &   :active {',
    ],
    [
      'a line whose rule body opens on the line after it',
      '${C}:hover,\n  ${C}:focus\n  {',
      '&   :hover,\n  &   :focus\n  {',
    ],
    ['a CRLF', '${C}:hover,\r\n  ${C}:focus {', '&   :hover,\r\n  &   :focus {'],
  ])(
    'should read a placeholder with a pseudo-class as a selector when its list continues on the next line with %s',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    ['a selector list of placeholders', '${A},\n${B} {', 'xxxx,\nxxxx {'],
    [
      'a pseudo-class placeholder after a parent selector',
      '&:hover,\n  ${C}:focus {',
      '&:hover,\n  &   :focus {',
    ],
    [
      'a value split over lines after ","',
      'transition:\n  ${a},\n  ${b};',
      'transition:\n  xxxx,\n  xxxx;',
    ],
    ['a font list split over lines', 'font-family: a,\n  ${b};', 'font-family: a,\n  xxxx;'],
    [
      'a property name whose value continues after ","',
      '${p}: a,\n  b;\n  &:hover {',
      '$axx: a,\n  b;\n  &:hover {',
    ],
    [
      'a property name whose value continues after "," before a declaration and a rule on one line',
      '${p}: a,\n  b; &:hover {',
      '$axx: a,\n  b; &:hover {',
    ],
  ])('should keep %s split over lines as it was', (_description, value, expected) => {
    assert.strictEqual(performSubstitutions(value), expected)
  })

  it.each([
    ['a block comment holding ";"', '${A}:hover /* a; b */ {', '&   :hover /* a; b */ {'],
    ['a block comment holding "}"', '${A}:hover /* } */ {', '&   :hover /* } */ {'],
    ['a block comment over lines', '${A}:hover /* a;\n b */ {', '&   :hover /* a;\n b */ {'],
    ['a line comment holding ";"', '${A}:hover // a; b\n{', '&   :hover // a; b\n{'],
    ['a double-quoted string holding ";"', '${A}:not([x="a;b"]) {', '&   :not([x="a;b"]) {'],
    ["a single-quoted string holding '}'", "${A}:not([x='a}b']) {", "&   :not([x='a}b']) {"],
    [
      'a string holding "//" and ";"',
      '${A}:not([x^="http://a;b"]) {',
      '&   :not([x^="http://a;b"]) {',
    ],
    ['an unquoted url() holding ";" and "}"', '${A}:is(url(a;}b)) {', '&   :is(url(a;}b)) {'],
    [
      'a comment holding ";" in a selector list on one line',
      '${A}:hover, /* a; b */ ${B}:focus {',
      '&   :hover, /* a; b */ &   :focus {',
    ],
    [
      'a comment after the "," that ends a selector list line',
      '${A}:hover, /* a; b */\n  ${B}:focus {',
      '&   :hover, /* a; b */\n  &   :focus {',
    ],
    [
      'a line comment after the "," that ends a selector list line',
      '${A}:hover, // a; b\n  ${B}:focus {',
      '&   :hover, // a; b\n  &   :focus {',
    ],
    [
      'a line comment after the "," that ends a selector list line, with a CRLF',
      '${A}:hover, // a; b\r\n  ${B}:focus {',
      '&   :hover, // a; b\r\n  &   :focus {',
    ],
    [
      'a comment holding ";" on a selector list line',
      '${A}:hover,\n  /* a; b */ ${B}:focus {',
      '&   :hover,\n  /* a; b */ &   :focus {',
    ],
    [
      'a comment holding ";" after a placeholder joined to a class name',
      '&.${v}:hover /* a; b */ {',
      '&.xxxx:hover /* a; b */ {',
    ],
  ])(
    'should read a placeholder with a pseudo-class as a selector past %s',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    ['a comment', '${A}: 0 /* c */; &:hover {', '$axx: 0 /* c */; &:hover {'],
    ['a string', '${A}: "a" ; &:hover {', '$axx: "a" ; &:hover {'],
    ['a comment, before "}"', '${A}: 0 /* { */ } &:hover {', '$axx: 0 /* { */ } &:hover {'],
    [
      'a line comment, before a line break',
      '${A}: red // c\n&:hover {',
      '$axx: red // c\n&:hover {',
    ],
    [
      'a line comment after ",", on a value continued over lines',
      '${A}: a, // c\n  b;\n&:hover {',
      '$axx: a, // c\n  b;\n&:hover {',
    ],
  ])(
    'should keep a placeholder a property name when a real ";" or "}" follows %s',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  /**
   * A comment after the "," leaves "," the line's last code character, so the list continues and
   * `b {` makes a selector; anything else there ends the list at the line break, and a next line
   * that does not start with "{" makes a property name.
   */
  it.each([
    ['a double-quoted string', '${A}:hover, "a"\n  b {', '$axx:hover, "a"\n  b {'],
    [
      'a single-quoted string, before a CRLF',
      "${A}:hover, 'a'\r\n  b {",
      "$axx:hover, 'a'\r\n  b {",
    ],
    ['an unquoted url()', '${A}:hover, url(a)\n  b {', '$axx:hover, url(a)\n  b {'],
    ['a CSS-escaped ","', '${A}:hover, \\\\,\n  b {', '$axx:hover, \\\\,\n  b {'],
    ['a block comment', '${A}:hover, /* a */\n  b {', '&   :hover, /* a */\n  b {'],
  ])(
    'should read a line ending in %s after its "," as a selector list line only for a comment',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    ['an unterminated block comment', 'a: 0 /* \n  ${m}', 'a: 0 /* \n  xxxx'],
    ['an unterminated block comment, after a ";" in it', 'a: 0 /* ;\n  ${m}', 'a: 0 /* ;\n  xxxx'],
  ])(
    'should fill a placeholder on its own line inside %s with x',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    ['a double-quoted string holding "{"', '${A}: "a{b";', '$axx: "a{b";'],
    ["a single-quoted string holding '&'", "${A}: 'a&b';", "$axx: 'a&b';"],
    ['a block comment holding "{"', '${A}: 0 /* { */;', '$axx: 0 /* { */;'],
    ['a block comment holding "&"', '${A}: 0 /* & */;', '$axx: 0 /* & */;'],
    ['a line comment holding "{"', '${A}: 0 // {\n;', '$axx: 0 // {\n;'],
    ['an unquoted url() holding "{" and "&"', '${A}: url(a{&b);', '$axx: url(a{&b);'],
  ])(
    'should keep a placeholder a property name when its only "{" or "&" is inside %s',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    [
      'a comment holding ";" on its line',
      '@media screen and /* a; b */ ${q} {',
      '@media screen and /* a; b */ (x ) {',
    ],
    [
      'a comment holding ";" on the line before',
      '@media screen and\n/* a; b */ ${q} {',
      '@media screen and\n/* a; b */ (x ) {',
    ],
    [
      'a string holding ";"',
      '@supports (content: "a;b") and ${q} {',
      '@supports (content: "a;b") and x( ) {',
    ],
    [
      'an unquoted url() holding "}"',
      '@supports (background: url(a}b)) and ${q} {',
      '@supports (background: url(a}b)) and x( ) {',
    ],
  ])(
    'should read an at-rule condition placeholder after %s as a condition',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it('should keep a placeholder followed by a colon a property name when the next line starts with other text', () => {
    assert.strictEqual(performSubstitutions('${p}: red\ncolor: blue;'), '$axx: red\ncolor: blue;')
  })

  it('should skip a comment between a placeholder and the ":" that follows it, keeping it a property name the same as without the comment', () => {
    const control = '${p}: red;'
    const withComment = '${p} /* note */: red;'

    assert.strictEqual(performSubstitutions(control), '$axx: red;')
    assert.strictEqual(performSubstitutions(withComment), '$axx /* note */: red;')
  })

  it('should treat a string between a placeholder and the ":" that follows it as significant, not skip it like a comment', () => {
    const value = '${p} "note": red;'

    assert.strictEqual(performSubstitutions(value), '     "note": red;')
  })

  it('should skip a comment between a placeholder joined to a name and the ":" that follows it, keeping the joined-name fill the same as without the comment', () => {
    const control = '${side}-top: 0;'
    const withComment = '${side}-top /* note */: 0;'

    assert.strictEqual(performSubstitutions(control), '#{x   }-top: 0;')
    assert.strictEqual(performSubstitutions(withComment), '#{x   }-top /* note */: 0;')
  })

  it('should treat a string after a placeholder joined to a name as significant, not skip it like a comment', () => {
    const value = '${side}-top "note": 0;'

    assert.strictEqual(performSubstitutions(value), '       -top "note": 0;')
  })

  /**
   * A comment anywhere makes every scan read the text with the boundary scanner; one after the
   * last placeholder changes no decision before it, so each shape reads as it does without one.
   */
  it.each([
    ['a selector list over lines', '${C}:hover,\n  ${C}:focus {', '&   :hover,\n  &   :focus {'],
    [
      'a selector list over a CRLF',
      '${C}:hover,\r\n  ${C}:focus {',
      '&   :hover,\r\n  &   :focus {',
    ],
    ['a value continued after ","', '${p}: a,\n  b;\n  &:hover {', '$axx: a,\n  b;\n  &:hover {'],
    [
      'a joined property name before a rule',
      'padding-${s}: 0; &:hover {',
      'padding-#{x}: 0; &:hover {',
    ],
    [
      'a mixin after a closing brace',
      'a { color: red; } ${m}\nb: 0;',
      'a { color: red; }     \nb: 0;',
    ],
    ['a mixin inside a one-line rule body', '&:hover { ${m} }', '&:hover {      }'],
    ['two mixins after a declaration line', 'color: red;\n${a} ${b}\n', 'color: red;\n         \n'],
    [
      'a condition after a statement',
      'a: 0; @media screen and ${q} {',
      'a: 0; @media screen and (x ) {',
    ],
    [
      'a condition after a closing brace',
      'a { } @media screen and ${q} {',
      'a { } @media screen and (x ) {',
    ],
    ['a custom property name after a closing brace', 'a { } --x-${p}: 0;', 'a { } --x-xxxx: 0;'],
  ])(
    'should substitute %s the same when a comment follows the last placeholder',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
      assert.strictEqual(performSubstitutions(`${value} /* c */`), `${expected} /* c */`)
    },
  )

  it.each([
    ['";"', 'background: url(a;${x}) no-repeat;', 'background: url(a;xxxx) no-repeat;'],
    ['"{"', 'background: url(a{${x}) no-repeat;', 'background: url(a{xxxx) no-repeat;'],
  ])(
    'should read a placeholder inside a url() after %s as part of the url, not a mixin',
    (_description, template, expected) => {
      assert.strictEqual(performSubstitutions(template), expected)
    },
  )

  /**
   * At runtime the interpolated value holds none of the placeholder's source line breaks, so one
   * that starts inside a comment, string, or unquoted url() argument fills its whole length with
   * "x", line terminators included, in the masked text as in the output (docs/architecture.md,
   * substitution invariants).
   */
  it.each([
    [
      'an unquoted url() argument, across a line feed',
      'background: url(${\n  x\n});',
      'background: url(xxxxxxxx);',
    ],
    [
      'an unquoted url() argument, across a CRLF',
      'background: url(${\r\n  x\r\n});',
      'background: url(xxxxxxxxxx);',
    ],
    [
      'an unquoted url() argument, across a line separator',
      'background: url(${\u2028  x\u2028});',
      'background: url(xxxxxxxx);',
    ],
    [
      'an unquoted url() argument, across a paragraph separator',
      'background: url(${\u2029  x\u2029});',
      'background: url(xxxxxxxx);',
    ],
    [
      'a url-prefix() argument',
      'background: url-prefix(${\n  x\n});',
      'background: url-prefix(xxxxxxxx);',
    ],
    ['a url() argument after "#"', 'fill: url(#${\n  id\n});', 'fill: url(#xxxxxxxxx);'],
    ['a url() argument after "#", on one line', 'fill: url(#${id});', 'fill: url(#xxxxx);'],
    [
      'a url() argument after its own line break',
      'background: url(\n  ${\n  x\n}\n);',
      'background: url(\n  xxxxxxxx\n);',
    ],
    ['a quoted url() argument', 'background: url("${\n  x\n}");', 'background: url("xxxxxxxx");'],
    ['a double-quoted string', 'content: "${\n  x\n}";', 'content: "xxxxxxxx";'],
    ['a single-quoted string', "content: '${\n  x\n}';", "content: 'xxxxxxxx';"],
    [
      'a string holding two placeholders',
      'content: "${\n  a\n} ${\n  b\n}";',
      'content: "xxxxxxxx xxxxxxxx";',
    ],
    [
      'a string before a mixin on its line, which stays a mixin',
      'content: "${\n  a\n}"; ${mixin}\ncolor: red;',
      'content: "xxxxxxxx";         \ncolor: red;',
    ],
    ['a line comment', '// ${\n  a\n} note\ncolor: red;', '// xxxxxxxx note\ncolor: red;'],
    ['a block comment', '/* ${\n  x\n} */\ncolor: red;', '/* xxxxxxxx */\ncolor: red;'],
  ])(
    'should fill a placeholder inside %s with x over its whole length (#13)',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it.each([
    [
      'an escaped run, whose backslash may escape the placeholder itself',
      '\\${\n  p\n}: 1px;',
      '\\$axxxxxx: 1px;',
    ],
    [
      'code, on a line of its own',
      'a: b;\n${\n  m\n}\ncolor: red;',
      'a: b;\n        \ncolor: red;',
    ],
  ])(
    'should give a placeholder in %s its usual fill, not the solid fill',
    (_description, value, expected) => {
      assert.strictEqual(performSubstitutions(value), expected)
    },
  )

  it('should replace placeholder used in child selector (#75)', () => {
    assert.deepEqual(
      performSubstitutions(
        ['position: relative;', '> ${FlipContainer}:hover {', '   color: red;', '}'].join('\n'),
      ),
      ['position: relative;', '> &               :hover {', '   color: red;', '}'].join('\n'),
    )
  })
})

function performSubstitutions(value: string) {
  return getTemplateSubstitutions(value, getSpans(value))
}

function getSpans(value: string) {
  return Array.from(value.matchAll(/\$\{[^}]*\}/g), (match) => ({
    end: match.index + match[0].length,
    start: match.index,
  }))
}
