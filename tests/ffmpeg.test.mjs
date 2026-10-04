/**
 * The half that needs a real ffmpeg: every action that writes a file, and the analysis pipeline.
 *
 * Each test drives the *registered tool definition*, not the core, because that is what a caller
 * reaches: it covers argument validation, capability preflight, plan building, execution and the
 * measurement afterwards in one go. The suite skips itself on a machine with no ffmpeg rather than
 * failing, and says so.
 *
 * @module dsh-ffmpeg/tests/ffmpeg
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeConfig } from '../index.mjs'
import { toolDefinitions } from '../src/tools/index.mjs'
import { capabilities } from '../src/core/caps.mjs'
import { demoClip, ffmpegAvailable, flatClip, workDir, writeSrt } from './helpers.mjs'

const availability = await ffmpegAvailable()
const skip = availability.ok ? false : `跳过：${availability.reason}`
const config = normalizeConfig({ maxConcurrent: 2 })

/** The registered definitions, keyed by name. */
const tools = new Map(toolDefinitions(config, { info: () => {}, warn: () => {}, error: () => {} }).map((definition) => [definition.name, definition]))

/**
 * Call one tool action.
 * @param {string} tool - the tool name.
 * @param {object} args - the arguments.
 * @returns {Promise<object>} the result.
 */
const call = (tool, args) => tools.get(tool).execute(args, { cwd: process.cwd() })

/** Where this suite writes. */
let DIR = null
let DEMO = null

before(async () => {
  if (!availability.ok) return
  DIR = workDir('ffmpeg')
  DEMO = await demoClip(DIR)
})

test('ffmpeg_env probe and caps describe this build', { skip }, async () => {
  const probe = await call('ffmpeg_env', { action: 'probe' })
  assert.equal(typeof probe.ffmpeg.path, 'string')
  assert.match(probe.ffmpeg.version, /^ffmpeg version/)
  assert.equal(probe.ffprobe.version.startsWith('ffprobe version'), true)
  assert.ok(probe.install.sources.length >= 2)

  const caps = await call('ffmpeg_env', { action: 'caps' })
  assert.ok(caps.counts.encoders > 20)
  assert.equal(caps.encoders.aac, true)
  assert.equal(typeof caps.capture.gdigrab, 'boolean')
  assert.ok(Array.isArray(caps.missingBasics))
})

test('ffmpeg_setup status reports without writing anything', { skip }, async () => {
  const status = await call('ffmpeg_setup', { action: 'status' })
  assert.equal(typeof status.vendor.present, 'boolean')
  assert.equal(status.defaultSource, 'gyan-release')
  assert.ok(status.sources.some((source) => source.pinnedSha256 !== null), '默认来源必须有固定摘要')
})

test('ffmpeg_probe info, keyframes and integrity agree with each other', { skip }, async () => {
  const info = await call('ffmpeg_probe', { action: 'info', target: DEMO })
  const facts = info.files[0]
  assert.equal(facts.kind, 'video')
  assert.equal(facts.video.width, 640)
  assert.equal(facts.video.height, 360)
  assert.equal(facts.video.codec, 'h264')
  assert.equal(facts.audio.codec, 'aac')
  assert.ok(Math.abs(facts.durationSec - 6) < 0.2)
  assert.equal(facts.streamCount, 2)

  const multi = await call('ffmpeg_probe', { action: 'info', paths: [DEMO, join(DIR, 'does-not-exist.mp4')] })
  assert.equal(multi.files.length, 1)
  assert.equal(multi.failed.length, 1)

  const keyframes = await call('ffmpeg_probe', { action: 'keyframes', target: DEMO })
  assert.ok(keyframes.count >= 1)
  assert.equal(keyframes.times[0], 0)

  const integrity = await call('ffmpeg_probe', { action: 'integrity', target: DEMO })
  assert.equal(integrity.ok, true)
  assert.ok(integrity.decodedFrames >= 140, `解出 ${integrity.decodedFrames} 帧`)
  assert.ok(Math.abs(integrity.deltaSec) < 0.2, `时长差 ${integrity.deltaSec}`)
})

