import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

import type { server } from 'typescript'

import { e2eRoot, type FixtureProject } from '../fixture-paths'
import { TSServerMessageReader } from './message-reader'
import { responseTimeoutMs } from './timeouts'

const require = createRequire(import.meta.url)

export const pluginPackageName = '@styled/typescript-styled-plugin'

/**
 * V8 heap cap for each tsserver, several times what a fixture project's server uses, so a plugin
 * regression that retains without bound ends that server with "JavaScript heap out of memory" in
 * the failure message instead of growing every parallel server toward swap.
 */
const TSSERVER_HEAP_CAP_MB = 1024

/** Requests the scenarios send, each paired with the response tsserver's protocol declares for it. */
interface RequestTypes {
  completionEntryDetails: {
    request: server.protocol.CompletionDetailsRequest
    response: server.protocol.CompletionDetailsResponse
  }
  completions: {
    request: server.protocol.CompletionsRequest
    response: server.protocol.CompletionsResponse
  }
  configure: {
    request: server.protocol.ConfigureRequest
    response: server.protocol.ConfigureResponse
  }
  configurePlugin: {
    request: server.protocol.ConfigurePluginRequest
    response: server.protocol.ConfigurePluginResponse
  }
  getCodeFixes: {
    request: server.protocol.CodeFixRequest
    response: server.protocol.GetCodeFixesResponse
  }
  getOutliningSpans: {
    request: server.protocol.OutliningSpansRequest
    response: server.protocol.OutliningSpansResponse
  }
  quickinfo: {
    request: server.protocol.QuickInfoRequest
    response: server.protocol.QuickInfoResponse
  }
  semanticDiagnosticsSync: {
    request: server.protocol.SemanticDiagnosticsSyncRequest
    response: server.protocol.SemanticDiagnosticsSyncResponse
  }
}

/** Messages tsserver applies without a required response. */
interface NotificationTypes {
  change: server.protocol.ChangeRequest
  open: server.protocol.OpenRequest
}

export type RequestCommand = keyof RequestTypes
export type RequestArguments<Command extends RequestCommand> =
  RequestTypes[Command]['request']['arguments']
export type ResponseTo<Command extends RequestCommand> = RequestTypes[Command]['response']
type NotificationCommand = keyof NotificationTypes

export interface TSServerOptions {
  project?: FixtureProject
  /** An alias from test/e2e/package.json; defaults to `TSSERVER_TYPESCRIPT_PACKAGE`, then `typescript`. */
  typescriptPackage?: string
}

interface PendingRequest {
  command: RequestCommand
  reject: (reason: Error) => void
  resolve: (response: server.protocol.Response) => void
  timeout: NodeJS.Timeout
}

export class TSServer {
  private closePromise: Promise<void> | undefined
  private readonly exited: Promise<void>
  private failure: Error | undefined
  /**
   * Sequence numbers of sent notifications. Some TypeScript versions answer a notification with a
   * response and others send none (docs/tsserver-host.md), so an answer is consumed if it arrives
   * and never awaited.
   */
  private readonly notifications = new Set<number>()
  private readonly pending = new Map<number, PendingRequest>()
  private readonly process: ChildProcessWithoutNullStreams
  private sequence = 0
  public readonly logFile: string
  public readonly project: FixtureProject

