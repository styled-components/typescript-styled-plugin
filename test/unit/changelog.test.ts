import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, assert, describe, it, vi } from 'vitest'

import {
  CHANGESET_DIRECTORY,
  attribution,
  getDependencyReleaseLine,
  getReleaseLine,
  isAgent,
  isMaintainer,
} from '../../scripts/changelog.cjs'
import type { GitIdentity } from '../../scripts/changelog.cjs'

const CHANGESET_PACKAGE_NAME = '@styled/typescript-styled-plugin'
const SCRIPTS_DIRECTORY = path.resolve(__dirname, '../../scripts')

const ADA: GitIdentity = { email: 'ada@example.com', name: 'Ada Author' }
const BEA: GitIdentity = { email: 'bea@example.com', name: 'Bea Maintainer' }
const CORA: GitIdentity = { email: 'cora@example.com', name: 'Cora Helper' }
const DAN: GitIdentity = { email: 'dan@example.com', name: 'Dan Fixer' }

const MAINTAINERS = ['Bea Maintainer', 'ej@quantizor.dev', 'quantizor']

let repoDir: string | undefined

afterEach(() => {
  vi.restoreAllMocks()
  if (repoDir) {
    rmSync(repoDir, { force: true, recursive: true })
    repoDir = undefined
  }
})

/** A fresh temporary directory, removed after the test; not a git repository. */
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'changelog-test-'))
  repoDir = dir
  return dir
}

/** Makes `dir` the directory getReleaseLine's git queries run in. */
function runIn(dir: string) {
  vi.spyOn(process, 'cwd').mockReturnValue(dir)
}

/**
 * Runs `git` inside `cwd` with a fixed author/committer identity, independent of the host's global
 * git config (name, email, commit signing), so the fixture is deterministic wherever it runs.
 */
function git(cwd: string, args: string[], identity: GitIdentity = ADA): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_AUTHOR_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
    },
  })
}

/** A fresh, empty git repository with no commits at all: the next commit made in it is parentless. */
function initBareRepo(): string {
  const dir = tempDir()
  git(dir, ['init', '--initial-branch=main', '-q'])
  mkdirSync(path.join(dir, CHANGESET_DIRECTORY))
  return dir
}

/**
 * A throwaway repository with one settled root commit, so every fixture commit added afterward has
 * a parent (`attribution`'s `trustworthy` stays true, the ordinary case away from a shallow clone).
 */
function initRepo(): string {
  const dir = initBareRepo()
  writeFileSync(path.join(dir, 'README.md'), '# fixture\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-q', '-m', 'chore: root commit'])
  return dir
}

/**
 * Writes the changeset `id` with `body` and commits it as `identity` with `message`, returning the
 * commit's abbreviated hash.
 */
function commitChangeset(
  dir: string,
  change: { body: string; id: string; identity?: GitIdentity; message: string },
): string {
  const relativePath = `${CHANGESET_DIRECTORY}/${change.id}.md`
  const identity = change.identity ?? ADA
  writeFileSync(
    path.join(dir, relativePath),
    `---\n"${CHANGESET_PACKAGE_NAME}": patch\n---\n\n${change.body}\n`,
  )
  git(dir, ['add', relativePath], identity)
  git(dir, ['commit', '-q', '-m', change.message], identity)
  return git(dir, ['rev-parse', '--short', 'HEAD']).trim()
}

function coAuthored(subject: string, ...people: GitIdentity[]): string {
  return `${subject}\n\n${people.map((person) => `Co-authored-by: ${person.name} <${person.email}>`).join('\n')}`
}

