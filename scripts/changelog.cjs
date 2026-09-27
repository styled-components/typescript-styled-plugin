'use strict'
/**
 * Changelog generator for changesets: cites every commit behind a changeset and
 * thanks the contributors other than the maintainer.
 *
 * The stock generator (@changesets/cli/changelog) resolves one commit per
 * changeset with `git log --diff-filter=A`, so a later commit that ships code
 * while amending the same changeset is absent from the release notes and its
 * author goes uncredited. This one asks for adds and modifications, oldest
 * first, cites them all, and names the people behind them.
 *
 * Wired up by .changeset/config.json, which also supplies `maintainers`.
 * @changesets/apply-release-plan loads it with import(), which takes either
 * module system; test/unit/changelog.test.ts also require()s it from a plain
 * `node -e` process to check stderr.
 */
const { execFileSync } = require('node:child_process')

/** Where changesets keeps one file per pending change, relative to the repository root. */
const CHANGESET_DIRECTORY = '.changeset'

/**
 * The revision filter every attribution query uses: commits that added or
 * modified the file, oldest first. Shared with scripts/changeset-credits.ts so
 * the release notes and the credits report never disagree about which commits
 * belong to a changeset.
 */
const ATTRIBUTION_LOG_ARGS = ['log', '--reverse', '--diff-filter=AM']

/**
 * Email fragments identifying an agent rather than a person. An agent usually
 * acts for somebody, and that somebody is who a release note names, so agents
 * are never thanked automatically. An agent that genuinely originated the work
 * is creditable, but that is a judgment for whoever writes the changeset prose,
 * not something derivable from a commit.
 *
 * Matched on the email alone: "Claude" is also a person's name, and silently
 * dropping a human contributor is the failure worth avoiding here.
 */
const AGENT_EMAILS = ['copilot@', 'cursoragent', 'devin-ai-integration', 'noreply@anthropic.com']

/** ASCII separators; no git identity or subject line contains them. */
const FIELD = '\x1f'
const RECORD = '\x02'
const TRAILER = '\x1e'

const LOG_FORMAT = [
  '%h',
  '%p',
  '%an',
  '%ae',
  '%s',
  `%(trailers:key=Co-authored-by,valueonly,separator=${TRAILER})`,
].join(FIELD)

/** Repo-relative path of a changeset file, given the id changesets passes us. */
function changesetPath(id) {
  return `${CHANGESET_DIRECTORY}/${id}.md`
}

/** True for an agent or automation identity, which is never thanked. */
function isAgent(person) {
  const email = person.email.toLowerCase()
  return (
    person.name.toLowerCase().endsWith('[bot]') ||
    AGENT_EMAILS.some((fragment) => email.includes(fragment))
  )
}

/** `Name <email>` as git writes a Co-authored-by trailer. */
function parseTrailer(value) {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  return match ? { email: match[2], name: match[1] } : null
}

/**
 * Who and what is behind a changeset file.
 *
 * `trustworthy` is false when any commit has no parent. In a shallow clone
 * that is the boundary commit, where every file reads as having been added by
 * it, and the credits would be confidently wrong; a repository's own root
 * commit is parentless too, so this errs toward the fallback in the one case
 * where the answer would have been right anyway. The release workflow checks
 * out full history, so this stays unused in CI.
 *
 * Shapes are declared in scripts/changelog.d.cts, which is what the importing
 * TypeScript sees.
 */
