import type { TemplateContext } from 'typescript-template-language-service-decorator'
import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it, vi } from 'vitest'
import type {
  Command,
  CompletionItem,
  Diagnostic,
  LanguageSettings,
  Range,
} from 'vscode-css-languageservice'
import { TextDocument } from 'vscode-languageserver-textdocument'
import * as vscode from 'vscode-languageserver-types'

import {
  PluginConfigurationManager,
  StyledPluginConfiguration,
} from '../../src/configuration/plugin-configuration'
import { CSS_APPLY_CODE_ACTION_COMMAND } from '../../src/features/code-actions'
import { MAX_VALIDATION_CACHE_ENTRIES } from '../../src/features/diagnostics'
import {
  CssLanguageService,
  EmmetCompletionProvider,
  StylesLanguageServiceFactory,
  ScssLanguageService,
} from '../../src/features/styles-language-services'
import { StyledTemplateLanguageService } from '../../src/template-language-service'
import { getTemplateSubstitutions } from '../../src/template/template-substitutions'
import { pluginIdentity } from '../../src/tsserver/plugin-identity'
import {
  StyledVirtualDocumentProvider,
  VirtualDocumentProvider,
} from '../../src/virtual-document/styled-virtual-document-provider'
import { createTemplateContext as createContext } from './create-template-context'

