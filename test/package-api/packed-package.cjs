/**
 * Installs a packed tarball of this package into a throwaway project, the way a consumer's
 * install lays it out: the archive extracted to node_modules/@styled/typescript-styled-plugin,
 * and each runtime dependency it declares linked from this repository's own node_modules
 * (nothing is downloaded). Plain CommonJS with no syntax newer than Node 14.21.3, since
 * tsserver-smoke.cjs loads it on the package's own Node floor (docs/tsserver-host.md).
 */
const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const PACKAGE_NAME = '@styled/typescript-styled-plugin'

/** Returns the directory the package was extracted to. */
function installPackedPackage({ projectDirectory, tarballPath, workspaceRoot }) {
  const packageDirectory = path.join(projectDirectory, 'node_modules', PACKAGE_NAME)
  fs.mkdirSync(packageDirectory, { recursive: true })
  runChecked('tar', ['-xzf', tarballPath, '--strip-components=1', '-C', packageDirectory])

  const { dependencies } = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'),
  )
  for (const dependency of Object.keys(dependencies)) {
    linkWorkspaceModule({ name: dependency, projectDirectory, workspaceRoot })
  }
  return packageDirectory
}

/** Links node_modules/<name> in the project to the same module in this repository. */
function linkWorkspaceModule({ name, projectDirectory, workspaceRoot }) {
  const link = path.join(projectDirectory, 'node_modules', name)
  fs.mkdirSync(path.dirname(link), { recursive: true })
  fs.symlinkSync(path.join(workspaceRoot, 'node_modules', name), link, 'dir')
}

function runChecked(command, args) {
  const result = childProcess.spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) {
    throw new Error(`${command} ${args.join(' ')} could not start: ${result.error.message}`)
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}.`)
  }
}

module.exports = { PACKAGE_NAME, installPackedPackage, linkWorkspaceModule }
