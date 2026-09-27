// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import type { TemplateSettings } from 'typescript-template-language-service-decorator'

import type { PluginConfigurationManager } from './configuration/plugin-configuration.ts'
import { getTemplateSubstitutions } from './template/template-substitutions.ts'

export function getTemplateSettings(
  configurationManager: PluginConfigurationManager,
): TemplateSettings {
  return {
    get tags() {
      return configurationManager.config.tags
    },
    enableForStringWithSubstitutions: true,
    getSubstitutions: getTemplateSubstitutions,
  }
}