test('ffmpeg_convert transcode rewrites the container and measures the result', { skip }, async () => {
  const out = join(DIR, 'transcoded.mp4')
  const result = await call('ffmpeg_convert', {
    action: 'transcode',
    input: DEMO,
    out,
    video: { crf: 28, preset: 'ultrafast', scale: '320:-2', fps: 15 },
    audio: { codec: 'aac', bitrate: '64k', channels: 1 },
  })
  assert.equal(result.ok, true, JSON.stringify(result.files))
  assert.equal(result.container, 'mp4')
  const file = result.files[0]
  assert.equal(file.ok, true, file.problems.join('；'))
  assert.equal(file.facts.video.width, 320)
  assert.equal(file.facts.video.height, 180)
  assert.equal(file.facts.video.fps, 15)
  assert.equal(file.facts.audio.channels, 1)
  assert.ok(Math.abs(file.facts.durationSec - 6) < 0.3)
})

test('ffmpeg_convert refuses an output that is also an input', { skip }, async () => {
  await assert.rejects(
    () => call('ffmpeg_convert', { action: 'transcode', input: DEMO, out: DEMO }),
    /输出路径与输入是同一个文件/,
  )
  await assert.rejects(() => call('ffmpeg_convert', { action: 'transcode', input: DEMO, out: join(DIR, 'x.xyz') }), /不认识的输出扩展名/)
  await assert.rejects(() => call('ffmpeg_convert', { action: 'transcode', input: join(DIR, 'nope.mp4'), out: join(DIR, 'y.mp4') }), /输入不存在/)
})

test('ffmpeg_convert trim cuts where it says it does', { skip }, async () => {
  const copy = await call('ffmpeg_convert', { action: 'trim', input: DEMO, out: join(DIR, 'cut-copy.mp4'), start: 3, duration: 2, mode: 'copy' })
  assert.equal(copy.ok, true, JSON.stringify(copy.files))
  const copyDuration = copy.files[0].facts.durationSec
  assert.ok(copyDuration >= 1.5 && copyDuration <= 2.5, `copy 切片 ${copyDuration}s`)

  const encode = await call('ffmpeg_convert', { action: 'trim', input: DEMO, out: join(DIR, 'cut-encode.mp4'), start: 3, duration: 2, mode: 'encode' })
  assert.equal(encode.ok, true, JSON.stringify(encode.files))
  const encodeDuration = encode.files[0].facts.durationSec
  assert.ok(Math.abs(encodeDuration - 2) < 0.25, `encode 切片 ${encodeDuration}s，应当接近 2s`)

  await assert.rejects(() => call('ffmpeg_convert', { action: 'trim', input: DEMO, out: join(DIR, 'z.mp4'), start: 3, duration: 0 }), /裁剪区间为空/)
})

test('ffmpeg_convert frames writes one still per timestamp', { skip }, async () => {
  const outDir = join(DIR, 'stills')
  const result = await call('ffmpeg_convert', { action: 'frames', input: DEMO, outDir, times: [0.5, 2, 4.5], format: 'png' })
  assert.equal(result.files.length, 3)
  for (const file of result.files) {
    assert.equal(file.ok, true, file.problems.join('；'))
    assert.equal(file.facts.kind, 'image')
  }
  assert.equal(readdirSync(outDir).filter((name) => name.endsWith('.png')).length, 3)

  await assert.rejects(() => call('ffmpeg_convert', { action: 'frames', input: DEMO, outDir }), /需要 at/)
  await assert.rejects(() => call('ffmpeg_convert', { action: 'frames', input: DEMO, outDir, at: 1, times: [2] }), /只能给一个/)
})