describe('StyledTemplateLanguageService', () => {
  it('should convert CSS completion items to TypeScript completion entries', () => {
    const context = createContext('color:')
    const service = createService()
    const completion = service.getCompletionsAtPosition(context, context.toPosition(6))
    const aliceblue = completion.entries.find((entry) => entry.name === 'aliceblue')

    assert.isDefined(aliceblue)
    assert.strictEqual(aliceblue.kind, ts.ScriptElementKind.constElement)
    assert.strictEqual(aliceblue.kindModifiers, 'color')
    assert.deepEqual(aliceblue.replacementSpan, { start: 6, length: 0 })
  })

  it('should return fallback details for an unknown completion entry', () => {
    const context = createContext('color:')
    const details = createServiceWithCompletionItems([]).getCompletionEntryDetails(
      context,
      context.toPosition(context.text.length),
      'missing-entry',
    )

    assert.deepEqual(details, {
      name: 'missing-entry',
      kind: ts.ScriptElementKind.unknown,
      kindModifiers: '',
      tags: [],
      displayParts: [{ kind: 'text', text: 'missing-entry' }],
      documentation: [],
    })
  })

  it('should omit completion edits that target the virtual document wrapper', () => {
    const context = createContext('color:')
    const completion = createServiceWithCompletionItems([
      createCompletionItem('wrapper', {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      }),
    ]).getCompletionsAtPosition(context, context.toPosition(context.text.length))

    assert.isUndefined(completion.entries.find((entry) => entry.name === 'wrapper'))
  })

  it('should omit completion edits that cross into the virtual document wrapper', () => {
    const context = createContext('color:')
    const completion = createServiceWithCompletionItems([
      createCompletionItem('crossing', {
        start: { line: 0, character: 0 },
        end: { line: 1, character: 1 },
      }),
    ]).getCompletionsAtPosition(context, context.toPosition(context.text.length))

    assert.isUndefined(completion.entries.find((entry) => entry.name === 'crossing'))
  })

  it('should map completion edits at the template end', () => {
    const context = createContext('color:')
    const completion = createServiceWithCompletionItems([
      createCompletionItem('end', {
        start: { line: 1, character: 6 },
        end: { line: 1, character: 6 },
      }),
    ]).getCompletionsAtPosition(context, context.toPosition(context.text.length))
    const end = completion.entries.find((entry) => entry.name === 'end')

    assert.isDefined(end)
    assert.deepEqual(end.replacementSpan, { start: 6, length: 0 })
  })

  it('should derive completion boundaries from a custom virtual document provider', () => {
    const context = createContext('color:')
    const providerWithoutTrailer = createCustomVirtualDocumentProvider('custom{', '')
    const providerWithTrailer = createCustomVirtualDocumentProvider('custom{', '<trailer>')
    const completionItems = (document: TextDocument) => [
      createCompletionItem('end', {
        start: document.positionAt('custom{'.length + context.text.length),
        end: document.positionAt('custom{'.length + context.text.length),
      }),
      createCompletionItem('trailer', {
        start: document.positionAt('custom{'.length + context.text.length + 1),
        end: document.positionAt('custom{'.length + context.text.length + 2),
      }),
    ]

    const completionAtEnd = createServiceWithCompletionItems(
      completionItems,
      providerWithoutTrailer,
    ).getCompletionsAtPosition(context, context.toPosition(context.text.length))
    const completionWithTrailer = createServiceWithCompletionItems(
      completionItems,
      providerWithTrailer,
    ).getCompletionsAtPosition(context, context.toPosition(context.text.length))

    assert.deepEqual(
      completionAtEnd.entries.find((entry) => entry.name === 'end')?.replacementSpan,
      { start: context.text.length, length: 0 },
    )
    assert.isUndefined(completionWithTrailer.entries.find((entry) => entry.name === 'trailer'))
  })

  it('should map completion boundaries for a custom provider whose offset mapping is not a fixed shift', () => {
    /**
     * rawText is "aa: 1; bb: 2;" (indices: a0 a1 :2 _3 1(4) ;5 _6 b7 b8 :9 _10 2(11) ;12). The
     * provider wraps it in "pre{" and inserts "???" right before raw offset 7, so the virtual text
     * is "pre{" + "aa: 1; " + "???" + "bb: 2;" = "pre{aa: 1; ???bb: 2;" (indices: p0 r1 e2 {3 a4 a5
     * :6 _7 1(8) ;9 _10 ?11 ?12 ?13 b14 b15 :16 _17 2(18) ;19). A completion entry on virtual [8, 9)
     * (the "1") sits before the insertion, so it maps back by the prefix alone to raw [4, 5). One on
     * virtual [18, 19) (the "2") sits after it, so it maps back by the prefix plus the marker to raw
     * [11, 12): a single constant shift would instead read raw [14, 15), past the marker.
     */
    const rawText = 'aa: 1; bb: 2;'
    const provider = createNonShiftVirtualDocumentProvider({
      insertAt: 7,
      marker: '???',
      prefix: 'pre{',
    })
    const context = createContext(rawText)
    const completionItems = (document: TextDocument) => [
      createCompletionItem('before', {
        start: document.positionAt(8),
        end: document.positionAt(9),
      }),
      createCompletionItem('after', {
        start: document.positionAt(18),
        end: document.positionAt(19),
      }),
    ]

    const completion = createServiceWithCompletionItems(
      completionItems,
      provider,
    ).getCompletionsAtPosition(context, context.toPosition(rawText.length))

    assert.deepEqual(completion.entries.find((entry) => entry.name === 'before')?.replacementSpan, {
      start: 4,
      length: 1,
    })
    assert.deepEqual(completion.entries.find((entry) => entry.name === 'after')?.replacementSpan, {
      start: 11,
      length: 1,
    })
  })

  it('should omit the replacement span when a completion has no text edit', () => {
    const context = createContext('color:')
    const completion = createServiceWithCompletionItems([
      { label: 'current-position' },
    ]).getCompletionsAtPosition(context, context.toPosition(context.text.length))
    const entry = completion.entries.find((candidate) => candidate.name === 'current-position')

    assert.isDefined(entry)
    assert.isUndefined(entry.replacementSpan)
  })

  it('should map the replace range from an insert-replace completion edit', () => {
    const context = createContext('color: re')
    const completion = createServiceWithCompletionItems([
      {
        label: 'red',
        textEdit: {
          newText: 'red',
          insert: {
            start: { line: 1, character: 8 },
            end: { line: 1, character: 9 },
          },
          replace: {
            start: { line: 1, character: 7 },
            end: { line: 1, character: 9 },
          },
        },
      },
    ]).getCompletionsAtPosition(context, context.toPosition(context.text.length))
    const entry = completion.entries.find((candidate) => candidate.name === 'red')

    assert.isDefined(entry)
    assert.deepEqual(entry.replacementSpan, { start: 7, length: 2 })
  })

  function createSnippetFormatItems(): CompletionItem[] {
    return [
      {
        label: 'border',
        insertText: 'ignored',
        insertTextFormat: vscode.InsertTextFormat.Snippet,
        filterText: 'border',
        textEdit: {
          newText: 'border: ${1:1px} ${2:solid} ${3:black};$0',
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 3 },
          },
        },
      },
      {
        label: 'var',
        insertText: 'var($1)',
        insertTextFormat: vscode.InsertTextFormat.Snippet,
      },
    ]
  }

  it('should never set insertText, isSnippet, or filterText on a completion, matching 1.0.1', () => {
    /**
     * 1.0.1's translateCompetionEntry (lib/_language-service.js) never set insertText or
     * isSnippet on any entry, snippet-format or not: it built an entry from name, kind,
     * kindModifiers, sortText, and replacementSpan alone and left insertion to the client's own
     * handling of the entry's name. tsserver's includeCompletionsWithSnippetText preference is
     * not a reliable signal for whether a client renders snippet tab stops (VS Code's TypeScript
     * extension always sends it as true), so this plugin never trusts it either.
     */
    const context = createContext('bor')
    const completion = createServiceWithCompletionItems(
      createSnippetFormatItems(),
    ).getCompletionsAtPosition(context, context.toPosition(context.text.length))
    const border = completion.entries.find((entry) => entry.name === 'border')
    const variable = completion.entries.find((entry) => entry.name === 'var')

    assert.isDefined(border)
    assert.isUndefined(border.insertText)
    assert.isUndefined(border.isSnippet)
    assert.isUndefined(border.filterText)
    assert.deepEqual(border.replacementSpan, { start: 0, length: 3 })

    assert.isDefined(variable)
    assert.isUndefined(variable.insertText)
    assert.isUndefined(variable.isSnippet)
    assert.isUndefined(variable.replacementSpan)
  })

  it('should merge CSS, filtered SCSS, and Emmet completions in order', () => {
    const context = createContext('m10')
    const factory = createFakeLanguageServiceFactory(
      [{ label: 'css-only' }, { label: ':shared' }],
      {
        scssCompletions: {
          isIncomplete: false,
          items: [
            { label: 'filtered-property', kind: vscode.CompletionItemKind.Property },
            { label: ':scss-only', kind: vscode.CompletionItemKind.Function },
            { label: ':shared', kind: vscode.CompletionItemKind.Function },
          ],
        },
      },
    )
    const emmetCompletionProvider: EmmetCompletionProvider = {
      doComplete() {
        return {
          isIncomplete: false,
          items: [{ label: ':shared' }, { label: 'emmet-only' }],
        }
      },
    }
    const service = createServiceWithFactory(factory, { emmetCompletionProvider })

    const completions = service.getCompletionsAtPosition(
      context,
      context.toPosition(context.text.length),
    )

    assert.deepEqual(
      completions.entries.map((entry) => entry.name),
      ['css-only', ':shared', ':scss-only', ':shared', ':shared', 'emmet-only'],
    )
    assert.deepEqual(completions.metadata, { isIncomplete: true })
  })

  describe('nested at-rule completions', () => {
    const nestedAtRules = [
      '@container',
      '@counter-style',
      '@font-face',
      '@font-palette-values',
      '@keyframes',
      '@layer',
      '@media',
      '@page',
      '@property',
      '@scope',
      '@starting-style',
      '@supports',
    ]

    function atRuleEntries(completion: ts.WithMetadata<ts.CompletionInfo>) {
      return completion.entries
        .filter((entry) => /^@[a-z-]+$/.test(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name))
    }

    it.each([
      ['after a declaration', 'color: red;\n@', 'color: red;\n@'.length],
      ['inside a nested rule body', '&:hover { @', '&:hover { @'.length],
      ['after a closing brace', 'a { color: red; }\n@', 'a { color: red; }\n@'.length],
      ['at the template start', '@', 1],
      ['after a declaration and a block comment', 'color: red; /* note */ @', 24],
      ['after a declaration and a line comment', 'color: red; // note\n@', 21],
      /** The raw `\\` is a CSS backslash, so the quote opens no string and the ";" ends a statement. */
      ['after a declaration whose value holds a CSS-escaped quote', 'content: \\\\"a;\n@', 16],
    ])(
      'should offer every nested at-rule %s, replacing the typed "@"',
      (_description, text, caret) => {
        const context = createContext(text, 'styled.div')

        const entries = atRuleEntries(
          createService().getCompletionsAtPosition(context, context.toPosition(caret)),
        )

        assert.deepEqual(
          entries,
          nestedAtRules.map((name) => ({
            kind: ts.ScriptElementKind.keyword,
            kindModifiers: '',
            name,
            replacementSpan: { length: 1, start: caret - 1 },
            sortText: name,
          })),
        )
      },
    )

    it('should replace the whole at-keyword, including characters after the caret', () => {
      const text = 'color: red;\n@media (min-width: 1px) {}'
      const context = createContext(text, 'styled.div')
      const keywordStart = text.indexOf('@')

      const entries = atRuleEntries(
        createService().getCompletionsAtPosition(
          context,
          context.toPosition(keywordStart + '@me'.length),
        ),
      )

      assert.deepEqual(
        entries.map((entry) => entry.replacementSpan),
        nestedAtRules.map(() => ({ length: '@media'.length, start: keywordStart })),
      )
    })

    it.each([
      ['in a property value', 'color: @'],
      ['after a declaration missing its semicolon', 'color: red\n@'],
      ['after a character that does not end a statement', 'a@'],
      ['inside a block comment after a ";"', 'color: red; /* a; @'],
      ['inside a string after a ";"', 'content: "a; @'],
      ['after a CSS-escaped ";"', 'a\\\\;\n@'],
      ['after a CSS-escaped "@"', 'color: red;\n\\\\@'],
    ])('should not offer nested at-rules %s', (_description, text) => {
      const context = createContext(text, 'styled.div')

      assert.deepEqual(
        atRuleEntries(
          createService().getCompletionsAtPosition(context, context.toPosition(text.length)),
        ),
        [],
      )
    })

    it('should read a non-ASCII name character as part of the at-keyword, as the CSS scanner does', () => {
      const text = 'color: red;\n@mé'
      const context = createContext(text, 'styled.div')

      const entries = atRuleEntries(
        createService().getCompletionsAtPosition(context, context.toPosition(text.length)),
      )

      assert.deepEqual(
        entries.map((entry) => entry.replacementSpan),
        nestedAtRules.map(() => ({ length: '@mé'.length, start: text.indexOf('@') })),
      )
    })

    it('should describe a nested at-rule with the CSS language service documentation', () => {
      const context = createContext('color: red;\n@', 'styled.div')

      const details = createService().getCompletionEntryDetails(
        context,
        context.toPosition(context.text.length),
        '@media',
      )

      assert.strictEqual(details.kind, ts.ScriptElementKind.keyword)
      assert.match(ts.displayPartsToString(details.documentation), /media type/i)
    })

    it('should request the at-rule catalog once per service, offer only listed names it contains, and skip labels already present', () => {
      const catalogRequests: string[] = []
      const noEmmet: EmmetCompletionProvider = { doComplete: () => undefined }
      const factory = createFakeLanguageServiceFactory((document) => {
        if (document.getText() === '@') {
          catalogRequests.push(document.languageId)
          return [
            { kind: vscode.CompletionItemKind.Keyword, label: '@charset' },
            {
              documentation: 'media docs',
              kind: vscode.CompletionItemKind.Keyword,
              label: '@media',
            },
            { kind: vscode.CompletionItemKind.Keyword, label: '@supports' },
          ]
        }
        return [{ label: '@supports' }]
      })
      const service = createServiceWithFactory(factory, { emmetCompletionProvider: noEmmet })
      const first = createContext('color: red;\n@', 'styled.div')
      const second = createContext('a { @', 'styled.div')

      const firstNames = service
        .getCompletionsAtPosition(first, first.toPosition(first.text.length))
        .entries.map((entry) => entry.name)
      const secondNames = service
        .getCompletionsAtPosition(second, second.toPosition(second.text.length))
        .entries.map((entry) => entry.name)

      assert.deepEqual(catalogRequests, ['css'])
      assert.deepEqual(firstNames, ['@supports', '@media'])
      assert.deepEqual(secondNames, ['@supports', '@media'])
    })
  })

  describe('Emmet placement, against the real CSS language service and Emmet', () => {
    function namesAt(text: string, caret: number, tagName = 'styled.div') {
      const context = createContext(text, tagName)
      return createService()
        .getCompletionsAtPosition(context, context.toPosition(caret))
        .entries.map((entry) => entry.name)
    }

    it.each([
      ['at the template start', 'm10', 'margin: 10px;'],
      ['after a declaration', 'color: red;\n  p10', 'padding: 10px;'],
      ['inside a nested rule body', '&:hover {\n    m10', 'margin: 10px;'],
      [
        'after a declaration and a comment holding a colon',
        'color: red; /* a: b */ m10',
        'margin: 10px;',
      ],
    ])('should offer Emmet abbreviations %s', (_description, text, expected) => {
      assert.include(namesAt(text, text.length), expected)
    })

    it.each([
      [
        'after a property colon, before ";"',
        '  display: fl;',
        '  display: fl'.length,
        'flex',
        'float: left;',
      ],
      [
        'after a property colon, before "}"',
        '&:hover { margin: m10 }',
        '&:hover { margin: m10'.length,
        'auto',
        'margin: 10px;',
      ],
      [
        'after a property colon at the template end',
        '  margin: m10',
        '  margin: m10'.length,
        'auto',
        'margin: 10px;',
      ],
      [
        'after a later value token',
        '  margin: 0 m10;',
        '  margin: 0 m10'.length,
        'auto',
        'margin: 10px;',
      ],
      [
        'after a colon inside a string earlier in the value',
        '  content: ":" m10;',
        '  content: ":" m10'.length,
        'attr()',
        'margin: 10px;',
      ],
      [
        'after a url() holding ";"',
        '  background: url(a;b.png) m10;',
        '  background: url(a;b.png) m10'.length,
        'no-repeat',
        'margin: 10px;',
      ],
      [
        'after a data url() holding ":" and ";"',
        '  background: url(data:image/svg+xml;utf8,<svg/>) no-repeat m10;',
        '  background: url(data:image/svg+xml;utf8,<svg/>) no-repeat m10'.length,
        'no-repeat',
        'margin: 10px;',
      ],
      [
        'after a url() holding "{" and "}"',
        '  background: url(a{b}c.png) m10;',
        '  background: url(a{b}c.png) m10'.length,
        'no-repeat',
        'margin: 10px;',
      ],
    ])(
      'should offer value completions but no Emmet abbreviation in value position %s',
      (_description, text, caret, valueCompletion, emmetAbbreviation) => {
        const names = namesAt(text, caret)

        assert.include(names, valueCompletion)
        assert.notInclude(names, emmetAbbreviation)
      },
    )

    it.each([
      ['a hex color', '  color: #12;', '  color: #12'.length, '#121212'],
      ['an !important flag', '  margin: 10px !;', '  margin: 10px !'.length, '!important'],
    ])(
      'should keep an Emmet expansion that is a value, %s, in value position',
      (_description, text, caret, expected) => {
        assert.include(namesAt(text, caret), expected)
      },
    )

    it.each([
      [
        'after a selector colon, with a rule body after it',
        '&:hover m10 {\n  color: red;\n}',
        '&:hover m10'.length,
        ':active',
      ],
      [
        'in a media feature value',
        '@media (min-width: m10) {\n  color: red;\n}',
        '@media (min-width: m10'.length,
        'any-hover',
      ],
    ])(
      'should offer completions but no Emmet declaration %s',
      (_description, text, caret, expected) => {
        const names = namesAt(text, caret)

        assert.include(names, expected)
        assert.notInclude(names, 'margin: 10px;')
      },
    )

    it.each([
      ['in a media prelude', '@media m10 {\n  color: red;\n}', '@media m10'.length],
      ['in a supports prelude', '@supports m10 {\n  color: red;\n}', '@supports m10'.length],
      [
        'in an at-rule prelude after a comment',
        'color: red; /* x */ @media m10 {}',
        'color: red; /* x */ @media m10'.length,
      ],
    ])('should offer no Emmet declaration %s', (_description, text, caret) => {
      const control = 'color: red;\n  m10'

      assert.notInclude(namesAt(text, caret), 'margin: 10px;')
      assert.include(namesAt(control, control.length), 'margin: 10px;')
    })

    it.each([
      ['m10', 'margin: 10px;'],
      ['us', 'user-select: none;'],
    ])(
      'should offer no Emmet declaration for "%s" inside a url() after ";", but keep a value expansion',
      (abbreviation, declaration) => {
        const text = `  background: url(data:image/svg+xml;${abbreviation}) no-repeat;`
        const caret = `  background: url(data:image/svg+xml;${abbreviation}`.length
        const valueText = '  background: url(data:image/svg+xml;#12) no-repeat;'
        const control = `color: red;\n  ${abbreviation}`

        assert.notInclude(namesAt(text, caret), declaration)
        assert.include(namesAt(valueText, valueText.indexOf('#12') + 3), '#121212')
        assert.include(namesAt(control, control.length), declaration)
      },
    )

    it('should still offer Emmet declarations on a line before a nested rule', () => {
      const text = 'color: red;\n  m10\n  &:hover { color: blue; }'

      assert.include(namesAt(text, 'color: red;\n  m10'.length), 'margin: 10px;')
    })

    it('should offer no Emmet abbreviation inside a value-shaped css fragment', () => {
      const text = '1px solid m10'
      const names = namesAt(text, text.length, 'css')

      assert.include(names, 'inherit')
      assert.notInclude(names, 'margin: 10px;')
    })
  })

  describe('completions inside comments and strings, against the real CSS language service', () => {
    it.each([
      ['a block comment', '  /* p10 */', '  /* p10'.length],
      ['a block comment holding a property prefix', '  /* dis */', '  /* dis'.length],
      ['a line comment', '  // dis\n  color: red;', '  // dis'.length],
      ['an unterminated block comment', '  /* dis', '  /* dis'.length],
      ['a string value holding an abbreviation', '  content: "w10";', '  content: "w10'.length],
      ['a string value holding an at-sign', '  content: "@";', '  content: "@'.length],
      ['a font name string', '  font-family: "Ar";', '  font-family: "Ar'.length],
      ['an attribute selector string', '  &[data-x="a"] { color: red; }', '  &[data-x="a'.length],
      [
        'an unterminated string, at the template end',
        '  content: "a; @',
        '  content: "a; @'.length,
      ],
      [
        'an unterminated string, at its line end',
        '  content: "a; @\n  color: red;',
        '  content: "a; @'.length,
      ],
      [
        'a string opened by a JavaScript-escaped quote, at the template end',
        '  content: \\"a; @',
        '  content: \\"a; @'.length,
      ],
    ])('should offer no completions inside %s', (_description, text, caret) => {
      const context = createContext(text, 'styled.div')
      const service = createService()
      const control = createContext('  dis', 'styled.div')

      assert.deepEqual(
        service.getCompletionsAtPosition(context, context.toPosition(caret)).entries,
        [],
      )
      assert.include(
        service
          .getCompletionsAtPosition(control, control.toPosition(control.text.length))
          .entries.map((entry) => entry.name),
        'display',
      )
    })

    it('should offer completions right after a comment closes', () => {
      const text = '  /* note */ dis'
      const context = createContext(text, 'styled.div')

      assert.include(
        createService()
          .getCompletionsAtPosition(context, context.toPosition(text.length))
          .entries.map((entry) => entry.name),
        'display',
      )
    })
  })

  it('should offer statement-position completions in an empty template', () => {
    const context = createContext('', 'styled.div')

    const names = createService()
      .getCompletionsAtPosition(context, { character: 0, line: 0 })
      .entries.map((entry) => entry.name)

    assert.include(names, 'display')
    assert.include(names, 'color')
  })

  it('should not reuse completions between different virtual document wrappers', () => {
    const service = createServiceWithCompletionItems((document) => [
      { label: document.getText().startsWith('@keyframes') ? 'keyframes' : 'root' },
    ])
    const cssContext = createContext('color:', 'css')
    const keyframesContext = createContext('color:', 'keyframes')

    const cssCompletions = service.getCompletionsAtPosition(
      cssContext,
      cssContext.toPosition(cssContext.text.length),
    )
    const keyframesCompletions = service.getCompletionsAtPosition(
      keyframesContext,
      keyframesContext.toPosition(keyframesContext.text.length),
    )

    assert.deepEqual(
      cssCompletions.entries.map((entry) => entry.name),
      ['root'],
    )
    assert.deepEqual(
      keyframesCompletions.entries.map((entry) => entry.name),
      ['keyframes'],
    )
  })

  it('should not reuse completion or virtual-document caches across files', () => {
    let cssCompletionRequests = 0
    const factory = createFakeLanguageServiceFactory(() => [
      { label: ++cssCompletionRequests === 1 ? 'first' : 'second' },
    ])
    const virtualDocumentProvider = new StyledVirtualDocumentProvider(ts)
    const createVirtualDocument = vi.spyOn(virtualDocumentProvider, 'createVirtualDocument')
    const service = createServiceWithFactory(factory, { virtualDocumentProvider })
    const firstContext = createContext('color:', 'css', 'first.ts')
    const secondContext = createContext('color:', 'css', 'second.ts')

    const first = service.getCompletionsAtPosition(
      firstContext,
      firstContext.toPosition(firstContext.text.length),
    )
    const second = service.getCompletionsAtPosition(
      secondContext,
      secondContext.toPosition(secondContext.text.length),
    )

    assert.deepEqual(
      first.entries.map((entry) => entry.name),
      ['first'],
    )
    assert.deepEqual(
      second.entries.map((entry) => entry.name),
      ['second'],
    )
    assert.strictEqual(createVirtualDocument.mock.calls.length, 2)
    assert.strictEqual(factory.parsedDocuments.length, 2)
    assert.strictEqual(factory.completionRequests, 4)
  })

  it('should convert CSS hover documentation and ranges to template offsets', () => {
    const context = createContext('color: red;')
    const quickInfo = createService().getQuickInfoAtPosition(context, context.toPosition(1))

    assert.isDefined(quickInfo)
    assert.deepEqual(quickInfo.textSpan, { start: 0, length: 10 })
    assert.match(ts.displayPartsToString(quickInfo.documentation), /Sets the color/i)
  })

  it('should use the request position when hover has no range', () => {
    const context = createContext('color: red;')
    const service = createServiceWithLanguageServiceResponses({
      hover: { contents: { kind: vscode.MarkupKind.Markdown, value: 'color docs' } },
    })

    const quickInfo = service.getQuickInfoAtPosition(context, context.toPosition(2))

    assert.isDefined(quickInfo)
    assert.deepEqual(quickInfo?.textSpan, { start: 2, length: 1 })
    assert.deepEqual(quickInfo?.documentation, [{ kind: 'unknown', text: 'color docs' }])
  })

  it('should keep a hover without a range inside the template at its end', () => {
    const context = createContext('color: red;')
    const service = createServiceWithLanguageServiceResponses({
      hover: { contents: { kind: vscode.MarkupKind.Markdown, value: 'color docs' } },
    })

    const quickInfo = service.getQuickInfoAtPosition(
      context,
      context.toPosition(context.text.length),
    )

    assert.deepEqual(quickInfo?.textSpan, { length: 0, start: context.text.length })
  })

  it('should return undefined when the language service has no hover', () => {
    const context = createContext('color: red;')

    assert.isUndefined(
      createServiceWithLanguageServiceResponses({}).getQuickInfoAtPosition(
        context,
        context.toPosition(2),
      ),
    )
  })

  it('should translate diagnostic codes and severities', () => {
    const context = createContext('color: red;')
    const range = {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 1 },
    }
    const service = createServiceWithLanguageServiceResponses({
      diagnostics: [
        {
          range,
          message: 'error',
          code: 'css-error',
          severity: vscode.DiagnosticSeverity.Error,
        },
        { range, message: 'warning', code: 42, severity: vscode.DiagnosticSeverity.Warning },
        { range, message: 'information', severity: vscode.DiagnosticSeverity.Information },
        { range, message: 'hint', severity: vscode.DiagnosticSeverity.Hint },
        { range, message: 'default severity' },
      ],
    })

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.deepEqual(
      diagnostics.map(({ category, code, messageText, source }) => ({
        category,
        code,
        messageText,
        source,
      })),
      [
        {
          category: ts.DiagnosticCategory.Error,
          code: 9999,
          messageText: 'error',
          source: pluginIdentity,
        },
        {
          category: ts.DiagnosticCategory.Warning,
          code: 42,
          messageText: 'warning',
          source: pluginIdentity,
        },
        {
          category: ts.DiagnosticCategory.Message,
          code: 9999,
          messageText: 'information',
          source: pluginIdentity,
        },
        {
          category: ts.DiagnosticCategory.Message,
          code: 9999,
          messageText: 'hint',
          source: pluginIdentity,
        },
        {
          category: ts.DiagnosticCategory.Error,
          code: 9999,
          messageText: 'default severity',
          source: pluginIdentity,
        },
      ],
    )
  })

  it('should keep an end-of-template "at-rule or selector expected" diagnostic alongside the same message at a real position', () => {
    /**
     * vscode-css-languageservice reports ParseError.RuleOrSelectorExpected (code
     * "css-ruleorselectorexpected") when the parser reaches the top level of the stylesheet,
     * outside every rule, still wanting a new at-rule or selector to start. Inside this plugin's
     * wrapper, that state is only reachable via the wrapper's own synthetic closing brace (a
     * stray "}" or unattached ";" in the template closed it early); it is never dropped based on
     * another diagnostic in the same template, even one carrying the identical message and code
     * at a real position, since that would silently accept the stray "}" or ";" whenever an
     * unrelated diagnostic also happened to exist. No "}" appears in this template's text, so the
     * end-of-template diagnostic has nothing to re-anchor to and stays at the template end.
     */
    const context = createContext('color: red;')
    const templateEndPosition = { line: 1, character: context.text.length }
    const realPosition = { line: 1, character: 0 }
    const service = createServiceWithLanguageServiceResponses({
      diagnostics: [
        {
          range: { start: templateEndPosition, end: templateEndPosition },
          message: 'at-rule or selector expected',
          code: 'css-ruleorselectorexpected',
        },
        {
          range: { start: realPosition, end: { line: 1, character: 1 } },
          message: 'at-rule or selector expected',
          code: 'css-ruleorselectorexpected',
        },
      ],
    })

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 2)
    const realDiagnostic = diagnostics.find((d) => d.start === 0)
    const endOfTemplateDiagnostic = diagnostics.find((d) => d.start === context.text.length)
    assert.isDefined(realDiagnostic)
    assert.strictEqual(realDiagnostic?.length, 1)
    assert.isDefined(endOfTemplateDiagnostic)
    assert.strictEqual(endOfTemplateDiagnostic?.length, 0)
  })

  it('should keep and re-anchor a standalone end-of-template "at-rule or selector expected" diagnostic to the stray "}" that caused it', () => {
    /**
     * No other diagnostic reports the real problem here, so this is the template's only error:
     * dropping it, as the previous test does when a real diagnostic covers the same defect,
     * would silently accept the stray "}". Re-anchored to that brace's own offset (12) instead
     * of the template end (13) it would otherwise clamp to.
     */
    const context = createContext('color: red; }')
    const templateEndPosition = { line: 1, character: context.text.length }
    const service = createServiceWithLanguageServiceResponses({
      diagnostics: [
        {
          range: { start: templateEndPosition, end: templateEndPosition },
          message: 'at-rule or selector expected',
          code: 'css-ruleorselectorexpected',
        },
      ],
    })

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 1)
    assert.strictEqual(diagnostics[0]?.messageText, 'at-rule or selector expected')
    assert.strictEqual(diagnostics[0]?.start, context.text.indexOf('}'))
    assert.strictEqual(diagnostics[0]?.length, 1)
  })

  it('should keep a standalone end-of-template "at-rule or selector expected" diagnostic at the template end when no stray "}" is determinable', () => {
    /**
     * The template has no closing brace at all (the "unattached ;" or "empty template" causes
     * documented on RULE_OR_SELECTOR_EXPECTED_DIAGNOSTIC_CODE), so there is nothing to re-anchor
     * to: the template-end position stays, rather than being dropped.
     */
    const context = createContext('color: red;')
    const templateEndPosition = { line: 1, character: context.text.length }
    const service = createServiceWithLanguageServiceResponses({
      diagnostics: [
        {
          range: { start: templateEndPosition, end: templateEndPosition },
          message: 'at-rule or selector expected',
          code: 'css-ruleorselectorexpected',
        },
      ],
    })

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 1)
    assert.strictEqual(diagnostics[0]?.start, context.text.length)
    assert.strictEqual(diagnostics[0]?.length, 0)
  })

  it('should report a stray "}" as a real diagnostic when it is the template\'s only error, against the real CSS language service', () => {
    /**
     * A stray "}" that is a template's only error is reported as a real diagnostic, anchored to
     * the brace itself, rather than dropped as a duplicate of the cascading "at-rule or selector
     * expected" diagnostic at the template end. Uses the real vscode-css-languageservice
     * (createService, not the fake diagnostics harness above) so the reported position is not
     * just asserted but genuinely produced by parsing each shape.
     */
    const service = createService()

    const trailingBrace = createContext('color: red; }')
    const bareBrace = createContext('}')
    const braceThenRule = createContext('color: red; } a { color: blue; }')
    const doubleBrace = createContext('a { color: red; }}')

    const trailingBraceDiagnostics = service.getSemanticDiagnostics(trailingBrace)
    const bareBraceDiagnostics = service.getSemanticDiagnostics(bareBrace)
    const braceThenRuleDiagnostics = service.getSemanticDiagnostics(braceThenRule)
    const doubleBraceDiagnostics = service.getSemanticDiagnostics(doubleBrace)

    assert.strictEqual(trailingBraceDiagnostics.length, 1)
    assert.strictEqual(trailingBraceDiagnostics[0]?.start, trailingBrace.text.indexOf('}'))
    assert.strictEqual(trailingBraceDiagnostics[0]?.length, 1)

    assert.strictEqual(bareBraceDiagnostics.length, 1)
    assert.strictEqual(bareBraceDiagnostics[0]?.start, bareBrace.text.indexOf('}'))
    assert.strictEqual(bareBraceDiagnostics[0]?.length, 1)

    /** The first "}" is the stray one; the rule that follows it parses cleanly on its own. */
    assert.strictEqual(braceThenRuleDiagnostics.length, 1)
    assert.strictEqual(braceThenRuleDiagnostics[0]?.start, braceThenRule.text.indexOf('}'))
    assert.strictEqual(braceThenRuleDiagnostics[0]?.length, 1)

    /** The first "}" closes "a { ... }"; the second, unmatched one is the stray brace. */
    assert.strictEqual(doubleBraceDiagnostics.length, 1)
    assert.strictEqual(doubleBraceDiagnostics[0]?.start, doubleBrace.text.lastIndexOf('}'))
    assert.strictEqual(doubleBraceDiagnostics[0]?.length, 1)
  })

  it('should keep a stray "}" alongside an unrelated diagnostic that starts before it, against the real CSS language service', () => {
    /**
     * "colr" is an unrelated unknown-property warning positioned before the stray "}", not the
     * cascade the brace caused: dropping the brace's own diagnostic here (as a scan that treats
     * any other diagnostic in the template as covering the real problem would) would silently
     * accept the stray "}" whenever an unrelated error also happened to exist in the template.
     */
    const service = createService()
    const context = createContext('colr: red; }')

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 2)
    const unknownProperty = diagnostics.find((d) => d.messageText === "Unknown property: 'colr'")
    const strayBrace = diagnostics.find((d) => d.messageText === 'at-rule or selector expected')
    assert.isDefined(unknownProperty)
    assert.isDefined(strayBrace)
    assert.strictEqual(unknownProperty?.start, context.text.indexOf('colr'))
    assert.strictEqual(strayBrace?.start, context.text.indexOf('}'))
    assert.strictEqual(strayBrace?.length, 1)
  })

  it('should keep a stray "}" alongside an unrelated diagnostic that starts after it, against the real CSS language service', () => {
    /**
     * "colr" is an unrelated unknown-property warning positioned after the stray "}": everything
     * from the "}" onward still parses (".a { colr: red; }" is a rule that is valid on its own
     * except for the misspelled property), so this is not the cascade the brace itself caused.
     * Dropping the brace's own diagnostic whenever any other diagnostic starts anywhere in the
     * template, including after it, would leave no error-level diagnostic at all here.
     */
    const service = createService()
    const context = createContext('color: red; } .a { colr: red; }')

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 2)
    const unknownProperty = diagnostics.find((d) => d.messageText === "Unknown property: 'colr'")
    const strayBrace = diagnostics.find((d) => d.messageText === 'at-rule or selector expected')
    assert.isDefined(unknownProperty)
    assert.isDefined(strayBrace)
    assert.strictEqual(unknownProperty?.start, context.text.indexOf('colr'))
    assert.strictEqual(strayBrace?.start, context.text.indexOf('}'))
    assert.strictEqual(strayBrace?.length, 1)
    assert.strictEqual(
      strayBrace?.category,
      ts.DiagnosticCategory.Error,
      'the stray brace must be an error-level diagnostic, not swallowed by the unrelated warning',
    )
  })

  it.each([
    ['line separator', String.fromCharCode(0x2028)],
    ['paragraph separator', String.fromCharCode(0x2029)],
  ])(
    'should find a stray "}" after a "//" comment ended by a Unicode %s, matching the virtual document normalizer',
    (_description, separator) => {
      /**
       * normalizeVirtualText (styled-virtual-document-provider.ts) ends a "//"
       * comment at a Unicode line or paragraph separator, converting it to "\n" before the CSS
       * scanner ever sees it, so the "}" after it is real, structural content. findStrayClosingBraceOffset
       * uses the same scanner (nonCodeEnd) so it finds the same brace instead of treating the
       * comment as still open and falling back to the template-end position.
       */
      const service = createService()
      const context = createContext(`color: red; // note${separator}  }`)

      const diagnostics = service.getSemanticDiagnostics(context)

      assert.strictEqual(diagnostics.length, 1)
      assert.strictEqual(diagnostics[0]?.messageText, 'at-rule or selector expected')
      assert.strictEqual(diagnostics[0]?.start, context.text.indexOf('}'))
      assert.strictEqual(diagnostics[0]?.length, 1)
    },
  )

  it('should not re-anchor a real "at-rule or selector expected" diagnostic that is not at the template end', () => {
    /**
     * isCascadeCandidate (src/features/diagnostics.ts) requires both the
     * RULE_OR_SELECTOR_EXPECTED_DIAGNOSTIC_CODE and entry.start === context.rawText.length: only
     * the second condition tells apart the wrapper's own cascading diagnostic (always reported at
     * the template end) from a same-coded diagnostic at a real, earlier position in the template.
     * Dropping the position half of that check would treat both as the cascade, re-anchoring the
     * real one to the stray "}" too and losing its own position. The text contains exactly one
     * stray "}" (index 2) for findStrayClosingBraceOffset to find, so a re-anchor is observable.
     */
    const context = createContext('a } color: red;')
    const templateEndPosition = { line: 1, character: context.text.length }
    const realPosition = { line: 1, character: 4 }
    const service = createServiceWithLanguageServiceResponses({
      diagnostics: [
        {
          range: { start: realPosition, end: { line: 1, character: 5 } },
          message: 'at-rule or selector expected',
          code: 'css-ruleorselectorexpected',
        },
        {
          range: { start: templateEndPosition, end: templateEndPosition },
          message: 'at-rule or selector expected',
          code: 'css-ruleorselectorexpected',
        },
      ],
    })

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 2)
    const realDiagnostic = diagnostics.find((d) => d.start === 4)
    const cascadeDiagnostic = diagnostics.find((d) => d.start === context.text.indexOf('}'))
    assert.isDefined(realDiagnostic)
    assert.strictEqual(realDiagnostic?.length, 1)
    assert.isDefined(cascadeDiagnostic)
    assert.strictEqual(cascadeDiagnostic?.length, 1)
  })

  it('should skip a "}" inside a block comment when scanning for the stray closing brace, against the real CSS language service', () => {
    /**
     * findStrayClosingBraceOffset tracks block comments so a "}" written inside one is not
     * structural. Without that tracking, the scanner would anchor on the decoy "}" at index 3
     * (inside "/* } *\/") instead of the real stray "}" at the template end that actually closed
     * the wrapper early.
     */
    const service = createService()
    const context = createContext('/* } */ color: red; }')

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 1)
    assert.strictEqual(diagnostics[0]?.messageText, 'at-rule or selector expected')
    assert.strictEqual(diagnostics[0]?.start, context.text.lastIndexOf('}'))
    assert.strictEqual(diagnostics[0]?.length, 1)
  })

  it('should not mistake "//" inside an unquoted url() for a line comment when scanning for the stray closing brace, against the real CSS language service', () => {
    /**
     * findStrayClosingBraceOffset's scanner (nonCodeEnd) suppresses "//" line-comment detection
     * while inside an unquoted url(...), because a URL such as "http://" otherwise reads as
     * the start of a line comment, which would swallow the rest of the line, including the real
     * stray "}" that follows, and fall back to the (wrong) template-end position instead of the
     * brace itself.
     */
    const service = createService()
    const context = createContext('background: url(http://x.com/a.png); color: red; }')

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 1)
    assert.strictEqual(diagnostics[0]?.messageText, 'at-rule or selector expected')
    assert.strictEqual(diagnostics[0]?.start, context.text.lastIndexOf('}'))
    assert.strictEqual(diagnostics[0]?.length, 1)
  })

  it.each([
    ['a CSS-escaped quote, which opens no string', 'content: \\\\"x; }'],
    ['a CSS-escaped "/", which opens no comment', 'content: a\\\\//x; }'],
    ['a url() whose name has a hex-escaped "u"', 'background: \\75 rl(//x.png); }'],
    ['a url() whose name has an escaped "u"', 'background: \\url(//x.png); }'],
    ['a url() whose name has a CSS-escaped "r"', 'background: u\\\\rl(//x.png); }'],
    ['a CSS-escaped ")" inside a url()', 'background: url(a\\\\)g//x); }'],
    ['a JavaScript-escaped quote, which opens a string holding the "}"', 'content: \\"}\\"; }'],
  ])(
    'should anchor the stray "}" after %s, against the real CSS language service',
    (_description, text) => {
      const service = createService()
      const context = createContext(text)

      const diagnostics = service.getSemanticDiagnostics(context)

      assert.deepEqual(
        diagnostics.map((diagnostic) => [
          diagnostic.messageText,
          diagnostic.start,
          diagnostic.length,
        ]),
        [['at-rule or selector expected', text.lastIndexOf('}'), 1]],
      )
    },
  )

  it('should report no false error for a nested block @layer after a CSS-escaped quote, against the real CSS language service', () => {
    const service = createService()
    const context = createContext('content: \\\\"a; @layer u { colr: red; }', 'styled.div')

    const diagnostics = service.getSemanticDiagnostics(context)

    /** The misspelled property is the positive control: the layer body is validated as declarations. */
    assert.deepEqual(
      diagnostics.map((diagnostic) => [diagnostic.messageText, diagnostic.start]),
      [["Unknown property: 'colr'", context.text.indexOf('colr')]],
    )
  })

  it('should validate a css rule whose selector holds a CSS-escaped quote as a rule, not a value, against the real CSS language service', () => {
    const service = createService()
    const context = createContext('a\\\\"b { colr: red; }')

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.deepEqual(
      diagnostics.map((diagnostic) => [diagnostic.messageText, diagnostic.start]),
      [["Unknown property: 'colr'", context.text.indexOf('colr')]],
    )
  })

  describe('block comments inside url(), against the real CSS language service', () => {
    it('should offer completions after a url() whose leading comment holds a quote', () => {
      const text = 'background: url(/* " */a.png); m10'
      const context = createContext(text, 'styled.div')

      const completions = createService().getCompletionsAtPosition(
        context,
        context.toPosition(text.length),
      )

      assert.include(
        completions.entries.map((entry) => entry.name),
        'margin: 10px;',
      )
    })

    it('should validate a css value whose url() holds a leading comment with ";" as a value', () => {
      const service = createService()
      const context = createContext('url(/* ; */a.png) no-repeat')
      /** Positive control: the same wrapper choice reports a misspelled keyword position. */
      const control = createContext('colr: red;')

      assert.deepEqual(service.getSemanticDiagnostics(context), [])
      assert.deepEqual(
        service.getSemanticDiagnostics(control).map((diagnostic) => diagnostic.messageText),
        ["Unknown property: 'colr'"],
      )
    })
  })

  describe('spans that start or end inside a JavaScript escape, against the real CSS language service', () => {
    /** `\x63` is one JavaScript escape for "c", so the name is `colr` at runtime. */
    const ESCAPED_NAME = '\\x63olr'

    it('should widen a diagnostic to cover the whole escape', () => {
      const context = createContext(`${ESCAPED_NAME}: red;`)

      const diagnostics = createService().getSemanticDiagnostics(context)

      assert.deepEqual(
        diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
        [{ length: ESCAPED_NAME.length, messageText: "Unknown property: 'colr'", start: 0 }],
      )
    })

    it('should report the cooked name once for an escape inside a name, widened to the whole name', () => {
      /** `\x6C` is "l", so the name is `colr` at runtime: one unknown property, not a split name. */
      const name = 'co\\x6Cr'
      const context = createContext(`${name}: red;`)

      const diagnostics = createService().getSemanticDiagnostics(context)

      assert.deepEqual(
        diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
        [{ length: name.length, messageText: "Unknown property: 'colr'", start: 0 }],
      )
    })

    it.each([
      ['a line feed', '\n'],
      ['a CRLF', '\r\n'],
    ])(
      'should report only the later unknown property after a line continuation before %s inside a url(), on its own line',
      (_description, lineBreak) => {
        /** The stand-in holds no line break, while the line map still counts the raw one. */
        const text = `background: url(foo\\${lineBreak}bar.png);${lineBreak}colr: red;`
        const context = createContext(text, 'styled.div')

        const diagnostics = createService().getSemanticDiagnostics(context)

        assert.deepEqual(
          diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
          [{ length: 4, messageText: "Unknown property: 'colr'", start: text.indexOf('colr') }],
        )
      },
    )

    it.each([
      ['a known property name', 'ba\\x63kground: red;'],
      ['a known property name, before a hex digit', 'bor\\x64er: 0;'],
      ['an unquoted url() after "/"', 'background: url(a/\\x41y.png);'],
      ['an unquoted url() after ","', 'background: url(a,b\\x63.png);'],
      [
        'an unquoted url() after a cooked U+3000',
        `background: url(a${String.fromCharCode(92)}u3000,\\x41);`,
      ],
      ['an unquoted url() after a cooked U+00A0', 'background: url(a\\xA0,\\x41);'],
      [
        'an unquoted url() after CSS-escaped quotes',
        'background: url(data:image/svg+xml,\\\\"fill\\\\"\\x41);',
      ],
      ['an unquoted url() after a CSS-escaped space', 'background: url(a\\\\ b\\x41);'],
      ['an unquoted url() after the space a hex escape takes', 'background: url(a\\\\41 b\\x41);'],
      [
        'an unquoted url() holding a hex escape that takes a cooked line break',
        'background: url(\\x5c\\x31\\n\\\\f);',
      ],
      [
        'an unquoted url() holding a hex escape a later run continues',
        'background: url(a\\\\4\\x31 b\\x41);',
      ],
      [
        'an unquoted url() holding a hex escape one run writes whole',
        'background: url(a\\\\\\x34\\x31 b\\x41);',
      ],
      ['a value keyword', 'color: r\\x65d;'],
      ['a class joined to "&"', '&.bt\\x6E { color: red; }'],
      ['a pseudo-class', '&:ho\\x76er { color: red; }'],
      /**
       * Inside an unquoted url() argument, a run that cooks to trailing whitespace fills the padding
       * before that whitespace instead of after it: after would let the CSS scanner end the url token
       * at the whitespace and read the padding as a second, invalid token.
       */
      ['an unquoted url() ending in a cooked line break', 'background: url(x\\n);'],
      ['an unquoted url() ending in a cooked space', 'background: url(a.png\\x20);'],
      /**
       * A cooked quote opening the argument's first content makes the whole argument a quoted
       * string, not an unquoted one: the padding is spaces, as it is outside a url().
       */
      ['an unquoted url() argument opened by cooked quotes', 'background: url(\\x22\\x22);'],
      /**
       * url() requires no whitespace before its own "(", unlike a general function, so a run that
       * cooks to exactly "(" right after the name moves the padding in front of the name instead.
       */
      ['a url() opened by a cooked "("', 'background: url\\x28x.png);'],
    ])('should report nothing for an escape inside %s', (_description, text) => {
      const service = createService()

      assert.deepEqual(service.getSemanticDiagnostics(createContext(text)), [])
      /** Positive control: the same service reports an unknown property. */
      assert.strictEqual(service.getSemanticDiagnostics(createContext('colr: red;')).length, 1)
    })

    it('should widen a hover span to cover the whole escape', () => {
      /** A known property, so hover has documentation to show; `color` at runtime. */
      const name = '\\x63olor'
      const context = createContext(`${name}: red;`)

      const hover = createService().getQuickInfoAtPosition(context, context.toPosition(5))

      /** Hover spans the whole declaration, which starts inside the escape. */
      assert.deepEqual(hover?.textSpan, { length: `${name}: red`.length, start: 0 })
    })

    it('should widen a completion replacement span to cover the whole escape', () => {
      const text = '\\x63ol'
      const context = createContext(`${text}`, 'styled.div')

      const completions = createService().getCompletionsAtPosition(
        context,
        context.toPosition(text.length),
      )

      assert.deepEqual(
        completions.entries.find((entry) => entry.name === 'color')?.replacementSpan,
        { length: text.length, start: 0 },
      )
    })

    it('should offer no code fix whose edit overlaps an escape, and keep one whose edit does not', () => {
      const service = createService()
      const escaped = createContext(`${ESCAPED_NAME}: red;`)
      /** `\x3a` is ":"; the rename edits only `colr`, before the escape. */
      const escapeAfterName = createContext('colr\\x3a red;')

      const escapedFixes = service.getCodeFixesAtPosition(escaped, 0, ESCAPED_NAME.length)
      const escapeAfterNameFixes = service.getCodeFixesAtPosition(escapeAfterName, 0, 4)

      assert.deepEqual(escapedFixes, [])
      assert.deepEqual(
        escapeAfterNameFixes.map((fix) => [
          fix.description,
          fix.changes[0]?.textChanges[0]?.span,
          fix.changes[0]?.textChanges[0]?.newText,
        ]),
        [
          ["Rename to 'color'", { length: 4, start: 0 }, 'color'],
          ["Rename to 'clear'", { length: 4, start: 0 }, 'clear'],
          ["Rename to 'clip'", { length: 4, start: 0 }, 'clip'],
        ],
      )
    })
  })

  it('should skip a "}" inside an unquoted url() when scanning for the stray closing brace, against the real CSS language service', () => {
    const context = createContext('background: url(a}b.png); color: red; }', 'styled.div')

    assert.deepEqual(
      createService()
        .getSemanticDiagnostics(context)
        .map(({ length, messageText, start }) => ({ length, messageText, start })),
      [
        {
          length: 1,
          messageText: 'at-rule or selector expected',
          start: context.text.lastIndexOf('}'),
        },
      ],
    )
  })

  it('should skip a "}" inside a string after a CSS-escaped quote when scanning for the stray closing brace, against the real CSS language service', () => {
    /**
     * The raw `\\` is a CSS backslash that escapes the quote after it, so the string still holds
     * the "}" at index 14. Without escape handling, the string would close at the escaped quote and
     * the scanner would anchor on that decoy "}" instead of the real stray "}" at the template end.
     */
    const service = createService()
    const context = createContext('content: "a\\\\"}"; }')

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 1)
    assert.strictEqual(diagnostics[0]?.messageText, 'at-rule or selector expected')
    assert.strictEqual(diagnostics[0]?.start, context.text.lastIndexOf('}'))
    assert.strictEqual(diagnostics[0]?.length, 1)
  })

  /**
   * The stray-brace scan reads strings, escapes, and "//" comments the way the CSS scanner does:
   * an escaped line break (a "\r\n" pair counts as one) and a hex escape's trailing line break stay
   * inside the string, while an unescaped "\f" ends a string or a "//" comment just as "\n" does.
   * Each expected offset is the "}" the CSS scanner reads as code, counted by hand.
   */
  it.each([
    /** `"a\` + LF: the string runs through `}"` (13, 14), so the stray "}" is the last one, at 17. */
    ['an escaped LF inside a string', 'content: "a\\\n}"; }', 17],
    /** `"a\` + CRLF: the escape covers both "\r" (12) and "\n" (13); the stray "}" is at 18. */
    ['an escaped CRLF inside a string', 'content: "a\\\r\n}"; }', 18],
    /** `"\41` + LF: the hex escape absorbs the LF (13), so the string runs through `}"`; stray "}" at 18. */
    ['a hex escape followed by LF inside a string', 'content: "\\41\n}"; }', 18],
    /** `"a` + FF: the string ends before the "\f" (11), so the "}" at 12 closes the wrapper. */
    ['a form feed ending a string', 'content: "a\f}', 12],
    /** `// x` + FF: the comment ends at the "\f" (16), so the "}" at 17 is code. */
    ['a form feed ending a "//" comment', 'color: red; // x\f}', 17],
  ])(
    'should find the stray "}" after %s, matching the CSS scanner, against the real CSS language service',
    (_description, text, strayBraceOffset) => {
      const context = createContext(text)

      const diagnostics = createService().getSemanticDiagnostics(context)

      assert.deepEqual(
        diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
        [{ length: 1, messageText: 'at-rule or selector expected', start: strayBraceOffset }],
      )
    },
  )

  it("should report the CSS language service's own diagnostic on the bad string after a form-feed-ended string closes the wrapper early", () => {
    /**
     * `"a` ends before the "\f" (11), the "}" at 12 closes the wrapper, and `"; }` (13 through the
     * template end, 4 characters) is a second, unterminated string at the top level, which the CSS
     * language service itself flags at its own position; no end-of-template diagnostic remains to
     * re-anchor.
     */
    const context = createContext('content: "a\f}"; }')

    const diagnostics = createService().getSemanticDiagnostics(context)

    assert.deepEqual(
      diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
      [{ length: 4, messageText: 'at-rule or selector expected', start: 13 }],
    )
  })

  describe('nested block @layer, against the real CSS language service', () => {
    it.each([
      ['a named layer', '@layer utilities {\n  color: red;\n}'],
      [
        'a dotted layer name inside a rule',
        '&:hover {\n  @layer framework.base { color: red; }\n}',
      ],
      ['an anonymous layer', '@layer {\n  color: red;\n}'],
    ])('should report no diagnostics for declarations in %s', (_description, text) => {
      assert.deepEqual(
        createService().getSemanticDiagnostics(createContext(text, 'styled.div')),
        [],
      )
    })

    it('should map a real diagnostic inside a nested layer to its own position', () => {
      const context = createContext('@layer utilities {\n  colr: red;\n}', 'styled.div')

      const diagnostics = createService().getSemanticDiagnostics(context)

      assert.deepEqual(
        diagnostics.map(({ length, messageText, start }) => ({ length, messageText, start })),
        [
          {
            length: 'colr'.length,
            messageText: "Unknown property: 'colr'",
            start: context.text.indexOf('colr'),
          },
        ],
      )
    })

    it('should offer property completions and hover inside a nested layer', () => {
      const completionContext = createContext('@layer utilities {\n  opa', 'styled.div')
      const hoverContext = createContext('@layer utilities {\n  color: red;\n}', 'styled.div')
      const service = createService()

      const opacity = service
        .getCompletionsAtPosition(
          completionContext,
          completionContext.toPosition(completionContext.text.length),
        )
        .entries.find((entry) => entry.name === 'opacity')
      const hover = service.getQuickInfoAtPosition(
        hoverContext,
        hoverContext.toPosition(hoverContext.text.indexOf('color') + 1),
      )

      assert.deepEqual(opacity?.replacementSpan, {
        length: 'opa'.length,
        start: completionContext.text.indexOf('opa'),
      })
      assert.deepEqual(hover?.textSpan, {
        length: 'color: red'.length,
        start: hoverContext.text.indexOf('color'),
      })
      assert.match(ts.displayPartsToString(hover?.documentation), /Sets the color/i)
    })

    it('should fold a nested layer from its opening line to its last body line', () => {
      const text = '@layer utilities {\n  color: red;\n}'

      assert.deepEqual(
        createService()
          .getOutliningSpans(createContext(text, 'styled.div'))
          .map((span) => span.textSpan),
        [{ length: text.indexOf('\n') + 1, start: 0 }],
      )
    })

    it('should still report a declaration directly in a global-style template top-level layer', () => {
      /**
       * A global-style template's top level is the stylesheet's top level, where a layer body holds
       * rules, not declarations: the prelude stays untouched there, so the parser's own error
       * stands.
       */
      const context = createContext('@layer base { color: red; }', 'createGlobalStyle')

      assert.deepEqual(
        createService()
          .getSemanticDiagnostics(context)
          .map(({ messageText, start }) => ({ messageText, start })),
        [{ messageText: '{ expected', start: context.text.indexOf(':') }],
      )
    })
  })

  describe('value-shaped css fragments, against the real CSS language service', () => {
    it.each([
      ['a border value', '1px solid red'],
      ['an animation value after a whitespace-filled placeholder', '      1s linear'],
      ['a multi-line animation value', '\n  spin 2s linear infinite\n'],
      ['a background value with a url', 'url(http://x/a.png) no-repeat'],
    ])('should report no diagnostics for %s', (_description, text) => {
      assert.deepEqual(createService().getSemanticDiagnostics(createContext(text)), [])
    })

    it.each([
      ['a keyword', 'red'],
      ['"none"', 'none'],
      ['a unit after a whitespace-filled placeholder', '    px'],
      ['an unknown name', 'colr'],
      ['a name on its own line', '\n  dis\n'],
      ['a name before an unclosed comment', 'red /* note'],
    ])(
      'should report no diagnostics for a single identifier, %s, which reads as a value as much as a property name',
      (_description, text) => {
        const service = createService()

        assert.deepEqual(service.getSemanticDiagnostics(createContext(text)), [])
        /** Positive control: a declaration in the same kind of fragment still reports. */
        assert.deepEqual(
          service
            .getSemanticDiagnostics(createContext('colr: red;'))
            .map(({ length, messageText, start }) => ({ length, messageText, start })),
          [{ length: 'colr'.length, messageText: "Unknown property: 'colr'", start: 0 }],
        )
      },
    )

    it('should keep a diagnostic of a single-identifier fragment that both readings report', () => {
      const context = createContext('red')
      const position = { line: 1, character: 0 }
      const service = createServiceWithLanguageServiceResponses({
        diagnostics: [
          {
            code: 'css-lint-example',
            message: 'reported under either wrapper',
            range: { end: position, start: position },
          },
        ],
      })

      assert.deepEqual(
        service
          .getSemanticDiagnostics(context)
          .map(({ length, messageText, start }) => ({ length, messageText, start })),
        [{ length: 0, messageText: 'reported under either wrapper', start: 0 }],
      )
    })

    it('should clamp a value diagnostic on the closing wrapper to the template end', () => {
      const context = createContext('rgba(0, 0, 0')

      assert.deepEqual(
        createService()
          .getSemanticDiagnostics(context)
          .map(({ length, messageText, start }) => ({ length, messageText, start })),
        [{ length: 0, messageText: ') expected', start: context.text.length }],
      )
    })

    it('should offer value completions, not property names, inside a value fragment', () => {
      const context = createContext('1px solid ')
      const names = createService()
        .getCompletionsAtPosition(context, context.toPosition(context.text.length))
        .entries.map((entry) => entry.name)

      assert.include(names, 'inherit')
      assert.notInclude(names, 'display')
    })

    it('should keep property completions while the first declaration of a css fragment is typed', () => {
      const context = createContext('\n  dis')
      const display = createService()
        .getCompletionsAtPosition(context, context.toPosition(context.text.length))
        .entries.find((entry) => entry.name === 'display')

      assert.deepEqual(display?.replacementSpan, {
        length: 'dis'.length,
        start: context.text.indexOf('dis'),
      })
    })
  })

  it('should keep a real end-of-template diagnostic whose code is not "at-rule or selector expected"', () => {
    const context = createContext('color: red;')
    const templateEndPosition = { line: 1, character: context.text.length }
    const service = createServiceWithLanguageServiceResponses({
      diagnostics: [
        {
          range: { start: templateEndPosition, end: templateEndPosition },
          message: '} expected',
          code: 'css-rcurlyexpected',
        },
      ],
    })

    const diagnostics = service.getSemanticDiagnostics(context)

    assert.strictEqual(diagnostics.length, 1)
    assert.strictEqual(diagnostics[0]?.messageText, '} expected')
    assert.strictEqual(diagnostics[0]?.start, context.text.length)
  })

  it('should omit diagnostics and hover ranges that cross the virtual document wrapper', () => {
    const context = createContext('color: red;')
    const range = {
      start: { line: 0, character: 0 },
      end: { line: 1, character: 1 },
    }
    const service = createServiceWithLanguageServiceResponses({
      diagnostics: [{ range, message: 'wrapper diagnostic' }],
      hover: { range, contents: 'wrapper hover' },
    })

    assert.deepEqual(service.getSemanticDiagnostics(context), [])
    assert.isUndefined(service.getQuickInfoAtPosition(context, context.toPosition(1)))
  })

  it('should omit code actions when any edit targets the virtual document wrapper', () => {
    const context = createContext('color: reed;')
    const inside = createRenameCodeAction({
      end: 11,
      newText: 'red',
      start: 7,
      title: 'Fix inside',
    })
    const service = createServiceWithLanguageServiceResponses({
      codeActions: [
        {
          title: 'Fix color',
          command: CSS_APPLY_CODE_ACTION_COMMAND,
          arguments: [
            undefined,
            undefined,
            [
              {
                range: {
                  start: { line: 1, character: 7 },
                  end: { line: 1, character: 11 },
                },
                newText: 'red',
              },
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 1 },
                },
                newText: '',
              },
            ],
          ],
        },
        inside,
      ],
      diagnostics: [createLineOneDiagnostic(7, 11)],
    })

    assert.deepEqual(
      service
        .getCodeFixesAtPosition(context, 0, context.text.length, [9999])
        .map((fix) => fix.description),
      ['Fix inside'],
    )
  })

  it('should ignore unsupported code action commands and commands without edits', () => {
    const context = createContext('boarder: 1px solid black;')
    const service = createServiceWithLanguageServiceResponses({
      codeActions: [
        { title: 'External action', command: 'external.action' },
        { title: 'Missing edits', command: CSS_APPLY_CODE_ACTION_COMMAND },
        RENAME_TO_BORDER,
      ],
      diagnostics: [createLineOneDiagnostic(0, 7)],
    })

    assert.deepEqual(
      service.getCodeFixesAtPosition(context, 0, 7, [9999]).map((fix) => fix.description),
      ["Rename to 'border'"],
    )
  })

  it('should support the legacy three-argument code fix API', () => {
    const context = createContext('boarder: 1px solid black;')
    const service = createServiceWithLanguageServiceResponses({
      codeActions: [RENAME_TO_BORDER],
      diagnostics: [createLineOneDiagnostic(0, 7)],
    })

    const fixes = service.getCodeFixesAtPosition(context, 0, 7)

    assert.deepEqual(fixes, [
      {
        description: "Rename to 'border'",
        changes: [
          {
            fileName: context.fileName,
            textChanges: [{ newText: 'border', span: { start: 0, length: 7 } }],
          },
        ],
      },
    ])
  })

  it('should offer no code fix for a diagnostic the single-identifier intersection suppresses', () => {
    /** Reported under the declaration wrapper only, so the value reading drops it. */
    const rootReadingOnly = (document: TextDocument) =>
      document.getText().startsWith(':root{\n')
        ? [
            {
              code: 'unknownProperties',
              message: "Unknown property: 'colr'",
              range: { end: { line: 1, character: 4 }, start: { line: 1, character: 0 } },
            },
          ]
        : []
    const service = createServiceWithLanguageServiceResponses({
      codeActions: [
        createRenameCodeAction({ end: 4, newText: 'color', start: 0, title: "Rename to 'color'" }),
      ],
      diagnostics: rootReadingOnly,
    })
    const suppressed = createContext('colr')
    const control = createContext('colr: red;')

    assert.deepEqual(service.getSemanticDiagnostics(suppressed), [])
    assert.deepEqual(service.getCodeFixesAtPosition(suppressed, 0, 4), [])
    assert.deepEqual(
      service.getCodeFixesAtPosition(control, 0, 4).map((fix) => fix.description),
      ["Rename to 'color'"],
    )
  })

  it('should answer a code fix request from the validation cache the diagnostics request filled', () => {
    const position = { line: 1, character: 0 }
    const factory = createFakeLanguageServiceFactory([], {
      diagnostics: [
        {
          message: 'unknown property',
          range: { end: { line: 1, character: 4 }, start: position },
        },
      ],
    })
    const service = createServiceWithFactory(factory)
    const context = createContext('colr: red;')

    service.getSemanticDiagnostics(context)
    service.getCodeFixesAtPosition({ ...context }, 0, 4)

    assert.strictEqual(factory.validationRequests, 1)
    assert.strictEqual(factory.codeActionRequests, 1)
  })

  it('should return the supported code fix code without building a language service', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)

    assert.deepEqual(service.getSupportedCodeFixes(), [9999])
    assert.deepEqual(factory.scssConfigurations, [])
  })

  it('should convert nested CSS folding ranges to template offsets', () => {
    const context = createContext(['a {', '  color: red;', '}', 'div {', '', '}'].join('\n'))
    const spans = createService().getOutliningSpans(context)

    assert.strictEqual(spans.length, 2)
    assert.deepEqual(spans[0]?.textSpan, { start: 0, length: 4 })
    assert.deepEqual(spans[1]?.textSpan, { start: 20, length: 6 })
  })

  it('should default missing folding range characters to the start of each line', () => {
    const context = createContext(['a {', '  color: red;', '}'].join('\n'))
    const service = createServiceWithLanguageServiceResponses({
      foldingRanges: [{ startLine: 1, endLine: 2 }],
    })

    assert.deepEqual(service.getOutliningSpans(context), [
      {
        autoCollapse: false,
        kind: ts.OutliningSpanKind.Code,
        bannerText: '',
        textSpan: { start: 0, length: 4 },
        hintSpan: { start: 0, length: 4 },
      },
    ])
  })

  it('should omit folding ranges that target the virtual document wrapper', () => {
    const context = createContext('color: red;')
    const service = createServiceWithLanguageServiceResponses({
      foldingRanges: [{ startLine: 0, endLine: 1, endCharacter: 1 }],
    })

    assert.deepEqual(service.getOutliningSpans(context), [])
  })

  it('should use injected language services and reconfigure them on updates', () => {
    const manager = new PluginConfigurationManager()
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory, { configurationManager: manager })

    service.getCompletionsAtPosition(createContext('color:'), { line: 0, character: 6 })
    service.getCompletionsAtPosition(createContext('display:'), { line: 0, character: 8 })
    const initialConfiguration = manager.config
    manager.updateFromPluginConfig({ tags: ['sty'] })

    assert.strictEqual(factory.completionRequests, 4)
    assert.deepEqual(manager.config.tags, ['sty'])
    for (const configurations of [factory.cssConfigurations, factory.scssConfigurations]) {
      assert.strictEqual(configurations.length, 2)
      assert.strictEqual(configurations[0], initialConfiguration)
      assert.strictEqual(configurations[1], manager.config)
    }
  })

  it('should invalidate completion results when configuration changes', () => {
    const manager = new PluginConfigurationManager()
    const emmetConfigurations: StyledPluginConfiguration['emmet'][] = []
    const emmetCompletionProvider: EmmetCompletionProvider = {
      doComplete(_document, _position, configuration) {
        emmetConfigurations.push(configuration)
        return {
          isIncomplete: false,
          items: [{ label: configuration.showSuggestionsAsSnippets ? 'updated' : 'initial' }],
        }
      },
    }
    const service = createServiceWithFactory(createFakeLanguageServiceFactory(), {
      configurationManager: manager,
      emmetCompletionProvider,
    })
    const context = createContext('m10')
    const position = context.toPosition(context.text.length)

    const initial = service.getCompletionsAtPosition(context, position)
    service.getCompletionsAtPosition(context, position)
    manager.updateFromPluginConfig({ emmet: { showSuggestionsAsSnippets: true } })
    const updated = service.getCompletionsAtPosition(context, position)

    assert.strictEqual(emmetConfigurations.length, 2)
    assert.isUndefined(emmetConfigurations[0]?.showSuggestionsAsSnippets)
    assert.isTrue(emmetConfigurations[1]?.showSuggestionsAsSnippets)
    assert.isDefined(initial.entries.find((entry) => entry.name === 'initial'))
    assert.isDefined(updated.entries.find((entry) => entry.name === 'updated'))
    assert.isUndefined(updated.entries.find((entry) => entry.name === 'initial'))
  })

  it('should reuse parsed virtual documents across features and invalidate changed contexts', () => {
    const factory = createFakeLanguageServiceFactory()
    const virtualDocumentProvider = new StyledVirtualDocumentProvider(ts)
    const createVirtualDocument = vi.spyOn(virtualDocumentProvider, 'createVirtualDocument')
    const service = createServiceWithFactory(factory, { virtualDocumentProvider })
    const context = createContext('color:')

    service.getSemanticDiagnostics(context)
    service.getQuickInfoAtPosition(context, context.toPosition(1))
    service.getCompletionsAtPosition(context, context.toPosition(context.text.length))
    service.getCodeFixesAtPosition(context, 0, context.text.length, [9999])
    service.getOutliningSpans(context)

    assert.strictEqual(createVirtualDocument.mock.calls.length, 1)
    assert.strictEqual(factory.parsedDocuments.length, 1)

    service.getSemanticDiagnostics(createContext('display:'))
    assert.strictEqual(createVirtualDocument.mock.calls.length, 2)
    assert.strictEqual(factory.parsedDocuments.length, 2)

    service.getSemanticDiagnostics(createContext('display:', 'keyframes'))
    assert.strictEqual(createVirtualDocument.mock.calls.length, 3)
    assert.strictEqual(factory.parsedDocuments.length, 3)
    assert.match(factory.parsedDocuments[2]?.getText() ?? '', /^@keyframes/)
  })

  it('should reuse a raw validation result for an unchanged template (hit)', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)

    service.getSemanticDiagnostics(createContext('color: red;'))
    service.getSemanticDiagnostics(createContext('color: red;'))

    assert.strictEqual(factory.validationRequests, 1)
  })

  it('should re-validate after the template text changes (miss)', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)

    service.getSemanticDiagnostics(createContext('color: red;'))
    service.getSemanticDiagnostics(createContext('color: blue;'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should not collapse two templates whose raw text differs only in an unpaired surrogate into the same cache entry', () => {
    /**
     * The validation cache key is a flattened copy of wrapper plus raw text (flattenCacheKey,
     * src/features/diagnostics.ts): flattening through a UTF-8 round trip would rewrite every
     * unpaired surrogate to U+FFFD, making two templates that differ only in which unpaired
     * surrogate they contain collide on the same cache entry and serve one template's stale
     * diagnostics for the other.
     */
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)
    const highSurrogate = String.fromCharCode(0xd800)
    const lowSurrogate = String.fromCharCode(0xdc00)

    service.getSemanticDiagnostics(createContext(`color: a${highSurrogate}b;`))
    service.getSemanticDiagnostics(createContext(`color: a${lowSurrogate}b;`))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should validate a single-identifier css fragment under both readings once, then answer from the cache', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)

    service.getSemanticDiagnostics(createContext('red'))
    service.getSemanticDiagnostics(createContext('red'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should re-validate every cached template after configuration changes (miss)', () => {
    const manager = new PluginConfigurationManager()
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory, { configurationManager: manager })

    service.getSemanticDiagnostics(createContext('color: red;'))
    manager.updateFromPluginConfig({ lint: { unknownProperties: 'error' } })
    service.getSemanticDiagnostics(createContext('color: red;'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should evict the least recently used raw validation result once the cache is full', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)
    /** One more template than MAX_VALIDATION_CACHE_ENTRIES (src/features/diagnostics.ts) so the first entry is evicted before it is asked for again. */
    const templateCount = MAX_VALIDATION_CACHE_ENTRIES + 1

    for (let index = 0; index < templateCount; index++) {
      service.getSemanticDiagnostics(createContext(`.rule-${index} { color: red; }`))
    }
    assert.strictEqual(factory.validationRequests, templateCount)

    service.getSemanticDiagnostics(createContext('.rule-0 { color: red; }'))
    assert.strictEqual(factory.validationRequests, templateCount + 1)

    service.getSemanticDiagnostics(createContext(`.rule-${templateCount - 1} { color: red; }`))
    assert.strictEqual(factory.validationRequests, templateCount + 1)
  })

  it("should refresh an entry's recency on a hit, so it survives an eviction an untouched entry would not", () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)

    for (let index = 0; index < MAX_VALIDATION_CACHE_ENTRIES; index++) {
      service.getSemanticDiagnostics(createContext(`.rule-${index} { color: red; }`))
    }
    assert.strictEqual(factory.validationRequests, MAX_VALIDATION_CACHE_ENTRIES)

    /** A hit on the oldest entry (rule-0) moves it to the newest end of the LRU order. */
    service.getSemanticDiagnostics(createContext('.rule-0 { color: red; }'))
    assert.strictEqual(factory.validationRequests, MAX_VALIDATION_CACHE_ENTRIES)

    /** One new template forces exactly one eviction: the now-oldest entry (rule-1), not the just-refreshed rule-0. */
    service.getSemanticDiagnostics(
      createContext(`.rule-${MAX_VALIDATION_CACHE_ENTRIES} { color: red; }`),
    )
    const requestsAfterInsert = factory.validationRequests

    service.getSemanticDiagnostics(createContext('.rule-0 { color: red; }'))
    assert.strictEqual(factory.validationRequests, requestsAfterInsert)

    service.getSemanticDiagnostics(createContext('.rule-1 { color: red; }'))
    assert.strictEqual(factory.validationRequests, requestsAfterInsert + 1)
  })

  it('should not reuse documents across contexts for a custom provider without a cache key', () => {
    const factory = createFakeLanguageServiceFactory()
    const provider: VirtualDocumentProvider = {
      ...createCustomVirtualDocumentProvider('', ''),
      createVirtualDocument(context) {
        return TextDocument.create('untitled://custom.scss', 'scss', 1, context.rawText)
      },
    }
    const service = createServiceWithFactory(factory, { virtualDocumentProvider: provider })
    const context = createContext('same')

    service.getSemanticDiagnostics({ ...context, rawText: 'first' })
    service.getSemanticDiagnostics({ ...context, rawText: 'second' })

    assert.deepEqual(
      factory.parsedDocuments.map((document) => document.getText()),
      ['first', 'second'],
    )
  })

  it('should not reuse a raw validation result for a custom provider without canReuseVirtualDocument', () => {
    /**
     * The raw validation cache assumes a virtual document (and therefore doValidation's result)
     * is a pure function of wrapper plus raw text, an assumption canReuseVirtualDocument is what
     * proves for the built-in provider (docs/architecture.md, Caching): a provider without it
     * gets no reuse here either, matching the single-entry virtual-document cache.
     */
    const factory = createFakeLanguageServiceFactory()
    const provider: VirtualDocumentProvider = {
      ...createCustomVirtualDocumentProvider('', ''),
      createVirtualDocument(context) {
        return TextDocument.create('untitled://custom.scss', 'scss', 1, context.rawText)
      },
    }
    const service = createServiceWithFactory(factory, { virtualDocumentProvider: provider })

    service.getSemanticDiagnostics(createContext('color: red;'))
    service.getSemanticDiagnostics(createContext('color: red;'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should key the raw validation cache by wrapper as well as raw text, so "css" and "keyframes" templates with the same text do not share an entry', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)

    service.getSemanticDiagnostics(createContext('color: red;', 'css'))
    service.getSemanticDiagnostics(createContext('color: red;', 'keyframes'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should not reuse a raw validation result for a third-party provider whose canReuseVirtualDocument returns false', () => {
    /**
     * The memo trusts only the built-in StyledVirtualDocumentProvider (checked by identity, not
     * by merely finding a same-named method): a third-party provider that defines
     * canReuseVirtualDocument, even one that itself always answers false, must still get no reuse
     * here, since this cache never calls the method at all and a provider merely shaped like the
     * interface is not proof its virtual document is a pure function of wrapper plus raw text.
     */
    const factory = createFakeLanguageServiceFactory()
    const provider: VirtualDocumentProvider = {
      ...createCustomVirtualDocumentProvider('', ''),
      createVirtualDocument(context) {
        return TextDocument.create('untitled://custom.scss', 'scss', 1, context.rawText)
      },
      canReuseVirtualDocument() {
        return false
      },
    }
    const service = createServiceWithFactory(factory, { virtualDocumentProvider: provider })

    service.getSemanticDiagnostics(createContext('color: red;'))
    service.getSemanticDiagnostics(createContext('color: red;'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should not reuse a raw validation result for a third-party provider whose canReuseVirtualDocument returns true', () => {
    const factory = createFakeLanguageServiceFactory()
    const provider: VirtualDocumentProvider = {
      ...createCustomVirtualDocumentProvider('', ''),
      createVirtualDocument(context) {
        return TextDocument.create('untitled://custom.scss', 'scss', 1, context.rawText)
      },
      canReuseVirtualDocument() {
        return true
      },
    }
    const service = createServiceWithFactory(factory, { virtualDocumentProvider: provider })

    service.getSemanticDiagnostics(createContext('color: red;'))
    service.getSemanticDiagnostics(createContext('color: red;'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should not collide two distinct (reading key, rawText) pairs whose plain concatenation would be identical', () => {
    /**
     * A subclass of the built-in provider still passes the identity check the memo trusts, so it
     * can otherwise reuse a stale result across two calls whose reading key and rawText
     * concatenate to the same characters ("a" + "b;c" and "ab" + ";c" both concatenate to
     * "ab;c"): the key must keep them apart by length-prefixing the reading key
     * (buildValidationCacheKey) rather than by plain string concatenation.
     */
    class OverriddenReadingProvider extends StyledVirtualDocumentProvider {
      public readingKeyOverride = ''
      public override getReadingKey(): string {
        return this.readingKeyOverride
      }
    }
    const factory = createFakeLanguageServiceFactory()
    const provider = new OverriddenReadingProvider(ts)
    const service = createServiceWithFactory(factory, { virtualDocumentProvider: provider })

    provider.readingKeyOverride = 'a'
    service.getSemanticDiagnostics(createContext('b;c'))
    provider.readingKeyOverride = 'ab'
    service.getSemanticDiagnostics(createContext(';c'))

    assert.strictEqual(factory.validationRequests, 2)
  })

  it('should not create a virtual document on a raw validation cache hit', () => {
    /**
     * A cache hit must not build (and evict the session's single-entry cache with) a virtual
     * document purely to resolve positions for diagnostics the raw validation cache already
     * answers: the session's document cache holds "color: blue;" (the most recent request) when
     * "color: red;" comes around again, so a hit for "color: red;" must derive its TemplateLineMap
     * directly from context.rawText instead of rebuilding a document for it.
     */
    const factory = createFakeLanguageServiceFactory()
    const virtualDocumentProvider = new StyledVirtualDocumentProvider(ts)
    const createVirtualDocument = vi.spyOn(virtualDocumentProvider, 'createVirtualDocument')
    const service = createServiceWithFactory(factory, { virtualDocumentProvider })

    service.getSemanticDiagnostics(createContext('color: red;'))
    service.getSemanticDiagnostics(createContext('color: blue;'))
    assert.strictEqual(createVirtualDocument.mock.calls.length, 2)

    service.getSemanticDiagnostics(createContext('color: red;'))

    assert.strictEqual(createVirtualDocument.mock.calls.length, 2)
    assert.strictEqual(factory.validationRequests, 2)
  })

  describe('substitution on unchanged templates', () => {
    /**
     * The decorator substitutes a template's placeholders lazily, on the first read of
     * `TemplateContext.text`, and builds a fresh context per request. A request whose answer is
     * already cached (a validation hit, a reusable document) has no use for the substituted text,
     * so it must not force it.
     */
    it('should substitute placeholders in the counting context, once per context', () => {
      const counter = { count: 0 }
      const context = createSubstitutingContext('color: ${c};', 'styled.div', counter)

      assert.strictEqual(context.text, 'color: xxxx;')
      assert.strictEqual(context.text, 'color: xxxx;')
      assert.strictEqual(counter.count, 1)
    })

    it('should substitute nothing for a diagnostics request whose templates are all validation cache hits', () => {
      const counter = { count: 0 }
      const service = createService()
      const templates: Array<[string, string]> = [
        ['color: ${color};\npadding: ${pad}px;', 'styled.div'],
        ['colr: ${value};', 'styled.div'],
        ['colr', 'css'],
        ['${fadeIn} 1s linear', 'css'],
      ]
      const request = () =>
        templates.map(([text, tagName]) =>
          service
            .getSemanticDiagnostics(createSubstitutingContext(text, tagName, counter))
            .map(({ length, messageText, start }) => ({ length, messageText, start })),
        )

      const first = request()
      assert.strictEqual(counter.count, templates.length, 'each first request substitutes once')
      assert.deepEqual(first, [
        [],
        [{ length: 4, messageText: "Unknown property: 'colr'", start: 0 }],
        [],
        [],
      ])

      counter.count = 0
      const second = request()
      assert.strictEqual(counter.count, 0)
      assert.deepEqual(second, first)
    })

    it.each([
      ['styled.div', 'color: ${color};\nmargin: 0;'],
      ['css', 'color: ${color};\nmargin: 0;'],
    ])('should substitute nothing for a hover on a reusable document: %s', (tagName, text) => {
      const counter = { count: 0 }
      const service = createService()
      const hover = () => {
        const context = createSubstitutingContext(text, tagName, counter)
        return service.getQuickInfoAtPosition(context, context.toPosition(1))
      }

      const first = hover()
      assert.strictEqual(counter.count, 1, 'the first request substitutes once')
      /** A property hover spans its whole declaration, the ";" excluded. */
      assert.deepEqual(first?.textSpan, { length: 'color: ${color}'.length, start: 0 })

      counter.count = 0
      const second = hover()
      assert.strictEqual(counter.count, 0)
      assert.deepEqual(second, first)
    })

    it.each([
      ['styled.div', 'color: ${color};\nmargin: 0;'],
      ['css', 'color: ${color};\nmargin: 0;'],
    ])(
      'should substitute nothing for a completion at a new position on unchanged text: %s',
      (tagName, text) => {
        const counter = { count: 0 }
        const service = createService()
        const complete = (offset: number) => {
          const context = createSubstitutingContext(text, tagName, counter)
          return service.getCompletionsAtPosition(context, context.toPosition(offset))
        }
        const secondOffset = text.indexOf('margin') + 3

        complete(3)
        assert.strictEqual(counter.count, 1, 'the first request substitutes once')

        counter.count = 0
        const second = complete(secondOffset)
        assert.strictEqual(counter.count, 0)

        const freshContext = createSubstitutingContext(text, tagName, { count: 0 })
        const fresh = createService().getCompletionsAtPosition(
          freshContext,
          freshContext.toPosition(secondOffset),
        )
        assert.isTrue(second.entries.some((entry) => entry.name === 'margin'))
        assert.deepEqual(second, fresh)
      },
    )
  })

  it('should not reuse completions across contexts for a custom provider without a cache key', () => {
    const provider: VirtualDocumentProvider = {
      ...createCustomVirtualDocumentProvider('', ''),
      createVirtualDocument(context) {
        return TextDocument.create('untitled://custom.scss', 'scss', 1, context.rawText)
      },
    }
    const service = createServiceWithCompletionItems(
      (document) => [{ label: document.getText() }],
      provider,
    )
    const context = createContext('same')
    const position = context.toPosition(context.text.length)

    const first = service.getCompletionsAtPosition({ ...context, rawText: 'first' }, position)
    const second = service.getCompletionsAtPosition({ ...context, rawText: 'second' }, position)

    assert.deepEqual(
      first.entries.map((entry) => entry.name),
      ['first'],
    )
    assert.deepEqual(
      second.entries.map((entry) => entry.name),
      ['second'],
    )
  })

  it('should reuse the translated completion result across contexts with the same raw text and position', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)
    const context = createContext('color:')
    const position = context.toPosition(context.text.length)

    const first = service.getCompletionsAtPosition(context, position)
    const requestsAfterFirst = factory.completionRequests
    const second = service.getCompletionsAtPosition({ ...context }, position)

    /**
     * The second call reuses a different (but raw-text-identical) context object: proves the
     * cached, already-translated result is returned rather than re-running the underlying CSS
     * and SCSS completion requests (position translation itself is a pure function of raw text
     * and position, so it is not a useful signal here, see template-line-map.ts). The first call
     * makes one CSS and one SCSS request; "color:" holds no at-keyword, so no catalog request.
     */
    assert.strictEqual(requestsAfterFirst, 2)
    assert.strictEqual(factory.completionRequests, requestsAfterFirst)
    assert.deepEqual(second, first)
  })

  it('should return a completion result a caller can freely mutate without corrupting a later cache hit', () => {
    /**
     * ./api exposes StyledTemplateLanguageService directly to third-party consumers who may
     * reasonably hold and mutate a returned CompletionInfo (appending an entry, renaming one,
     * sorting the list). A cache hit returns a fresh CompletionInfo with a fresh entries array of
     * shallow-copied entries every time, so mutating one caller's result never reaches the cached
     * original or a later caller's result at the same position.
     */
    const service = createService()
    const context = createContext('color:')
    const position = context.toPosition(context.text.length)

    /** Populates the cache; the mutated result below comes from a cache hit, not this miss. */
    service.getCompletionsAtPosition(context, position)

    const first = service.getCompletionsAtPosition({ ...context }, position)
    const firstEntry = first.entries[0]
    assert.isDefined(firstEntry)
    const originalEntryCount = first.entries.length
    const originalFirstEntryName = firstEntry.name

    assert.doesNotThrow(() => {
      first.entries.push({
        name: 'injected',
        kind: ts.ScriptElementKind.unknown,
        sortText: 'injected',
      })
      firstEntry.name = 'renamed'
    })

    const second = service.getCompletionsAtPosition({ ...context }, position)
    assert.notStrictEqual(second, first)
    assert.strictEqual(second.entries.length, originalEntryCount)
    assert.isUndefined(second.entries.find((entry) => entry.name === 'injected'))
    assert.strictEqual(second.entries[0]?.name, originalFirstEntryName)
  })

  it('should return a fresh empty completion result per call, not a shared mutable object', () => {
    /**
     * ./api exposes StyledTemplateLanguageService directly to third-party consumers, who may
     * reasonably hold onto and mutate a returned CompletionInfo (appending their own entries,
     * for example): a shared "empty" object returned by reference to every caller would let one
     * consumer's mutation corrupt every other empty-template completion result for the rest of
     * the process.
     */
    const service = createService()
    const context = createContext('/* a */')
    const insideComment = context.toPosition('/* a'.length)

    const first = service.getCompletionsAtPosition(context, insideComment)
    first.entries.push({
      name: 'injected',
      kind: ts.ScriptElementKind.unknown,
      sortText: 'injected',
    })
    const second = service.getCompletionsAtPosition(context, insideComment)

    assert.deepEqual(second.entries, [])
  })

  it('should skip the language services for hover in an empty template', () => {
    const factory = createFakeLanguageServiceFactory()
    const virtualDocumentProvider = new StyledVirtualDocumentProvider(ts)
    const createVirtualDocument = vi.spyOn(virtualDocumentProvider, 'createVirtualDocument')
    const service = createServiceWithFactory(factory, { virtualDocumentProvider })
    const context = createContext('')

    assert.isUndefined(service.getQuickInfoAtPosition(context, { line: 0, character: 0 }))
    assert.strictEqual(createVirtualDocument.mock.calls.length, 0)
    assert.strictEqual(factory.parsedDocuments.length, 0)
    assert.strictEqual(factory.hoverRequests, 0)
  })

  it('should skip the CSS language services for completions inside a comment', () => {
    const factory = createFakeLanguageServiceFactory([{ label: 'css-item' }])
    const noEmmet: EmmetCompletionProvider = { doComplete: () => undefined }
    const service = createServiceWithFactory(factory, { emmetCompletionProvider: noEmmet })
    const comment = createContext('/* a */')
    const code = createContext('a')

    assert.deepEqual(
      service.getCompletionsAtPosition(comment, comment.toPosition('/* a'.length)).entries,
      [],
    )
    assert.strictEqual(factory.completionRequests, 0)
    assert.deepEqual(
      service
        .getCompletionsAtPosition(code, code.toPosition(code.text.length))
        .entries.map((entry) => entry.name),
      ['css-item'],
    )
  })

  it('should keep interactive requests isolated from diagnostics and code actions', () => {
    const factory = createFakeLanguageServiceFactory()
    const service = createServiceWithFactory(factory)
    const context = createContext('color:')

    service.getCompletionsAtPosition(context, context.toPosition(context.text.length))
    service.getQuickInfoAtPosition(context, context.toPosition(1))

    assert.strictEqual(factory.validationRequests, 0)
    assert.strictEqual(factory.codeActionRequests, 0)
  })

  describe('exception recovery', () => {
    /**
     * An uncaught exception here would fail the whole tsserver response for the file, including
     * TypeScript's own diagnostics. Each test replaces one lazily built feature getter (a
     * private accessor at runtime, like any other TypeScript "private" member) with one that
     * throws, isolating which entry point's recovery is under test.
     */
    it.each<
      [
        method: string,
        getter: string,
        request: (service: StyledTemplateLanguageService, context: TemplateContext) => unknown,
        fallback: unknown,
      ]
    >([
      [
        'getCompletionsAtPosition',
        'completions',
        (service, context) => service.getCompletionsAtPosition(context, context.toPosition(0)),
        {
          entries: [],
          isGlobalCompletion: false,
          isMemberCompletion: false,
          isNewIdentifierLocation: false,
          metadata: { isIncomplete: false },
        },
      ],
      [
        'getCompletionEntryDetails',
        'completions',
        (service, context) =>
          service.getCompletionEntryDetails(context, context.toPosition(0), 'aliceblue'),
        {
          displayParts: [{ kind: 'text', text: 'aliceblue' }],
          documentation: [],
          kind: ts.ScriptElementKind.unknown,
          kindModifiers: '',
          name: 'aliceblue',
          tags: [],
        },
      ],
      [
        'getQuickInfoAtPosition',
        'hover',
        (service, context) => service.getQuickInfoAtPosition(context, context.toPosition(0)),
        undefined,
      ],
      [
        'getSemanticDiagnostics',
        'diagnostics',
        (service, context) => service.getSemanticDiagnostics(context),
        [],
      ],
      [
        'getCodeFixesAtPosition',
        'codeActions',
        (service, context) => service.getCodeFixesAtPosition(context, 0, 1),
        [],
      ],
      [
        'getOutliningSpans',
        'folding',
        (service, context) => service.getOutliningSpans(context),
        [],
      ],
    ])(
      'should recover from %s throwing and return its fallback',
      (method, getter, request, fallback) => {
        const logger = { log: vi.fn() }
        const service = new StyledTemplateLanguageService(
          ts,
          new PluginConfigurationManager(),
          new StyledVirtualDocumentProvider(ts),
          logger,
        )
        Object.defineProperty(service, getter, {
          get() {
            throw new Error(`${getter} feature construction failed`)
          },
        })

        assert.deepEqual(request(service, createContext('color: red;')), fallback)
        assert.strictEqual(logger.log.mock.calls.length, 1)
        assert.match(
          logger.log.mock.calls[0]?.[0],
          new RegExp(`^${method} threw and was recovered`),
        )
      },
    )

    it('should still recover when no logger was supplied', () => {
      const service = new StyledTemplateLanguageService(
        ts,
        new PluginConfigurationManager(),
        new StyledVirtualDocumentProvider(ts),
      )
      Object.defineProperty(service, 'diagnostics', {
        get() {
          throw new Error('diagnostics feature construction failed')
        },
      })
      const context = createContext('color: red;')

      let result: ts.Diagnostic[] | undefined
      assert.doesNotThrow(() => {
        result = service.getSemanticDiagnostics(context)
      })
      assert.deepEqual(result, [])
    })

    it('should keep working on a later request after an earlier one threw', () => {
      /**
       * A recovered exception must not leave the service (or a lazily built feature instance) in
       * a broken state. Reproduced here against the real CSS language service, not a fake, using
       * the exact virtual-document text template-substitutions.ts produces for a placeholder used
       * as a property name and a placeholder used as its value, for example
       * `` `${prop}: ${value};` `` (the fake property fill is "$a" plus x-fill,
       * template-substitutions.ts, so the virtual text becomes "$axxxxx: xxxxxxxx;"): a
       * completions request with the caret at the very start of that fake property throws inside
       * vscode-css-languageservice's own property-completion code (declaration.getProperty is not
       * a function, cssCompletion.js), so this also stands as the regression test for that
       * specific upstream defect. createContext (create-template-context.ts) does not run
       * substitution (unlike the real decorator), so the already-substituted shape is passed as both
       * context.text and context.rawText, matching what the real pipeline would hand this class.
       */
      const logger = { log: vi.fn() }
      const service = new StyledTemplateLanguageService(
        ts,
        new PluginConfigurationManager(),
        new StyledVirtualDocumentProvider(ts),
        logger,
      )
      const throwingContext = createContext('\n  $axxxxx: xxxxxxxx;\n  ')

      const firstResult = service.getCompletionsAtPosition(
        throwingContext,
        throwingContext.toPosition(3),
      )
      assert.deepEqual(firstResult.entries, [])
      assert.strictEqual(logger.log.mock.calls.length, 1)
      assert.match(logger.log.mock.calls[0]?.[0], /getCompletionsAtPosition threw/)

      const laterContext = createContext('color:')
      const laterResult = service.getCompletionsAtPosition(
        laterContext,
        laterContext.toPosition(laterContext.text.length),
      )
      assert.isTrue(laterResult.entries.some((entry) => entry.name === 'aliceblue'))
    })
  })
})

/**
 * A context for `rawText` shaped like the decorator's StandardTemplateContext: `text` is a lazy
 * getter, memoized per context, that substitutes the placeholders on its first read, counted in
 * `counter`. The placeholder spans are derived from the template node the way the decorator
 * derives them (PlaceholderSubstituter.getPlaceholderSpans).
 */
function createSubstitutingContext(
  rawText: string,
  tagName: string,
  counter: { count: number },
): TemplateContext {
  const base = createContext(rawText, tagName)
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
      if (text === undefined) {
        counter.count++
        text = getTemplateSubstitutions(base.rawText, spans)
      }
      return text
    },
    toOffset: base.toOffset,
    toPosition: base.toPosition,
    typescript: base.typescript,
  }
}

function createService() {
  return new StyledTemplateLanguageService(
    ts,
    new PluginConfigurationManager(),
    new StyledVirtualDocumentProvider(ts),
  )
}

interface ServiceOptions {
  readonly configurationManager?: PluginConfigurationManager
  readonly emmetCompletionProvider?: EmmetCompletionProvider
  readonly virtualDocumentProvider?: VirtualDocumentProvider
}

function createServiceWithFactory(
  factory: StylesLanguageServiceFactory,
  {
    configurationManager = new PluginConfigurationManager(),
    emmetCompletionProvider,
    virtualDocumentProvider = new StyledVirtualDocumentProvider(ts),
  }: ServiceOptions = {},
) {
  return new StyledTemplateLanguageService(
    ts,
    configurationManager,
    virtualDocumentProvider,
    factory,
    emmetCompletionProvider,
  )
}

function createServiceWithCompletionItems(
  completionItems: CompletionItem[] | ((document: TextDocument) => CompletionItem[]),
  virtualDocumentProvider?: VirtualDocumentProvider,
) {
  return createServiceWithFactory(createFakeLanguageServiceFactory(completionItems), {
    virtualDocumentProvider,
  })
}

function createCustomVirtualDocumentProvider(
  prefix: string,
  suffix: string,
): VirtualDocumentProvider {
  return {
    createVirtualDocument(context) {
      return TextDocument.create(
        'untitled://custom.scss',
        'scss',
        1,
        `${prefix}${context.text}${suffix}`,
      )
    },
    toVirtualDocPosition(position) {
      return { line: position.line, character: position.character + prefix.length }
    },
    fromVirtualDocPosition(position) {
      return { line: position.line, character: position.character - prefix.length }
    },
    toVirtualDocOffset(offset) {
      return offset + prefix.length
    },
    fromVirtualDocOffset(offset) {
      return offset - prefix.length
    },
    getVirtualDocumentWrapper() {
      return prefix
    },
  }
}

/**
 * A provider whose offset mapping is not a fixed shift: its virtual document inserts `marker`
 * right before raw offset `insertAt`, so an offset before the insertion shifts by only
 * `prefix.length`, and one at or after it shifts by `prefix.length + marker.length`. Exercises
 * translateCompletionListToCompletionInfo's non-shift-mapped branch (completions.ts), which must
 * call toVirtualDocOffset/fromVirtualDocOffset per offset instead of subtracting one constant.
 */
function createNonShiftVirtualDocumentProvider({
  insertAt,
  marker,
  prefix,
}: {
  insertAt: number
  marker: string
  prefix: string
}): VirtualDocumentProvider {
  const toVirtual = (offset: number) =>
    offset < insertAt ? offset + prefix.length : offset + prefix.length + marker.length
  const fromVirtual = (offset: number) =>
    offset < insertAt + prefix.length
      ? offset - prefix.length
      : offset - prefix.length - marker.length

  return {
    createVirtualDocument(context) {
      return TextDocument.create(
        'untitled://custom-non-shift.scss',
        'scss',
        1,
        `${prefix}${context.rawText.slice(0, insertAt)}${marker}${context.rawText.slice(insertAt)}`,
      )
    },
    toVirtualDocPosition(position) {
      return { line: position.line, character: toVirtual(position.character) }
    },
    fromVirtualDocPosition(position) {
      return { line: position.line, character: fromVirtual(position.character) }
    },
    toVirtualDocOffset(offset) {
      return toVirtual(offset)
    },
    fromVirtualDocOffset(offset) {
      return fromVirtual(offset)
    },
    getVirtualDocumentWrapper() {
      return prefix
    },
  }
}

function createServiceWithLanguageServiceResponses(responses: FakeLanguageServiceResponses) {
  return createServiceWithFactory(createFakeLanguageServiceFactory([], responses))
}

const RENAME_TO_BORDER = createRenameCodeAction({
  end: 7,
  newText: 'border',
  start: 0,
  title: "Rename to 'border'",
})

/** A diagnostic on the first template line (virtual line 1) from `start` to `end`. */
function createLineOneDiagnostic(start: number, end: number): Diagnostic {
  return {
    message: 'fixable',
    range: { end: { line: 1, character: end }, start: { line: 1, character: start } },
  }
}

/** A CSS code action with one edit on the first template line, the shape the CSS service emits. */
function createRenameCodeAction({
  end,
  newText,
  start,
  title,
}: {
  end: number
  newText: string
  start: number
  title: string
}): Command {
  return {
    arguments: [
      undefined,
      undefined,
      [
        {
          newText,
          range: { end: { line: 1, character: end }, start: { line: 1, character: start } },
        },
      ],
    ],
    command: CSS_APPLY_CODE_ACTION_COMMAND,
    title,
  }
}

function createCompletionItem(label: string, range: Range): CompletionItem {
  return {
    label,
    textEdit: { range, newText: label },
  }
}

function createFakeLanguageServiceFactory(
  completionItems: CompletionItem[] | ((document: TextDocument) => CompletionItem[]) = [],
  responses: FakeLanguageServiceResponses = {},
): StylesLanguageServiceFactory & {
  readonly codeActionRequests: number
  readonly completionRequests: number
  cssConfigurations: LanguageSettings[]
  readonly hoverRequests: number
  parsedDocuments: TextDocument[]
  scssConfigurations: LanguageSettings[]
  readonly validationRequests: number
} {
  const cssConfigurations: LanguageSettings[] = []
  const scssConfigurations: LanguageSettings[] = []
  const parsedDocuments: TextDocument[] = []
  let completionRequests = 0
  let hoverRequests = 0
  let validationRequests = 0
  let codeActionRequests = 0
  const cssLanguageService: CssLanguageService = {
    configure(configuration) {
      if (configuration) {
        cssConfigurations.push(configuration)
      }
    },
    doComplete(document) {
      completionRequests++
      return {
        isIncomplete: false,
        items: typeof completionItems === 'function' ? completionItems(document) : completionItems,
      }
    },
  }
  const scssLanguageService: ScssLanguageService = {
    configure(configuration) {
      if (configuration) {
        scssConfigurations.push(configuration)
      }
    },
    parseStylesheet(document) {
      parsedDocuments.push(document)
      return {}
    },
    doComplete() {
      completionRequests++
      return responses.scssCompletions ?? { isIncomplete: false, items: [] }
    },
    doHover() {
      hoverRequests++
      return responses.hover ?? null
    },
    doValidation(document) {
      validationRequests++
      const { diagnostics = [] } = responses
      return typeof diagnostics === 'function' ? diagnostics(document) : diagnostics
    },
    /** Like the real service, offers actions only for the diagnostics it is asked about. */
    doCodeActions(_document, _range, context) {
      codeActionRequests++
      return context.diagnostics.length > 0 ? (responses.codeActions ?? []) : []
    },
    getFoldingRanges() {
      return responses.foldingRanges ?? []
    },
  }

  return {
    cssConfigurations,
    scssConfigurations,
    parsedDocuments,
    get completionRequests() {
      return completionRequests
    },
    get hoverRequests() {
      return hoverRequests
    },
    get validationRequests() {
      return validationRequests
    },
    get codeActionRequests() {
      return codeActionRequests
    },
    createCssLanguageService() {
      return cssLanguageService
    },
    createScssLanguageService() {
      return scssLanguageService
    },
  }
}

interface FakeLanguageServiceResponses {
  readonly codeActions?: ReturnType<ScssLanguageService['doCodeActions']>
  readonly diagnostics?:
    | ReturnType<ScssLanguageService['doValidation']>
    | ((document: TextDocument) => ReturnType<ScssLanguageService['doValidation']>)
  readonly foldingRanges?: ReturnType<ScssLanguageService['getFoldingRanges']>
  readonly hover?: Exclude<ReturnType<ScssLanguageService['doHover']>, null>
  readonly scssCompletions?: ReturnType<ScssLanguageService['doComplete']>
}
