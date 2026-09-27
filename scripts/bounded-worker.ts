/**
 * Runs contributor tooling that executes plugin code (the scaling check, the benchmark, the
 * compare-release sensor) in a worker thread with a wall-clock deadline and a heap cap, both
 * enforced from the parent thread, so a regression that makes plugin code superlinear, loop
 * forever, or retain without bound fails that one task loudly instead of holding a core and
 * growing into swap until someone kills the process.
 *
 * - Deadline: `worker.terminate()` once a task has run `deadlineMs` of wall-clock time, counted
 *   from `run()`, the worker's module load included for its first task. Termination stops a worker
 *   even inside a synchronous loop that never yields, which a timer inside that same thread could
 *   never interrupt.
 * - Heap cap: `resourceLimits.maxOldGenerationSizeMb`. Past it, V8 ends the worker with
 *   ERR_WORKER_OUT_OF_MEMORY and the process keeps running. Only the old generation is capped; the
 *   young generation stays at V8's small default, and plugin code allocates no ArrayBuffer or
 *   Buffer memory, which sits outside the V8 heap.
 * - The worker inherits the parent's `execArgv` (Node's default), so `--expose-gc` and
 *   `--experimental-transform-types` reach it; V8 flags such as `--no-flush-bytecode` apply to the
 *   whole process already. `process.threadCpuUsage` inside the worker reports the worker thread's
 *   own CPU time, and `process.memoryUsage().heapUsed` its own heap.
 * - The entry is a module that calls `serveBounded` when `isMainThread` is false, often the calling
 *   script itself. Input, progress, and result cross the thread boundary by structured clone. A
 *   worker reports through progress and result, never by printing: termination can drop its
 *   pending console output.
 * - A `BoundedWorker` runs one task at a time and stays alive between tasks, so repeated small
 *   tasks pay the module load once. A task stopped at its deadline or heap cap, or a crash outside
 *   the task handler, ends the worker: every later `run()` resolves as `crashed` at once, and the
 *   caller starts a new one. `runBounded` is the one-task form.
 * - `close()` resolves only after the worker has exited, and `runBounded` closes its worker
 *   whatever the outcome, so no worker outlives its caller. `run()` never rejects: a throw inside
 *   the worker resolves as `crashed`.
 */
import { isMainThread, parentPort, Worker } from 'node:worker_threads'

interface BoundedWorkerLimits {
  readonly deadlineMs: number
  readonly heapMb: number
}

export type BoundedWorkerOutcome<Progress, Result> =
  | { readonly elapsedMs: number; readonly kind: 'done'; readonly result: Result }
  | {
      readonly elapsedMs: number
      readonly kind: 'deadline' | 'heap'
      readonly lastProgress: Progress | undefined
    }
  | {
      readonly elapsedMs: number
      readonly error: unknown
      readonly kind: 'crashed'
      readonly lastProgress: Progress | undefined
    }

type ParentMessage<Input> = { readonly input: Input; readonly type: 'task' }

type WorkerMessage<Progress, Result> =
  | { readonly error: unknown; readonly type: 'error' }
  | { readonly progress: Progress; readonly type: 'progress' }
  | { readonly result: Result; readonly type: 'result' }

interface RunningTask<Progress, Result> {
  deadlineHit: boolean
  lastProgress: Progress | undefined
  readonly onProgress: ((progress: Progress) => void) | undefined
  readonly settle: (outcome: BoundedWorkerOutcome<Progress, Result>) => void
  readonly startedAt: number
  readonly timer: NodeJS.Timeout
}

const OUT_OF_MEMORY_CODE = 'ERR_WORKER_OUT_OF_MEMORY'

function isOutOfMemory(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === OUT_OF_MEMORY_CODE
}

interface BoundedWorkerOptions {
  readonly entry: string | URL
  readonly heapMb: number
}

interface RunOptions<Progress> {
  readonly deadlineMs: number
  readonly onProgress?: (progress: Progress) => void
}

export class BoundedWorker<Input, Progress, Result> {
  private readonly entry: string | URL
  private readonly exited: Promise<void>
  private exitCode: number | undefined
  /** The first 'error' event: the heap cap, or a throw outside the task handler. */
  private failure: unknown
  private running: RunningTask<Progress, Result> | undefined
  private readonly worker: Worker

  constructor({ entry, heapMb }: BoundedWorkerOptions) {
    this.entry = entry
    this.worker = new Worker(entry, { resourceLimits: { maxOldGenerationSizeMb: heapMb } })
    this.worker.on('message', (message: WorkerMessage<Progress, Result>) =>
      this.handleMessage(message),
    )
    this.worker.on('error', (error) => {
      this.failure ??= error
    })
    this.exited = new Promise((resolve) => {
      this.worker.once('exit', (exitCode) => {
        this.exitCode = exitCode
        this.settleOnExit()
        resolve()
      })
    })
  }

