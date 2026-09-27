/**
 * Asserts the exact file set of the packed tarball `corepack yarn pack:artifact` writes (the
 * packer `yarn npm publish` uses) against the set this script derives from package.json. Fails
 * listing every missing and every unexpected file.
 *
 * The expected set is:
 * - every path package.json points a consumer at (`main`, `types`, each `exports` and
 *   `typesVersions` target), so a new entry point is expected as soon as package.json names it;
 * - BUILD_HOOK_FILES, which tsdown.config.ts's build hooks write and package.json never names;
 * - ALWAYS_PACKED_FILES, which Yarn packs from the package root whatever `files` says.
 * A missing path outside every package.json `files` entry is flagged as such, since the packer
 * can never include it. Paths are compared literally, so a pattern in package.json
 * (findUnsupportedPatterns) fails the check by name before the tarball is read.
 *
 * Reads the tarball as it is: pack again after changing lib/ or package.json.
 *
 * Usage: node --experimental-strip-types scripts/check-pack-contents.ts [tarball]
 * The tarball defaults to package-artifact/package.tgz.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const DEFAULT_TARBALL = path.join(REPO_ROOT, 'package-artifact', 'package.tgz')

/** Yarn packs these from the package root regardless of `files` (package.json, README, LICENSE, CHANGELOG). */
const ALWAYS_PACKED_FILES = ['CHANGELOG.md', 'LICENSE.txt', 'README.md', 'package.json']

/**
 * Written by tsdown.config.ts's build:done hook and never named in package.json: the classic
 * Node10 declaration copy for a `lib/index` deep import, and the nested `{"type": "commonjs"}`
 * marker that keeps lib/index.js CommonJS under the root's "type": "module".
 */
const BUILD_HOOK_FILES = ['lib/index.d.ts', 'lib/package.json']

/** The directory every entry in a Yarn-packed tarball sits under. */
const TARBALL_ROOT = 'package/'

interface Manifest {
  exports?: unknown
  files?: string[]
  main?: string
  types?: string
  typesVersions?: unknown
}

type LeafVisitor = (leaf: string, keys: readonly string[]) => void

function normalize(target: string): string {
  return target.replace(/^\.\//, '')
}

/** Calls `visit` for every string leaf under `value`, with the keys (and list indexes) leading to it. */
function forEachLeaf(value: unknown, keys: readonly string[], visit: LeafVisitor): void {
  if (typeof value === 'string') {
    visit(value, keys)
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => forEachLeaf(entry, [...keys, String(index)], visit))
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      forEachLeaf(entry, [...keys, key], visit)
    }
  }
}

function expectedFiles(manifest: Manifest): Set<string> {
  const expected = new Set<string>([...ALWAYS_PACKED_FILES, ...BUILD_HOOK_FILES])
  for (const target of [manifest.main, manifest.types]) {
    if (target !== undefined) {
      expected.add(normalize(target))
    }
  }
  const add: LeafVisitor = (leaf) => expected.add(normalize(leaf))
  forEachLeaf(manifest.exports, [], add)
  forEachLeaf(manifest.typesVersions, [], add)
  return expected
}

const FILES_GLOB_PATTERN = /[*?[\]{}]/

/**
 * Every package.json value this script would otherwise compare as a literal path although it is a
 * pattern: a `files` glob or negation, an `exports` or `typesVersions` wildcard (`*`), or an
 * `exports` folder mapping (a key or target ending in "/"). Each would yield a misleading missing
 * or unexpected list, so the check stops and names it instead.
 */
