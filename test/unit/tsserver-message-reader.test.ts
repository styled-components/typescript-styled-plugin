import { assert, describe, it } from 'vitest'

import { TSServerMessageReader } from '../e2e/tsserver-fixture/message-reader'

function frame(message: string) {
  const body = Buffer.from(message)
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

describe('TSServerMessageReader', () => {
  it('keeps a partial header buffered until the separator arrives', () => {
    const reader = new TSServerMessageReader()
    const message = JSON.stringify({ type: 'response', command: 'quickinfo' })
    const framedMessage = frame(message)
    const splitAt = framedMessage.indexOf('\r\n\r\n') - 2

    assert.deepEqual(reader.push(framedMessage.subarray(0, splitAt)), [])
    assert.deepEqual(reader.push(framedMessage.subarray(splitAt)), [message])
  })

  it('uses UTF-8 byte lengths for non-ASCII messages', () => {
    const reader = new TSServerMessageReader()
    const firstMessage = JSON.stringify({ message: '颜色' })
    const secondMessage = JSON.stringify({ message: 'next' })
    const firstFrame = frame(firstMessage)
    const multibyteCharacter = '颜'
    const multibyteCharacterByteLength = Buffer.byteLength(multibyteCharacter, 'utf8')
    const multibyteCharacterStart = firstFrame.indexOf(Buffer.from(multibyteCharacter))
    const splitAt = multibyteCharacterStart + 1

    /**
     * Pins the precondition the test's name claims rather than only ruling out "not found" (-1):
     * the split point must fall strictly inside the multi-byte character's own bytes, never on or
     * before its first byte or on/past its last, so a change that stopped splitting mid-character
     * (for example by counting string length instead of UTF-8 byte length) fails this test instead
     * of passing it by accident.
     */
    assert.isAbove(multibyteCharacterStart, 0)
    assert.isAbove(splitAt, multibyteCharacterStart)
    assert.isBelow(splitAt, multibyteCharacterStart + multibyteCharacterByteLength)
    assert.deepEqual(reader.push(firstFrame.subarray(0, splitAt)), [])
    assert.deepEqual(
      reader.push(Buffer.concat([firstFrame.subarray(splitAt), frame(secondMessage)])),
      [firstMessage, secondMessage],
    )
  })

  it('fails loudly on a header block with no Content-Length, naming the header text', () => {
    const reader = new TSServerMessageReader()
    const header = 'X-Not-A-Real-Header: 1'

    assert.throws(
      () => reader.push(Buffer.from(`${header}\r\n\r\n`)),
      `tsserver wrote a header with no "Content-Length": ${header}`,
    )
  })
})