  run(input: Input, { deadlineMs, onProgress }: RunOptions<Progress>) {
    return new Promise<BoundedWorkerOutcome<Progress, Result>>((settle) => {
      const startedAt = performance.now()
      if (this.running !== undefined || this.exitCode !== undefined) {
        settle({
          elapsedMs: 0,
          error: new Error(
            this.running === undefined
              ? `The worker running ${String(this.entry)} already stopped; start a new BoundedWorker.`
              : `The worker running ${String(this.entry)} is still busy with another task.`,
          ),
          kind: 'crashed',
          lastProgress: undefined,
        })
        return
      }
      const timer = setTimeout(() => {
        if (this.running !== undefined) {
          this.running.deadlineHit = true
        }
        void this.worker.terminate()
      }, deadlineMs)
      this.running = {
        deadlineHit: false,
        lastProgress: undefined,
        onProgress,
        settle,
        startedAt,
        timer,
      }
      this.worker.postMessage({ input, type: 'task' } satisfies ParentMessage<Input>)
    })
  }

  /** Stops the worker and resolves once it has exited. */
  async close(): Promise<void> {
    await this.worker.terminate()
    await this.exited
  }

  private finish(outcome: BoundedWorkerOutcome<Progress, Result>): void {
    const running = this.running
    if (running === undefined) {
      return
    }
    clearTimeout(running.timer)
    this.running = undefined
    running.settle(outcome)
  }

  private handleMessage(message: WorkerMessage<Progress, Result>): void {
    const running = this.running
    /**
     * Once the deadline timer has fired, the task's outcome is already decided as a stop: a
     * message that arrives afterward (a result or an error the worker was already mid-flight on
     * when terminate() was requested) settles nothing here, so only the worker's own exit event
     * (settleOnExit) ever finishes the task, deterministically as 'deadline'. Without this guard, a
     * late 'result' or 'error' message races that exit event: whichever the parent's event loop
     * happens to process first decides the outcome, so the same regression that trips the deadline
     * could still read as 'done', and a BoundedWorker reused for a later task (compare-release.ts's
     * BuildRunner) would then find the worker already exited underneath it.
     */
    if (running === undefined || running.deadlineHit) {
      return
    }
    const elapsedMs = performance.now() - running.startedAt
    switch (message.type) {
      case 'progress':
        running.lastProgress = message.progress
        running.onProgress?.(message.progress)
        return
      case 'result':
        this.finish({ elapsedMs, kind: 'done', result: message.result })
        return
      case 'error':
        this.finish({
          elapsedMs,
          error: message.error,
          kind: 'crashed',
          lastProgress: running.lastProgress,
        })
    }
  }

  private settleOnExit(): void {
    const running = this.running
    if (running === undefined) {
      return
    }
    const elapsedMs = performance.now() - running.startedAt
    const { lastProgress } = running
    if (isOutOfMemory(this.failure)) {
      this.finish({ elapsedMs, kind: 'heap', lastProgress })
    } else if (this.failure !== undefined) {
      this.finish({ elapsedMs, error: this.failure, kind: 'crashed', lastProgress })
    } else if (running.deadlineHit) {
      this.finish({ elapsedMs, kind: 'deadline', lastProgress })
    } else {
      this.finish({
        elapsedMs,
        error: new Error(
          `The worker running ${String(this.entry)} exited with code ${String(this.exitCode)} ` +
            'before reporting a result. Something in it called process.exit.',
        ),
        kind: 'crashed',
        lastProgress,
      })
    }
  }
}

interface RunBoundedOptions<Input, Progress> {
  readonly entry: string | URL
  readonly input: Input
  readonly limits: BoundedWorkerLimits
  readonly onProgress?: (progress: Progress) => void
}

/** Runs one task in a fresh worker and closes it. */
export async function runBounded<Input, Progress, Result>({
  entry,
  input,
  limits,
  onProgress,
}: RunBoundedOptions<Input, Progress>): Promise<BoundedWorkerOutcome<Progress, Result>> {
  const worker = new BoundedWorker<Input, Progress, Result>({ entry, heapMb: limits.heapMb })
  const outcome = await worker.run(input, { deadlineMs: limits.deadlineMs, onProgress })
  await worker.close()
  return outcome
}

/**
 * The worker side: runs `handler` on each task's input and reports its result, or the error it
 * threw. Call it only when `isMainThread` is false.
 */
export function serveBounded<Input, Progress, Result>(
  handler: (input: Input, reportProgress: (progress: Progress) => void) => Result | Promise<Result>,
): void {
  if (isMainThread || parentPort === null) {
    throw new Error(
      'serveBounded runs only inside a worker started by scripts/bounded-worker.ts; guard the ' +
        'call with `if (!isMainThread)`.',
    )
  }
  const port = parentPort
  const post = (message: WorkerMessage<Progress, Result>) => port.postMessage(message)
  const reportProgress = (progress: Progress) => post({ progress, type: 'progress' })
  port.on('message', async (message: ParentMessage<Input>) => {
    try {
      const result = await handler(message.input, reportProgress)
      post({ result, type: 'result' })
    } catch (error) {
      post({ error, type: 'error' })
    }
  })
}

export function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`
}
