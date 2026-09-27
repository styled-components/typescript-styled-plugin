/**
 * Prints the newest version section of CHANGELOG.md, for use as GitHub release notes on a
 * snapshot prerelease (.github/workflows/release.yml, the `prerelease` job).
 *
 * `changeset version --snapshot` writes that section the same way an ordinary `changeset version`
 * does: scripts/changelog.cjs (wired in .changeset/config.json) assembles it, crediting
 * contributors, under a `## <version>` heading matching the version it just wrote to package.json.
 * This script trusts that heading rather than reformatting the version itself, so it fails loudly
 * instead of publishing notes for the wrong release when the two disagree.
 *
 * Usage: node --experimental-strip-types scripts/prerelease-notes.ts [changelogPath] [packageJsonPath]
 * Both paths default to CHANGELOG.md and package.json at the repository root.
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * The text from the first `## ` heading line up to, but not including, the next `## ` heading
 * line, or the end of `changelog` when there is only one section. Undefined when `changelog` has
 * no `## ` heading at all.
 */
export function latestSection(changelog: string): string | undefined {
  const lines = changelog.split('\n')
  const start = lines.findIndex((line) => line.startsWith('## '))
  if (start === -1) {
    return undefined
  }
  const nextOffset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '))
  const end = nextOffset === -1 ? lines.length : start + 1 + nextOffset
  return lines.slice(start, end).join('\n').trim()
}

/** `section`'s heading line, exactly as @changesets/apply-release-plan writes it (`## <version>`). */
export function sectionHeading(section: string): string {
  return section.split('\n', 1)[0] ?? ''
}

function main(): void {
  const changelogPath = path.resolve(process.argv[2] ?? path.join(REPO_ROOT, 'CHANGELOG.md'))
  const packageJsonPath = path.resolve(process.argv[3] ?? path.join(REPO_ROOT, 'package.json'))

  const changelog = fs.readFileSync(changelogPath, 'utf8')
  const version = (JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string })
    .version

  const section = latestSection(changelog)
  if (section === undefined) {
    console.error(`prerelease-notes: ${changelogPath} has no "## " version heading to print.`)
    process.exitCode = 1
    return
  }

  const heading = sectionHeading(section)
  const expectedHeading = `## ${version}`
  if (heading !== expectedHeading) {
    console.error(
      `prerelease-notes: the newest section in ${changelogPath} is headed "${heading}", which ` +
        `does not match "${expectedHeading}" from ${packageJsonPath}. Run "corepack yarn ` +
        'changeset-version" (or "changeset version --snapshot") again so the changelog and ' +
        'package.json agree before publishing.',
    )
    process.exitCode = 1
    return
  }

  console.log(section)
}

main()
