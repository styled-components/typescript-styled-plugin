/**
 * A default import of "@styled/typescript-styled-plugin/lib/api.js" resolves to the whole
 * CommonJS exports object, matching how 1.0.1 shipped this file as plain CommonJS: unlike "./api"
 * (a real ES module with named exports only), "./lib/api" and "./lib/api.js" always resolve as
 * CommonJS regardless of import or require syntax. Checked under `moduleResolution: node16`
 * (tsconfig.json, tsconfig.consumers.json) and `bundler` (tsconfig.consumers.bundler.json).
 */
import api from '@styled/typescript-styled-plugin/lib/api.js'

void api.StyledTemplateLanguageService
void api.PluginConfigurationManager
void api.getTemplateSettings
