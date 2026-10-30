/**
 * The import() half of runtime.ts: copied next to the extracted package in its throwaway
 * project, so every specifier here resolves through that project's node_modules.
 */
import importedPluginFactory from '@styled/typescript-styled-plugin'
import * as api from '@styled/typescript-styled-plugin/api'
import * as libApi from '@styled/typescript-styled-plugin/lib/api'
import * as libApiJs from '@styled/typescript-styled-plugin/lib/api.js'
import libApiJsDefault from '@styled/typescript-styled-plugin/lib/api.js'
import * as libIndex from '@styled/typescript-styled-plugin/lib/index'
import * as libIndexJs from '@styled/typescript-styled-plugin/lib/index.js'
import * as ts from 'typescript/lib/tsserverlibrary.js'
import { TextDocument } from 'vscode-languageserver-textdocument'

const API_EXPORTS = [
  'StyledTemplateLanguageService',
  'PluginConfigurationManager',
  'getTemplateSettings',
]

function expectFunction(value, description) {
  if (typeof value !== 'function') {
    throw new TypeError(`${description} must be a function; received ${typeof value}.`)
  }
}

function expectApiExports(module, description) {
  for (const name of API_EXPORTS) {
    expectFunction(module[name], `${name} from ${description}`)
  }
}

expectFunction(importedPluginFactory, 'The default import of the packed tsserver entry')
expectFunction(
  importedPluginFactory({ typescript: ts }).create,
  'create on the plugin module from the default import of the packed tsserver entry',
)
expectApiExports(api, 'import of "@styled/typescript-styled-plugin/api"')
expectFunction(libIndex.default, 'The default export of import("lib/index")')
expectFunction(libIndexJs.default, 'The default export of import("lib/index.js")')
expectApiExports(libApi, 'import of "lib/api"')
expectApiExports(libApiJs, 'import of "lib/api.js"')
/** 1.0.1 shipped lib/api.js as plain CommonJS, so its default import is the whole exports object. */
expectApiExports(libApiJsDefault, 'the default import of "lib/api.js"')

const prefix = ':root{\n'
const virtualDocumentProvider = {
  createVirtualDocument(context) {
    return TextDocument.create(context.fileName, 'scss', 1, prefix + context.text + '\n}')
  },
  fromVirtualDocOffset(offset) {
    return offset - prefix.length
  },
  fromVirtualDocPosition(position) {
    return { character: position.character, line: position.line - 1 }
  },
  getVirtualDocumentWrapper() {
    return prefix
  },
  toVirtualDocOffset(offset) {
    return offset + prefix.length
  },
  toVirtualDocPosition(position) {
    return { character: position.character, line: position.line + 1 }
  },
}
const languageServiceFactory = {
  createCssLanguageService() {
    return {
      configure() {},
      doComplete() {
        return { isIncomplete: false, items: [] }
      },
    }
  },
  createScssLanguageService() {
    return {
      configure() {},
      doCodeActions() {
        return [
          {
            arguments: [
              undefined,
              undefined,
              [
                {
                  newText: 'border',
                  range: { end: { character: 7, line: 1 }, start: { character: 0, line: 1 } },
                },
              ],
            ],
            command: '_css.applyCodeAction',
            title: "Rename to 'border'",
          },
        ]
      },
      doComplete() {
        return { isIncomplete: false, items: [] }
      },
      doHover() {
        return null
      },
      doValidation() {
        return [
          {
            message: 'Unknown property',
            range: { end: { character: 7, line: 1 }, start: { character: 0, line: 1 } },
          },
        ]
      },
      getFoldingRanges() {
        return []
      },
      parseStylesheet() {
        return {}
      },
    }
  },
}
const context = {
  fileName: 'consumer.ts',
  node: {},
  rawText: 'boarder: red;',
  text: 'boarder: red;',
  toOffset(position) {
    return position.character
  },
  toPosition(offset) {
    return { character: offset, line: 0 }
  },
  typescript: ts,
}
const service = new api.StyledTemplateLanguageService(
  ts,
  new api.PluginConfigurationManager(),
  virtualDocumentProvider,
  languageServiceFactory,
)
const fixes = service.getCodeFixesAtPosition(context, 0, 7)
if (fixes[0]?.changes[0]?.textChanges[0]?.newText !== 'border') {
  throw new TypeError('The packed API entry must support the legacy three-argument code-fix call.')
}
