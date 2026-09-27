import { assert, describe, it } from 'vitest'

import {
  createProgressLocationTracker,
  parseFilterArgument,
  selectChecks,
} from '../../test/performance/scaling-check-cli.ts'

describe('parseFilterArgument', () => {
  it('returns undefined when --filter is absent', () => {
    assert.isUndefined(parseFilterArgument([]))
    assert.isUndefined(parseFilterArgument(['--something-else']))
  })

  it('returns the value following --filter', () => {
    assert.strictEqual(parseFilterArgument(['--filter', 'url']), 'url')
    assert.strictEqual(parseFilterArgument(['before', '--filter', 'url', 'after']), 'url')
  })

  it('throws when --filter has no value after it', () => {
    assert.throws(() => parseFilterArgument(['--filter']), /needs a value/)
  })
})

describe('selectChecks', () => {
  const checks = [
    { name: 'substitution (single-line)' },
    { name: 'hex escapes in one url() argument' },
    { name: 'folding (many spans)' },
  ]

  it('returns every check, in order, with its original index, when filter is undefined', () => {
    const selected = selectChecks(checks, undefined)
    assert.deepEqual(
      selected.map((entry) => entry.index),
      [0, 1, 2],
    )
    assert.deepEqual(
      selected.map((entry) => entry.check.name),
      checks.map((check) => check.name),
    )
  })

  it('returns only checks whose name includes the filter substring, keeping original indices', () => {
    const selected = selectChecks(checks, 'url')
    assert.deepEqual(
      selected.map((entry) => ({ index: entry.index, name: entry.check.name })),
      [{ index: 1, name: 'hex escapes in one url() argument' }],
    )
  })

  it('throws loudly, listing every check name, when the filter matches nothing', () => {
    let thrown: unknown
    try {
      selectChecks(checks, 'nonexistent-check-name')
    } catch (error) {
      thrown = error
    }
    assert.instanceOf(thrown, Error)
    const message = (thrown as Error).message
    assert.match(message, /nonexistent-check-name/)
    for (const check of checks) {
      assert.include(message, check.name)
    }
  })
})

describe('createProgressLocationTracker', () => {
  it('reports "before its first sample" before any progress arrives', () => {
    const tracker = createProgressLocationTracker()
    assert.strictEqual(tracker.location(), 'before its first sample')
  })

  it('reports the most recent stage', () => {
    const tracker = createProgressLocationTracker()
    tracker.onProgress({ stage: 'size 6000, run 1 of 5, attempt 1 of 3' })
    assert.strictEqual(tracker.location(), 'at size 6000, run 1 of 5, attempt 1 of 3')
    tracker.onProgress({ stage: 'size 24000, run 2 of 5, attempt 1 of 3' })
    assert.strictEqual(tracker.location(), 'at size 24000, run 2 of 5, attempt 1 of 3')
  })

  /**
   * The regression this guards: scaling-check.ts's retry line is a free-form "line" progress
   * report, sent only after real sampling already happened for that attempt. Before this tracker,
   * the "where" computed from only the single most recent progress report read a retry line as
   * "before its first sample" whenever it happened to be the last report received before a
   * deadline or heap-cap stop, even though sampling had clearly already started.
   */
  it('keeps the last stage after a later "line" progress report, never reverting to "before its first sample"', () => {
    const tracker = createProgressLocationTracker()
    tracker.onProgress({ stage: 'size 6000, run 5 of 5, attempt 1 of 3' })
    tracker.onProgress({ line: 'retry 1/2 some-check: N=6000 ..., measuring again' })
    assert.strictEqual(tracker.location(), 'at size 6000, run 5 of 5, attempt 1 of 3')
  })
})
