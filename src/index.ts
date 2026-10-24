// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import type * as ts from 'typescript/lib/tsserverlibrary.js'

import { EditorConfigurationManager } from './tsserver/editor-configuration.ts'
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

const editorConfigurations = new WeakMap<object, EditorConfigurationManager>()

function getEditorConfiguration(info: ts.server.PluginCreateInfo): EditorConfigurationManager {
  const projectService = info.project.projectService
  let editorConfiguration = editorConfigurations.get(projectService)
  if (!editorConfiguration) {
    editorConfiguration = new EditorConfigurationManager()
    editorConfigurations.set(projectService, editorConfiguration)
  }
  return editorConfiguration
}

const createPlugin = (mod: { typescript: typeof ts }): StyledPlugin =>
  new TsServerStyledPlugin(mod.typescript, getEditorConfiguration)

export default createPlugin
