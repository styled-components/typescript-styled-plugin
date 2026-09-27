/**
 * Runs a command in its own POSIX process group and kills the whole group if the command has not
 * finished within a wall-clock deadline, so a child stuck in a synchronous loop, which a timer
 * running on the same blocked thread (Vitest's `testTimeout`, for example) can never interrupt,
 * fails this wrapper loudly instead of hanging the machine.
 *
 * Usage: node --experimental-strip-types scripts/with-deadline.ts <deadlineMs> -- <command> [args...]
 *
 * - The deadline can be overridden with the WITH_DEADLINE_MS environment variable: a shorter one to
 *   red/green test this wrapper, a longer one to keep a debugger attached past the default.
 * - `<command>` starts with `detached: true`, which on POSIX makes it the leader of a new process
 *   group; killing that group with `process.kill(-pid, signal)` reaches every descendant that never
 *   called setsid itself, including Vitest's forked test workers and any tsserver process one of
 *   them spawns, not only the immediate child. This is a POSIX mechanism; the project has no
 *   Windows CI job or documented Windows support to extend it to.
 * - stdio is inherited, so the child's stdout and stderr reach the terminal or CI log unbuffered
 *   and byte-for-byte, and a run that finishes before the deadline passes its exit code straight
 *   through, unchanged.
 * - SIGINT and SIGTERM received by this wrapper (Ctrl-C, a CI job cancellation) are forwarded to
 *   the child's process group, then re-raised on this process once the child has actually exited,
 *   instead of only killing the wrapper and leaving the child tree running as an orphan.
 * - A run that hits the deadline is killed with SIGKILL: the failure mode this guards against, a
 *   synchronous loop that never returns to the event loop, cannot act on SIGTERM either.
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

import { formatSeconds } from './bounded-worker.ts'
import { killGroup } from './kill-group.ts'

const DEADLINE_OVERRIDE_ENV_VAR = 'WITH_DEADLINE_MS'

/** Node fires any timer delay above this after 1 ms instead, which would kill the run at once. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1

function usageError(message: string): never {
  console.error(message)
  console.error(
    'Usage: node --experimental-strip-types scripts/with-deadline.ts <deadlineMs> -- <command> [args...]',
  )
  process.exit(1)
}

function parseDeadlineMs(defaultArg: string): number {
  const override = process.env[DEADLINE_OVERRIDE_ENV_VAR]
  const source = override ?? defaultArg
  const value = Number(source)
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    const expected = `expected a number of milliseconds from 1 to ${MAX_TIMER_DELAY_MS}.`
    usageError(
      override === undefined
        ? `Invalid deadline "${defaultArg}": ${expected}`
        : `Invalid ${DEADLINE_OVERRIDE_ENV_VAR}="${override}": ${expected}`,
    )
  }
  return value
}

function main(): void {
  const args = process.argv.slice(2)
  if (args.length < 3 || args[1] !== '--') {
    usageError('Expected "<deadlineMs> -- <command> [args...]".')
  }
  const deadlineMs = parseDeadlineMs(args[0])
  const [command, ...commandArgs] = args.slice(2)
  const commandLine = [command, ...commandArgs].join(' ')

  const startedAt = performance.now()
  const child = spawn(command, commandArgs, { detached: true, stdio: 'inherit' })

  let deadlineHit = false
  const timer = setTimeout(() => {
    deadlineHit = true
    killGroup(child.pid, 'SIGKILL')
  }, deadlineMs)

  const forwardSignal = (signal: NodeJS.Signals) => killGroup(child.pid, signal)
  process.on('SIGINT', forwardSignal)
  process.on('SIGTERM', forwardSignal)

  child.on('error', (error) => {
    clearTimeout(timer)
    console.error(`Failed to start "${commandLine}": ${String(error)}`)
    process.exitCode = 1
  })

  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    process.off('SIGINT', forwardSignal)
    process.off('SIGTERM', forwardSignal)

    if (deadlineHit) {
      const ranFor = formatSeconds(performance.now() - startedAt)
      const likelyCause =
        command === 'vitest'
          ? ' Likely cause: a test stuck in a synchronous loop, which testTimeout cannot interrupt.' +
            ' Rerun with --reporter=verbose to see which test last started.'
          : ''
      console.error(
        `"${commandLine}" did not finish within its ${formatSeconds(deadlineMs)} deadline ` +
          `(ran ${ranFor}) and was killed.${likelyCause}`,
      )
      process.exitCode = 1
      return
    }

    if (signal !== null) {
      /**
       * Re-raise the same signal on this process, once the child has actually exited, so the
       * caller sees the same signal death (the usual 128+n exit convention) as an unwrapped run.
       */
      process.kill(process.pid, signal)
      return
    }

    process.exitCode = code ?? 1
  })
}

main()
