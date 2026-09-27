import { afterEach, assert, describe, it, vi } from 'vitest'

import { killGroup } from '../../scripts/kill-group.ts'

function errnoError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

describe('killGroup', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('signals the negated pid (the process group) and logs nothing on success', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    assert.doesNotThrow(() => killGroup(1234, 'SIGTERM'))

    assert.deepEqual(kill.mock.calls, [[-1234, 'SIGTERM']])
    assert.strictEqual(errorSpy.mock.calls.length, 0)
  })

  it('does nothing when there is no pid to signal (the child never started)', () => {
    const kill = vi.spyOn(process, 'kill')
    killGroup(undefined, 'SIGTERM')
    assert.strictEqual(kill.mock.calls.length, 0)
  })

  it('is a silent no-op for ESRCH, the benign race where the group already exited', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    assert.doesNotThrow(() => killGroup(1234, 'SIGTERM'))

    assert.strictEqual(errorSpy.mock.calls.length, 0)
  })

  /**
   * The regression this guards: killGroup runs inside the SIGINT/SIGTERM handler and the deadline
   * timer, both synchronous callbacks with no caller to catch a throw, so any error besides ESRCH
   * (EPERM, for example) used to escape uncaught and crash the wrapper mid-shutdown instead of
   * finishing it.
   */
  it('logs and returns, without throwing, when process.kill fails with an error other than ESRCH', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EPERM')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    assert.doesNotThrow(() => killGroup(1234, 'SIGTERM'))

    assert.strictEqual(errorSpy.mock.calls.length, 1)
    assert.match(String(errorSpy.mock.calls[0]?.[0]), /EPERM/)
    assert.match(String(errorSpy.mock.calls[0]?.[0]), /SIGTERM/)
  })
})
