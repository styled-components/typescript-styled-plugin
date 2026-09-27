/**
 * Runs every consumer type gate: each test/package-api/tsconfig.consumers.<gate>.json, compiled
 * by the TypeScript its "typescript/*" paths entry points at (node_modules/<alias>/*, a workspace
 * alias declared in test/e2e/package.json). Adding a TypeScript version means adding one tsconfig.
 *
 * - tsconfig.consumers.json is the shared base the version gates extend, not a gate itself.
 * - A gate whose moduleResolution (its own or an extended one) is node10 first gets the
 *   repository self-link that resolution needs (ensureNode10SelfLink, below).
 * - Fails before any gate runs when lib/ is missing, when a gate names no alias, or when an
 *   alias is not installed: without the alias, TypeScript silently falls back to the hoisted
 *   "typescript" package and checks the wrong version while still reporting success.
 * - Blind spot: reads each tsconfig as plain JSON, so a comment in one fails the run by name.
 *
 * Usage: node --experimental-strip-types scripts/test-package-api-types.ts [gate ...]
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import path from 'node:path'

interface CompilerOptions {
  moduleResolution?: string
  paths?: Record<string, string[]>
}

interface TsConfig {
  compilerOptions?: CompilerOptions
  extends?: string
}

interface Gate {
  alias: string
  file: string
  name: string
  node10: boolean
  tsc: string
  version: string
}

interface GateResult {
  gate: Gate
  ok: boolean
  output: string
}

const REPOSITORY_ROOT = realpathSync(path.resolve(import.meta.dirname, '..'))
const GATE_DIRECTORY = path.join(REPOSITORY_ROOT, 'test', 'package-api')
const GATE_FILE = /^tsconfig\.consumers\.(.+)\.json$/
const ALIAS_TARGET = /(?:^|\/)node_modules\/([^/]+)\/\*$/

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function relative(file: string): string {
  return path.relative(REPOSITORY_ROOT, file)
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return fail(`Could not read ${relative(file)} as JSON: ${reason}`)
  }
}

/** The compiler options a tsconfig sets, merged over the ones it extends. */
function resolvedOptions(file: string): CompilerOptions {
  const config = readJson<TsConfig>(file)
  const inherited = config.extends
    ? resolvedOptions(path.resolve(path.dirname(file), config.extends))
    : {}
  return { ...inherited, ...config.compilerOptions }
}

function describeGate(name: string): Gate {
  const file = path.join(GATE_DIRECTORY, `tsconfig.consumers.${name}.json`)
  const options = resolvedOptions(file)
  const target = options.paths?.['typescript/*']?.[0] ?? ''
  const alias = ALIAS_TARGET.exec(target)?.[1]
  if (alias === undefined) {
    fail(
      `Gate ${name} (${relative(file)}) needs a "typescript/*" paths entry ` +
        'pointing at node_modules/<alias>/*, the TypeScript version it checks against.',
    )
  }

  const aliasDirectory = path.join(REPOSITORY_ROOT, 'node_modules', alias)
  const tsc = path.join(aliasDirectory, 'bin', 'tsc')
  if (!existsSync(tsc)) {
    fail(
      `Gate ${name} checks against node_modules/${alias}, which is not installed. Run ` +
        '"corepack yarn install --immutable" to restore the alias declared in test/e2e/package.json.',
    )
  }

  const { version } = readJson<{ version: string }>(path.join(aliasDirectory, 'package.json'))
  return {
    alias,
    file,
    name,
    node10: ['node', 'node10'].includes(String(options.moduleResolution).toLowerCase()),
    tsc,
    version,
  }
}

function readLinkEntry(linkPath: string): Stats | undefined {
  try {
    return lstatSync(linkPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

function resolveLinkTarget(linkPath: string): string | undefined {
  try {
    return realpathSync(linkPath)
  } catch {
    return undefined
  }
}

/**
 * moduleResolution: node10 never consults "exports" or the self-reference feature that lets the
 * other consumer files import "@styled/typescript-styled-plugin" without a real node_modules
 * entry (docs/architecture.md, "Public surface"); it walks node_modules directories the way an
 * installed dependency would be found. test/e2e gets this for free because Yarn links its
 * "workspace:*" dependency there; test/package-api is not a workspace, so this keeps the
 * equivalent link at the repository root, matching what an install of this package into itself
 * would produce.
 *
 * - Missing: creates the link.
 * - A link resolving to this repository root: leaves it alone.
 * - A link resolving anywhere else, or dangling: re-points it here and says so. A second checkout
 *   or scratch copy that shares this node_modules through a symlink re-points the shared link at
 *   itself, and the node10 gate would then silently type-check that copy's lib/ instead.
 * - Anything that is not a link (a real directory or file): fails, since replacing it could
 *   delete real content.
 */
function ensureNode10SelfLink(): void {
  const scopeDirectory = path.join(REPOSITORY_ROOT, 'node_modules', '@styled')
  const linkPath = path.join(scopeDirectory, 'typescript-styled-plugin')
  const entry = readLinkEntry(linkPath)

  if (entry === undefined) {
    mkdirSync(scopeDirectory, { recursive: true })
    symlinkSync(REPOSITORY_ROOT, linkPath, 'dir')
    console.log(`Created ${relative(linkPath)} -> repository root for node10 resolution.`)
    return
  }

  if (!entry.isSymbolicLink()) {
    fail(
      `${linkPath} is a real ${entry.isDirectory() ? 'directory' : 'file'}, not a link to this ` +
        'repository, so the node10 type gate would check its contents instead of this ' +
        "repository's lib/. Move it aside or delete it, then rerun; this script recreates the link.",
    )
  }

  const target = resolveLinkTarget(linkPath)
  if (target !== REPOSITORY_ROOT) {
    unlinkSync(linkPath)
    symlinkSync(REPOSITORY_ROOT, linkPath, 'dir')
    console.log(
      `Re-pointed ${relative(linkPath)} from ${target ?? 'a missing target'} to this repository ` +
        `root (${REPOSITORY_ROOT}) for node10 resolution.`,
    )
  }
}

function runGate(gate: Gate): Promise<GateResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [gate.tsc, '--noEmit', '-p', gate.file], {
      cwd: REPOSITORY_ROOT,
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.on('error', (error) => resolve({ gate, ok: false, output: error.message }))
    child.on('close', (code) => resolve({ gate, ok: code === 0, output }))
  })
}

if (!existsSync(path.join(REPOSITORY_ROOT, 'lib', 'index.d.cts'))) {
  fail(
    'lib/ is missing, and the consumer gates type-check its declarations. Run "corepack yarn compile" first.',
  )
}

const available = readdirSync(GATE_DIRECTORY)
  .map((file) => GATE_FILE.exec(file)?.[1])
  .filter((name) => name !== undefined)
  .sort()
const requested = process.argv.slice(2)
const unknown = requested.filter((name) => !available.includes(name))
if (unknown.length > 0) {
  fail(`Unknown gate ${unknown.join(', ')}. Gates: ${available.join(', ')}.`)
}

const gates = (requested.length > 0 ? requested : available).map(describeGate)
if (gates.some((gate) => gate.node10)) {
  ensureNode10SelfLink()
}

const results = await Promise.all(gates.map(runGate))
for (const { gate, ok, output } of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} consumer gate ${gate.name} (${gate.alias} ${gate.version})`)
  if (!ok) {
    console.log(output.trimEnd().replace(/^/gm, '     '))
  }
}

if (results.some((result) => !result.ok)) {
  process.exitCode = 1
}
