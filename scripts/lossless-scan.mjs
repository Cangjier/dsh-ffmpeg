/**
 * Find every leaf of an analysis result that would not survive a JSON round-trip.
 *
 * Run with `node scripts/lossless-scan.mjs <file>`. The harness refuses a tool result that is not
 * lossless JSON, and this says which field is responsible instead of leaving it to guesswork.
 */
import { analyze } from '../src/core/semantics.mjs'
import { normalizeConfig } from '../index.mjs'
import { toLosslessJson } from '../src/tools/shared.mjs'

const input = process.argv[2]
if (input === undefined) {
  console.error('usage: node scripts/lossless-scan.mjs <video>')
  process.exit(2)
}

/** @returns {string[]} one line per offending path. */
function scan(value, path = '$', found = []) {
  if (value === undefined) {
    found.push(`${path} = undefined（JSON 里这个键会消失）`)
    return found
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    found.push(`${path} = ${value}（JSON 里会变成 null）`)
    return found
  }
  if (Object.is(value, -0)) found.push(`${path} = -0（JSON 里会变成 0）`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scan(entry, `${path}[${index}]`, found))
    return found
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      if (!(value instanceof Date)) found.push(`${path} 是 ${value.constructor?.name}（不是普通对象）`)
      return found
    }
    for (const [key, entry] of Object.entries(value)) scan(entry, `${path}.${key}`, found)
  }
  return found
}

const structure = await analyze({
  input,
  outDir: 'tmp/lossless-scan',
  config: normalizeConfig({}),
  options: { maxKeyframes: 6 },
  onProgress: () => {},
})

const raw = scan(structure)
console.log(`原始结果里的问题（${raw.length} 条）：`)
for (const line of raw.slice(0, 40)) console.log(`  ${line}`)

const safe = toLosslessJson(structure)
const roundTrip = JSON.parse(JSON.stringify(safe))
console.log(`\nafter toLosslessJson: lossless = ${JSON.stringify(roundTrip) === JSON.stringify(safe)}`)

// And the same thing through a registered tool, which is the path the harness actually takes.
const { toolDefinitions } = await import('../src/tools/index.mjs')
const semantics = toolDefinitions(normalizeConfig({}), { info: () => {}, warn: () => {}, error: () => {} }).find(
  (definition) => definition.name === 'ffmpeg_semantics',
)
const viaTool = await semantics.execute({ action: 'analyze', input, outDir: 'tmp/lossless-scan/tool', text: 'off', maxKeyframes: 3 }, { cwd: process.cwd() })
const toolRoundTrip = JSON.parse(JSON.stringify(viaTool))
console.log(`through the tool definition: lossless = ${JSON.stringify(toolRoundTrip) === JSON.stringify(viaTool)}`)
const remaining = scan(viaTool)
console.log(`tool result problems: ${remaining.length === 0 ? 'none' : remaining.slice(0, 10).join(' | ')}`)
