/**
 * Measures whether RawValidationCache's key (src/features/diagnostics.ts, buildValidationCacheKey
 * plus flattenCacheKey) needs its explicit flatten step, or whether inserting and looking up a
 * plain concatenated string as an actual Map key already flattens it on this Node version. Plain
 * JavaScript, no build step, so it runs unmodified on the package's Node floor as well as the
 * development Node version. Run: node --expose-gc test/performance/validation-cache-key-flattening-probe.mjs
 *
 * Mirrors RawValidationCache's real shape for the "map key" and "flattened map key" cases: each
 * iteration builds a fresh key the way buildValidationCacheKey does (the reading key's length,
 * ":", the reading key, then rawText, a slice of a large parent string), `Map.set`s it, then
 * `Map.get`s a second, separately built but content-equal key (a real cache hit looks up a
 * freshly concatenated key, never the same string instance that was inserted). The "value, never
 * hashed" case stores the same key as an array element instead, the shape that does retain the
 * parent, included so a probe that reports near-zero for every case is caught as broken rather
 * than trusted.
 */
const gc = globalThis.gc
if (!gc) {
  throw new Error('This probe needs --expose-gc.')
}

const ITERATIONS = 300
const PARENT_LENGTH = 500_000
const SLICE_START = 100_000
const SLICE_LENGTH = 400

/**
 * Embeds `seed` at SLICE_START itself, not merely appended at the end: the sliced window below is
 * [SLICE_START, SLICE_START + SLICE_LENGTH), and a seed appended after the whole repeated pattern
 * never reaches that window, so every iteration's rawText read back as the identical string and the
 * Map below collapsed 300 "distinct" keys into one entry, measuring nothing.
 */
function buildFlatParent(seed) {
  const marker = String(seed)
  const body = 'abcdefghij'.repeat(PARENT_LENGTH / 10)
  const withMarker = body.slice(0, SLICE_START) + marker + body.slice(SLICE_START + marker.length)
  /** split/join forces a genuinely flat backing buffer, never a ConsString left over from string ops. */
  return withMarker.split('').join('')
}

/** A realistic reading key: TagKind values (src/virtual-document/styled-virtual-document-provider.ts) are short tag-kind strings. */
const READING_KEY = 'global-style'

/** Same shape as buildValidationCacheKey in src/features/diagnostics.ts. */
function buildValidationCacheKey(readingKey, rawText) {
  return `${readingKey.length}:${readingKey}${rawText}`
}

function flattenCacheKey(key) {
  return (' ' + key).slice(1)
}

/**
 * Yields one macrotask before calling `gc()`, mirroring settleHeap
 * (test/performance/template-language-service-fixture.ts): a synchronous `gc()` call right after
 * the allocations it is meant to collect measured every case here, including a deliberately-held
 * whole-parent control, as retaining near zero on this Node version, so it under-collects rather
 * than failing loudly. Yielding first is what this probe validated against its self-check below.
 */
async function collectGarbage() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  gc()
}

/** Runs `store` once per iteration with a fresh rawText slice of a fresh parent string. */
async function measureRetainedMb(store) {
  await collectGarbage()
  const before = process.memoryUsage().heapUsed
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const parent = buildFlatParent(iteration)
    store(parent.slice(SLICE_START, SLICE_START + SLICE_LENGTH))
  }
  await collectGarbage()
  const after = process.memoryUsage().heapUsed
  return (after - before) / (1024 * 1024)
}

const mapForKeyCases = new Map()
const mapKeyPlain = await measureRetainedMb((rawText) => {
  mapForKeyCases.set(buildValidationCacheKey(READING_KEY, rawText), 1)
  /** A fresh, content-equal lookup key, not the same instance. */
  mapForKeyCases.get(buildValidationCacheKey(READING_KEY, rawText))
})

const mapForFlattenedCases = new Map()
const mapKeyFlattened = await measureRetainedMb((rawText) => {
  mapForFlattenedCases.set(flattenCacheKey(buildValidationCacheKey(READING_KEY, rawText)), 1)
  mapForFlattenedCases.get(buildValidationCacheKey(READING_KEY, rawText))
})

const heldValues = []
const valueNeverHashed = await measureRetainedMb((rawText) => {
  heldValues.push(buildValidationCacheKey(READING_KEY, rawText))
})

console.log(`map key, plain concatenation:      ${mapKeyPlain.toFixed(2)} MB retained`)
console.log(`map key, explicitly flattened:     ${mapKeyFlattened.toFixed(2)} MB retained`)
console.log(`array value, never hashed:         ${valueNeverHashed.toFixed(2)} MB retained`)

/**
 * A key that keeps its parent alive retains a whole parent per iteration, the never-hashed
 * control's reading; a flat key retains only its own few hundred bytes. Both the self-check and
 * the verdict compare against this share of the control, a margin orders of magnitude past the
 * sub-megabyte noise the key readings show, so noise cannot flip either.
 */
const PARENT_RETENTION_SHARE = 0.5
/** The never-hashed control keeps ITERATIONS parents of PARENT_LENGTH one-byte characters alive, well over this. */
const MINIMUM_CONTROL_MB = 10

/**
 * Self-check of the instrument, independent of the plain key's reading (the outcome under test):
 * the control must retain its parents and the explicitly flattened key, a copy, must not. A probe
 * reading near zero for everything, or high for everything, is broken rather than trusted.
 */
if (
  !(valueNeverHashed > MINIMUM_CONTROL_MB) ||
  !(mapKeyFlattened < valueNeverHashed * PARENT_RETENTION_SHARE)
) {
  throw new Error(
    `Expected the never-hashed control to retain over ${MINIMUM_CONTROL_MB} MB and the explicitly ` +
      `flattened key under ${PARENT_RETENTION_SHARE} of that (control=${valueNeverHashed.toFixed(2)} MB, ` +
      `flattened=${mapKeyFlattened.toFixed(2)} MB). The probe is broken.`,
  )
}

console.log(
  mapKeyPlain - mapKeyFlattened > valueNeverHashed * PARENT_RETENTION_SHARE
    ? 'RESULT: a plain concatenated Map key keeps its parent string alive on this Node version (the explicit flatten is load-bearing here).'
    : 'RESULT: a plain concatenated Map key retains no parent string on this Node version, the same as the explicitly flattened key (the explicit flatten is redundant here, kept defensively).',
)
