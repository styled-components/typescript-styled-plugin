/**
 * Upper bound on each tsserver response and on the process exit after `close()`. A request runs
 * against a real TypeScript program in a separate process, so its wall time tracks host CPU
 * contention rather than the request's own work; the default leaves headroom for a busy host.
 * `vitest.config.ts` derives the e2e test and hook timeouts from this value. The hook timeout
 * leaves headroom for `close()` to report a stalled process before Vitest reports a generic hook
 * timeout.
 */
const DEFAULT_RESPONSE_TIMEOUT_MS = 30_000

const responseTimeoutVariable = 'TSSERVER_RESPONSE_TIMEOUT_MS'

/** Node fires any timer delay above this after 1 ms instead, so a larger timeout would fail at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

/** Lets Vitest cleanup wait long enough for the harness's own process-exit timeout to win. */
export const E2E_TIMEOUT_HEADROOM_MS = 15_000

export const MAX_RESPONSE_TIMEOUT_MS = MAX_TIMER_DELAY_MS - E2E_TIMEOUT_HEADROOM_MS

export function parsePositiveInteger(
  name: string,
  value: string | undefined,
  maximum = MAX_TIMER_DELAY_MS,
): number | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = Number(value)
  if (!/^[1-9]\d*$/.test(value) || parsed > maximum) {
    throw new Error(
      `${name} is "${value}", which is not a whole number of milliseconds from 1 to ${maximum}. Set it to a value such as 60000, or unset it to use ${DEFAULT_RESPONSE_TIMEOUT_MS}.`,
    )
  }
  return parsed
}

export function getResponseTimeoutMs(value: string | undefined): number {
  return (
    parsePositiveInteger(responseTimeoutVariable, value, MAX_RESPONSE_TIMEOUT_MS) ??
    DEFAULT_RESPONSE_TIMEOUT_MS
  )
}

export const responseTimeoutMs = getResponseTimeoutMs(process.env[responseTimeoutVariable])
