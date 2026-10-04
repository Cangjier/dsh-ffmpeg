/**
 * The pure half: everything that can be checked without ffmpeg, a network, or a video file.
 *
 * These are the tests that matter most, because they cover the decisions — argument order, size
 * arithmetic, cut detection, region merging, refusal paths — where a mistake produces a file that
 * looks fine and is not.
 *
 * @module dsh-ffmpeg/tests/core
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fitSize } from '../src/core/image.mjs'
import {
  assertSeparate,
  audioArguments,
  audioPlan,
  concatCanvas,
  containerFor,
  formatTime,
  parseLoudnorm,
  substituteLoudnorm,
  transcodePlan,
  trimPlan,
  framesPlan,
  gifPlan,
  subtitlesPlan,
  videoArguments,
} from '../src/core/media.mjs'
import { longPath } from '../src/core/env.mjs'
import { TimelineBuilder, keyframeTime, mergeShortSegments, motionLevel } from '../src/core/timeline.mjs'
import { classifyTile, dominantColors, frameDifference, mergeRegions, segmentFrame, tileStats } from '../src/core/segmentation.mjs'
import { collapsePrefixes, extractKeywords, isCjk } from '../src/core/text.mjs'
import { classify, parseRational, rotationOf } from '../src/core/probe.mjs'
import { checkNeeds, parseDevices, parseDshowDevices, parseHwaccels, parseListNames } from '../src/core/caps.mjs'
import { extractBinaries, findEndOfCentralDirectory } from '../src/core/install.mjs'
import { inspectArgs, filterNames } from '../src/tools/run.mjs'
import { canRemuxToMp4, describeSegmentKind, normalizeOptions, summarizeKinds, writeChapters } from '../src/core/semantics.mjs'
import { escapeOptionValue, screenPlan, audioPlan as recordAudioPlan } from '../src/core/record.mjs'
import { normalizeConfig } from '../index.mjs'
import { parseProgress } from '../src/core/ffmpeg.mjs'
import { toLosslessJson } from '../src/tools/shared.mjs'

const WORK = join(import.meta.dirname, '..', 'tmp', 'unit')
mkdirSync(WORK, { recursive: true })

// ---------------------------------------------------------------------------------------------
// Sizes, containers and argument order
// ---------------------------------------------------------------------------------------------

test('fitSize keeps the aspect ratio and always produces even dimensions', () => {
  assert.deepEqual(fitSize(1920, 1080, 320), { width: 320, height: 180, scale: 320 / 1920 })
  assert.deepEqual(fitSize(1080, 1920, 320), { width: 180, height: 320, scale: 180 / 1080 })
  assert.deepEqual(fitSize(641, 361, 320), { width: 320, height: 180, scale: 320 / 641 })
  // Never upscales.
  assert.deepEqual(fitSize(160, 90, 320), { width: 160, height: 90, scale: 1 })
  // Odd results are rounded up to even, because H.264 refuses a 641-wide frame.
  const odd = fitSize(1999, 999, 640)
  assert.equal(odd.width % 2, 0)
  assert.equal(odd.height % 2, 0)
})

test('containerFor maps extensions and refuses the ones it cannot write', () => {
  assert.equal(containerFor('a.mp4').muxer, 'mp4')
  assert.equal(containerFor('a.MP4').muxer, 'mp4')
  assert.equal(containerFor('a.webm').video, 'libvpx-vp9')
  assert.equal(containerFor('a.wav').video, null)
  assert.throws(() => containerFor('a.xyz'), /不认识的输出扩展名/)
})

test('assertSeparate refuses an output that is one of its own inputs', () => {
  const input = join(WORK, 'same.mp4')
  assert.throws(() => assertSeparate(input, input), /输出路径与输入是同一个文件/)
  assert.throws(() => assertSeparate(join(WORK, './same.mp4'), input), /同一个文件/)
  assert.doesNotThrow(() => assertSeparate(join(WORK, 'other.mp4'), input))
  assert.doesNotThrow(() => assertSeparate(input, input, true))
})

test('transcodePlan maps streams explicitly and adds the container defaults', () => {
  const plan = transcodePlan({ input: 'in.mkv', out: 'out.mp4' })
  const joined = plan.args.join(' ')
  assert.match(joined, /-map 0:v:0\? -map 0:a:0\?/)
  assert.match(joined, /-c:v libx264/)
  assert.match(joined, /-pix_fmt yuv420p/)
  assert.match(joined, /-c:a aac/)
  assert.match(joined, /-movflags \+faststart/)
  // Every input option precedes every output option.
  assert.ok(plan.args.indexOf('-i') < plan.args.indexOf('-c:v'))
  assert.equal(plan.expect.video, true)
  assert.equal(plan.expect.audio, true)
})

test('transcodePlan honours an explicit codec and refuses a bad crf or preset', () => {
  const plan = transcodePlan({ input: 'in.mp4', out: 'out.mp4', video: { codec: 'libx265', crf: 28, preset: 'slow' }, audio: { codec: 'libopus', bitrate: '96k', channels: 2 } })
  assert.match(plan.args.join(' '), /-c:v libx265 -crf 28 -preset slow/)
  assert.match(plan.args.join(' '), /-c:a libopus -b:a 96k -ac 2/)
  assert.throws(() => transcodePlan({ input: 'a', out: 'b.mp4', video: { crf: 99 } }), /crf 必须在/)
  assert.throws(() => transcodePlan({ input: 'a', out: 'b.mp4', video: { preset: 'turbo' } }), /不是 x264\/x265 的值/)
})

test('videoArguments reports a codec that ignores crf instead of pretending', () => {
  const result = videoArguments({ codec: 'mpeg4', crf: 20 })
  assert.equal(result.notes.length, 1)
  assert.match(result.notes[0], /不认 crf/)
})

test('trimPlan differs between copy and encode in the way the documentation claims', () => {
  // Paths reach ffmpeg absolute (see `longPath`), so the assertions are about argument order rather
  // than about the exact spelling of the path.
  const copy = trimPlan({ input: 'in.mp4', out: 'out.mp4', start: 10, duration: 5, mode: 'copy' })
  assert.match(copy.args.join(' '), /-ss 10 -i .*in\.mp4 -t 5/)
  assert.match(copy.args.join(' '), /-c copy/)
  assert.equal(copy.notes.some((note) => note.includes('关键帧')), true)

  const encode = trimPlan({ input: 'in.mp4', out: 'out.mp4', start: 10, duration: 5, mode: 'encode' })
  assert.match(encode.args.join(' '), /-c:v libx264/)
  assert.equal(encode.notes.some((note) => note.includes('准确')), true)

  assert.throws(() => trimPlan({ input: 'a', out: 'b.mp4', start: 5, duration: 0 }), /裁剪区间为空/)
})

test('framesPlan produces one pass per timestamp and a pattern for a cadence', () => {
  const single = framesPlan({ input: 'in.mp4', outDir: 'out', at: 1.5 })
  assert.equal(single.passes.length, 1)
  assert.match(single.out, /frame_000001500\.jpg$/)

  const several = framesPlan({ input: 'in.mp4', outDir: 'out', times: [0, 2.5, 61] })
  assert.equal(several.passes.length, 3)
  assert.match(several.passes[2].out, /frame_000101000\.jpg$/)

  const cadence = framesPlan({ input: 'in.mp4', outDir: 'out', fps: 2, format: 'png' })
  assert.equal(cadence.pattern.endsWith('frame_%04d.png'), true)
})

test('gifPlan builds the palette inside one filter graph', () => {
  const plan = gifPlan({ input: 'in.mp4', out: 'out.gif', start: 1, duration: 3, fps: 10, width: 480 })
  assert.equal(plan.passes.length, 1)
  const graph = plan.passes[0].args[plan.passes[0].args.indexOf('-vf') + 1]
  assert.match(graph, /palettegen/)
  assert.match(graph, /paletteuse/)
  assert.match(graph, /scale=480:-1/)
  assert.throws(() => gifPlan({ input: 'in.mp4', out: 'out.mp4', duration: 1 }), /只能输出 \.gif/)
})

test('subtitlesPlan escapes the path and picks the right subtitle codec', () => {
  const srt = join(WORK, 'a b.srt')
  writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nhi\n')
  const burn = subtitlesPlan({ input: 'in.mp4', out: 'out.mp4', srt, mode: 'burn' })
  const filter = burn.args[burn.args.indexOf('-vf') + 1]
  assert.match(filter, /subtitles='/)
  assert.equal(filter.includes('\\:'), true)

  const mux = subtitlesPlan({ input: 'in.mp4', out: 'out.mp4', srt, mode: 'mux' })
  assert.match(mux.args.join(' '), /-c:s mov_text/)
  assert.throws(() => subtitlesPlan({ input: 'in.mp4', out: 'out.mp4', srt: 'missing.srt' }), /字幕文件不存在/)
})

test('audioPlan covers all four modes', () => {
  const extract = audioPlan({ input: 'in.mp4', out: 'out.m4a', mode: 'extract' })
  assert.match(extract.args.join(' '), /-vn/)
  assert.equal(extract.expect.video, false)

  const drop = audioPlan({ input: 'in.mp4', out: 'out.mp4', mode: 'drop' })
  assert.match(drop.args.join(' '), /-an/)
  assert.equal(drop.expect.audio, false)

  assert.throws(() => audioPlan({ input: 'in.mp4', out: 'out.mp4', mode: 'replace', audioPath: join(WORK, 'nope.wav') }), /replace 模式需要 audioPath/)

  const twoPass = audioPlan({ input: 'in.mp4', out: 'out.mp4', mode: 'normalize' })
  assert.equal(twoPass.passes.length, 2)
  assert.equal(twoPass.passes[0].measureLoudnorm, true)
})

test('loudnorm measurement parsing and substitution round-trip', () => {
  const stderr = `
[Parsed_loudnorm_0 @ 0x1] 
{
	"input_i" : "-23.42",
	"input_tp" : "-3.11",
	"input_lra" : "5.20",
	"input_thresh" : "-33.50",
	"output_i" : "-16.02",
	"target_offset" : "0.42"
}
`
  const measured = parseLoudnorm(stderr)
  assert.equal(measured.input_i, '-23.42')
  const substituted = substituteLoudnorm(['-af', 'loudnorm=I=-16:measured_I=MEASURED_I:measured_TP=MEASURED_TP:measured_LRA=MEASURED_LRA:measured_thresh=MEASURED_THRESH:offset=MEASURED_OFFSET'], measured)
  assert.match(substituted[1], /measured_I=-23\.42/)
  assert.match(substituted[1], /offset=0\.42/)
  assert.equal(parseLoudnorm('no json here'), null)
})

test('formatTime is the spelling the still file names use', () => {
  assert.equal(formatTime(0), '000000000')
  assert.equal(formatTime(61.5), '000101500')
  assert.equal(formatTime(3661.25), '010101250')
})

// ---------------------------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------------------------

/** A frame of one solid colour, as the analysis would see it. */
function solidFrame(width, height, value) {
  return new Uint8Array(width * height * 3).fill(value)
}

