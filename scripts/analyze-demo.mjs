/**
 * End-to-end exercise of the analysis pipeline against a synthetic recording.
 *
 * Run with `node tmp/analyze-smoke.mjs`. Prints the structure it produced so the shape can be read
 * by eye; the assertions live in tests/ffmpeg.test.mjs.
 */
import { analyze } from '../src/core/semantics.mjs'
import { normalizeConfig } from '../index.mjs'

const config = normalizeConfig({})
const structure = await analyze({
  input: 'tmp/media/demo.mp4',
  outDir: 'tmp/analysis',
  config,
  options: {},
  onProgress: (message) => console.log(`… ${message}`),
})

console.log('\n=== timeline ===')
console.log(`segments: ${structure.timeline.segments}, duration: ${structure.timeline.durationSec}s, decoded ${structure.analysis.decodedFrames} frames at ${structure.analysis.size.width}x${structure.analysis.size.height}`)
for (const segment of structure.segments) {
  const labels = segment.labelShares === null ? '—' : Object.entries(segment.labelShares).map(([label, share]) => `${label}:${share}`).join(' ')
  const text = segment.text?.reading?.replace(/\n/g, ' | ') ?? '—'
  console.log(
    `#${segment.index} ${segment.start.toFixed(2)}–${segment.end.toFixed(2)}s ${segment.kind} (${segment.motion.level}, mad=${segment.motion.meanAbsDiff}) keyframe=${segment.keyframe?.at ?? '—'} regions=${segment.regions?.length ?? 0} [${labels}] text="${text}"`,
  )
}

console.log('\n=== providers ===')
console.log(JSON.stringify(structure.providers, null, 2))

console.log('\n=== kinds / keywords ===')
console.log(JSON.stringify(structure.structure.kinds, null, 2))
console.log(JSON.stringify(structure.structure.keywords.slice(0, 8), null, 2))

console.log('\n=== outputs ===')
console.log(JSON.stringify(structure.outputs, null, 2))
console.log('\n=== notes ===')
console.log(structure.notes.join('\n'))
