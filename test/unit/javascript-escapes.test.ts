import { assert, describe, it } from 'vitest'

import {
  getTemplateCssText,
  getTemplateEscapeRuns,
  replaceJavaScriptEscapes,
} from '../../src/virtual-document/javascript-escapes'

/**
 * Each input is raw template source text: a backslash here is a JavaScript escape, as in a
 * template literal. BACKSLASH builds the `\u` forms so no Unicode escape is read by this file's own
 * parser.
 */
const BACKSLASH = String.fromCharCode(92)

describe('replaceJavaScriptEscapes', () => {
  it.each([
    ['an escaped double quote', 'content: \\"x\\";', 'content:  "x ";'],
    ['an escaped single quote', "content: \\'x\\';", "content:  'x ';"],
    ['two escaped backslashes in a row', '\\\\\\\\b', '  \\\\b'],
    ['an escaped backtick', 'content: "\\`";', 'content: " `";'],
    ['an escaped dollar sign before a brace', 'content: "\\${x}";', 'content: " ${x}";'],
    ['a character that needs no escape', '\\a', ' a'],
    ['an escaped surrogate pair', '\\😀', ' 😀'],
    ['a hex escape', '\\x41', '   A'],
    ['a four-digit Unicode escape', `${BACKSLASH}u00e9`, '     é'],
    ['a code point escape', `${BACKSLASH}u{1F600}`, '       😀'],
    [
      'a surrogate pair written as two escapes',
      `${BACKSLASH}uD83D${BACKSLASH}uDE00`,
      '          😀',
    ],
    ['a character that does not continue the name before it', 'a\\;b', 'a ;b'],
  ])('should write %s as its cooked character, right-aligned', (_description, raw, expected) => {
    const result = replaceJavaScriptEscapes(raw)

    assert.strictEqual(result, expected)
    assert.strictEqual(result.length, raw.length)
  })

  /**
   * A cooked backslash escapes the character after it, as a CSS escape. Where CSS allows, the
   * stand-in spends the padding inside that escape instead of as a space that would split the
   * name or url() around it: as leading zeros of a hex escape, or as the escaped character's own
   * hex code. Otherwise the padding moves in front of the name the escape sits in, or is a space
   * before the backslash when no name comes before it.
   */
  it.each([
    ['a hex code point in a string', '"\\\\f101"', '"\\0f101"'],
    ['a one-digit hex escape in a url()', 'url(a\\\\b.png)', 'url(a\\0b.png)'],
    ['a hex escape followed by a space', '\\\\31 0', '\\031 0'],
    ['a letter inside a name', 'u\\\\rl(', 'u\\72l('],
    ['a quote before a non-hex character', '"a\\\\":b"', '"a\\22:b"'],
    ['a character after three backslashes', 'a\\\\\\\\\\\\:x', 'a\\\\\\003ax'],
    ['a colon before a hex digit, which a hex escape would absorb', '.md\\\\:flex', ' .md\\:flex'],
    ['a colon before a space, which a hex escape would absorb', 'a\\\\: b', ' a\\: b'],
    ['a character at the end of the text', 'a\\\\@', ' a\\@'],
    ['a character before another escape', 'u\\\\r\\\\l', '  u\\r\\l'],
    ['six hex digits, too many to take a leading zero', '\\\\abcdef', ' \\abcdef'],
    ['a line break, which CSS does not escape', 'a\\\\\nb', ' a\\\nb'],
    ['a character whose code fits in two hex digits', '\\\\é!', '\\e9!'],
    ['a character whose code needs more hex digits than the room', '\\\\中!', ' \\中!'],
    ['hex digits a later run continues', '"\\\\4\\x31"', '"\\000041"'],
    /** Joined, the zeros and digits would pass six, so each run keeps its own stand-in. */
    ['hex digits a later run continues past six', 'x\\\\fa\\x34;', 'x\\0fa\\034;'],
  ])('should write an escaped backslash before %s', (_description, raw, expected) => {
    const result = replaceJavaScriptEscapes(raw)

    assert.strictEqual(result, expected)
    assert.strictEqual(result.length, raw.length)
  })

  /**
   * Inside an unquoted url() a space would split the url token, so where the escape cannot absorb
   * the padding, the padding becomes "_", a character a url token holds, after the cooked text and
   * before a trailing backslash.
   */
  it.each([
    ['a paren before a hex digit', 'url(a\\\\(b\\\\).png)', 'url(a_\\(b\\29.png)'],
    ['a paren before a hex digit after leading whitespace', 'url( a\\\\(b)', 'url( a_\\(b)'],
    ['two parens before hex digits', 'url(a\\\\(b\\\\(c)', 'url(a_\\(b_\\(c)'],
    ['a url-prefix() argument', 'url-prefix(a\\\\(b)', 'url-prefix(a_\\(b)'],
    ['a url() written in capitals', 'URL(a\\\\(b)', 'URL(a_\\(b)'],
    ['a letter after "/"', 'url(a/\\x41y.png)', 'url(a/A___y.png)'],
    ['a letter after "."', 'url(a.\\x41)', 'url(a.A___)'],
    ['a name at the start of the argument', 'url(a\\x62.png)', 'url(ab___.png)'],
    ['a name after "/"', 'url(x/a\\x62.png)', 'url(x/ab___.png)'],
    ['a name after ","', 'url(a,b\\x63.png)', 'url(a,bc___.png)'],
    ['a name after ";"', 'url(a;b\\x63.png)', 'url(a;bc___.png)'],
    ['a run of a non-name character', 'url(a\\x2Fb.png)', 'url(a/___b.png)'],
    ['two runs in one name', 'url(a\\x62c\\x64.png)', 'url(ab___cd___.png)'],
    ['a line continuation before a line feed', 'url(foo\\\nbar.png)', 'url(foo__bar.png)'],
    ['a line continuation before a CRLF', 'url(foo\\\r\nbar.png)', 'url(foo___bar.png)'],
    /**
     * A character JavaScript's `\s` matches but CSS does not count as whitespace is url content, so
     * the run after it is still inside the argument.
     */
    [
      'a run after a cooked U+3000',
      `url(a${BACKSLASH}u3000,${BACKSLASH}x41)`,
      `url(a${String.fromCharCode(0x3000)}_____,A___)`,
    ],
    [
      'a run after a cooked U+00A0',
      'url(a\\xA0,\\x41)',
      `url(a${String.fromCharCode(0xa0)}___,A___)`,
    ],
    [
      'a run after a cooked U+FEFF',
      `url(a${BACKSLASH}uFEFF,${BACKSLASH}x41)`,
      `url(a${String.fromCharCode(0xfeff)}_____,A___)`,
    ],
    [
      'a run after a cooked U+0085',
      'url(a\\x85,\\x41)',
      `url(a${String.fromCharCode(0x85)}___,A___)`,
    ],
    /** A quote, paren, or whitespace a CSS escape takes is url content too. */
    ['a run after a CSS-escaped double quote', 'url(a\\\\"b\\x41)', 'url(a_\\"bA___)'],
    ['a run after a CSS-escaped single quote', "url(a\\\\'b\\x41)", "url(a_\\'bA___)"],
    [
      'a run after a quote a hex-escaped backslash escapes',
      'url(a\\x5c"b\\x41)',
      'url(a___\\"bA___)',
    ],
    [
      'a run after a paren a hex-escaped backslash escapes',
      'url(a\\x5c)b\\x41)',
      'url(a___\\)bA___)',
    ],
    [
      'a run after a CSS-escaped quote inside the cooked text',
      'url(a\\\\\\"b\\x41)',
      'url(a\\"__bA___)',
    ],
    ['a run after a CSS-escaped space', 'url(a\\\\ b\\x41)', 'url(a_\\ bA___)'],
    ['a run after the space a hex escape takes', 'url(a\\\\41 b\\x41)', 'url(a\\041 bA___)'],
    /** A hex escape takes the cooked line break after its digits, so the fill follows that line break. */
    [
      'a run whose hex escape takes its cooked line break',
      'url(\\x5c\\x31\\n\\\\f)',
      'url(\\1 ________\\f)',
    ],
    /**
     * A CSS hex escape a run continues takes all its digits and the whitespace after them, so the
     * padding goes where it splits neither: as leading zeros after the backslash while the escape
     * stays within six hex digits, and otherwise as "_" before the backslash.
     */
    ['a hex escape a later run continues', 'url(a\\\\4\\x31 b\\x41)', 'url(a\\000041 bA___)'],
    [
      'a hex escape a later run continues past six digits with the zeros',
      'url(a\\\\4\\x31\\x32 b\\x41)',
      'url(a_______\\412 bA___)',
    ],
    [
      'a five-digit hex escape a later run continues',
      'url(a\\\\1234\\x35 b\\x41)',
      'url(a____\\12345 bA___)',
    ],
    [
      'a hex escape written whole by one run',
      'url(a\\\\\\x34\\x31 b\\x41)',
      'url(a_______\\41 bA___)',
    ],
  ])(
    'should pad an escape inside an unquoted url() with "_" for %s',
    (_description, raw, expected) => {
      const result = replaceJavaScriptEscapes(raw)

      assert.strictEqual(result, expected)
      assert.strictEqual(result.length, raw.length)
    },
  )

  /**
   * Padding written after a run's own cooked whitespace would let the CSS scanner end the url token
   * at that whitespace and read the padding as a second, invalid token (vscode-css-languageservice's
   * `_unquotedChar`, cssScanner.js, excludes whitespace, quotes, and parens from an unquoted url()
   * character, so any of them ends the token there; `_parseURLArgument` then accepts only one token
   * before requiring the closing paren). The padding goes before the run's own trailing whitespace
   * instead, so it stays part of the token the whitespace ends. A cooked quote opening the argument's
   * first content (nothing but whitespace precedes it back to the "(") makes the whole argument a
   * quoted string, which `_parseURLArgument` tries before an unquoted one: the padding is spaces
   * outside url() and out of the fill.
   */
  it.each([
    ['a run that cooks to a trailing line break', 'url(x\\n)', 'url(x_ )'],
    ['a run that cooks to a trailing space', 'url(a.png\\x20)', 'url(a.png___ )'],
    ['a run that cooks to a trailing line break, after another', 'url(a\\n)', 'url(a_ )'],
    ['a quote opening the argument right after "("', 'url(\\x22\\x22)', 'url(      "")'],
    [
      'a run that cooks to leading whitespace only, with real content later in the same run',
      'url(\\x204a)',
      'url(    4a)',
    ],
  ])('should keep a valid unquoted url() valid for %s', (_description, raw, expected) => {
    const result = replaceJavaScriptEscapes(raw)

    assert.strictEqual(result, expected)
    assert.strictEqual(result.length, raw.length)
  })

  it.each([
    ['a quoted url()', 'url("a\\\\(b")', 'url("a \\(b")'],
    ['a function whose name only ends in url', 'image-url(a\\\\(b)', 'image-url( a\\(b)'],
    ['a function whose name ends in url after a non-ASCII letter', 'äurl(a\\\\(b)', 'äurl( a\\(b)'],
    ['a url() closed before the escape', 'url(a) b\\\\(c', 'url(a)  b\\(c'],
    ['a url() argument with whitespace inside it', 'url(a b\\\\(c)', 'url(a  b\\(c)'],
    ['a paren that is not a url()', 'x(a\\\\(b)', 'x( a\\(b)'],
    ['a url name after "#", a hash', '#url(a,b\\x41)', '#url(a,   bA)'],
    /** A url function name must be written literally, so a name spelled with an escape opens no url(). */
    ['a url name spelled with an escape', 'u\\x72l(a,b\\x41)', '   url(a,   bA)'],
    ['a url name spelled with a CSS escape', 'u\\\\rl(a,b\\x41)', 'u\\72l(a,   bA)'],
    ['a url name joined to an escape run before it', '\\x20url(a,b\\x41)', '    url(a,   bA)'],
    /** The cooked text of an earlier run ends the argument: a runtime url() breaks there too. */
    ['a url() whose earlier run cooks to a space', 'url(a\\x20,\\x41)', 'url(a___ ,   A)'],
    [
      'a url() whose earlier run cooks to a vertical tab, written as a space',
      'url(a\\x0B,\\x41)',
      'url(a___ ,   A)',
    ],
    ['a url() whose earlier run cooks to an unescaped quote', 'url(a\\",\\x41)', 'url(a"_,   A)'],
    [
      'a url() whose earlier run ends with a backslash before a line break',
      'url(a\\\\\n,\\x41)',
      'url(a_\\\n,   A)',
    ],
    ['a url() with two spaces after a hex escape', 'url(a\\\\41  b\\x41)', 'url(a\\041     bA)'],
  ])(
    'should pad an escape with a space outside an unquoted url(), in %s',
    (_description, raw, expected) => {
      const result = replaceJavaScriptEscapes(raw)

      assert.strictEqual(result, expected)
      assert.strictEqual(result.length, raw.length)
    },
  )

  /**
   * An escape run inside a name keeps the name one identifier with its cooked spelling: the padding
   * moves in front of the name, where whitespace changes nothing.
   */
  it.each([
    ['a letter inside a property name', 'co\\x6Cr: red;', '   colr: red;'],
    ['a letter inside a known property name', 'ba\\x63kground: red;', '   background: red;'],
    ['a letter before a hex digit', 'bor\\x64er: 0;', '   border: 0;'],
    ['a letter inside a value keyword', 'color: r\\x65d;', 'color:    red;'],
    ['a Unicode escape inside a name', `r${BACKSLASH}u0065d`, '     red'],
    ['two runs inside one name', '\\x63ol\\x6Fr', '      color'],
    ['a digit inside a number', '1\\x30px', '   10px'],
    ['a hex color', 'color: #f\\x66f;', 'color:    #fff;'],
    ['a class name', '.bt\\x6E {', '   .btn {'],
    ['an at-keyword', '@me\\x64ia', '   @media'],
    ['"!important"', 'red !imp\\x6Frtant', 'red    !important'],
    ['a name after an escaped CSS colon', '.md\\\\:fl\\x65x', '    .md\\:flex'],
    ['a name after "("', 'var(--a\\x62)', 'var(   --ab)'],
    /**
     * A run that cooks to exactly "(" right after a name opens that name as a function call: url()
     * and url-prefix() specifically require no whitespace before the "(" (unlike a general function,
     * which tolerates it), so the padding moves in front of the name instead of staying between the
     * name and the call.
     */
    ['a url() name right before a cooked "("', 'url\\x28a)', '   url(a)'],
    ['a general function name right before a cooked "("', 'rgb\\x28 0,0,0)', '   rgb( 0,0,0)'],
  ])('should move the padding in front of %s', (_description, raw, expected) => {
    const result = replaceJavaScriptEscapes(raw)

    assert.strictEqual(result, expected)
    assert.strictEqual(result.length, raw.length)
  })

  /**
   * Where whitespace in front of the name would split a larger token (`&.a`, `a:hover`), the last
   * cooked character becomes a CSS hex escape that fills the padding instead, ended by a space when
   * the character after it would continue or end the hex digits.
   */
  it.each([
    ['a class joined to "&", before a non-hex character', '&.bt\\x6E{', '&.bt\\06e{'],
    ['a class joined to "&", before a hex digit', '&.bor\\x64er{', '&.bor\\64 er{'],
    ['a pseudo-class', 'a:ho\\x76er', 'a:ho\\76 er'],
    ['a value right after ":"', 'color:r\\x65d;', 'color:r\\65 d;'],
    ['a non-ASCII letter', `&.a${BACKSLASH}u00e9b`, '&.a\\00e9 b'],
    ['a name inside a string', '"a\\x62"', '"a\\062"'],
  ])('should write a CSS hex escape for %s', (_description, raw, expected) => {
    const result = replaceJavaScriptEscapes(raw)

    assert.strictEqual(result, expected)
    assert.strictEqual(result.length, raw.length)
  })

  /** An escaped digit starts an identifier rather than continuing a number or hash, and an astral character's code does not fit. */
  it.each([
    ['a hash right after ":"', 'color:#f\\x66f;', 'color:#f   ff;'],
    ['a number right after ":"', 'margin:1\\x30px;', 'margin:1   0px;'],
    ['a character outside the Basic Multilingual Plane', `&.a${BACKSLASH}u{1F600}`, '&.a       😀'],
  ])('should leave the padding before the cooked text for %s', (_description, raw, expected) => {
    const result = replaceJavaScriptEscapes(raw)

    assert.strictEqual(result, expected)
    assert.strictEqual(result.length, raw.length)
  })

  it.each([
    ['a line feed', '\\n'],
    ['a carriage return', '\\r'],
    ['a tab', '\\t'],
    ['a vertical tab', '\\v'],
    ['a form feed', '\\f'],
    ['a backspace', '\\b'],
    ['a null character', '\\0'],
    ['a hex-escaped control character', '\\x1b'],
    ['an escaped line separator', `${BACKSLASH}u2028`],
    ['an escaped paragraph separator', `${BACKSLASH}u2029`],
  ])('should write %s as spaces', (_description, escape) => {
    const raw = `a${escape}b`

    assert.strictEqual(replaceJavaScriptEscapes(raw), `a${' '.repeat(escape.length)}b`)
  })

  it.each([
    ['a line feed', '\n'],
    ['a CRLF', '\r\n'],
    ['a lone carriage return', '\r'],
    ['a line separator', String.fromCharCode(0x2028)],
    ['a paragraph separator', String.fromCharCode(0x2029)],
  ])('should write a line continuation before %s as spaces', (_description, lineBreak) => {
    const raw = `color: red;\\${lineBreak}margin: 0;`

    assert.strictEqual(
      replaceJavaScriptEscapes(raw),
      `color: red;${' '.repeat(1 + lineBreak.length)}margin: 0;`,
    )
  })

  it.each([
    ['a digit other than zero', '\\1'],
    ['zero followed by a digit', '\\01'],
    ['a hex escape with one digit', '\\x4g'],
    ['a four-digit Unicode escape with three digits', `${BACKSLASH}u12g4`],
    ['a code point escape past U+10FFFF', `${BACKSLASH}u{110000}`],
    ['an empty code point escape', `${BACKSLASH}u{}`],
    ['an unclosed code point escape', `${BACKSLASH}u{41`],
  ])('should leave an invalid escape, %s, as written', (_description, raw) => {
    assert.strictEqual(replaceJavaScriptEscapes(`a${raw};`), `a${raw};`)
  })

  it('should keep reading escapes after an invalid one', () => {
    assert.strictEqual(replaceJavaScriptEscapes('\\1\\"x'), '\\1 "x')
  })

  it('should return text with no backslash unchanged', () => {
    const text = 'color: red; content: "é";'

    assert.strictEqual(replaceJavaScriptEscapes(text), text)
  })

  it('should keep a backslash at the very end of the text as written', () => {
    assert.strictEqual(replaceJavaScriptEscapes('a\\'), 'a\\')
  })
})