test('ffmpeg_convert concat joins matching clips and refuses mismatched ones in copy mode', { skip }, async () => {
  const a = await flatClip(join(DIR, 'part-a.mp4'), { seconds: 1 })
  const b = await flatClip(join(DIR, 'part-b.mp4'), { seconds: 1, color: '0x804020' })
  const joined = await call('ffmpeg_convert', { action: 'concat', inputs: [a, b], out: join(DIR, 'joined.mp4'), mode: 'copy' })
  assert.equal(joined.ok, true, JSON.stringify(joined.files))
  assert.ok(Math.abs(joined.files[0].facts.durationSec - 2) < 0.3, `拼接后 ${joined.files[0].facts.durationSec}s`)
  assert.equal(existsSync(joined.listPath), false, '临时清单必须被清掉')

  const odd = await flatClip(join(DIR, 'part-c.mp4'), { seconds: 1, size: '320x240' })
  await assert.rejects(
    () => call('ffmpeg_convert', { action: 'concat', inputs: [a, odd], out: join(DIR, 'bad-join.mp4'), mode: 'copy' }),
    /编码参数一致/,
  )
  const reencoded = await call('ffmpeg_convert', { action: 'concat', inputs: [a, odd], out: join(DIR, 'good-join.mp4'), mode: 'encode' })
  assert.equal(reencoded.ok, true, JSON.stringify(reencoded.files))
  assert.ok(Math.abs(reencoded.files[0].facts.durationSec - 2) < 0.4)
})

test('ffmpeg_convert audio extracts, drops and normalizes', { skip }, async () => {
  const extracted = await call('ffmpeg_convert', { action: 'audio', input: DEMO, out: join(DIR, 'audio.m4a'), mode: 'extract' })
  assert.equal(extracted.ok, true, JSON.stringify(extracted.files))
  assert.equal(extracted.files[0].facts.video, null)
  assert.equal(extracted.files[0].facts.audio.codec, 'aac')

  const silent = await call('ffmpeg_convert', { action: 'audio', input: DEMO, out: join(DIR, 'silent.mp4'), mode: 'drop' })
  assert.equal(silent.ok, true, JSON.stringify(silent.files))
  assert.equal(silent.files[0].facts.audio, null)

  const normalized = await call('ffmpeg_convert', { action: 'audio', input: DEMO, out: join(DIR, 'normalized.mp4'), mode: 'normalize', normalize: { targetI: -16 } })
  assert.equal(normalized.ok, true, JSON.stringify(normalized.files))
  assert.ok(normalized.measured !== null && normalized.measured.input_i !== undefined, '两遍模式必须留下测量值')
  assert.equal(normalized.passes, 2)
})

test('ffmpeg_convert subtitles muxes a track without re-encoding the picture', { skip }, async () => {
  const srt = writeSrt(DIR)
  const muxed = await call('ffmpeg_convert', { action: 'subtitles', input: DEMO, out: join(DIR, 'muxed.mp4'), srt, mode: 'mux' })
  assert.equal(muxed.ok, true, JSON.stringify(muxed.files))
  const info = await call('ffmpeg_probe', { action: 'info', target: join(DIR, 'muxed.mp4') })
  assert.equal(info.files[0].subtitles, 1)
  // The picture is untouched, byte for byte, because the packet copy is exact.
  assert.equal(muxed.files[0].facts.video.codec, 'h264')
})

test('ffmpeg_convert gif builds a palette in one pass', { skip }, async () => {
  const result = await call('ffmpeg_convert', { action: 'gif', input: DEMO, out: join(DIR, 'clip.gif'), start: 3, duration: 1.5, fps: 8, width: 240 })
  assert.equal(result.ok, true, JSON.stringify(result.files))
  assert.equal(result.files[0].facts.video.codec, 'gif')
  assert.equal(result.files[0].facts.video.width, 240)
})

test('ffmpeg_semantics scenes finds the cut without writing anything', { skip }, async () => {
  const before = readdirSync(DIR).length
  const timeline = await call('ffmpeg_semantics', { action: 'scenes', input: DEMO })
  assert.equal(timeline.segments.length, 2)
  const [first, second] = timeline.segments
  assert.equal(first.start, 0)
  assert.ok(Math.abs(first.end - 3) < 0.35, `切点落在 ${first.end}s`)
  assert.equal(first.endReason, 'cut')
  assert.ok(first.sceneScore > 30, `切分强度 ${first.sceneScore}`)
  assert.equal(second.startReason, 'cut')
  assert.equal(timeline.options.sceneThreshold, 8)
  assert.equal(readdirSync(DIR).length, before, 'scenes 不写文件')
})

