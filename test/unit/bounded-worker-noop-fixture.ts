/**
 * A worker entry with a handler that never resolves on its own: bounded-worker.test.ts drives the
 * settle logic directly through BoundedWorker's internal state, so the only thing this file needs
 * to provide is a real, terminable worker thread to run it in.
 */
import { isMainThread } from 'node:worker_threads'

import { serveBounded } from '../../scripts/bounded-worker.ts'

if (!isMainThread) {
  serveBounded<undefined, never, string>(() => new Promise<string>(() => {}))
}