describe('getTemplateCssText', () => {
  function createCountingContext(text: string) {
    const context = {
      reads: 0,
      get text() {
        context.reads++
        return text
      },
    }
    return context
  }

  it('should replace the escapes of a template context once, however often it is asked', () => {
    const context = createCountingContext('content: \\"x\\";')

    assert.strictEqual(getTemplateCssText(context), 'content:  "x ";')
    assert.strictEqual(getTemplateCssText(context), 'content:  "x ";')
    assert.strictEqual(context.reads, 1)
  })

  it('should answer each template context from its own text', () => {
    const first = createCountingContext('a\\;')
    const second = createCountingContext('b\\;')

    assert.deepEqual([getTemplateCssText(first), getTemplateCssText(second)], ['a ;', 'b ;'])
  })
})

describe('getTemplateEscapeRuns', () => {
  it.each([
    ['one run of adjacent escapes', ';\\x41\\x42b', [{ end: 9, start: 1 }]],
    /** The padding moves in front of `co`, so the run covers the name before it too. */
    ['a run inside a name', 'co\\x6Cr', [{ end: 6, start: 0 }]],
    ['two runs inside one name, as one', '\\x63ol\\x6Fr', [{ end: 10, start: 0 }]],
    ['a hex escape stand-in', '&.bt\\x6E{', [{ end: 8, start: 4 }]],
    [
      'two runs apart',
      '\\"x\\"',
      [
        { end: 2, start: 0 },
        { end: 5, start: 3 },
      ],
    ],
    /** The stand-in `\72` takes the "r" after the run too, so the run ends after it. */
    ['a run whose stand-in takes the escaped character', 'u\\\\rl(', [{ end: 4, start: 1 }]],
    /** The stand-in `\000041` covers the first run, the raw "4", and the run that continues the hex escape. */
    ['runs joined by one CSS hex escape', 'url(a\\\\4\\x31 b)', [{ end: 12, start: 5 }]],
    /** Inside a url() argument the padding follows the cooked text, so the run covers itself alone. */
    ['a run inside a url() argument', 'url(co\\x6Cr)', [{ end: 10, start: 6 }]],
    /**
     * `äurl` is a different function name, so the run is no url content: the padding moves in front
     * of `co`, and the run covers that name too.
     */
    [
      'a run after a function name that only ends in url',
      'äurl(co\\x6Cr)',
      [{ end: 11, start: 5 }],
    ],
    ['an invalid escape, which stays as written', 'a\\1;', []],
    ['no escape', 'color: red;', []],
  ])('should record %s', (_description, text, expected) => {
    assert.deepEqual(getTemplateEscapeRuns({ text }), expected)
  })
})