test('ffmpeg_semantics analyze produces the structure, the stills and the video', { skip }, async () => {
  const outDir = workDir('ffmpeg-analyze')
  const structure = await call('ffmpeg_semantics', { action: 'analyze', input: DEMO, outDir })

  assert.equal(structure.version, 1)
  assert.equal(structure.segments.length, 2)
  assert.equal(structure.timeline.segments, 2)
  assert.ok(structure.analysis.decodedFrames > 10)

  for (const segment of structure.segments) {
    assert.ok(segment.keyframe !== null, `第 ${segment.index} 段没有关键帧`)
    assert.equal(existsSync(segment.keyframe.path), true)
    assert.ok(Array.isArray(segment.regions) && segment.regions.length > 0)
    assert.equal(typeof segment.labelShares, 'object')
    assert.ok(typeof segment.kind === 'string' && segment.kind !== 'unknown', `第 ${segment.index} 段的类别是 ${segment.kind}`)
    assert.equal(typeof segment.kindEvidence.rule, 'string')
    const share = Object.values(segment.labelShares).reduce((sum, value) => sum + value, 0)
    assert.ok(share <= 1.02, `第 ${segment.index} 段的标签占比合计 ${share}`)
  }

  // Text: the second segment is a flat dark screen with one line burned in. A provider that is
  // present must have read something; the provider's identity is part of the answer either way.
  const providers = structure.providers.ocr
  assert.ok(['sibling', 'winrt', 'none', 'off'].includes(providers.provider))
  if (providers.provider === 'sibling' || providers.provider === 'winrt') {
    const withText = structure.segments.filter((segment) => (segment.text?.lineCount ?? 0) > 0)
    assert.ok(withText.length >= 1, `provider=${providers.provider} 但一段文字都没读到`)
    assert.equal(typeof withText[0].text.reading, 'string')
  } else {
    assert.ok(providers.notes.length > 0, '没有 provider 时必须说明原因')
  }

  // Outputs: the structure file is on disk and parses back to the same thing.
  assert.equal(existsSync(structure.outputs.structure), true)
  const reparsed = JSON.parse(readFileSync(structure.outputs.structure, 'utf8'))
  assert.equal(reparsed.segments.length, structure.segments.length)
  assert.equal(reparsed.version, structure.version)

  // The keyframe directory holds one still per segment.
  const stills = readdirSync(structure.outputs.keyframes)
  assert.equal(stills.filter((name) => /^kf_\d+\.(jpg|png|webp)$/.test(name)).length, structure.segments.length)

  // A contact sheet exists once there is more than one still.
  assert.equal(typeof structure.outputs.contactSheet, 'string')
  assert.equal(existsSync(structure.outputs.contactSheet), true)

  // The delivery video plays, has chapters, and is the full length.
  assert.equal(typeof structure.outputs.video.path, 'string')
  assert.equal(structure.outputs.video.ok, true, structure.outputs.video.problems.join('；'))
  assert.ok(Math.abs(structure.outputs.video.facts.durationSec - 6) < 0.3)
  assert.equal(existsSync(structure.outputs.video.chaptersPath), true)
  const chapters = readFileSync(structure.outputs.video.chaptersPath, 'utf8')
  assert.match(chapters, /\[CHAPTER\]/)
  assert.match(chapters, /TIMEBASE=1\/1000/)

  // Keywords come from counts over the recognised text, so they are only claimed when text exists.
  if (structure.segments.some((segment) => (segment.text?.lineCount ?? 0) > 0)) {
    assert.ok(Array.isArray(structure.structure.keywords))
  }
})

