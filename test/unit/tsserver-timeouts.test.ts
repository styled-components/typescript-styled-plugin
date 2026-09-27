import { assert, describe, it } from 'vitest'

import { parsePositiveInteger } from '../e2e/tsserver-fixture/timeouts'

describe('parsePositiveInteger', () => {
  it('returns undefined for an unset variable, so the default applies', () => {
    assert.strictEqual(parsePositiveInteger('TIMEOUT_MS', undefined), undefined)
  })

  it.each([
    ['1', 1],
    ['60000', 60_000],
    ['2147483647', 2 ** 31 - 1],
  ])('accepts %s', (value, expected) => {
    assert.strictEqual(parsePositiveInteger('TIMEOUT_MS', value), expected)
  })

  it.each(['0', '-5', '1.5', '60s', '', '2147483648', '99999999999999999999999'])(
    'rejects %j, naming the variable and the accepted range',
    (value) => {
      assert.throws(
        () => parsePositiveInteger('TIMEOUT_MS', value),
        `TIMEOUT_MS is "${value}", which is not a whole number of milliseconds from 1 to 2147483647.`,
      )
    },
  )
})
