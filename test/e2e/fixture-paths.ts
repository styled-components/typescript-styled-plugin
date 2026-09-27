import * as path from 'node:path'

export const e2eRoot = import.meta.dirname

export const repositoryRoot = path.resolve(e2eRoot, '..', '..')

export type FixtureProject =
  | 'closed-file-project-fixture'
  | 'default-tags-project-fixture'
  | 'emmet-disabled-project-fixture'
  | 'plugin-missing-project-fixture'
  | 'styled-project-fixture'
