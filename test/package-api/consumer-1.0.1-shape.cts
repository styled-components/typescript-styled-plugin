/**
 * A consumer written exactly as one compiled against 1.0.1's published types would be: the root
 * factory's result invoked without an optional-chained onConfigurationChanged, a
 * StyledPluginConfiguration built with lint/emmet values 1.0.1's open `{ [key: string]: any }`
 * shape accepted (a rule or option this plugin does not itself know about, and an arbitrary index
 * access), and a VirtualDocumentProvider implementation whose methods omit the optional context
 * parameter the way an implementation predating it would.
 */
import api = require('@styled/typescript-styled-plugin/api')
import plugin = require('@styled/typescript-styled-plugin')
import ts = require('typescript/lib/tsserverlibrary.js')

const configuredPlugin = plugin({ typescript: ts })
configuredPlugin.onConfigurationChanged({ tags: ['styled'] })

const configuration: api.StyledPluginConfiguration = {
  emmet: { customKey: 1, showExpandedAbbreviation: 'always' },
  lint: { someFutureRule: 'warning', unknownProperties: 'ignore' },
  tags: ['styled'],
  validate: true,
}
const lintLevel: string = configuration.lint.unknownProperties
const arbitraryLintValue: number = configuration.lint['whatever']
void lintLevel
void arbitraryLintValue

class LegacyShapeVirtualDocumentProvider implements api.VirtualDocumentProvider {
  public createVirtualDocument(): any {
    return undefined
  }

  public fromVirtualDocOffset(offset: number): number {
    return offset
  }

  public fromVirtualDocPosition(position: ts.LineAndCharacter): ts.LineAndCharacter {
    return position
  }

  public getVirtualDocumentWrapper(): string {
    return ''
  }

  public toVirtualDocOffset(offset: number): number {
    return offset
  }

  public toVirtualDocPosition(position: ts.LineAndCharacter): ts.LineAndCharacter {
    return position
  }
}
void LegacyShapeVirtualDocumentProvider
