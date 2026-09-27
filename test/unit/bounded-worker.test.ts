import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { assert, describe, it } from 'vitest'

import { BoundedWorker } from '../../scripts/bounded-worker.ts'

const NOOP_FIXTURE_ENTRY = pathToFileURL(path.resolve(__dirname, 'bounded-worker-noop-fixture.ts'))

/** Reaches past BoundedWorker's own encapsulation to drive the exact message ordering under test: the settle-once rule is a race between two real async event sources (a worker thread's message and its exit), which real timing cannot reproduce deterministically. */
interface BoundedWorkerInternals {
  handleMessage(message: { readonly result: string; readonly type: 'result' }): void
  running?: { deadlineHit: boolean }
}

describe('BoundedWorker', () => {
  it('resolves done for a normal result reported before any deadline', async () => {
    const worker = new BoundedWorker<undefined, never, string>({
      entry: NOOP_FIXTURE_ENTRY,
      heapMb: 64,
    })
    try {
      const runPromise = worker.run(undefined, { deadlineMs: 60_000 })
      await new Promise((resolve) => setImmediate(resolve))
      const internals = worker as unknown as BoundedWorkerInternals
      assert.isDefined(internals.running, 'run() must populate its running state synchronously')
      internals.handleMessage({ result: 'on-time result', type: 'result' })

      const outcome = await runPromise
      assert.strictEqual(outcome.kind, 'done')
      assert.strictEqual(outcome.kind === 'done' ? outcome.result : undefined, 'on-time result')
    } finally {
      await worker.close()
    }
  })

  it('settles a result that arrives after the deadline as the deadline stop, never as done', async () => {
    const worker = new BoundedWorker<undefined, never, string>({
      entry: NOOP_FIXTURE_ENTRY,
      heapMb: 64,
    })
    try {
      const runPromise = worker.run(undefined, { deadlineMs: 60_000 })
      await new Promise((resolve) => setImmediate(resolve))
      const internals = worker as unknown as BoundedWorkerInternals
      assert.isDefined(internals.running, 'run() must populate its running state synchronously')

      /**
       * Simulates the deadline timer firing (worker.terminate() requested) immediately followed by
       * the worker's own 'result' message for the task it was already running, arriving before the
       * worker has actually exited: a real race between the timer callback and the message event,
       * both delivered on the parent's event loop.
       */
      internals.running.deadlineHit = true
      internals.handleMessage({ result: 'late result', type: 'result' })

      const stillPending = Symbol('still-pending')
      const raced = await Promise.race([
        runPromise,
        new Promise((resolve) => setTimeout(() => resolve(stillPending), 50)),
      ])
      assert.strictEqual(
        raced,
        stillPending,
        'a message after the deadline must not settle the outcome by itself',
      )

      await worker.close()
      const outcome = await runPromise
      assert.strictEqual(
        outcome.kind,
        'deadline',
        "only the worker's real exit settles the task, and it must read as the deadline stop, " +
          'never as the late "done" result',
      )
    } finally {
      await worker.close()
    }
  })
})
