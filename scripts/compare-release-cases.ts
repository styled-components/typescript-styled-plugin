/**
 * Default cases for scripts/compare-release.ts: shapes whose diagnostics, completions, or code
 * fixes changed on purpose since the last release, so a run shows each difference next to what
 * the release did. The format is documented in docs/maintenance.md, "Comparing with a release".
 */

export interface CompareCase {
  readonly code: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly ext?: string
  readonly name: string
  readonly ops?: readonly CompareOperation[]
}

export type CompareOperation =
  | { readonly at: string; readonly op: 'comp'; readonly show?: number }
  | { readonly at: string; readonly op: 'hover' }
  | { readonly configuration: unknown; readonly op: 'configure' }
  | { readonly from: string; readonly op: 'change'; readonly text: string; readonly to?: string }
  | { readonly op: 'diag' }
  | { readonly op: 'fix' }
  | { readonly op: 'fold' }

const HEADER = "import styled, { css, keyframes } from 'styled-components'\n"

function diagnosticsCase(name: string, body: string): CompareCase {
  return { code: HEADER + body, name, ops: [{ op: 'diag' }, { op: 'fix' }] }
}

const SELECTOR_STOP_DECLARATIONS =
  "import { createGlobalStyle } from 'styled-components'\ndeclare const Link: string, Other: string, p: string, q: string, v: string\n"

/**
 * A ";", "{", "}", or "&" inside a comment, string, or unquoted url() argument between a
 * placeholder's ":" and what follows, which must not decide whether the placeholder is a selector
 * or a property name.
 */
function selectorStopCases(): CompareCase[] {
  const rule = '${Link}:hover /* a; b */ { color: red; }'
  const entries: ReadonlyArray<readonly [string, string]> = [
    ['block comment holding ";"', 'styled.div`${Link}:hover /* nav; link */ { color: red; }`'],
    ['block comment holding "}"', 'styled.div`${Link}:hover /* } */ { color: red; }`'],
    ['line comment holding ";"', 'styled.div`\n  ${Link}:hover // nav; link\n  { color: red; }\n`'],
    ['double-quoted string holding ";"', 'styled.div`${Link}:not([data-x="a;b"]) { color: red; }`'],
    ["single-quoted string holding '}'", "styled.div`${Link}:not([data-x='a}b']) { color: red; }`"],
    [
      'string holding "//" and ";"',
      'styled.div`${Link}:not([href^="http://a;b"]) { color: red; }`',
    ],
    [
      'selector list with a comment holding ";"',
      'styled.div`${Link}:hover, /* a; b */ ${Other}:focus { color: red; }`',
    ],
    [
      'selector list whose line ends in "," and a line comment',
      'styled.div`\n  ${Link}:hover, // first\n  ${Other}:focus {\n    color: red;\n  }\n`',
    ],
    ['placeholder joined to a class name', 'styled.div`&.${v}:hover /* a; b */ { color: red; }`'],
    ['css fragment', `css\`${rule}\``],
    ['createGlobalStyle', `createGlobalStyle\`body { ${rule} }\``],
    ['nested block', `styled.div\`&:focus { ${rule} }\``],
    ['@media body', `styled.div\`@media (min-width: 1px) { ${rule} }\``],
    ['@supports body', `styled.div\`@supports (display: grid) { ${rule} }\``],
    ['property name before a string holding "{"', 'styled.div`${p}: "a{b"; color: red;`'],
    ['property name before a comment holding "&"', 'styled.div`${p}: 0 /* & */; color: red;`'],
    ['property name before a url() holding "{"', 'styled.div`${p}: url(a{b.png); color: red;`'],
    [
      'media condition after a comment holding ";"',
      'styled.div`@media screen and /* a; b */ ${q} { color: red; }`',
    ],
  ]
  return entries.map(([name, template]) =>
    diagnosticsCase(
      `selector scan past a ${name}`,
      `${SELECTOR_STOP_DECLARATIONS}const A = ${template}`,
    ),
  )
}

const NEXT_CHARACTER_COMMENT_DECLARATIONS = 'declare const Child: string, p: string\n'

/**
 * A comment between a placeholder and the character right after it, or right after it on the next
 * line, that decides the placeholder's role: a selector's "{", a property name's ":", or the "{"
 * that opens a rule body on the line after a pseudo-class.
 */
