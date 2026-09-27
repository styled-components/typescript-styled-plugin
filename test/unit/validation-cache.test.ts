import * as ts from 'typescript/lib/tsserverlibrary.js'
import { assert, describe, it } from 'vitest'
import type { Diagnostic } from 'vscode-css-languageservice'

import {
  buildValidationCacheKey,
  MAX_VALIDATION_CACHE_BYTES,
  MAX_VALIDATION_CACHE_ENTRIES,
  RawValidationCache,
  VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES,
} from '../../src/features/diagnostics'
import { StyledVirtualDocumentProvider } from '../../src/virtual-document/styled-virtual-document-provider'
import { createTemplateContext } from './create-template-context'

/**
 * Mirrors the estimate docs/architecture.md and src/features/diagnostics.ts document for an
 * entry's size: key length times 2 bytes, plus, per diagnostic, message length times 2 bytes
 * plus the fixed overhead constant. Solving that formula for a message length that lands an
 * entry at a target byte count (using only the exported constants), rather than calling the
 * cache's own private size estimator, keeps these tests a check against the documented contract
 * instead of the implementation checking itself.
 */
function messageLengthForBytes(keyLength: number, targetBytes: number): number {
  return Math.ceil((targetBytes - keyLength * 2 - VALIDATION_CACHE_DIAGNOSTIC_OVERHEAD_BYTES) / 2)
}

function makeDiagnostic(messageLength: number): Diagnostic {
  return {
    message: 'x'.repeat(messageLength),
    range: { end: { character: 1, line: 0 }, start: { character: 0, line: 0 } },
  }
}

/** Fixed-length raw text so every key built from it is the same length regardless of content. */
function rawTextOf(fill: string): string {
  return fill.repeat(20)
}

const readingKey = new StyledVirtualDocumentProvider(ts).getReadingKey(
  createTemplateContext('color: red;', 'styled.div'),
)

describe('buildValidationCacheKey', () => {
  it('builds distinct keys when the tag kind or raw text differs', () => {
    const provider = new StyledVirtualDocumentProvider(ts)
    const text = 'colr'
    const keyFor = (tagName: string, rawText = text) =>
      buildValidationCacheKey(provider.getReadingKey(createTemplateContext(text, tagName)), rawText)

    const keys = [
      keyFor('styled.div'),
      /** The keyframes wrapper, same nesting mode and flag. */
      keyFor('keyframes'),
      /** The global-style top level, same wrapper and flag. */
      keyFor('createGlobalStyle'),
      /** A single-identifier css fragment, same wrapper and nesting mode. */
      keyFor('css'),
      keyFor('styled.div', 'color'),
    ]

    assert.strictEqual(new Set(keys).size, keys.length)
    assert.strictEqual(keyFor('styled.div'), keys[0], 'the same tag kind and text build one key')
    assert.strictEqual(keyFor('styled.button'), keys[0], 'two component tags share a tag kind')
    assert.strictEqual(keyFor('injectGlobal'), keys[2], 'two global-style tags share a tag kind')
  })
})

describe('RawValidationCache', () => {
  it('evicts the least recently used entry once the byte budget is exceeded, well under the count cap', () => {
    const cache = new RawValidationCache()
    const keyA = buildValidationCacheKey(readingKey, rawTextOf('a'))
    const keyB = buildValidationCacheKey(readingKey, rawTextOf('b'))
    /** Each entry alone is 60% of the byte budget, so two together (120%) force an eviction. */
    const messageLength = messageLengthForBytes(keyA.length, MAX_VALIDATION_CACHE_BYTES * 0.6)
    const diagnosticsA = [makeDiagnostic(messageLength)]
    const diagnosticsB = [makeDiagnostic(messageLength)]

    cache.set(keyA, diagnosticsA)
    assert.deepEqual(cache.peek(keyA), diagnosticsA)

    cache.set(keyB, diagnosticsB)

    assert.isUndefined(cache.peek(keyA), 'the oldest entry evicts once the budget is exceeded')
    assert.deepEqual(cache.peek(keyB), diagnosticsB)
  })

  it('evicts the oldest entry once the count cap is reached, even though every entry is tiny', () => {
    const cache = new RawValidationCache()
    const keys = Array.from({ length: MAX_VALIDATION_CACHE_ENTRIES + 1 }, (_, index) =>
      buildValidationCacheKey(readingKey, `rule-${index}`),
    )

    for (const key of keys) {
      cache.set(key, [makeDiagnostic(1)])
    }

    const firstKey = keys[0]
    const lastKey = keys[keys.length - 1]
    assert.isDefined(firstKey)
    assert.isDefined(lastKey)

    assert.isUndefined(cache.peek(firstKey), 'the entry inserted before the cap fills evicts')
    assert.isDefined(cache.peek(lastKey), 'the most recently inserted entry stays cached')
  })

  it('never caches a single entry larger than the byte budget alone, and does not evict to make room for it', () => {
    const cache = new RawValidationCache()
    const smallKey = buildValidationCacheKey(readingKey, rawTextOf('s'))
    const smallDiagnostics = [makeDiagnostic(1)]
    cache.set(smallKey, smallDiagnostics)

    const oversizedKey = buildValidationCacheKey(readingKey, rawTextOf('o'))
    const oversizedMessageLength = messageLengthForBytes(
      oversizedKey.length,
      MAX_VALIDATION_CACHE_BYTES * 1.5,
    )
    cache.set(oversizedKey, [makeDiagnostic(oversizedMessageLength)])

    assert.isUndefined(cache.peek(oversizedKey), 'an entry bigger than the budget is never cached')
    assert.deepEqual(
      cache.peek(smallKey),
      smallDiagnostics,
      'an oversized rejected entry must not evict what is already cached',
    )
  })

  it('treats a peek as a recency touch, so the least recently peeked entry evicts first under the byte budget', () => {
    const cache = new RawValidationCache()
    const keyA = buildValidationCacheKey(readingKey, rawTextOf('a'))
    const keyB = buildValidationCacheKey(readingKey, rawTextOf('b'))
    const keyC = buildValidationCacheKey(readingKey, rawTextOf('c'))
    /** Two of these fit under the budget; three do not, forcing exactly one eviction. */
    const messageLength = messageLengthForBytes(keyA.length, MAX_VALIDATION_CACHE_BYTES * 0.4)
    const diagnosticsA = [makeDiagnostic(messageLength)]
    const diagnosticsB = [makeDiagnostic(messageLength)]
    const diagnosticsC = [makeDiagnostic(messageLength)]

    cache.set(keyA, diagnosticsA)
    cache.set(keyB, diagnosticsB)
    /** Touching A moves it to the back, leaving B as the least recently used entry. */
    cache.peek(keyA)

    cache.set(keyC, diagnosticsC)

    assert.isUndefined(cache.peek(keyB), 'B, not A, was least recently used and evicts')
    assert.deepEqual(cache.peek(keyA), diagnosticsA)
    assert.deepEqual(cache.peek(keyC), diagnosticsC)
  })
})
