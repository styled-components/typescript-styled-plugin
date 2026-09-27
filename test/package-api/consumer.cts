import plugin = require('@styled/typescript-styled-plugin')
import ts = require('typescript/lib/tsserverlibrary.js')

const pluginModule: ts.server.PluginModule = plugin({ typescript: ts })

void pluginModule