test('frameDifference separates a whole-screen switch from a small change', () => {
  const black = solidFrame(64, 36, 0)
  const white = solidFrame(64, 36, 255)
  const nearlyBlack = solidFrame(64, 36, 4)
  assert.equal(frameDifference(black, black).meanAbsDiff, 0)
  assert.ok(frameDifference(black, white).meanAbsDiff > 200)
  assert.ok(frameDifference(black, nearlyBlack).meanAbsDiff < 5)
  assert.equal(frameDifference(black, white).changedRatio, 1)
})

test('TimelineBuilder cuts on a switch, keeps every closed segment, and merges the short ones', () => {
  const builder = new TimelineBuilder({ sceneThreshold: 8, minSegmentSec: 1, maxSegmentSec: 30, fps: 4 })
  const a = solidFrame(32, 18, 10)
  const b = solidFrame(32, 18, 240)
  // 3 seconds of A, 3 seconds of B at 4 fps.
  for (let index = 0; index < 12; index += 1) builder.push(index / 4, a)
  for (let index = 12; index < 24; index += 1) builder.push(index / 4, b)
  const segments = builder.finish(6)

  assert.equal(segments.length, 2, '切一次就该有两段——闭合的段必须被记下来')
  assert.equal(segments[0].start, 0)
  assert.equal(segments[0].end, 3)
  assert.equal(segments[0].endReason, 'cut')
  assert.equal(segments[1].start, 3)
  assert.equal(segments[1].end, 6)
  assert.equal(segments[1].endReason, 'end')
  assert.equal(segments[0].motion.level, 'static')
  assert.equal(segments[1].motion.level, 'static')
  assert.ok(segments[0].sceneScore > 200, '结束边界的差值')
  assert.ok(segments[1].startScore > 200, '开始边界的差值')
  assert.equal(segments[1].sceneScore, null, '文件结尾没有差值可言')

  const merged = mergeShortSegments(
    [
      { start: 0, end: 2, durationSec: 2, startReason: 'start', endReason: 'cut', sceneScore: 9, motion: { meanAbsDiff: 1, changedRatio: 0.1, maxDiff: 3, level: 'low', samples: 8 } },
      { start: 2, end: 2.4, durationSec: 0.4, startReason: 'cut', endReason: 'cut', sceneScore: 9, motion: { meanAbsDiff: 20, changedRatio: 0.9, maxDiff: 200, level: 'high', samples: 2 } },
      { start: 2.4, end: 5, durationSec: 2.6, startReason: 'cut', endReason: 'end', sceneScore: 9, motion: { meanAbsDiff: 1, changedRatio: 0.1, maxDiff: 3, level: 'low', samples: 10 } },
    ],
    0.7,
  )
  assert.equal(merged.length, 2)
  assert.equal(merged[0].end, 2.4)
  assert.equal(merged[0].mergedCount, 2)
  assert.equal(merged[1].start, 2.4)
})