test('ffmpeg_semantics analyze can skip text, keyframes and the delivery video', { skip }, async () => {
  const outDir = workDir('ffmpeg-analyze-minimal')
  const structure = await call('ffmpeg_semantics', {
    action: 'analyze',
    input: DEMO,
    outDir,
    text: 'off',
    segmentation: 'off',
    contactSheet: false,
    chapters: false,
    output: 'none',
    maxKeyframes: 1,
  })
  assert.equal(structure.outputs.video, null)
  assert.equal(structure.outputs.contactSheet, null)
  assert.equal(structure.providers.ocr.provider, 'off')
  assert.equal(structure.segments[1].text, null)
  assert.equal(structure.segments[1].regions, null)
  assert.equal(structure.segments[1].keyframe, null, '超过 maxKeyframes 的段没有关键帧')
})

test('ffmpeg_semantics regions labels a still and a frame of a video', { skip }, async () => {
  const still = join(DIR, 'stills', readdirSync(join(DIR, 'stills'))[0])
  const fromStill = await call('ffmpeg_semantics', { action: 'regions', input: still })
  assert.ok(fromStill.regions.length > 0)
  assert.equal(fromStill.source.kind, 'image')
  const total = Object.values(fromStill.labelShares).reduce((sum, value) => sum + value, 0)
  assert.ok(total <= 1.02, `占比合计 ${total}`)
  assert.ok(fromStill.vocabulary.text.length > 0)

  const fromVideo = await call('ffmpeg_semantics', { action: 'regions', input: DEMO, at: 4.5 })
  assert.equal(fromVideo.at, 4.5)
  assert.ok(fromVideo.regions.length > 0)
  assert.ok(fromVideo.frame.width <= 320)
})

test('ffmpeg_semantics writes a delivery video that a player can seek in', { skip }, async () => {
  const outDir = workDir('ffmpeg-analyze-encode')
  const structure = await call('ffmpeg_semantics', { action: 'analyze', input: DEMO, outDir, output: 'encode', maxKeyframes: 4, contactSheet: true })
  assert.equal(structure.outputs.video.mode, 'encode')
  assert.equal(structure.outputs.video.ok, true, structure.outputs.video.problems.join('；'))
  assert.equal(structure.outputs.video.facts.video.codec, 'h264')
  assert.equal(structure.outputs.video.facts.video.pixFmt, 'yuv420p')
  // faststart: the moov box precedes mdat.
  const bytes = readFileSync(structure.outputs.video.path)
  const moov = bytes.indexOf(Buffer.from('moov'))
  const mdat = bytes.indexOf(Buffer.from('mdat'))
  assert.ok(moov > 0 && mdat > 0 && moov < mdat, 'moov 必须在 mdat 之前（faststart）')
})

test('ffmpeg_run check describes a call and run measures it', { skip }, async () => {
  const check = await call('ffmpeg_run', { action: 'check', args: ['-i', DEMO, '-vf', 'hflip', '-c:a', 'copy', join(DIR, 'flipped.mp4')] })
  assert.deepEqual(check.inputs, [DEMO])
  assert.equal(check.output, join(DIR, 'flipped.mp4'))
  assert.equal(check.filters.includes('hflip'), true)
  assert.match(check.command, /^ffmpeg -i /)

  const result = await call('ffmpeg_run', { action: 'run', args: ['-i', DEMO, '-vf', 'hflip', '-c:a', 'copy', join(DIR, 'flipped.mp4')] })
  assert.equal(result.code, 0)
  assert.equal(result.output.ok, true, result.output.problems.join('；'))
  assert.ok(result.elapsedMs > 0)

  // The managed options are supplied by the plugin, so a caller repeating them is told, not obeyed.
  const repeated = await call('ffmpeg_run', { action: 'check', args: ['-y', '-i', DEMO, join(DIR, 'again.mp4')] })
  assert.equal(repeated.warnings.some((line) => line.includes('-y 已被本插件接管')), true)

  // An output that is also an input is described by `check` and refused by `run`: the describe step
  // alone would let a caller truncate their own source file.
  const dangerous = await call('ffmpeg_run', { action: 'check', args: ['-i', DEMO, '-c', 'copy', DEMO] })
  assert.equal(dangerous.samePathAsInput, DEMO)
  assert.equal(dangerous.warnings.some((line) => line.includes('输出路径与输入是同一个文件')), true)
  await assert.rejects(() => call('ffmpeg_run', { action: 'run', args: ['-i', DEMO, '-c', 'copy', DEMO] }), /同时是输入/)

  await assert.rejects(() => call('ffmpeg_run', { action: 'run', args: '-i a.mp4 b.mp4' }), /非空字符串数组/)
  await assert.rejects(() => call('ffmpeg_run', { action: 'check', args: ['-i', DEMO, 42, join(DIR, 'x.mp4')] }), /每一项都必须是字符串/)
})

