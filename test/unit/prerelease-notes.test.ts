import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, assert, describe, it } from 'vitest'

const SCRIPT = path.resolve(__dirname, '../../scripts/prerelease-notes.ts')

let fixtureDir: string | undefined

afterEach(() => {
  if (fixtureDir) {
    rmSync(fixtureDir, { force: true, recursive: true })
    fixtureDir = undefined
  }
})

/** A fresh temporary directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'prerelease-notes-test-'))
  fixtureDir = dir
  return dir
}

/** Writes `changelog` and a package.json naming `version` into a fresh temp directory, returning both paths. */
function fixture(
  changelog: string,
  version: string,
): { changelogPath: string; packageJsonPath: string } {
  const dir = tempDir()
  const changelogPath = path.join(dir, 'CHANGELOG.md')
  const packageJsonPath = path.join(dir, 'package.json')
  writeFileSync(changelogPath, changelog)
  writeFileSync(packageJsonPath, JSON.stringify({ name: 'fixture', version }))
  return { changelogPath, packageJsonPath }
}

function run(changelogPath: string, packageJsonPath: string) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', SCRIPT, changelogPath, packageJsonPath],
    { encoding: 'utf8' },
  )
}

describe('prerelease-notes', () => {
  it('prints the newest section, stopping before the next "## " heading', () => {
    const { changelogPath, packageJsonPath } = fixture(
      '# Changelog\n\n' +
        '## 1.1.0-prerelease-20260927190000\n\n' +
        '- abc1234: Adds a thing.\n\n' +
        '  Thanks Ada Author!\n\n' +
        '## 1.0.1 - December 11, 2023\n\n' +
        '- Add support for `@container` queries\n',
      '1.1.0-prerelease-20260927190000',
    )

    const result = run(changelogPath, packageJsonPath)

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stderr, '')
    assert.strictEqual(
      result.stdout,
      '## 1.1.0-prerelease-20260927190000\n\n' +
        '- abc1234: Adds a thing.\n\n' +
        '  Thanks Ada Author!\n',
    )
  })

  it('prints the only section unchanged when the changelog has just one', () => {
    const { changelogPath, packageJsonPath } = fixture(
      '# Changelog\n\n## 2.0.0\n\n- Internal changes only.\n',
      '2.0.0',
    )

    const result = run(changelogPath, packageJsonPath)

    assert.strictEqual(result.status, 0)
    assert.strictEqual(result.stdout, '## 2.0.0\n\n- Internal changes only.\n')
  })

  it('fails with a clear message and no stdout when the changelog has no "## " heading', () => {
    const { changelogPath, packageJsonPath } = fixture(
      '# Changelog\n\nNothing released yet.\n',
      '1.0.0',
    )

    const result = run(changelogPath, packageJsonPath)

    assert.notEqual(result.status, 0)
    assert.strictEqual(result.stdout, '')
    assert.match(result.stderr, /no "## " version heading to print/)
    assert.include(result.stderr, changelogPath)
  })

  it("fails with a clear message and no stdout when the newest heading does not match package.json's version", () => {
    const { changelogPath, packageJsonPath } = fixture(
      '# Changelog\n\n## 1.2.0\n\n- Adds a thing.\n',
      '1.3.0',
    )

    const result = run(changelogPath, packageJsonPath)

    assert.notEqual(result.status, 0)
    assert.strictEqual(result.stdout, '')
    assert.match(result.stderr, /"## 1\.2\.0".*does not match "## 1\.3\.0"/s)
    assert.include(result.stderr, packageJsonPath)
  })
})
