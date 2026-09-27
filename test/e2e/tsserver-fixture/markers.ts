import type { server } from 'typescript'

/** `⟨name⟩` opens a marker (or marks a caret); `⟨/name⟩` closes the range `name` opened. */
const markerPattern = /⟨(\/?)([^⟨⟩]+)⟩/g

export interface MarkedSource {
  /** The caret `⟨name⟩` marks, as a tsserver protocol position. */
  at(name: string): server.protocol.Location
  /** The span from `⟨name⟩` to `⟨/name⟩`, as a tsserver protocol span. */
  range(name: string): server.protocol.TextSpan
  /** The source with every marker removed. */
  text: string
}

/**
 * Removes the markers from `source` and returns its text plus the protocol positions they mark:
 * a 1-based line and a 1-based UTF-16 offset, with lines split the way tsserver splits them.
 */
export function mark(source: string): MarkedSource {
  const indexes = new Map<string, number>()
  let text = ''
  let last = 0
  for (const match of source.matchAll(markerPattern)) {
    const key = `${match[1]}${match[2]}`
    if (indexes.has(key)) {
      throw new Error(`The marker ⟨${key}⟩ appears twice; give each marker a distinct name.`)
    }
    text += source.slice(last, match.index)
    indexes.set(key, text.length)
    last = match.index + match[0].length
  }
  text += source.slice(last)

  const lineStarts = computeLineStarts(text)
  const find = (key: string) => {
    const index = indexes.get(key)
    if (index === undefined) {
      throw new Error(`The source has no ⟨${key}⟩ marker. Add it where the position belongs.`)
    }
    return toLocation(lineStarts, index)
  }

  return {
    at: (name) => find(name),
    range: (name) => ({ end: find(`/${name}`), start: find(name) }),
    text,
  }
}

/**
 * TypeScript's scanner ends a line at LF, CR, CRLF (one break), U+2028, and U+2029, so protocol
 * lines count the two Unicode separators too.
 */
function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) {
      index++
      starts.push(index + 1)
    } else if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      starts.push(index + 1)
    }
  }
  return starts
}

function toLocation(lineStarts: readonly number[], index: number): server.protocol.Location {
  let line = 0
  while (line + 1 < lineStarts.length && (lineStarts[line + 1] ?? Infinity) <= index) {
    line++
  }
  return { line: line + 1, offset: index - (lineStarts[line] ?? 0) + 1 }
}
