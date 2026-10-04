/**
 * What the recorded screens were *about*, from the text that was on them.
 *
 * OCR gives a bag of lines. This turns that into a small, ranked list of terms a reader can use as
 * an index, using counts and nothing else — no model, no embeddings, no language detection. Two
 * tokenizers, because the material is mixed:
 *
 * - **Latin words** are split on non-word characters, lowercased, and filtered against a short
 *   stop-word list and a length bound.
 * - **CJK runs** have no spaces to split on, so they are enumerated as 2- to 4-character n-grams.
 *   That alone would report `语义`, `语义分` and `语义分割` as three terms, so the longest n-gram
 *   that occurs exactly as often as its own prefix absorbs the shorter ones. The surviving term is
 *   the longest one whose count is not an artefact of prefix counting.
 *
 * The caller gets counts and where they came from, never a summary: deciding what the recording
 * was about is DSH's job, and the honest input to that decision is a term list with positions.
 *
 * @module dsh-ffmpeg/core/text
 */

/** Latin words that carry no indexing value on their own. */
export const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'her', 'was', 'one', 'our',
  'out', 'day', 'get', 'has', 'him', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'two',
  'way', 'who', 'boy', 'did', 'use', 'with', 'that', 'this', 'from', 'they', 'have', 'will', 'your',
  'what', 'when', 'make', 'like', 'time', 'just', 'know', 'take', 'into', 'than', 'them', 'well',
  'only', 'come', 'over', 'also', 'back', 'after', 'use', 'two', 'how', 'our', 'work', 'first',
  'http', 'https', 'www', 'com', 'org', 'html', 'true', 'false', 'null', 'undefined',
])

/** Shortest and longest Latin word kept. */
const LATIN_MIN = 3
const LATIN_MAX = 32

/** CJK n-gram lengths enumerated. */
const CJK_MIN = 2
const CJK_MAX = 4

/**
 * Test whether a character is in a CJK block.
 * @param {string} character - one character.
 * @returns {boolean} whether it is CJK.
 */
export function isCjk(character) {
  const code = character.codePointAt(0) ?? 0
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xac00 && code <= 0xd7af)
  )
}

/**
 * Enumerate the CJK n-grams in one string.
 * @param {string} text - the line.
 * @param {Map<string, number>} counts - counts to add to.
 * @returns {void}
 */
function addCjkGrams(text, counts) {
  const characters = [...text]
  for (let start = 0; start < characters.length; start += 1) {
    if (!isCjk(characters[start])) continue
    for (let length = CJK_MIN; length <= CJK_MAX; length += 1) {
      const slice = characters.slice(start, start + length)
      if (slice.length < length || !slice.every(isCjk)) break
      const term = slice.join('')
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
  }
}

/**
 * Enumerate the Latin words in one string.
 * @param {string} text - the line.
 * @param {Map<string, number>} counts - counts to add to.
 * @returns {void}
 */
function addLatinWords(text, counts) {
  for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_+#.-]*/g)) {
    const word = match[0].toLowerCase().replace(/[.-]+$/, '')
    if (word.length < LATIN_MIN || word.length > LATIN_MAX) continue
    if (STOP_WORDS.has(word)) continue
    if (/^\d+$/.test(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
}

/**
 * Take the longest n-gram when a set of n-grams always occur together.
 *
 * `语义分割` occurring four times makes `语义`, `义分` and `语义分` occur at least four times too, so
 * a raw count ranks the fragment as highly as the term. An n-gram is dropped when a longer n-gram
 * that contains it has the same count, which leaves the longest spelling of each actual term.
 *
 * @param {Map<string, number>} counts - term counts.
 * @returns {Map<string, number>} the reduced counts.
 */
export function collapsePrefixes(counts) {
  const terms = [...counts.keys()]
  const dropped = new Set()
  for (const term of terms) {
    if (dropped.has(term)) continue
    for (const candidate of terms) {
      if (candidate === term || candidate.length <= term.length) continue
      if (!candidate.includes(term)) continue
      if ((counts.get(candidate) ?? 0) >= (counts.get(term) ?? 0)) dropped.add(term)
    }
  }
  const reduced = new Map()
  for (const [term, count] of counts) if (!dropped.has(term)) reduced.set(term, count)
  return reduced
}

/**
 * Extract ranked keywords from OCR results.
 *
 * @param {{text: string, index?: number, at?: number}[]} documents - one entry per segment's reading.
 * @param {object} [options] - `{ maxKeywords, minCount }`.
 * @returns {{term: string, count: number, segments: number[], firstAt: number|null}[]} the terms.
 */
export function extractKeywords(documents, options = {}) {
  const maxKeywords = Number.isFinite(options.maxKeywords) ? options.maxKeywords : 20
  const minCount = Number.isFinite(options.minCount) ? options.minCount : 2

  const counts = new Map()
  const where = new Map()
  for (const [position, document] of documents.entries()) {
    const text = String(document?.text ?? '')
    if (text.trim() === '') continue
    const local = new Map()
    addLatinWords(text, local)
    addCjkGrams(text, local)
    for (const [term, count] of local) {
      counts.set(term, (counts.get(term) ?? 0) + count)
      const entry = where.get(term) ?? { segments: new Set(), firstAt: null }
      entry.segments.add(document.index ?? position)
      if (entry.firstAt === null && Number.isFinite(document.at)) entry.firstAt = document.at
      where.set(term, entry)
    }
  }

  const reduced = collapsePrefixes(counts)
  return [...reduced.entries()]
    .filter(([, count]) => count >= minCount)
    .map(([term, count]) => ({
      term,
      count,
      segments: [...(where.get(term)?.segments ?? [])].sort((left, right) => left - right),
      firstAt: where.get(term)?.firstAt ?? null,
    }))
    .sort((left, right) => right.count - left.count || right.term.length - left.term.length || left.term.localeCompare(right.term))
    .slice(0, maxKeywords)
}
