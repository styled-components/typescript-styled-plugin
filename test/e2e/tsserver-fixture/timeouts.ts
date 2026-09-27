/**
 * Upper bound on each tsserver response and on the process exit after `close()`. A request runs
 * against a real TypeScript program in a separate process, so its wall time tracks host CPU
 * contention rather than the request's own work; the default leaves headroom for a busy host.
 * `vitest.config.ts` derives the e2e `testTimeout` from this value, so a slow response fails with
 * this harness's message naming the request instead of Vitest's generic "test timed out".
 */
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000

const responseTimeoutVariable = 'TSSERVER_RESPONSE_TIMEOUT_MS'

/** Node fires any timer delay above this after 1 ms instead, so a larger timeout would fail at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

export function parsePositiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!/^[1-9]\d*$/.test(value) || parsed > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `${name} is "${value}", which is not a whole number of milliseconds from 1 to ${MAX_TIMER_DELAY_MS}. Set it to a value such as 60000, or unset it to use ${DEFAULT_RESPONSE_TIMEOUT_MS}.`,
    )
  }
  return parsed
}

export const responseTimeoutMs =
  parsePositiveInteger(responseTimeoutVariable, process.env[responseTimeoutVariable]) ??
  DEFAULT_RESPONSE_TIMEOUT_MS
