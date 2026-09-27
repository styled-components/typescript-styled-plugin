/** Types for test/package-api/packed-package.cjs. */

export const PACKAGE_NAME: '@styled/typescript-styled-plugin'

export function installPackedPackage(options: {
  projectDirectory: string
  tarballPath: string
  workspaceRoot: string
}): string

export function linkWorkspaceModule(options: {
  name: string
  projectDirectory: string
  workspaceRoot: string
}): void
