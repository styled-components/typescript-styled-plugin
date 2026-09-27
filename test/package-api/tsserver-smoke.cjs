/**
 * Drives a real tsserver against the packed tarball to prove the tsserver plugin loads under
 * require() and answers completions, diagnostics, and hover for a styled-components template.
 * Plain CommonJS so it runs directly on this package's Node floor, 14.21.3 (docs/tsserver-host.md),
 * where the vitest-based E2E suite cannot run (vitest declares a newer engines.node itself).
 *
 * Usage: node tsserver-smoke.cjs <tarball-path> <typescript-package-dir> [workspace-root]
 *
 * Set the TSSERVER_SMOKE_MODE environment variable to "inactive" to instead prove graceful
 * non-activation on a TypeScript host below the plugin's supported floor: the plugin logs the
 * unsupported-version message and returns the host's language service untouched, so tsserver
 * keeps answering completions and diagnostics for the same fixture, just without the plugin's
 * own contributions. Any other value, or leaving it unset, runs the normal activation check.
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { installPackedPackage } = require('./packed-package.cjs')

const tarballPath = path.resolve(requireArg(2, 'tarball-path'))
const typescriptDir = path.resolve(requireArg(3, 'typescript-package-dir'))
const workspaceRoot = path.resolve(process.argv[4] || path.join(__dirname, '..', '..'))
const mode = process.env.TSSERVER_SMOKE_MODE === 'inactive' ? 'inactive' : 'active'

function requireArg(index, name) {
  const value = process.argv[index]
  if (!value) {
    console.error(`Missing required argument <${name}>.`)
    console.error(
      'Usage: node tsserver-smoke.cjs <tarball-path> <typescript-package-dir> [workspace-root]',
    )
    process.exit(1)
  }
  return value
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsserver-smoke-'))

/**
 * V8 heap cap for this tsserver, the same value and rationale as
 * test/e2e/tsserver-fixture/server.ts's TSSERVER_HEAP_CAP_MB (several times what this fixture's
 * server uses, so a plugin regression that retains without bound ends it with "JavaScript heap out
 * of memory" instead of growing toward swap); duplicated as a plain number here rather than
 * imported, since this script's only build requirement is Node 14.21.3 itself. Verified on a real
 * Node 14.21.3 binary that --max-old-space-size caps the old generation there exactly as on later
 * Node versions (a run held under the cap completes normally; the same workload comfortably over
 * it aborts with a V8 out-of-memory error instead of growing unbounded).
 */
const TSSERVER_HEAP_CAP_MB = 1024

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function main() {
  try {
    installPackedPackage({ projectDirectory: projectDir, tarballPath, workspaceRoot })
    installTypeScript()
    writeFixture()

    const { completions, diagnostics, quickinfo, log } = await driveTsserver()

    if (mode === 'inactive') {
      assertPluginInactive(log)
      assertCompletionsInactive(completions)
      assertDiagnosticsInactive(diagnostics)

      console.log(
        'tsserver smoke check passed: plugin logged the unsupported-version message and left tsserver responsive.',
      )
    } else {
      assertPluginLoaded(log)
      assertCompletions(completions)
      assertDiagnostics(diagnostics)
      assertQuickInfo(quickinfo)

      console.log(
        'tsserver smoke check passed: plugin loaded and answered completions, diagnostics, and hover.',
      )
    }
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

function installTypeScript() {
  /**
   * A real copy, not a symlink: tsserver resolves a plugin relative to the realpath of the
   * typescript package it was loaded from (docs/tsserver-host.md, "classic Node10 rules from
   * the host's own directory"), so a symlinked typescript package would send the plugin probe
   * to the symlink target's directory tree instead of this fixture project. Copied by hand
   * rather than with fs.cpSync, which this script's own Node floor, 14.21.3 (docs/tsserver-
   * host.md), does not have (added in Node 16.7.0).
   */
  copyDirectory(typescriptDir, path.join(projectDir, 'node_modules', 'typescript'))
}

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath)
    } else if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
    } else {
      fs.copyFileSync(sourcePath, destinationPath)
    }
  }
}

