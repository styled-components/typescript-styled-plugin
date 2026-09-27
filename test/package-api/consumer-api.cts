import api = require('@styled/typescript-styled-plugin/api')
import ts = require('typescript/lib/tsserverlibrary.js')

void api.StyledTemplateLanguageService
void api.PluginConfigurationManager

declare const virtualDocumentProvider: api.VirtualDocumentProvider

const configurationManager = new api.PluginConfigurationManager()
const resolvedConfiguration: api.StyledPluginConfiguration = configurationManager.config
const templateSettings = api.getTemplateSettings(configurationManager)
const templateLanguageService = new api.StyledTemplateLanguageService(
  ts,
  configurationManager,
  virtualDocumentProvider,
  { log() {} },
)

void resolvedConfiguration
void templateSettings
void templateLanguageService