test('TimelineBuilder forces a cadence break on a long static stretch', () => {
  const builder = new TimelineBuilder({ sceneThreshold: 8, minSegmentSec: 1, maxSegmentSec: 2, fps: 4 })
  const a = solidFrame(16, 9, 100)
  for (let index = 0; index < 16; index += 1) builder.push(index / 4, a)
  const segments = builder.finish(4)
  assert.equal(segments.length, 2)
  assert.equal(segments[0].endReason, 'cadence')
  assert.equal(segments[0].end, 2)
})

test('motionLevel and keyframeTime are stable at the boundaries', () => {
  assert.equal(motionLevel(0), 'static')
  assert.equal(motionLevel(0.5), 'low')
  assert.equal(motionLevel(3), 'moderate')
  assert.equal(motionLevel(10), 'high')
  const segment = { start: 10, end: 14 }
  assert.equal(keyframeTime(segment, 'mid'), 12)
  assert.equal(keyframeTime(segment, 'lead'), 10.5)
  assert.equal(keyframeTime(segment, 'last'), 13.75)
  // A very short segment still yields a time inside itself.
  const tiny = { start: 2, end: 2.1 }
  for (const strategy of ['mid', 'lead', 'last']) {
    const at = keyframeTime(tiny, strategy)
    assert.ok(at >= tiny.start && at <= tiny.end, `${strategy} produced ${at}`)
  }
})