function writeFixture() {
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
  fs.writeFileSync(
    path.join(projectDir, 'src', 'a.ts'),
    [
      'import styled from "styled-components"',
      'export const Button = styled.button`',
      '  col',
      '`',
      'export const Box = styled.div`',
      '  boarder: 1px solid red;',
      '  color: blue;',
      '`',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(projectDir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'es2018',
        jsx: 'react',
        plugins: [{ name: '@styled/typescript-styled-plugin' }],
      },
      include: ['src'],
    }),
  )
}

/** How long to wait for a tsserver response before failing: a dropped response would otherwise hang the process until the CI job's own, much longer, unrelated timeout kills it without naming which request never came back. */
const PENDING_RESPONSE_TIMEOUT_MS = 10_000

function driveTsserver() {
  const file = path.join(projectDir, 'src', 'a.ts')
  const logFile = path.join(projectDir, 'tsserver-smoke.log')
  const tsserverPath = path.join(projectDir, 'node_modules', 'typescript', 'lib', 'tsserver.js')

  return new Promise((resolve, reject) => {
    const server = spawn(
      process.execPath,
      [
        `--max-old-space-size=${TSSERVER_HEAP_CAP_MB}`,
        tsserverPath,
        '--logVerbosity',
        'verbose',
        '--logFile',
        logFile,
      ],
      { cwd: projectDir },
    )

    let buffer = ''
    let sequence = 0
    const pending = new Map()
    server.on('error', reject)
    /**
     * A multibyte UTF-8 character can straddle two "data" chunks; decoding each chunk with its
     * own Buffer#toString() call, independent of the bytes before and after it, corrupts a split
     * character into the U+FFFD replacement character instead of reassembling it. setEncoding
     * uses a StringDecoder internally, which buffers a trailing incomplete sequence until the
     * next chunk completes it, so `chunk` below already arrives as a correctly decoded string.
     */
    server.stdout.setEncoding('utf8')
    server.stdout.on('data', (chunk) => {
      buffer += chunk
      for (;;) {
        const header = /Content-Length: (\d+)\r\n\r\n/.exec(buffer)
        if (!header) break
        const bodyStart = header.index + header[0].length
        const rest = Buffer.from(buffer.slice(bodyStart), 'utf8')
        const length = Number(header[1])
        if (rest.length < length) break
        const body = rest.subarray(0, length).toString('utf8')
        buffer = rest.subarray(length).toString('utf8')
        let message
        try {
          message = JSON.parse(body)
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
          reject(
            new Error(`tsserver sent a message body that is not JSON (${error.message}):\n${body}`),
          )
          server.kill()
          return
        }
        if (message.type === 'response' && pending.has(message.request_seq)) {
          pending.get(message.request_seq)(message)
          pending.delete(message.request_seq)
        }
      }
    })

    const send = (command, args, expectResponse = true) =>
      new Promise((resolveResponse, rejectResponse) => {
        const requestSeq = ++sequence
        if (expectResponse) {
          const timeout = setTimeout(() => {
            pending.delete(requestSeq)
            rejectResponse(
              new Error(
                `tsserver never responded to "${command}" (request_seq ${requestSeq}) within ${PENDING_RESPONSE_TIMEOUT_MS}ms.`,
              ),
            )
          }, PENDING_RESPONSE_TIMEOUT_MS)
          pending.set(requestSeq, (message) => {
            clearTimeout(timeout)
            resolveResponse(message)
          })
        }
        server.stdin.write(
          `${JSON.stringify({ seq: requestSeq, type: 'request', command, arguments: args })}\n`,
        )
        if (!expectResponse) resolveResponse()
      })
    ;(async () => {
      try {
        await send('open', { file }, false)
        const completions = await send('completionInfo', { file, line: 3, offset: 6 })
        const diagnostics = await send('semanticDiagnosticsSync', { file })
        const quickinfo = await send('quickinfo', { file, line: 7, offset: 4 })
        resolve({ completions, diagnostics, quickinfo, log: safeReadLog(logFile) })
      } catch (error) {
        reject(error)
      } finally {
        /**
         * Runs on every exit path, including a pending-response timeout: without it, a dropped
         * response would leave the tsserver child process running and this script's event loop
         * alive indefinitely, hanging instead of failing fast. Only waits for "exit" when the
         * process has not already exited on its own (a crash), since that event fires once and
         * would otherwise never come for a promise registered after the fact.
         */
        if (server.exitCode === null && server.signalCode === null) {
          server.stdin.end()
          server.kill()
          await new Promise((r) => server.once('exit', r))
        }
      }
    })()
  })
}