describe('attribution', () => {
  it('cites every commit that added or modified the file, oldest first, deduplicated by email', () => {
    const dir = initRepo()
    const id = 'brave-lions-jump'

    const addSha = commitChangeset(dir, {
      body: 'First draft.',
      id,
      message: 'chore: add changeset',
    })
    const refineSha = commitChangeset(dir, {
      body: 'First draft, refined.',
      id,
      identity: BEA,
      message: coAuthored('chore: refine changeset', CORA),
    })

    const result = attribution(`${CHANGESET_DIRECTORY}/${id}.md`, { cwd: dir })

    assert.isTrue(result.trustworthy)
    assert.deepEqual(result.commits, [addSha, refineSha])
    assert.deepEqual(
      result.people.map((person) => ({
        email: person.email,
        name: person.name,
        sha: person.sha,
        via: person.via,
      })),
      [
        { email: ADA.email, name: ADA.name, sha: addSha, via: 'author' },
        { email: BEA.email, name: BEA.name, sha: refineSha, via: 'author' },
        { email: CORA.email, name: CORA.name, sha: refineSha, via: 'co-author' },
      ],
    )
  })

  it('marks a parentless (root) commit as untrustworthy, the shallow-clone boundary signature', () => {
    const dir = initBareRepo()
    const id = 'lonely-otters-fly'

    commitChangeset(dir, { body: 'Fixes a bug.', id, message: 'root commit' })

    const result = attribution(`${CHANGESET_DIRECTORY}/${id}.md`, { cwd: dir })

    assert.isFalse(result.trustworthy)
    assert.lengthOf(result.commits, 1)
  })

  it('returns an empty, untrustworthy result when the git query itself fails', () => {
    /**
     * No `git init`: the query fails outright ("fatal: not a git repository"), the case this
     * guards, distinct from a real repo with no history for the path (which git answers with an
     * empty, but successful, result).
     */
    const dir = tempDir()

    const result = attribution(`${CHANGESET_DIRECTORY}/never-existed.md`, { cwd: dir })

    assert.isFalse(result.trustworthy)
    assert.deepEqual(result.commits, [])
    assert.deepEqual(result.people, [])
    assert.match(result.error ?? '', /not a git repository/)
  })

  it("keeps git's stderr off the terminal when the git query fails", () => {
    const dir = tempDir()
    const changelog = path.join(SCRIPTS_DIRECTORY, 'changelog.cjs')
    const probe = `const { attribution } = require(${JSON.stringify(changelog)}); process.stdout.write(attribution('.changeset/x.md', { cwd: ${JSON.stringify(dir)} }).error)`

    const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })

    assert.strictEqual(result.status, 0)
    assert.match(result.stdout, /not a git repository/)
    assert.strictEqual(result.stderr, '')
  })

  it('returns a trustworthy, empty result for a real repository with no history for the path', () => {
    const dir = initRepo()

    const result = attribution(`${CHANGESET_DIRECTORY}/never-existed.md`, { cwd: dir })

    assert.isTrue(result.trustworthy)
    assert.deepEqual(result.commits, [])
    assert.deepEqual(result.people, [])
  })
})

describe('isAgent', () => {
  it('flags a "[bot]" name suffix regardless of case', () => {
    assert.isTrue(isAgent({ email: 'x@example.com', name: 'dependabot[BOT]' }))
  })

  it('flags each configured agent email fragment', () => {
    assert.isTrue(isAgent({ email: 'copilot@github.com', name: 'Copilot' }))
    assert.isTrue(isAgent({ email: 'noreply+cursoragent@cursor.sh', name: 'Cursor' }))
    assert.isTrue(isAgent({ email: 'devin-ai-integration[bot]@devin.ai', name: 'Devin' }))
    assert.isTrue(isAgent({ email: 'noreply@anthropic.com', name: 'Claude' }))
  })

  it('never flags a person by name alone, even when the name matches an agent brand', () => {
    assert.isFalse(isAgent({ email: 'claude@example.com', name: 'Claude' }))
  })

  it('does not flag an ordinary contributor', () => {
    assert.isFalse(isAgent(ADA))
  })
})

describe('isMaintainer', () => {
  it('matches by exact name, case-insensitively', () => {
    assert.isTrue(
      isMaintainer({ email: 'someone@example.com', name: 'bea maintainer' }, MAINTAINERS),
    )
  })

  it('matches by exact email', () => {
    assert.isTrue(isMaintainer({ email: 'ej@quantizor.dev', name: 'E J' }, MAINTAINERS))
  })

  it('matches an email containing a configured entry as a substring', () => {
    assert.isTrue(
      isMaintainer(
        { email: '570070+quantizor@users.noreply.github.com', name: 'GitHub Noreply' },
        MAINTAINERS,
      ),
    )
  })

  it('does not match a name that only contains a configured entry', () => {
    assert.isFalse(isMaintainer({ email: 'x@example.com', name: 'Not quantizor' }, MAINTAINERS))
  })

  it('does not match an unrelated contributor', () => {
    assert.isFalse(isMaintainer(ADA, MAINTAINERS))
  })
})

