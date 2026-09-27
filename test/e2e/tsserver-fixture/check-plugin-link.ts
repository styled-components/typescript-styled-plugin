import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import { e2eRoot, repositoryRoot } from '../fixture-paths'
import { pluginPackageName } from './server'

/**
 * Vitest globalSetup for the e2e project. tsserver loads the plugin by resolving its package name
 * from the e2e root (`--pluginProbeLocations`), so a workspace link pointing anywhere else (another
 * checkout, a stale copy) would silently test that other build. Node's resolution from the same
 * directory walks the same `node_modules` chain and returns the real path.
 */
export default function checkPluginLink() {
  const manifest = createRequire(path.join(e2eRoot, 'package.json')).resolve(
    `${pluginPackageName}/package.json`,
  )
  const resolvedRoot = realpathSync(path.dirname(manifest))
  const expectedRoot = realpathSync(repositoryRoot)
  if (resolvedRoot !== expectedRoot) {
    throw new Error(
      `The e2e workspace resolves ${pluginPackageName} to ${resolvedRoot}, not this repository (${expectedRoot}), so the scenarios would test that other build. Run \`corepack yarn install\` in this repository to relink test/e2e/node_modules/${pluginPackageName} to it.`,
    )
  }
}