// ---------------------------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------------------------

test('tileStats measures a flat tile and a busy tile differently', () => {
  const width = 32
  const height = 16
  const data = new Uint8Array(width * height * 3)
  // Left half: flat grey. Right half: a 1-pixel checkerboard.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      const value = x < width / 2 ? 128 : (x + y) % 2 === 0 ? 255 : 0
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
    }
  }
  const grid = tileStats(data, width, height, 8)
  const flat = grid.tiles.find((tile) => tile.x === 0)
  const busy = grid.tiles.find((tile) => tile.x === 16)
  assert.equal(flat.lumaStd, 0)
  assert.equal(flat.edgeDensity, 0)
  assert.ok(busy.edgeDensity > 0.5)
  assert.equal(classifyTile(flat).label, 'flat')
  assert.equal(classifyTile(busy).label, 'text')
})

test('segmentFrame produces disjoint rectangles whose areas fill the frame', () => {
  const width = 64
  const height = 32
  const data = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      // Top half dark and flat, bottom half light and flat: two rectangles, no overlap.
      const value = y < height / 2 ? 20 : 200
      data[offset] = value
      data[offset + 1] = value
      data[offset + 2] = value
    }
  }
  const result = segmentFrame(data, width, height, { tileSize: 8 })
  assert.equal(result.regions.length, 2)
  const total = Object.values(result.labelShares).reduce((sum, share) => sum + share, 0)
  assert.ok(Math.abs(total - 1) < 0.02, `label shares sum to ${total}`)
  assert.equal(result.labelShares.dark > 0.4, true)
  assert.equal(result.labelShares.flat > 0.4, true)
  // Every rectangle stays inside the frame.
  for (const region of result.regions) {
    assert.ok(region.x >= 0 && region.y >= 0)
    assert.ok(region.x + region.width <= width)
    assert.ok(region.y + region.height <= height)
  }
})

test('mergeRegions never lets two rectangles share a tile', () => {
  const grid = { cols: 4, rows: 3, tileSize: 8 }
  const tiles = []
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      tiles.push({ col, row, x: col * 8, y: row * 8, width: 8, height: 8, label: 'flat', score: 1 })
    }
  }
  const regions = mergeRegions(tiles, grid, 32, 24)
  assert.equal(regions.length, 1)
  assert.equal(regions[0].width, 32)
  assert.equal(regions[0].height, 24)
})

test('dominantColors reports the colours that are actually there', () => {
  const data = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255])
  const colors = dominantColors(data, { maxColors: 2 })
  assert.equal(colors.length, 2)
  assert.equal(colors[0].hex, '#ff0000')
  assert.equal(colors[0].share, 0.5)
})

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

test('isCjk covers the ranges this plugin claims and nothing else', () => {
  assert.equal(isCjk('中'), true)
  assert.equal(isCjk('あ'), true)
  assert.equal(isCjk('한'), true)
  assert.equal(isCjk('A'), false)
  assert.equal(isCjk('1'), false)
})

test('extractKeywords keeps the longest spelling of a repeated term', () => {
  const documents = [
    { text: '语义分割 语义分割 语义分割', index: 0, at: 0 },
    { text: 'ffmpeg 语义分割 and the ffmpeg tool', index: 1, at: 2 },
    { text: 'the ffmpeg tool again', index: 2, at: 4 },
  ]
  const keywords = extractKeywords(documents, { maxKeywords: 10, minCount: 1 })
  const terms = keywords.map((entry) => entry.term)
  assert.ok(terms.includes('语义分割'), `expected 语义分割 in ${terms.join(', ')}`)
  assert.equal(terms.includes('语义'), false, '被更长的同频词吸收')
  const ffmpeg = keywords.find((entry) => entry.term === 'ffmpeg')
  assert.equal(ffmpeg.count, 3)
  assert.deepEqual(ffmpeg.segments, [1, 2])
  assert.equal(ffmpeg.firstAt, 2)
  assert.equal(terms.includes('the'), false, '停用词不进结果')
})

test('collapsePrefixes drops a fragment only when a longer term is at least as frequent', () => {
  const counts = new Map([
    ['语义', 4],
    ['语义分割', 4],
    ['分割', 5],
  ])
  const reduced = collapsePrefixes(counts)
  assert.equal(reduced.has('语义'), false)
  assert.equal(reduced.get('语义分割'), 4)
  // `分割` occurs more often than the longer term that contains it, so it survives on its own.
  assert.equal(reduced.get('分割'), 5)
})

