/**
 * Types for scripts/changelog.cjs. Without this file the importing script sees
 * `any` for every export, and the two could disagree about the attribution
 * shape with nothing to catch it.
 */

/** Where changesets keeps one file per pending change, relative to the repository root. */
export const CHANGESET_DIRECTORY: '.changeset'

/** One person credited on a changeset, with the commit that put them there. */
export interface Contributor {
  email: string
  name: string
  sha: string
  subject: string
  via: 'author' | 'co-author'
}

/** A git author or committer identity. */
export type GitIdentity = Pick<Contributor, 'email' | 'name'>

/** Who and what is behind a changeset file. */
export interface Attribution {
  /** Abbreviated hashes of every commit that added or modified the file. */
  commits: string[]
  /** Message from git when the query itself failed. */
  error?: string
  /** Authors and co-authors, first appearance first, deduplicated by email. */
  people: Contributor[]
  /**
   * False when any commit came back without a parent, which means a shallow
   * clone where every file reads as added by the boundary commit.
   */
  trustworthy: boolean
}

/** One pending (or already-applied) changeset, as `@changesets/cli` passes it to the generator. */
export interface Changeset {
  /** The single commit `@changesets/cli` itself resolved; the fallback when attribution fails. */
  commit?: string
  /** The changeset filename, minus `.md`. */
  id: string
  releases: Array<{ name: string; type: 'major' | 'minor' | 'patch' }>
  /** The changeset body, frontmatter already stripped. */
  summary: string
}

export interface ChangelogOptions {
  maintainers?: string[]
}

/** One package whose dependency range moved as a side effect of another package's release. */
export interface DependencyUpdate {
  name: string
  newVersion: string
}

export function attribution(file: string, options?: { cwd?: string; revs?: string[] }): Attribution

/** Repo-relative path of a changeset file, given its id. */
export function changesetPath(id: string): string

/** Unchanged from the stock generator: dependency bumps carry no attribution. */
export function getDependencyReleaseLine(
  changesets: Array<Pick<Changeset, 'commit'>>,
  dependenciesUpdated: DependencyUpdate[],
): Promise<string>

/** One release-note bullet: the contributing commits, the summary, then a thanks line. */
export function getReleaseLine(
  changeset: Changeset,
  type: 'major' | 'minor' | 'patch',
  options?: ChangelogOptions,
): Promise<string>

/** True for an agent or automation identity, which is never thanked. */
export function isAgent(person: GitIdentity): boolean

/** True when the person is one of the configured maintainers. */
export function isMaintainer(person: GitIdentity, maintainers: string[]): boolean
