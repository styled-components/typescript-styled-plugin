import { availableParallelism } from 'node:os'

import { defineConfig } from 'vitest/config'

import { responseTimeoutMs } from './test/e2e/tsserver-fixture/timeouts'

/**
 * Two projects, so only e2e files run the e2e globalSetup: Vitest assigns each test file to a
 * project by its `include` glob, whatever the invocation (a path, a `-t` filter, an IDE runner).
 */

/**
 * Every e2e test file runs at least one tsserver process, a full TypeScript program load. Workers
 * leave one core free, as Vitest's own default does, and never exceed the host's core count.
 * Concurrent tests within one file (the files that start a server per test) are capped at the
 * same number, so a 4-core CI runner holds at most a few tsserver processes per worker.
 */
const e2eParallelism = Math.max(1, Math.min(8, availableParallelism() - 1))

/**
 * Unit tests run plugin code inside each test worker, a child process in Vitest's default `forks`
 * pool. The heap cap ends a worker whose test retains without bound within seconds, as a failed
 * run naming the test file, instead of letting every parallel worker grow toward swap; the suite
 * needs a small fraction of it (lower it with `--execArgv=--max-old-space-size=<MB>` to see).
 * scripts/with-deadline.ts, which wraps this command, separately catches a test stuck in a
 * synchronous loop, which Vitest's own `testTimeout` cannot interrupt. Every bound on a tool that
 * runs plugin code is in docs/maintenance.md, "Running tests".
 */
const UNIT_WORKER_HEAP_CAP_MB = 1024

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: 'node',
          execArgv: [`--max-old-space-size=${UNIT_WORKER_HEAP_CAP_MB}`],
          globals: true,
          include: ['test/unit/**/*.test.ts'],
          name: 'unit',
        },
      },
      {
        test: {
          environment: 'node',
          globals: true,
          globalSetup: [
            'test/e2e/tsserver-fixture/check-plugin-link.ts',
            'test/e2e/tsserver-fixture/clear-logs.ts',
          ],
          include: ['test/e2e/scenarios/**/*.test.ts'],
          maxConcurrency: e2eParallelism,
          maxWorkers: e2eParallelism,
          name: 'e2e',
          /** Above the harness's own response timeout, so its message naming the request wins. */
          testTimeout: responseTimeoutMs + 15_000,
        },
      },
    ],
  },
})
