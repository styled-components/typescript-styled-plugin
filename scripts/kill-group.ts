/**
 * Signals a POSIX process group, in its own module so with-deadline.test.ts can import it directly
 * without triggering with-deadline.ts's own `main()`, which runs as a side effect of that file being
 * loaded.
 */
import process from 'node:process'

/** Sends `signal` to the process group led by `pid` (`process.kill(-pid, signal)`), the SIGINT/SIGTERM handler and the deadline timer in with-deadline.ts. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch (error) {
    const isEsrch = error instanceof Error && 'code' in error && error.code === 'ESRCH'
    if (isEsrch) {
      /** The group already exited: a benign race between the deadline timer and a fast exit. */
      return
    }
    /**
     * Any other error (EPERM, for example) is unexpected, but this runs inside the deadline timer
     * and the SIGINT/SIGTERM handler, both of which must finish the shutdown they are in the middle
     * of: an uncaught throw here would crash the wrapper mid-forward instead, leaving the child
     * process group signaled but the wrapper itself dead before it could report anything or forward
     * the next signal.
     */
    console.error(
      `with-deadline: failed to send ${signal} to process group ${pid}: ${String(error)}`,
    )
  }
}
