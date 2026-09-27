const headerSeparator = Buffer.from('\r\n\r\n')

export class TSServerMessageReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): string[] {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages: string[] = []

    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf(headerSeparator)
      if (headerEnd === -1) {
        break
      }

      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const contentLengthText = /^Content-Length: (\d+)$/im.exec(header)?.[1]
      if (contentLengthText === undefined) {
        throw new Error(`tsserver wrote a header with no "Content-Length": ${header}`)
      }

      const bodyStart = headerEnd + headerSeparator.length
      const messageEnd = bodyStart + Number(contentLengthText)
      if (this.buffer.length < messageEnd) {
        break
      }

      messages.push(this.buffer.subarray(bodyStart, messageEnd).toString('utf8'))
      this.buffer = this.buffer.subarray(messageEnd)
    }

    return messages
  }
}