// ---------------------------------------------------------------------------------------------
// Probe and capability parsers
// ---------------------------------------------------------------------------------------------

test('parseRational reads ffprobe frame rates, including the ones that mean "unknown"', () => {
  assert.equal(parseRational('30000/1001'), 30000 / 1001)
  assert.equal(parseRational('25/1'), 25)
  assert.equal(parseRational('25'), 25)
  assert.equal(parseRational('0/0'), null)
  assert.equal(parseRational('0/1'), null)
  assert.equal(parseRational(undefined), null)
})

test('rotationOf reads both the side data and the legacy tag', () => {
  assert.equal(rotationOf({ side_data_list: [{ rotation: -90 }] }), 270)
  assert.equal(rotationOf({ tags: { rotate: '90' } }), 90)
  assert.equal(rotationOf({}), 0)
})

test('classify names the kind of a file from its own facts', () => {
  assert.equal(classify({ video: { frames: 1 }, audio: null, formatName: 'png_pipe', durationSec: null }), 'image')
  assert.equal(classify({ video: null, audio: { codec: 'aac' }, formatName: 'mp4', durationSec: 3 }), 'audio')
  assert.equal(classify({ video: { frames: 300 }, audio: null, formatName: 'mov,mp4', durationSec: 10 }), 'video')
  assert.equal(classify({ video: { frames: null }, audio: null, formatName: 'matroska', durationSec: null }), 'unknown')
})

test('the capability parsers read ffmpeg list output', () => {
  // The flag column is six characters wide for encoders, three for muxers, two for devices, and two
  // for filters in ffmpeg 9 even though its own header still shows three — which is why the parser
  // reads the row instead of assuming a width.
  const encoders = `
Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC (codec h264)
 A....D aac                  AAC (Advanced Audio Coding)
`
  assert.deepEqual(parseListNames(encoders), ['libx264', 'aac'])

  const filters = `
Filters:
  T.. = Timeline support
  .S. = Slice threading
  ------
 TS aap               AA->A      Apply Affine Projection algorithm.
 .. abench            A->A       Benchmark part of a filtergraph.
 ... scale            V->V       Scale the input video size and/or convert the image format.
`
  const filterNames = parseListNames(filters)
  assert.deepEqual(filterNames, ['aap', 'abench', 'scale'])
  assert.equal(filterNames.includes('T..'), false, '表头不能被当成滤镜名')

  const muxers = `
Formats:
 D.. = Demuxing supported
 .E. = Muxing supported
 ------
  E  mp4             MP4 (MPEG-4 Part 14)
`
  assert.deepEqual(parseListNames(muxers), ['mp4'])

  const devices = `
Devices:
 D. = Demuxing supported
 .E = Muxing supported
 ---
 D  dshow           DirectShow capture
 DE gdigrab         GDI API Windows frame grabber
`
  const parsed = parseDevices(devices)
  assert.deepEqual(parsed.demuxers, ['dshow', 'gdigrab'])
  assert.deepEqual(parsed.muxers, [])

  assert.deepEqual(parseHwaccels('Hardware acceleration methods:\ncuda\nd3d11va\n'), ['cuda', 'd3d11va'])

  const dshow = `
[dshow @ 0x1] "HD Webcam" (video)
[dshow @ 0x1]   Alternative name "@device_pnp_..."
[dshow @ 0x1] "Microphone (Realtek(R) Audio)" (audio)
`
  assert.deepEqual(parseDshowDevices(dshow), { video: ['HD Webcam'], audio: ['Microphone (Realtek(R) Audio)'] })
})

test('checkNeeds separates a missing encoder from a missing accelerator', () => {
  const report = { encoders: { libx264: true, aac: true }, filters: { scale: true, subtitles: false }, capture: { gdigrab: true }, hwaccels: ['d3d11va'] }
  const ok = checkNeeds(report, { encoders: ['libx264'], filters: ['scale'], capture: 'gdigrab', hwaccel: 'cuda' })
  assert.equal(ok.ok, true)
  assert.equal(ok.degraded.length, 1)
  assert.match(ok.degraded[0], /cuda/)

  const bad = checkNeeds(report, { filters: ['subtitles'], capture: 'dshow' })
  assert.equal(bad.ok, false)
  assert.equal(bad.missing.length, 2)
})

// ---------------------------------------------------------------------------------------------
// Archive handling
// ---------------------------------------------------------------------------------------------