describe('getReleaseLine', () => {
  it('cites every commit oldest-first and thanks non-maintainer, non-agent contributors once, excluding a name already in the summary', async () => {
    const dir = initRepo()
    const id = 'brave-lions-jump'
    const summary = 'Adds a thing. Thanks Cora Helper for the report.'

    const addSha = commitChangeset(dir, {
      body: 'Adds a thing.',
      id,
      message: 'chore: add changeset',
    })
    const refineSha = commitChangeset(dir, {
      body: summary,
      id,
      identity: BEA,
      message: coAuthored('chore: refine', CORA),
    })
    runIn(dir)

    const line = await getReleaseLine({ commit: undefined, id, releases: [], summary }, 'patch', {
      maintainers: MAINTAINERS,
    })

    /**
     * Bea is a configured maintainer and Cora's name is already in the summary, so only Ada (the
     * changeset's actual reporter-turned-author) is thanked.
     */
    assert.equal(line, `- ${addSha}, ${refineSha}: ${summary}\n\n  Thanks Ada Author!`)
  })

  it('joins three or more names with an Oxford comma, via Intl.ListFormat', async () => {
    const dir = initRepo()
    const id = 'three-friends-help'
    const summary = 'Adds another thing.'

    const sha = commitChangeset(dir, {
      body: summary,
      id,
      message: coAuthored('chore: add changeset', CORA, DAN),
    })
    runIn(dir)

    const line = await getReleaseLine({ commit: undefined, id, releases: [], summary }, 'patch', {
      maintainers: [],
    })

    assert.equal(line, `- ${sha}: ${summary}\n\n  Thanks Ada Author, Cora Helper, and Dan Fixer!`)
  })

  it('falls back to changeset.commit and warns once when the changeset was added by a parentless commit', async () => {
    const dir = initBareRepo()
    const id = 'lonely-otters-fly'
    const summary = 'Fixes a bug.'

    commitChangeset(dir, { body: summary, id, message: 'root commit' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    runIn(dir)

    const line = await getReleaseLine(
      { commit: 'deadbeefcafefeed', id, releases: [], summary },
      'patch',
      { maintainers: [] },
    )

    /**
     * Untrustworthy attribution carries no thanks line at all, not even an empty one: the
     * shallow-clone fallback only knows the single commit changesets itself resolved.
     */
    assert.equal(line, `- deadbee: ${summary}`)
    assert.equal(warnSpy.mock.calls.length, 1)
    assert.match(
      String(warnSpy.mock.calls[0]?.[0]),
      /\.changeset\/lonely-otters-fly\.md has a parentless commit in its history, which means a shallow clone/,
    )
  })

  it("falls back to changeset.commit and warns with git's error when the git query fails", async () => {
    const summary = 'Fixes a bug.'
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    runIn(tempDir())

    const line = await getReleaseLine(
      { commit: 'deadbeefcafefeed', id: 'lonely-otters-fly', releases: [], summary },
      'patch',
      { maintainers: [] },
    )

    assert.equal(line, `- deadbee: ${summary}`)
    assert.equal(warnSpy.mock.calls.length, 1)
    assert.match(
      String(warnSpy.mock.calls[0]?.[0]),
      /^changelog: git could not read the history of \.changeset\/lonely-otters-fly\.md[\s\S]*not a git repository/,
    )
  })

  it('cites nothing and skips thanks when the changeset has no resolvable commit at all', async () => {
    runIn(initRepo())

    const line = await getReleaseLine(
      { commit: undefined, id: 'never-committed', releases: [], summary: 'Untracked change.' },
      'patch',
      { maintainers: [] },
    )

    assert.equal(line, '- Untracked change.')
  })
})

describe('getDependencyReleaseLine', () => {
  it('returns an empty string when no dependencies changed', async () => {
    assert.equal(await getDependencyReleaseLine([], []), '')
  })

  it('lists the changeset commit and each updated dependency', async () => {
    const result = await getDependencyReleaseLine(
      [{ commit: 'abc1234567890' }],
      [{ name: CHANGESET_PACKAGE_NAME, newVersion: '1.2.3' }],
    )

    assert.equal(result, `- Updated dependencies [abc1234]\n  - ${CHANGESET_PACKAGE_NAME}@1.2.3`)
  })
})

describe('changeset-credits', () => {
  it("fails with git's error instead of reporting no history when the git query fails", () => {
    const script = path.join(SCRIPTS_DIRECTORY, 'changeset-credits.ts')
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', script, 'completions'],
      {
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: path.join(tmpdir(), 'changeset-credits-missing-git-dir') },
      },
    )

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /git could not read the history of \.changeset\/completions\.md/)
    assert.match(result.stderr, /not a git repository/)
    assert.notInclude(result.stdout, 'no history')
  })
})
