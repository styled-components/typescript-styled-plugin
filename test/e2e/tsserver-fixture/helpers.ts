import type { server } from 'typescript'
import { afterAll, beforeAll, type TestContext } from 'vitest'

import { TSServer, type TSServerOptions } from './server'

/** The `source` tsserver reports on this plugin's diagnostics. */
const pluginSource = 'ts-styled-plugin'

/** The `code` of every diagnostic this plugin reports, and the one its code fixes answer to. */
export const pluginDiagnosticCode = 9999

/** TypeScript ends a line at each of these, so a table covering one covers both. */
export const unicodeLineBreaks = [
  ['line separator', String.fromCharCode(0x2028)],
  ['paragraph separator', String.fromCharCode(0x2029)],
] as const

/** Asserts the response succeeded and carries a body, and returns that body. */
export function bodyOf<Response extends server.protocol.Response>(
  response: Response,
): NonNullable<Response['body']> {
  if (!response.success) {
    throw new Error(
      `Expected a successful "${response.command}" response; tsserver answered: ${response.message ?? 'no message'}`,
    )
  }
  const body = response.body
  if (body === undefined || body === null) {
    throw new Error(`Expected the "${response.command}" response to carry a body.`)
  }
  return body
}

/** Every diagnostic in the response, TypeScript's and this plugin's. */
export function diagnosticsOf(
  response: server.protocol.SemanticDiagnosticsSyncResponse,
): server.protocol.Diagnostic[] {
  const diagnostics: readonly (
    | server.protocol.Diagnostic
    | server.protocol.DiagnosticWithLinePosition
  )[] = bodyOf(response)
  return diagnostics.map((diagnostic) => {
    if (!('text' in diagnostic)) {
      throw new Error(
        'Expected line and offset diagnostics; the request must not set includeLinePosition.',
      )
    }
    return diagnostic
  })
}

export function pluginDiagnostics(
  response: server.protocol.SemanticDiagnosticsSyncResponse,
): server.protocol.Diagnostic[] {
  return diagnosticsOf(response).filter((diagnostic) => diagnostic.source === pluginSource)
}

/**
 * The span and message of each diagnostic in source order, for a full-list assertion. tsserver's
 * order is not part of the contract (editors sort diagnostics themselves).
 */
export function spansAndText(diagnostics: readonly server.protocol.Diagnostic[]) {
  return diagnostics
    .map(({ end, start, text }) => ({ end, start, text }))
    .sort(
      (left, right) =>
        left.start.line - right.start.line ||
        left.start.offset - right.start.offset ||
        left.end.line - right.end.line ||
        left.end.offset - right.end.offset ||
        left.text.localeCompare(right.text),
    )
}

/**
 * One tsserver for every test in the enclosing suite, started before the first and closed after
 * the last. Its tests run in sequence and each reopens the file it reads with its own content.
 */
export function useSharedServer(options?: TSServerOptions): () => TSServer {
  let shared: TSServer | undefined
  beforeAll(() => {
    shared = new TSServer(options)
  })
  afterAll(() => shared?.close())
  return () => {
    if (shared === undefined) {
      throw new Error('The shared tsserver starts in beforeAll; read it inside a test.')
    }
    return shared
  }
}

/** A tsserver for one test, closed when that test finishes, including when it fails. */
export function startServer(
  context: Pick<TestContext, 'onTestFinished'>,
  options?: TSServerOptions,
): TSServer {
  const server = new TSServer(options)
  context.onTestFinished(() => server.close())
  return server
}