  constructor({ project = 'styled-project-fixture', typescriptPackage }: TSServerOptions = {}) {
    this.project = project
    const runId = process.env.TSSERVER_FIXTURE_RUN_ID
    if (runId === undefined) {
      throw new Error(
        'TSSERVER_FIXTURE_RUN_ID is not set: the e2e globalSetup (test/e2e/tsserver-fixture/clear-logs.ts) sets it. Run e2e scenarios through the e2e vitest project, for example `corepack yarn test:e2e`.',
      )
    }
    const logDirectory = path.join(import.meta.dirname, 'logs', runId)
    mkdirSync(logDirectory, { recursive: true })
    this.logFile = path.join(logDirectory, `${randomUUID()}.log`)

    const packageName = typescriptPackage ?? process.env.TSSERVER_TYPESCRIPT_PACKAGE ?? 'typescript'
    const tsserverPath = require.resolve(`${packageName}/lib/tsserver.js`)
    this.process = spawn(
      process.execPath,
      [
        `--max-old-space-size=${TSSERVER_HEAP_CAP_MB}`,
        tsserverPath,
        '--logVerbosity',
        'verbose',
        '--logFile',
        this.logFile,
        '--pluginProbeLocations',
        e2eRoot,
      ],
      { cwd: path.join(e2eRoot, project), stdio: 'pipe' },
    )

    let stderr = ''
    this.process.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8_192)
    })
    const messageReader = new TSServerMessageReader()
    this.process.stdout.on('data', (chunk: Buffer) => {
      for (const message of messageReader.push(chunk)) {
        this.handleMessage(message)
      }
    })
    this.exited = new Promise((resolve) => {
      this.process.on('error', (error) => {
        this.fail(new Error(`tsserver failed to start from ${tsserverPath}.`, { cause: error }))
      })
      this.process.on('close', (code, signal) => {
        const closing = this.closePromise !== undefined
        if (!closing || code !== 0 || signal !== null) {
          this.fail(
            new Error(
              `tsserver ${closing ? 'exited' : 'exited before close()'} with code ${String(code)} and signal ${String(signal)}. Its log: ${this.logFile}${stderr ? `\n${stderr}` : ''}`,
            ),
          )
        }
        resolve()
      })
    })
  }

  /** Path of a file in this server's fixture project. */
  fixtureFile(fileName = 'main.ts'): string {
    return path.join(e2eRoot, this.project, fileName)
  }

  /**
   * Sends `command` and resolves with the response whose `request_seq` matches it. A response
   * that never arrives fails the whole session and stops tsserver at once: a plugin stuck in a
   * synchronous loop never reads stdin, so waiting for `close()` to end it would hold a core for
   * another full timeout.
   */
  request<Command extends RequestCommand>(
    command: Command,
    args: RequestArguments<Command>,
  ): Promise<ResponseTo<Command>> {
    const seq = this.write(command, args)
    return new Promise<ResponseTo<Command>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.fail(
          new Error(
            `tsserver did not answer "${command}" (request_seq ${seq}) within ${responseTimeoutMs} ms, so it was stopped. Raise TSSERVER_RESPONSE_TIMEOUT_MS on a slow host, or read the log: ${this.logFile}`,
          ),
        )
      }, responseTimeoutMs)
      this.pending.set(seq, { command, reject, resolve, timeout })
    })
  }

  notify<Command extends NotificationCommand>(
    command: Command,
    args: NotificationTypes[Command]['arguments'],
  ): void {
    this.notifications.add(this.write(command, args))
  }

  /** Opens `fileName` in this server's fixture project with `fileContent`, returning its path. */
  open(
    fileContent: string,
    {
      fileName = 'main.ts',
      scriptKindName = 'TS',
    }: { fileName?: string; scriptKindName?: server.protocol.ScriptKindName } = {},
  ): string {
    const file = this.fixtureFile(fileName)
    this.notify('open', { file, fileContent, scriptKindName })
    return file
  }

  async configurePlugin(configuration: unknown): Promise<void> {
    const response = await this.request('configurePlugin', {
      configuration,
      pluginName: pluginPackageName,
    })
    if (!response.success) {
      throw new Error(`configurePlugin failed: ${response.message ?? 'no message'}`)
    }
  }

  /** Ends tsserver's input and waits for it to exit; rejects on any failure the session saw. */
  close(): Promise<void> {
    this.closePromise ??= this.shutDown()
    return this.closePromise
  }

  /** Reads this server's own tsserver log; throws when tsserver never wrote it. */
  readLog(): string {
    return readFileSync(this.logFile, 'utf8')
  }

  private async shutDown(): Promise<void> {
    if (this.pending.size > 0) {
      this.fail(
        new Error(
          `close() ran while requests still awaited responses: ${this.describePending()}. Await each request before closing.`,
        ),
      )
    } else {
      this.process.stdin.end()
    }

    let timeout: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timed out'>((resolve) => {
      timeout = setTimeout(() => resolve('timed out'), responseTimeoutMs)
    })
    const outcome = await Promise.race([this.exited, timedOut])
    clearTimeout(timeout)
    if (outcome === 'timed out') {
      this.process.kill('SIGKILL')
      throw new Error(
        `tsserver did not exit within ${responseTimeoutMs} ms of close(). Its log: ${this.logFile}`,
      )
    }
    if (this.failure !== undefined) {
      throw this.failure
    }
  }

  private write(command: string, args: unknown): number {
    if (this.failure !== undefined) {
      throw this.failure
    }
    if (this.closePromise !== undefined) {
      throw new Error(`Cannot send "${command}": close() already ran for this server.`)
    }
    const seq = ++this.sequence
    let message = JSON.stringify({ arguments: args, command, seq, type: 'request' })
    /** The line-delimited protocol reads a raw U+2028 or U+2029 as a line break. */
    for (const code of [0x2028, 0x2029]) {
      message = message.replaceAll(String.fromCharCode(code), `\\u${code.toString(16)}`)
    }
    this.process.stdin.write(`${message}\n`)
    return seq
  }

  private handleMessage(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch (error) {
      this.fail(
        new Error(`tsserver wrote a message that is not JSON: ${text.slice(0, 500)}`, {
          cause: error,
        }),
      )
      return
    }
    if (isEvent(message)) {
      return
    }
    if (!isResponse(message)) {
      this.fail(
        new Error(
          `tsserver wrote a message that is neither a response nor an event: ${text.slice(0, 500)}`,
        ),
      )
      return
    }
    if (this.notifications.delete(message.request_seq)) {
      return
    }
    const pending = this.pending.get(message.request_seq)
    if (pending === undefined) {
      this.fail(
        new Error(
          `tsserver answered request_seq ${message.request_seq} ("${message.command}"), which no request awaits.`,
        ),
      )
      return
    }
    this.pending.delete(message.request_seq)
    clearTimeout(pending.timeout)
    if (message.command !== pending.command) {
      pending.reject(
        new Error(
          `tsserver answered request_seq ${message.request_seq} with a "${message.command}" response; the request was "${pending.command}".`,
        ),
      )
      return
    }
    pending.resolve(message)
  }

  /** Records the first failure, rejects every awaiting request with it, and stops tsserver. */
  private fail(error: Error): void {
    this.failure ??= error
    for (const [seq, pending] of this.pending) {
      clearTimeout(pending.timeout)
      pending.reject(this.failure)
      this.pending.delete(seq)
    }
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill()
    }
  }

  private describePending(): string {
    return [...this.pending]
      .map(([seq, { command }]) => `"${command}" (request_seq ${seq})`)
      .join(', ')
  }
}

function isEvent(message: unknown): boolean {
  return (
    typeof message === 'object' && message !== null && 'type' in message && message.type === 'event'
  )
}

function isResponse(message: unknown): message is server.protocol.Response {
  return (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'response' &&
    'seq' in message &&
    typeof message.seq === 'number' &&
    'request_seq' in message &&
    typeof message.request_seq === 'number' &&
    'command' in message &&
    typeof message.command === 'string' &&
    'success' in message &&
    typeof message.success === 'boolean'
  )
}