function findUnsupportedPatterns(manifest: Manifest): string[] {
  const found = new Set<string>()
  for (const entry of manifest.files ?? []) {
    if (entry.startsWith('!') || FILES_GLOB_PATTERN.test(entry)) {
      found.add(`"files" entry ${JSON.stringify(entry)} (a glob or negation)`)
    }
  }
  forEachLeaf(manifest.exports, [], (leaf, keys) => {
    for (const key of keys) {
      if (key.startsWith('.') && (key.includes('*') || key.endsWith('/'))) {
        found.add(`"exports" key ${JSON.stringify(key)} (a wildcard or folder pattern)`)
      }
    }
    if (leaf.includes('*') || leaf.endsWith('/')) {
      found.add(
        `"exports" target ${JSON.stringify(leaf)} at exports${keys.map((key) => `[${JSON.stringify(key)}]`).join('')} (a wildcard or folder pattern)`,
      )
    }
  })
  forEachLeaf(manifest.typesVersions, [], (leaf, keys) => {
    const subpath = keys[1] ?? ''
    if (subpath.includes('*') || leaf.includes('*')) {
      found.add(`"typesVersions" mapping ${JSON.stringify(subpath)} (a wildcard pattern)`)
    }
  })
  return [...found]
}

function isUnderFilesEntry(file: string, entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const prefix = normalize(entry).replace(/\/$/, '')
    return file === prefix || file.startsWith(`${prefix}/`)
  })
}

function packedFiles(tarball: string): Set<string> {
  const listing = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  if (listing.error || listing.status !== 0) {
    throw new Error(
      `\`tar -tzf ${tarball}\` failed (${listing.error ?? `exit code ${listing.status}`}): ${listing.stderr}`,
    )
  }
  const files = new Set<string>()
  for (const entry of listing.stdout.split('\n')) {
    if (entry === '' || entry.endsWith('/')) {
      continue
    }
    if (!entry.startsWith(TARBALL_ROOT)) {
      throw new Error(
        `${tarball} holds ${entry}, outside the ${TARBALL_ROOT} directory every packed file sits under.`,
      )
    }
    files.add(entry.slice(TARBALL_ROOT.length))
  }
  if (files.size === 0) {
    throw new Error(`${tarball} lists no files, so there is nothing to compare.`)
  }
  return files
}

function main(): void {
  const tarball = path.resolve(process.argv[2] ?? DEFAULT_TARBALL)
  if (!fs.existsSync(tarball)) {
    console.error(
      `Pack check: no packed tarball at ${tarball}. Run "corepack yarn pack:artifact" (it builds ` +
        'lib/ first), or pass a tarball path.',
    )
    process.exitCode = 1
    return
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as Manifest
  const unsupported = findUnsupportedPatterns(manifest)
  if (unsupported.length > 0) {
    console.error(
      `Pack check: package.json uses patterns this script compares only as literal paths:\n  ` +
        `${unsupported.join('\n  ')}\n` +
        'Its missing and unexpected lists would be wrong for these. Name each file literally in ' +
        'package.json, or teach scripts/check-pack-contents.ts to expand the pattern.',
    )
    process.exitCode = 1
    return
  }
  const expected = expectedFiles(manifest)
  const packed = packedFiles(tarball)
  const missing = [...expected].filter((file) => !packed.has(file)).sort()
  const unexpected = [...packed].filter((file) => !expected.has(file)).sort()

  if (missing.length > 0) {
    const describeMissing = (file: string) =>
      ALWAYS_PACKED_FILES.includes(file) || isUnderFilesEntry(file, manifest.files ?? [])
        ? file
        : `${file} (outside every package.json "files" entry, ${JSON.stringify(manifest.files)}, so the tarball can never contain it)`
    console.error(
      `Pack check: missing from the tarball:\n  ${missing.map(describeMissing).join('\n  ')}\n` +
        'Either the build no longer writes these (check tsdown.config.ts), or package.json ' +
        '"files" does not cover them: add the directory to "files", or move the entry point ' +
        '(package.json) or build hook output (BUILD_HOOK_FILES in this script) under one.',
    )
  }
  if (unexpected.length > 0) {
    console.error(
      `Pack check: unexpected in the tarball:\n  ${unexpected.join('\n  ')}\n` +
        'Either the build writes a file nothing points at (remove it, or name it in package.json), ' +
        'or a stray file at the package root matches a name Yarn always packs.',
    )
  }
  if (missing.length > 0 || unexpected.length > 0) {
    process.exitCode = 1
    return
  }
  console.log(`ok   pack contents: ${packed.size} files, exactly the expected set`)
}

main()
