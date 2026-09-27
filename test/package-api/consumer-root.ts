import plugin from '@styled/typescript-styled-plugin'
import * as ts from 'typescript/lib/tsserverlibrary.js'

const pluginModule: ts.server.PluginModule = plugin({ typescript: ts })

void pluginModule