function nextCharacterCommentCases(): CompareCase[] {
  const entries: ReadonlyArray<readonly [string, string]> = [
    [
      'comment between a selector placeholder and its body',
      'styled.div`\n  ${Child} /* note */ {\n    color: red;\n  }\n`',
    ],
    [
      'comment on the line before a rule body after a pseudo-class',
      'styled.div`\n  ${Child}:hover\n  /* note */ {\n    color: red;\n  }\n`',
    ],
    [
      'comment between a property-name placeholder and its colon',
      'styled.div`\n  ${p} /* note */: red;\n`',
    ],
  ]
  return entries.map(([name, template]) =>
    diagnosticsCase(
      `next-character scan past a ${name}`,
      `${NEXT_CHARACTER_COMMENT_DECLARATIONS}const A = ${template}`,
    ),
  )
}

const cases: CompareCase[] = [
  diagnosticsCase('escape at a property name start', 'const A = styled.div`\\x63olr: red;`'),
  diagnosticsCase('escape inside a property name', 'const A = styled.div`co\\x6Cr: red;`'),
  diagnosticsCase('escape after a property name', 'const A = styled.div`colr\\x3a red;`'),
  {
    code: `${HEADER}const A = styled.div\`\\x63ol⟨a⟩\``,
    name: 'completion after an escape',
    ops: [{ at: 'a', op: 'comp', show: 3 }],
  },
  diagnosticsCase(
    'keyframe selector placeholder first',
    'declare const a: number\nconst k = keyframes`${a}% { opacity: 0; } to { opacity: 1; }`',
  ),
  diagnosticsCase(
    'keyframe selector placeholder second',
    'declare const a: number\nconst k = keyframes`\n  0% { opacity: 0; }\n  ${a}% { opacity: 1; }\n`',
  ),
  diagnosticsCase(
    'selector list of placeholders with pseudo-classes over lines',
    'declare const C: string\nconst A = styled.div`\n  ${C}:hover,\n  ${C}:focus {\n    color: red;\n  }\n`',
  ),
  diagnosticsCase(
    'selector list ending in a parent selector over lines',
    'declare const C: string\nconst A = styled.div`\n  ${C}:hover,\n  &:focus-visible {\n    color: red;\n  }\n`',
  ),
  diagnosticsCase(
    'value continued after a comma over lines',
    'declare const a: string, b: string\nconst A = styled.div`\n  transition:\n    ${a},\n    ${b};\n  font-family: a,\n    ${b};\n`',
  ),
  diagnosticsCase(
    'media conditions on both sides of "or"',
    'declare const q: string\nconst A = styled.div`@media ${q} or ${q} { color: red; }`',
  ),
  diagnosticsCase(
    'media prelude after a comment',
    'declare const q: string\nconst A = styled.div`/* x */ @media screen and ${q} { color: red; }`',
  ),
  diagnosticsCase(
    'comment between "and" and a media condition',
    'declare const q: string\nconst A = styled.div`@media screen and /* x */ ${q} { color: red; }`',
  ),
  diagnosticsCase(
    'escaped paren before a hex digit in url()',
    'const A = styled.div`background: url(a\\\\(b\\\\).png);`',
  ),
  diagnosticsCase(
    'escaped paren before a letter in url()',
    'const A = styled.div`background: url(a\\\\(z\\\\).png);`',
  ),
  {
    code: `${HEADER}const A = styled.div\`\n  background: url(/* " */a.png); m10⟨a⟩\n\``,
    name: 'completion after a url() whose leading comment holds a quote',
    ops: [{ at: 'a', op: 'comp', show: 3 }],
  },
  diagnosticsCase(
    'css value whose url() leading comment holds ";"',
    'const f = css`url(/* ; */a.png) no-repeat`',
  ),
  diagnosticsCase(
    'escape inside a known property name',
    'const A = styled.div`ba\\x63kground: red;`',
  ),
  diagnosticsCase(
    'escape before a hex digit inside a name',
    'const A = styled.div`bor\\x64er: 0;`',
  ),
  diagnosticsCase('escape inside a value keyword', 'const A = styled.div`color: r\\x65d;`'),
  diagnosticsCase(
    'escaped CSS colon inside a class name',
    'const A = styled.div`.md\\\\:flex { color: red; }`',
  ),
  diagnosticsCase('css single keyword', 'const f = css`red`'),
  diagnosticsCase('css single keyword "none"', 'const f = css`none`'),
  diagnosticsCase('css placeholder with a unit', 'declare const x: number\nconst f = css`${x}px`'),
  diagnosticsCase('css single unknown name', 'const f = css`colr`'),
  diagnosticsCase('css declaration with an unknown property', 'const f = css`colr: red;`'),
  {
    code: `${HEADER}const f = css\`dis⟨a⟩\``,
    name: 'css single name still completes properties',
    ops: [{ at: 'a', op: 'comp', show: 3 }],
  },
  diagnosticsCase(
    'css value whose url() holds a comment with ";"',
    'const f = css`url(a/*;*/b.png) no-repeat`',
  ),
  diagnosticsCase('css value whose url() holds "}"', 'const f = css`url(a}b.png) no-repeat`'),
  diagnosticsCase(
    'url() holding "{" before a declaration',
    'const A = styled.div`background: url(a{b.png); color: red;`',
  ),
  diagnosticsCase(
    'stray brace after a url() holding "}"',
    'const A = styled.div`background: url(a}b.png); color: red; }`',
  ),
  diagnosticsCase(
    'nested @layer after a url() holding "}"',
    "import { createGlobalStyle } from 'styled-components'\nconst G = createGlobalStyle`body { background: url(a}b.png); @layer x { color: red; } }`",
  ),
  diagnosticsCase(
    'placeholder inside a url() after ";"',
    'declare const x: string\nconst A = styled.div`background: url(a;${x}.png) no-repeat;`',
  ),
  {
    code: `${HEADER}const A = styled.div\`background: url(data:image/svg+xml;utf8,<svg/>) no-repeat m10⟨a⟩\``,
    name: 'completion after a url() holding ":" and ";"',
    ops: [{ at: 'a', op: 'comp', show: 3 }],
  },
  {
    code: `${HEADER}const A = styled.div\`background: url(data:image/svg+xml;⟨a⟩utf8,<svg/>) no-repeat\``,
    name: 'completion inside a url() right after ";"',
    ops: [{ at: 'a', op: 'comp', show: 3 }],
  },
  {
    code: `${HEADER}const A = styled.div\`background: url(icon.svg) no-repeat m10⟨a⟩\``,
    name: 'completion after a plain url()',
    ops: [{ at: 'a', op: 'comp', show: 3 }],
  },
  diagnosticsCase(
    'escape after a url character that is no name character',
    'const A = styled.div`background: url(a/\\x41y.png);`',
  ),
  diagnosticsCase(
    'escape inside a url() name',
    'const A = styled.div`background: url(x\\u0041y.png);`',
  ),
  diagnosticsCase(
    'line continuation inside a url()',
    'const A = styled.div`background: url(foo\\\nbar.png);\ncolor: red;`',
  ),
  diagnosticsCase(
    'placeholder spanning a line break inside an unquoted url() argument',
    'declare const props: { image: string }\nconst A = styled.div`background: url(${\n  props.image\n});`',
  ),
  diagnosticsCase(
    'placeholder inside a url() after "#" with text after it',
    'declare const id: string\nconst A = styled.div`fill: url(#${id}-grad);`',
  ),
  diagnosticsCase(
    'placeholder spanning a line break inside a quoted string',
    'declare const props: { label: string }\nconst A = styled.div`content: "${\n  props.label\n}";`',
  ),
  diagnosticsCase(
    'placeholder spanning a line break inside a line comment',
    'declare const note: string\nconst A = styled.div`// ${\n  note\n} here\ncolor: red;`',
  ),
  diagnosticsCase(
    'placeholder spanning a line break as an @media prelude',
    'declare const query: string\nconst A = styled.div`@media ${\n  query\n} {\n  color: red;\n}`',
  ),
  diagnosticsCase(
    'property name placeholder before "&" on the same line',
    'declare const s: string\nconst A = styled.div`padding-${s}: 0; &:hover { color: red; }`',
  ),
  diagnosticsCase(
    'property name suffix placeholder before "&" on the same line',
    'declare const s: string\nconst A = styled.div`${s}-top: 0; &:hover { color: red; }`',
  ),
  diagnosticsCase(
    'property name middle placeholder before "&" on the same line',
    'declare const s: string\nconst A = styled.div`border-${s}-color: red; &:hover { color: red; }`',
  ),
  diagnosticsCase(
    'whole property name placeholder before "&" on the same line',
    'declare const p: string\nconst A = styled.div`${p}: 0; &:hover { color: red; }`',
  ),
  ...selectorStopCases(),
  ...nextCharacterCommentCases(),
  {
    ...diagnosticsCase('capitalized lint level', 'const A = styled.div`&:hover { }`'),
    config: { lint: { emptyRules: 'Error' } },
  },
  {
    ...diagnosticsCase('lowercase lint level', 'const A = styled.div`&:hover { }`'),
    config: { lint: { emptyRules: 'error' } },
  },
]

export default cases
