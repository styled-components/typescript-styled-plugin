// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/** Public API that lets other libraries consume the language service. */
export { StyledTemplateLanguageService } from './template-language-service.ts'
export {
  PluginConfigurationManager,
  /** Alias matching the name 1.0.1 published for this class. */
  PluginConfigurationManager as ConfigurationManager,
} from './configuration/plugin-configuration.ts'
export type {
  StyledPluginConfiguration,
  StyledPluginConfigurationInput,
  StyledPluginEmmetConfiguration,
  StyledPluginLintConfiguration,
  StyledPluginLintLevel,
} from './configuration/plugin-configuration.ts'
export type {
  EmmetCompletionProvider,
  StylesLanguageServiceFactory,
} from './features/styles-language-services.ts'
export type { VirtualDocumentProvider } from './virtual-document/styled-virtual-document-provider.ts'
export { getTemplateSettings } from './template-settings.ts'
