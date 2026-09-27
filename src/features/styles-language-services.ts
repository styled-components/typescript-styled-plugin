import { doComplete as emmetDoComplete } from '@vscode/emmet-helper'
import { getCSSLanguageService, getSCSSLanguageService } from 'vscode-css-languageservice'
import type { CompletionList, LanguageService, Position } from 'vscode-css-languageservice'
import type { TextDocument } from 'vscode-languageserver-textdocument'

import type { StyledPluginEmmetConfiguration } from '../configuration/plugin-configuration.ts'

export type CssLanguageService = Pick<LanguageService, 'configure' | 'doComplete'>

export type ScssLanguageService = Pick<
  LanguageService,
  | 'configure'
  | 'parseStylesheet'
  | 'doComplete'
  | 'doHover'
  | 'doValidation'
  | 'doCodeActions'
  | 'getFoldingRanges'
>

export interface StylesLanguageServiceFactory {
  createCssLanguageService(): CssLanguageService
  createScssLanguageService(): ScssLanguageService
}

export interface EmmetCompletionProvider {
  doComplete(
    document: TextDocument,
    position: Position,
    configuration: StyledPluginEmmetConfiguration,
  ): CompletionList | undefined
}

export class DefaultStylesLanguageServiceFactory implements StylesLanguageServiceFactory {
  public createCssLanguageService(): CssLanguageService {
    return getCSSLanguageService()
  }

  public createScssLanguageService(): ScssLanguageService {
    return getSCSSLanguageService()
  }
}

export class DefaultEmmetCompletionProvider implements EmmetCompletionProvider {
  public doComplete(
    document: TextDocument,
    position: Position,
    configuration: StyledPluginEmmetConfiguration,
  ): CompletionList | undefined {
    return emmetDoComplete(document, position, 'css', configuration)
  }
}