function safeReadLog(logFile) {
  try {
    return fs.readFileSync(logFile, 'utf8')
  } catch {
    return ''
  }
}

function assertPluginLoaded(log) {
  if (!log.includes('Plugin validation succeeded')) {
    throw new Error(
      `tsserver never logged "Plugin validation succeeded" for @styled/typescript-styled-plugin.\n${log}`,
    )
  }
}

const UNKNOWN_PROPERTY_MESSAGE = "Unknown property: 'boarder'"

function completionNames(response) {
  return (response.body?.entries || []).map((entry) => entry.name)
}

function diagnosticMessages(response) {
  return (response.body || []).map((diagnostic) => `${diagnostic.code} ${diagnostic.text}`)
}

function hasUnknownPropertyDiagnostic(response) {
  return diagnosticMessages(response).some((message) => message.includes(UNKNOWN_PROPERTY_MESSAGE))
}

function assertCompletions(response) {
  const names = completionNames(response)
  if (!response.success || !names.includes('color')) {
    throw new Error(
      `Expected a "color" completion inside the styled template, got ${JSON.stringify(names.slice(0, 20))}.`,
    )
  }
}

function assertDiagnostics(response) {
  if (!response.success || !hasUnknownPropertyDiagnostic(response)) {
    throw new Error(
      `Expected an "${UNKNOWN_PROPERTY_MESSAGE}" diagnostic, got ${JSON.stringify(diagnosticMessages(response))}.`,
    )
  }
}

function assertQuickInfo(response) {
  const documentation = response.body?.documentation
  const text = Array.isArray(documentation)
    ? documentation.map((part) => part.text).join('')
    : String(documentation || '')
  if (!response.success || !text.includes('color')) {
    throw new Error(`Expected hover documentation mentioning "color", got ${JSON.stringify(text)}.`)
  }
}

function assertPluginInactive(log) {
  if (!/Unsupported TypeScript version .* TypeScript 5\.0 or newer required/.test(log)) {
    throw new Error(
      `tsserver log never reported the unsupported-version message for @styled/typescript-styled-plugin.\n${log}`,
    )
  }
}

function assertCompletionsInactive(response) {
  const names = completionNames(response)
  if (!response.success) {
    throw new Error(`Expected a successful completions response, got ${JSON.stringify(response)}.`)
  }
  if (names.includes('color')) {
    throw new Error(
      `Expected no "color" completion inside the styled template on an inactive host, got ${JSON.stringify(names.slice(0, 20))}.`,
    )
  }
}

function assertDiagnosticsInactive(response) {
  if (!response.success) {
    throw new Error(`Expected a successful diagnostics response, got ${JSON.stringify(response)}.`)
  }
  if (hasUnknownPropertyDiagnostic(response)) {
    throw new Error(
      `Expected no "${UNKNOWN_PROPERTY_MESSAGE}" diagnostic on an inactive host, got ${JSON.stringify(diagnosticMessages(response))}.`,
    )
  }
}
