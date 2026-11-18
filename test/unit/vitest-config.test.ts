import { assert, describe, it } from 'vitest'

import { e2eProjectConfig, e2eTestConfig, e2eTimeoutMs, vitestConfig } from '../../vitest.config.ts'
import { responseTimeoutMs } from '../e2e/tsserver-fixture/timeouts.ts'

describe('Vitest configuration', () => {
  it('lets tsserver cleanup report its process-exit timeout before Vitest does', () => {
    const projects = vitestConfig.test?.projects
    if (!Array.isArray(projects)) {
      assert.fail('Expected Vitest projects to be configured.')
    }

    assert.include(projects, e2eProjectConfig)
    assert.isAbove(e2eTimeoutMs, responseTimeoutMs)
    assert.strictEqual(e2eTestConfig.hookTimeout, e2eTimeoutMs)
    assert.strictEqual(e2eTestConfig.testTimeout, e2eTimeoutMs)
  })
})