function attribution(file, options) {
  /**
   * Read explicitly rather than left to execFileSync's own default, so a test can stand in a
   * directory by stubbing process.cwd() instead of changing the process's real one.
   */
  const cwd = options?.cwd ?? process.cwd()
  const revs = options?.revs ?? []

  let stdout
  try {
    stdout = execFileSync(
      'git',
      [...ATTRIBUTION_LOG_ARGS, ...revs, `--format=${RECORD}${LOG_FORMAT}`, '--', file],
      /** stderr is piped, not inherited, so git's message reaches `error` instead of the terminal. */
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (error) {
    return { commits: [], people: [], trustworthy: false, error: error.message }
  }

  const commits = []
  const people = []
  const seen = new Set()
  let trustworthy = true

  const add = (person) => {
    const key = person.email.toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    people.push(person)
  }

  for (const record of stdout.split(RECORD)) {
    if (!record.trim()) {
      continue
    }
    const [sha, parents, name, email, subject, trailers] = record.split(FIELD)
    if (!parents) {
      trustworthy = false
    }
    commits.push(sha)

    add({ email, name, sha, subject, via: 'author' })

    for (const value of (trailers || '').split(TRAILER)) {
      if (!value.trim()) {
        continue
      }
      const person = parseTrailer(value)
      if (person) {
        add({ ...person, sha, subject, via: 'co-author' })
      }
    }
  }

  return { commits, people, trustworthy }
}

/** True when `person` is one of the configured maintainers. */
function isMaintainer(person, maintainers) {
  const name = person.name.toLowerCase()
  const email = person.email.toLowerCase()
  return maintainers.some((entry) => {
    const needle = entry.toLowerCase()
    return name === needle || email.includes(needle)
  })
}

const NAMES = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' })

/**
 * One release-note bullet: the contributing commits, the summary, then thanks
 * for everyone who worked on it other than the maintainer and any agent.
 * Mirrors the stock generator's shape (leading commit reference, continuation
 * lines indented by two) so old and new entries read the same.
 */
const getReleaseLine = async (changeset, _type, options) => {
  const maintainers = options?.maintainers || []
  const [firstLine, ...futureLines] = changeset.summary.split('\n').map((line) => line.trimEnd())

  const found = attribution(changesetPath(changeset.id), {})
  const usable = found.trustworthy && found.commits.length > 0
  if (found.error) {
    console.warn(
      `changelog: git could not read the history of ${changesetPath(changeset.id)}, so ` +
        'no contributors are credited and the release line cites the single commit ' +
        `changesets resolved. Check that git is installed and this runs inside the repository.\n${found.error}`,
    )
  } else if (!usable && found.commits.length > 0) {
    console.warn(
      `changelog: ${changesetPath(changeset.id)} has a parentless commit in ` +
        'its history, which means a shallow clone. Falling back to the single ' +
        'commit changesets resolved; check out full history to fix.',
    )
  }

  const cited = usable ? found.commits : changeset.commit ? [changeset.commit.slice(0, 7)] : []

  let returnVal = `- ${cited.length > 0 ? `${cited.join(', ')}: ` : ''}${firstLine}`

  if (futureLines.length > 0) {
    returnVal += `\n${futureLines.map((line) => `  ${line}`).join('\n')}`
  }

  if (usable) {
    const summary = changeset.summary.toLowerCase()
    const thanks = found.people
      .filter((person) => !isAgent(person))
      .filter((person) => !isMaintainer(person, maintainers))
      /** Hand-written prose in the changeset wins: never say a name twice. */
      .filter((person) => !summary.includes(person.name.toLowerCase()))
      .map((person) => person.name)

    if (thanks.length > 0) {
      returnVal += `\n\n  Thanks ${NAMES.format(thanks)}!`
    }
  }

  return returnVal
}

/** Unchanged from the stock generator: dependency bumps carry no attribution. */
const getDependencyReleaseLine = async (changesets, dependenciesUpdated) => {
  if (dependenciesUpdated.length === 0) {
    return ''
  }

  const changesetLinks = changesets.map(
    (changeset) =>
      `- Updated dependencies${changeset.commit ? ` [${changeset.commit.slice(0, 7)}]` : ''}`,
  )
  const updatedDependenciesList = dependenciesUpdated.map(
    (dependency) => `  - ${dependency.name}@${dependency.newVersion}`,
  )

  return [...changesetLinks, ...updatedDependenciesList].join('\n')
}

module.exports = {
  CHANGESET_DIRECTORY,
  attribution,
  changesetPath,
  getDependencyReleaseLine,
  getReleaseLine,
  isAgent,
  isMaintainer,
}
