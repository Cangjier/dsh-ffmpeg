/**
 * A real capture on this machine: three seconds of the actual desktop, then a look at what came out.
 *
 * Run with `node tmp/record-smoke.mjs`. The file it writes stays under `tmp/`, which is gitignored.
 */
import { normalizeConfig } from '../index.mjs'
import { toolDefinitions } from '../src/tools/index.mjs'
import { analyze } from '../src/core/semantics.mjs'

const config = normalizeConfig({})
const tools = new Map(toolDefinitions(config, { info: () => {}, warn: console.warn, error: console.error }).map((definition) => [definition.name, definition]))
const call = (tool, args) => tools.get(tool).execute(args, { cwd: process.cwd() })

const devices = await call('ffmpeg_env', { action: 'devices' })
console.log('audio devices:', devices.audio.slice(0, 6))
console.log('video devices:', devices.video.slice(0, 4))

const out = 'tmp/media/screen.mp4'
const recorded = await call('ffmpeg_record', { action: 'screen', out, seconds: 3, fps: 10, drawMouse: true })
console.log('\nrecord:', JSON.stringify({ ok: recorded.ok, requested: recorded.requestedSeconds, actual: recorded.actualSeconds, files: recorded.files.map((file) => ({ problems: file.problems, video: file.facts?.video, durationSec: file.facts?.durationSec })) }, null, 2))
console.log('notes:', recorded.notes.join(' | '))

const structure = await analyze({
  input: out,
  outDir: 'tmp/media/analysis',
  config,
  options: { maxKeyframes: 8, ocrMaxFrames: 8 },
  onProgress: (message) => console.log(`… ${message}`),
})
console.log(`\nsegments: ${structure.segments.length}, kinds: ${structure.structure.kinds.map((entry) => `${entry.kind}×${entry.segments}`).join(' ')}`)
for (const segment of structure.segments) {
  const text = segment.text?.reading?.split('\n')[0] ?? ''
  console.log(`#${segment.index} ${segment.start.toFixed(2)}–${segment.end.toFixed(2)} ${segment.kind} ${segment.motion.level} regions=${segment.regions?.length ?? 0} text="${text.slice(0, 60)}"`)
}
console.log('keywords:', structure.structure.keywords.map((entry) => `${entry.term}(${entry.count})`).join(' ') || '(none)')
console.log('outputs:', JSON.stringify({ video: structure.outputs.video?.path, ok: structure.outputs.video?.ok, structure: structure.outputs.structure, sheet: structure.outputs.contactSheet }, null, 2))
console.log('notes:', structure.notes.join(' | ') || '(none)')
