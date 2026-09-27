// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import { TsServerStyledPlugin } from './tsserver/tsserver-plugin.ts'

/**
 * 1.0.1's published return type, with both members required and `any` config, rather than
 * `ts.server.PluginModule`, where `onConfigurationChanged` is optional: a 1.0.1 consumer's
 * unguarded `plugin(...).onConfigurationChanged(...)` call must keep compiling.
 */
interface StyledPlugin {
  create(info: ts.server.PluginCreateInfo): ts.LanguageService
  onConfigurationChanged(config: any): void
}

const createPlugin = (mod: { typescript: typeof ts }): StyledPlugin =>
  new TsServerStyledPlugin(mod.typescript)

export default createPlugin
