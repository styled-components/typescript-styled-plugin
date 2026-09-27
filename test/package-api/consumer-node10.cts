/**
 * A moduleResolution: node10 consumer, matching how a 1.0.1 project (published with no
 * "exports" map at all) resolved these paths. node10 resolution never consults "exports"
 * (docs/architecture.md, "Public surface"), so every one of these deep imports depends on a
 * real file (or a typesVersions redirect) sitting at the literal requested path.
 */
import { StyledTemplateLanguageService as ApiExport } from '@styled/typescript-styled-plugin/api'
import { StyledTemplateLanguageService as LibApi } from '@styled/typescript-styled-plugin/lib/api'
import { StyledTemplateLanguageService as LibApiJs } from '@styled/typescript-styled-plugin/lib/api.js'
import plugin = require('@styled/typescript-styled-plugin/lib/index')
import pluginJs = require('@styled/typescript-styled-plugin/lib/index.js')
import * as ts from 'typescript/lib/tsserverlibrary.js'

void ApiExport
void LibApi
void LibApiJs

const pluginModule: ts.server.PluginModule = plugin({ typescript: ts })
const pluginModuleFromJsSpecifier: ts.server.PluginModule = pluginJs({ typescript: ts })

void pluginModule
void pluginModuleFromJsSpecifier