/**
 * Build a small zip in memory.
 *
 * Only the parts this plugin's extractor reads are written: a local header, the data, a central
 * directory entry and the end record. The CRC field is left at zero because the extractor verifies
 * the uncompressed size instead — a real archive from a release has a real CRC and this field is
 * never consulted.
 *
 * @param {{name: string, data: Buffer, method?: number, declaredSize?: number}[]} entries - what to store.
 * @returns {Buffer} the archive.
 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(entry.data) : entry.data
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14) // crc
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.declaredSize ?? entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, payload)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(0, 16) // crc
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.declaredSize ?? entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + payload.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

test('extractBinaries takes only the wanted names and refuses an unsafe path', async () => {
  const directory = join(WORK, 'zip')
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })

  const good = join(directory, 'good.zip')
  writeFileSync(
    good,
    buildZip([
      { name: 'ffmpeg-9.0.2/bin/ffmpeg.exe', data: Buffer.from('MZ fake ffmpeg') },
      { name: 'ffmpeg-9.0.2/bin/ffprobe.exe', data: Buffer.from('MZ fake ffprobe'), method: 8 },
      { name: 'ffmpeg-9.0.2/doc/readme.txt', data: Buffer.from('not a binary') },
    ]),
  )
  const written = await extractBinaries(good, join(directory, 'bin'))
  assert.deepEqual(written.sort(), ['ffmpeg.exe', 'ffprobe.exe'])

  const traversal = join(directory, 'traversal.zip')
  writeFileSync(traversal, buildZip([{ name: '../escape/ffmpeg.exe', data: Buffer.from('MZ') }]))
  await assert.rejects(() => extractBinaries(traversal, join(directory, 'bin2')), /路径不可信/)

  const wrongSize = join(directory, 'wrong-size.zip')
  writeFileSync(wrongSize, buildZip([{ name: 'a/ffmpeg.exe', data: Buffer.from('MZ'), declaredSize: 999 }]))
  await assert.rejects(() => extractBinaries(wrongSize, join(directory, 'bin3')), /解压后大小不符/)

  const empty = join(directory, 'empty.zip')
  writeFileSync(empty, buildZip([{ name: 'a/readme.txt', data: Buffer.from('nothing') }]))
  await assert.rejects(() => extractBinaries(empty, join(directory, 'bin4')), /没有 ffmpeg\.exe/)

  const unsupported = join(directory, 'method.zip')
  writeFileSync(unsupported, buildZip([{ name: 'a/ffmpeg.exe', data: Buffer.from('MZ'), method: 12 }]))
  await assert.rejects(() => extractBinaries(unsupported, join(directory, 'bin5')), /不支持的压缩方式/)
})

test('findEndOfCentralDirectory finds the record or reports none', () => {
  const zip = buildZip([{ name: 'a/ffmpeg.exe', data: Buffer.from('x') }])
  const record = findEndOfCentralDirectory(zip)
  assert.equal(record.entryCount, 1)
  assert.equal(findEndOfCentralDirectory(Buffer.from('not a zip at all')), null)
})

// ---------------------------------------------------------------------------------------------
// Running raw arguments
// ---------------------------------------------------------------------------------------------

test('inspectArgs finds the inputs, the output, the codecs and the filters', () => {
  const reading = inspectArgs(['-i', 'in.mp4', '-vf', 'scale=640:-2,fps=25', '-c:v', 'libx264', '-c:a', 'aac', '-y', 'out.mp4'])
  assert.deepEqual(reading.inputs, ['in.mp4'])
  assert.equal(reading.output, 'out.mp4')
  assert.deepEqual(reading.codecs, ['libx264', 'aac'])
  assert.deepEqual(reading.filters, ['scale', 'fps'])
  assert.deepEqual(reading.removed, ['-y'])
  assert.deepEqual(reading.warnings, [])
})

test('inspectArgs still finds the output when a standalone flag precedes it', () => {
  const reading = inspectArgs(['-i', 'in.mp4', '-c:v', 'copy', '-an', 'out.mp4'])
  assert.equal(reading.output, 'out.mp4')
})

test('inspectArgs warns about the shapes that usually mean a mistake', () => {
  assert.equal(inspectArgs(['-f', 'lavfi', '-i', 'testsrc']).warnings.some((line) => line.includes('输出文件')), true)
  assert.equal(inspectArgs(['in.mp4']).warnings.some((line) => line.includes('没有 -i')), true)
  assert.equal(inspectArgs(['-i', 'in.mp4', 'out']).warnings.some((line) => line.includes('扩展名')), true)
})

test('filterNames reads a filter graph, including one with labels', () => {
  assert.deepEqual(filterNames('scale=640:-2,fps=25'), ['scale', 'fps'])
  assert.deepEqual(filterNames('[0:v]trim=0:5,setpts=PTS-STARTPTS[a];[a]scale=320:-2[b]'), ['trim', 'setpts', 'scale'])
})

test('parseProgress reads ffmpeg progress blocks and treats out_time_ms as microseconds', () => {
  const block = parseProgress('frame=120\nfps=25.0\nout_time_ms=4800000\nout_time_us=4800000\ntotal_size=2048\nspeed=1.5x\nprogress=continue\n')
  assert.equal(block.frame, 120)
  assert.equal(block.outTimeSec, 4.8)
  assert.equal(block.done, false)
  assert.equal(parseProgress('nothing here'), null)
})

// ---------------------------------------------------------------------------------------------
// Recording plans
// ---------------------------------------------------------------------------------------------

test('screenPlan captures a fixed length with the queue raised, and refuses nonsense', () => {
  const plan = screenPlan({ out: 'rec.mp4', seconds: 30, fps: 15, audioDevice: 'Microphone (Realtek(R) Audio)' })
  const joined = plan.args.join(' ')
  assert.match(joined, /-f gdigrab -framerate 15 -draw_mouse 1 -i desktop/)
  assert.match(joined, /-rtbufsize 128M -f dshow -i audio=Microphone \(Realtek\(R\) Audio\)/)
  assert.match(joined, /-t 30/)
  assert.equal(plan.expectedDurationSec, 30)
  assert.ok(plan.timeoutMs > 30_000)

  assert.throws(() => screenPlan({ out: 'rec.mp4', seconds: 0 }), /正数的秒数/)
  assert.throws(() => screenPlan({ out: 'rec.mp4', seconds: 7200 }), /最多录 3600 秒/)
  assert.throws(() => screenPlan({ out: 'rec.mp4', seconds: 5, window: 'Notepad', region: { width: 10, height: 10 } }), /只能选一个/)
  assert.throws(() => recordAudioPlan({ out: 'a.wav', seconds: 5 }), /需要 device/)
})

test('escapeOptionValue escapes what ffmpeg\u2019s own parser treats specially', () => {
  // A Windows drive letter inside a gdigrab title or a dshow device name is the real case: the
  // colon ends the option value unless it is escaped, and the apostrophe ends the quoting.
  assert.equal(escapeOptionValue('C:\\a:b'), 'C\\:\\\\a\\:b')
  assert.equal(escapeOptionValue("it's"), "it\\'s")
})

// ---------------------------------------------------------------------------------------------
// Semantic rules
// ---------------------------------------------------------------------------------------------

test('describeSegmentKind follows the published rule table', () => {
  const cases = [
    [{ motion: { level: 'static' }, labelShares: { text: 0.3 }, lineCount: 12 }, 'document'],
    [{ motion: { level: 'static' }, labelShares: { picture: 0.6 }, lineCount: 0 }, 'still_image'],
    [{ motion: { level: 'static' }, labelShares: { flat: 1 }, lineCount: 0 }, 'idle'],
    [{ motion: { level: 'low' }, labelShares: { text: 0.1 }, lineCount: 3 }, 'typing'],
    [{ motion: { level: 'moderate' }, labelShares: { text: 0.2 }, lineCount: 5 }, 'scrolling'],
    [{ motion: { level: 'high' }, labelShares: { picture: 0.5 }, lineCount: 0 }, 'video_playback'],
    [{ motion: { level: 'high' }, labelShares: { texture: 0.5 }, lineCount: 0 }, 'animation'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(describeSegmentKind(input).kind, expected, JSON.stringify(input))
  }
  const described = describeSegmentKind({ motion: { level: 'static', meanAbsDiff: 0 }, labelShares: { text: 0.3 }, lineCount: 4 })
  assert.equal(typeof described.evidence.rule, 'string')
  assert.equal(described.evidence.lineCount, 4)
})

test('normalizeOptions refuses values that would make the output meaningless', () => {
  assert.equal(normalizeOptions({}).fps, 4)
  assert.throws(() => normalizeOptions({ fps: 0 }), /fps 必须在/)
  assert.throws(() => normalizeOptions({ segmentation: 'magic' }), /segmentation 只能是/)
  assert.throws(() => normalizeOptions({ keyframeStrategy: 'first' }), /keyframeStrategy 只能是/)
  assert.throws(() => normalizeOptions({ output: 'stream' }), /output 只能是/)
  assert.throws(() => normalizeOptions({ minSegmentSec: 10, maxSegmentSec: 5 }), /maxSegmentSec 必须在/)
})

test('every plan that names an output ends its argument list with that output', () => {
  // ffmpeg 9 rejects "trailing options" after the output file, and a plan whose arguments simply stop
  // one token early produces an empty file plus that message. The invariant is asserted here so a
  // builder that forgets cannot reach a user.
  const plans = [    transcodePlan({ input: 'in.mp4', out: 'out.mp4' }),
    trimPlan({ input: 'in.mp4', out: 'out.mp4', start: 1, duration: 2 }),
    audioPlan({ input: 'in.mp4', out: 'out.m4a', mode: 'extract' }),
    audioPlan({ input: 'in.mp4', out: 'out.mp4', mode: 'drop' }),
    subtitlesPlan({ input: 'in.mp4', out: 'out.mp4', srt: join(WORK, 'a b.srt'), mode: 'mux' }),
    gifPlan({ input: 'in.mp4', out: 'out.gif', duration: 2 }),
    framesPlan({ input: 'in.mp4', outDir: WORK, at: 1 }),
  ]
  for (const plan of plans) {
    const list = plan.args ?? plan.passes[plan.passes.length - 1].args
    assert.equal(list[list.length - 1], longPath(plan.out), `${plan.out} 不在参数末尾`)
  }
  // A cadence extraction ends with its numbered pattern instead of a single file.
  const cadence = framesPlan({ input: 'in.mp4', outDir: WORK, fps: 1 })
  assert.match(cadence.pattern, /%04d/)
  assert.equal(cadence.passes[0].args[cadence.passes[0].args.length - 1], longPath(cadence.pattern))
})

test('concatCanvas takes the first clip as the canvas and names the ones that differ', () => {
  const facts = [
    { video: { width: 640, height: 360, fps: 25 }, audio: { sampleRate: 44100, channels: 1 } },
    { video: { width: 320, height: 240, fps: 25 }, audio: { sampleRate: 44100, channels: 1 } },
  ]
  const canvas = concatCanvas(facts)
  assert.deepEqual([canvas.width, canvas.height, canvas.fps], [640, 360, 25])
  assert.deepEqual(canvas.mismatched, [1])

  const forced = concatCanvas(facts, '1280x720')
  assert.deepEqual([forced.width, forced.height], [1280, 720])
  assert.deepEqual(forced.mismatched, [0, 1])

  const same = concatCanvas([facts[0], facts[0]])
  assert.deepEqual(same.mismatched, [])
})

test('canRemuxToMp4 and the encode fallback agree about codecs', () => {
  assert.equal(canRemuxToMp4({ video: { codec: 'h264' }, audio: { codec: 'aac' } }).ok, true)
  assert.equal(canRemuxToMp4({ video: { codec: 'h264' }, audio: { codec: 'vorbis' } }).ok, false)
  assert.equal(canRemuxToMp4({ video: { codec: 'theora' }, audio: null }).ok, false)
})

test('summarizeKinds totals each kind and shares the time', () => {
  const summary = summarizeKinds([
    { kind: 'document', durationSec: 3 },
    { kind: 'document', durationSec: 1 },
    { kind: 'idle', durationSec: 4 },
  ])
  assert.equal(summary[0].kind, 'document')
  assert.equal(summary[0].segments, 2)
  assert.equal(summary[0].totalSec, 4)
  assert.equal(summary[0].share, 0.5)
})

test('writeChapters writes ffmetadata that ffmpeg can read', () => {
  const path = join(WORK, 'chapters.txt')
  const structure = {
    segments: [
      { start: 0, end: 3.2, kind: 'document', text: { reading: '第一行\n第二行' } },
      { start: 3.2, end: 12, kind: 'typing', text: null },
    ],
  }
  writeChapters(structure, path)
  const body = readFileSync(path, 'utf8')
  assert.match(body, /^;FFMETADATA1/)
  assert.match(body, /\[CHAPTER\]\nTIMEBASE=1\/1000\nSTART=0\nEND=3200\ntitle=00:00 document · 第一行/)
  assert.match(body, /START=3200\nEND=12000\ntitle=00:03 typing/)
})

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

test('toLosslessJson makes a result survive the JSON boundary', () => {
  const input = {
    present: 1,
    missing: undefined,
    notANumber: Number.NaN,
    infinite: Number.POSITIVE_INFINITY,
    negativeZero: -0,
    nested: { list: [1, undefined, Number.NaN], deep: { gone: undefined } },
    date: new Date('2026-01-02T03:04:05Z'),
    keep: 'text',
  }
  const safe = toLosslessJson(input)
  assert.deepEqual(JSON.parse(JSON.stringify(safe)), safe, '往返必须一模一样')
  assert.equal(safe.missing, null)
  assert.equal(safe.notANumber, null)
  assert.equal(safe.infinite, null)
  assert.equal(Object.is(safe.negativeZero, 0), true)
  assert.deepEqual(safe.nested.list, [1, null, null])
  assert.equal(safe.nested.deep.gone, null)
  assert.equal(safe.date, '2026-01-02T03:04:05.000Z')

  // A non-plain object is deliberately passed through rather than rewritten, so a handler that
  // returns one fails loudly instead of having its shape quietly changed.
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(toLosslessJson(bytes), bytes)
})

test('normalizeConfig fills every default and rejects impossible values', () => {
  const config = normalizeConfig()
  assert.equal(config.maxConcurrent, 2)
  assert.equal(config.ocrProvider, 'auto')
  assert.equal(config.ocrLanguage, 'ch')
  assert.equal(config.analysis.sceneThreshold, 8)
  assert.equal(config.ffmpegPath, null)

  assert.throws(() => normalizeConfig({ maxConcurrent: 99 }), /maxConcurrent/)
  assert.throws(() => normalizeConfig({ maxConcurrent: 'two' }), /must be a positive number/)
  assert.throws(() => normalizeConfig({ ocr: { provider: 'cloud' } }), /config.ocr.provider/)
  assert.throws(() => normalizeConfig({ ffmpegPath: 42 }), /must be a string or null/)
})
