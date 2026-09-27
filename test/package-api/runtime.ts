/**
 * Loads a packed tarball of this package from a throwaway project: the tsserver entry, `./api`,
 * and the 1.0.1 deep subpaths through require(), then runtime-esm-consumer.mjs for import().
 *
 * Usage: node --experimental-strip-types test/package-api/runtime.ts [tarball]
 * The tarball defaults to package-artifact/package.tgz, which `corepack yarn pack:artifact`
 * writes after building lib/.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'

const workspaceRoot = path.resolve(import.meta.dirname, '../..')
const require = createRequire(import.meta.url)
const {
  PACKAGE_NAME,
  installPackedPackage,
  linkWorkspaceModule,
}: typeof import('./packed-package.cjs') = require('./packed-package.cjs')

const DEFAULT_TARBALL = path.join(workspaceRoot, 'package-artifact', 'package.tgz')
const API_EXPORTS = [
  'StyledTemplateLanguageService',
  'PluginConfigurationManager',
  'getTemplateSettings',
]

/**
 * Bounds on the import() consumer, which runs one code-fix request through the packed plugin: a
 * healthy run takes well under a second and a few dozen megabytes, so a stop means the packed
 * plugin loops forever or retains without bound.
 */
const ESM_CONSUMER_DEADLINE_MS = 60_000
const ESM_CONSUMER_HEAP_CAP_MB = 512

const tarballPath = path.resolve(process.argv[2] ?? DEFAULT_TARBALL)
if (!existsSync(tarballPath)) {
  console.error(
    `No packed tarball at ${tarballPath}. Run "corepack yarn pack:artifact" (it builds lib/ ` +
      'first), or pass a tarball path.',
  )
  process.exit(1)
}

function expectFunction(value: unknown, description: string): void {
  if (typeof value !== 'function') {
    throw new TypeError(`${description} must be a function; received ${typeof value}.`)
  }
}

function expectApiExports(module: Record<string, unknown>, description: string): void {
  for (const name of API_EXPORTS) {
    expectFunction(module[name], `${name} from ${description}`)
  }
}

const projectDirectory = mkdtempSync(path.join(tmpdir(), 'typescript-styled-plugin-'))
try {
  const packageDirectory = installPackedPackage({ projectDirectory, tarballPath, workspaceRoot })
  linkWorkspaceModule({ name: 'typescript', projectDirectory, workspaceRoot })

  const requireFromConsumer = createRequire(path.join(projectDirectory, 'consumer.cjs'))
  const typescript = require('typescript/lib/tsserverlibrary.js')

  const pluginFactory = requireFromConsumer(PACKAGE_NAME)
  expectFunction(pluginFactory, `require("${PACKAGE_NAME}")`)
  expectFunction(
    pluginFactory({ typescript }).create,
    `create on the module require("${PACKAGE_NAME}") builds`,
  )

  /** 1.0.1 shipped no "exports" map, so every deep path it had must keep resolving. */
  for (const deepPath of ['lib/index', 'lib/index.js']) {
    expectFunction(
      requireFromConsumer(`${PACKAGE_NAME}/${deepPath}`),
      `require("${PACKAGE_NAME}/${deepPath}")`,
    )
  }
  for (const deepPath of ['lib/api', 'lib/api.js']) {
    expectApiExports(
      requireFromConsumer(`${PACKAGE_NAME}/${deepPath}`),
      `require("${PACKAGE_NAME}/${deepPath}")`,
    )
  }

  /**
   * An absolute require() never consults "exports", as a resolver that ignores it (webpack 4,
   * Jest before 28) never does, so this passes only when lib/api.js is a real file.
   */
  expectApiExports(
    requireFromConsumer(path.join(packageDirectory, 'lib', 'api.js')),
    'the physical lib/api.js file',
  )

  /** The "require" condition of "./api" is a real CommonJS build, with no require(esm) needed. */
  expectApiExports(requireFromConsumer(`${PACKAGE_NAME}/api`), `require("${PACKAGE_NAME}/api")`)

  const esmConsumer = path.join(projectDirectory, 'consumer.mjs')
  copyFileSync(path.join(import.meta.dirname, 'runtime-esm-consumer.mjs'), esmConsumer)
  try {
    execFileSync(
      process.execPath,
      [`--max-old-space-size=${ESM_CONSUMER_HEAP_CAP_MB}`, esmConsumer],
      { killSignal: 'SIGKILL', stdio: 'inherit', timeout: ESM_CONSUMER_DEADLINE_MS },
    )
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') {
      throw new Error(
        `The import() consumer (test/package-api/runtime-esm-consumer.mjs) did not finish within ` +
          `${ESM_CONSUMER_DEADLINE_MS} ms and was stopped. It runs one code-fix request through ` +
          'the packed plugin, so the plugin most likely loops forever on it.',
        { cause: error },
      )
    }
    throw error
  }
  console.log(
    `ok   package runtime: ${path.relative(workspaceRoot, tarballPath)} loads through require() and import()`,
  )
} finally {
  rmSync(projectDirectory, { force: true, recursive: true })
}