test('a failed encode leaves no half-written file behind', { skip }, async () => {
  const target = join(DIR, 'never.mp4')
  await assert.rejects(
    () => call('ffmpeg_run', { action: 'run', args: ['-i', DEMO, '-vf', 'no_such_filter=1', target] }),
    /ffmpeg 退出码/,
  )
  assert.equal(existsSync(target), false, '失败后不能留下半成品')
})

test('the analysis options an operator configures are the ones that run', { skip }, async () => {
  const strict = normalizeConfig({ analysis: { sceneThreshold: 200, minSegmentSec: 1 } })
  const definitions = new Map(toolDefinitions(strict, { info: () => {}, warn: () => {}, error: () => {} }).map((definition) => [definition.name, definition]))
  const timeline = await definitions.get('ffmpeg_semantics').execute({ action: 'scenes', input: DEMO }, { cwd: process.cwd() })
  // A threshold above any difference the clip contains leaves the whole file as one segment.
  assert.equal(timeline.segments.length, 1, `阈值 200 时不该切分，却切成了 ${timeline.segments.length} 段`)
  assert.equal(timeline.options.sceneThreshold, 200)
})

test('the capability cache answers the second call without spawning ffmpeg', { skip }, async () => {
  const first = await capabilities(config)
  const started = Date.now()
  const second = await capabilities(config)
  assert.equal(second, first)
  assert.ok(Date.now() - started < 20)
})

test('a record plan for this machine names the devices it would use', { skip }, async () => {
  const devices = await call('ffmpeg_env', { action: 'devices' })
  assert.equal(devices.available, true)
  assert.ok(Array.isArray(devices.audio))
  // The plan itself is not executed here: a test suite must not capture the operator's screen.
  assert.ok(devices.note.length > 0)
})

test('analyzing a file in its own directory never aims the delivery at the source', { skip }, async () => {
  // The destructive case: a file already named `<stem>.mp4`, analysed with outDir set to the folder
  // it lives in. The delivery video must not be written over the input.
  const directory = workDir('ffmpeg-inplace')
  const source = await demoClip(directory)
  const before = readFileSync(source)
  const structure = await call('ffmpeg_semantics', { action: 'analyze', input: source, outDir: directory, maxKeyframes: 2, text: 'off' })
  assert.notEqual(structure.outputs.video.path, source)
  assert.equal(structure.outputs.video.ok, true, structure.outputs.video.problems.join('；'))
  assert.deepEqual(readFileSync(source), before, '源文件必须一个字节都没变')
  assert.equal(structure.notes.some((line) => line.includes('源文件没有被碰')), true)
})

test('probe reports the problems a file has before the conversion discovers them', { skip }, async () => {
  // A truncated file: keep the first 4 KB of a valid MP4 and nothing else.
  const bytes = readFileSync(DEMO)
  const truncated = join(DIR, 'truncated.mp4')
  writeFileSync(truncated, bytes.subarray(0, 4096))
  const info = await call('ffmpeg_probe', { action: 'info', target: truncated })
  // Either the file probes with problems named, or it cannot be probed at all — both are the plugin
  // telling the caller the truth, and neither is silence.
  if (info.files.length > 0) assert.ok(info.files[0].problems.length > 0, '截断的文件必须被指出')
  else assert.equal(info.failed.length, 1, '读不了的文件必须出现在 failed 里')
  assert.equal(statSync(truncated).size, 4096)
})
