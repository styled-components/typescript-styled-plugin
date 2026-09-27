import { readdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'

const logsRoot = path.join(import.meta.dirname, 'logs')

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

/**
 * `kill(pid, 0)` probes liveness without signaling. Any error other than "no such process" (EPERM
 * against another user's process, for example) counts as alive, so a live run's logs are never
 * removed.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

/**
 * Vitest globalSetup for the e2e project, run in the orchestrator before any worker starts; the
 * workers inherit `process.env` from it. Sets TSSERVER_FIXTURE_RUN_ID to the orchestrator's pid,
 * which gives this run's tsserver logs their own directory, so two e2e runs at once never delete
 * each other's logs. Removes every other run directory whose owning process has exited, and any
 * entry that is not a pid directory; a failed run's logs stay until the next e2e run.
 */
export default function clearTSServerLogs() {
  process.env.TSSERVER_FIXTURE_RUN_ID = String(process.pid)

  let entries: string[]
  try {
    entries = readdirSync(logsRoot)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return
    }
    throw error
  }

  for (const entry of entries) {
    const pid = Number(entry)
    if (Number.isInteger(pid) && isProcessAlive(pid)) {
      continue
    }
    rmSync(path.join(logsRoot, entry), { force: true, recursive: true })
  }
}
