/**
 * What this build of ffmpeg can actually do, and whether a request needs something it lacks.
 *
 * The point of this module is to move a class of failure earlier. "Unknown encoder 'libx264'" and
 * "No such filter: subtitles" arrive from ffmpeg *after* a long decode has already happened, and
 * they arrive as stderr rather than as an answer to "can this machine do it". Asking once, up
 * front, and caching the answer per binary turns that into a sentence before any work starts.
 *
 * Everything here runs short, read-only ffmpeg commands outside the encode queue, and every parse
 * is a pure function so it can be tested against captured output.
 *
 * @module dsh-ffmpeg/core/caps
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { requireTool, resolveTool, versionOf } from './env.mjs'

const run = promisify(execFile)

/** Encoders worth knowing about before a request is attempted. */
export const WATCHED_ENCODERS = [
  'libx264',
  'libx265',
  'libvpx-vp9',
  'libsvtav1',
  'h264_nvenc',
  'hevc_nvenc',
  'av1_nvenc',
  'h264_qsv',
  'hevc_qsv',
  'h264_amf',
  'hevc_amf',
  'mjpeg',
  'png',
  'gif',
  'aac',
  'libmp3lame',
  'libopus',
  'pcm_s16le',
  'flac',
]

/** Filters worth knowing about before a request is attempted. */
export const WATCHED_FILTERS = [
  'scale',
  'fps',
  'select',
  'trim',
  'concat',
  'metadata',
  'tile',
  'palettegen',
  'paletteuse',
  'subtitles',
  'ass',
  'drawtext',
  'loudnorm',
  'crop',
  'pad',
  'setpts',
  'atempo',
  'amix',
  'volume',
  'sidechaincompress',
  'silencedetect',
  'blackdetect',
  'freezedetect',
]

/** Software encoders this plugin assumes are present in any full build. */
const SOFT_VIDEO = ['libx264']
const SOFT_AUDIO = ['aac']

/**
 * Parse the name column out of an ffmpeg list command.
 *
 * The flag column's width is *not* stable across builds and commands: `-encoders` uses six
 * characters, `-muxers` three, `-devices` two, and ffmpeg 9's `-filters` prints only `TS`/`..` in a
 * two-wide field while its own header still shows `T..`. Assuming a width is therefore a bug that
 * appears as "this build is missing the scale filter". The parse looks at the row instead: a first
 * token made only of capital letters and dots is a flag column, and the name is the token after it.
 *
 * @param {string} text - the command's output.
 * @returns {string[]} the names, in output order.
 */
export function parseListNames(text) {
  const names = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    // Section headers (`Encoders:`), legend lines (` V..... = Video`) and the `------` rule.
    if (line === '' || line.startsWith('-') || line.includes('=') || line.endsWith(':')) continue
    const tokens = line.split(/\s+/)
    if (tokens.length < 2) continue
    const first = tokens[0]
    const isFlagColumn = /^[A-Z.]{1,6}$/.test(first)
    names.push(isFlagColumn ? tokens[1] : first)
  }
  return names
}

/**
 * Parse `-devices` output into the demuxers and muxers it lists.
 *
 * @param {string} text - the output.
 * @returns {{demuxers: string[], muxers: string[]}} the two lists.
 */
export function parseDevices(text) {
  const demuxers = []
  const muxers = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.includes('=')) continue
    const match = /^\s*([DE.])[E.]?\s+(\S+)/.exec(line)
    if (match === null) continue
    if (match[1] === 'D') demuxers.push(match[2])
    else if (match[1] === 'E') muxers.push(match[2])
  }
  return { demuxers, muxers }
}

/**
 * Parse `-hwaccels` output.
 * @param {string} text - the output.
 * @returns {string[]} the accelerator names.
 */
export function parseHwaccels(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes(':') && !line.includes('='))
}

/** Cache of capability reports, keyed by the executable that answered. */
const cache = new Map()

/**
 * Ask a build what it has, once per process.
 *
 * @param {object} [config] - normalized plugin config.
 * @param {object} [options] - `{ refresh }`.
 * @returns {Promise<object>} the capability report.
 * @throws {import('./env.mjs').FfmpegNotFound} when there is no ffmpeg to ask.
 */
export async function capabilities(config = {}, options = {}) {
  const binary = requireTool('ffmpeg', config)
  const key = binary.path
  if (options.refresh !== true && cache.has(key)) return cache.get(key)

  const ask = async (args) => {
    try {
      const { stdout, stderr } = await run(binary.path, args, { timeout: 30_000, windowsHide: true, maxBuffer: 16 << 20 })
      return `${stdout}${stderr}`
    } catch (error) {
      // `-list_devices` on some builds exits non-zero on purpose; the text is still the answer.
      const text = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
      if (text.trim() !== '') return text
      return ''
    }
  }

  const [version, encodersText, filtersText, hwaccelsText, devicesText, muxersText] = await Promise.all([
    versionOf(binary.path),
    ask(['-hide_banner', '-encoders']),
    ask(['-hide_banner', '-filters']),
    ask(['-hide_banner', '-hwaccels']),
    ask(['-hide_banner', '-devices']),
    ask(['-hide_banner', '-muxers']),
  ])

  const encoders = parseListNames(encodersText)
  const filters = parseListNames(filtersText)
  const devices = parseDevices(devicesText)
  const encoderSet = new Set(encoders)
  const filterSet = new Set(filters)

  const report = {
    ffmpeg: { path: binary.path, source: binary.source, label: binary.label, version },
    counts: {
      encoders: encoders.length,
      filters: filters.length,
      muxers: parseListNames(muxersText).length,
      demuxers: devices.demuxers.length,
    },
    encoders: Object.fromEntries(WATCHED_ENCODERS.map((name) => [name, encoderSet.has(name)])),
    filters: Object.fromEntries(WATCHED_FILTERS.map((name) => [name, filterSet.has(name)])),
    hwaccels: parseHwaccels(hwaccelsText),
    devices,
    capture: {
      gdigrab: devices.demuxers.includes('gdigrab'),
      dshow: devices.demuxers.includes('dshow'),
      lavfi: devices.demuxers.includes('lavfi'),
    },
  }
  cache.set(key, report)
  return report
}

/** Forget the capability cache. For tests, and after installing a different build. @returns {void} */
export function resetCapabilityCache() {
  cache.clear()
}

/**
 * Turn a requirement list into a verdict against a capability report.
 *
 * Missing **encoders** and **filters** are fatal; a missing hardware accelerator is not, because
 * every action that offers one also offers a software fallback. The distinction is the whole
 * reason this returns `missing` and `degraded` separately.
 *
 * @param {object} report - a report from {@link capabilities}.
 * @param {{encoders?: string[], filters?: string[], hwaccel?: string, capture?: string}} needs - what the action needs.
 * @returns {{ok: boolean, missing: string[], degraded: string[], notes: string[]}} the verdict.
 */
export function checkNeeds(report, needs = {}) {
  const missing = []
  const degraded = []
  const notes = []

  for (const name of needs.encoders ?? []) {
    if (report.encoders[name] !== true) missing.push(`编码器 ${name}`)
  }
  for (const name of needs.filters ?? []) {
    if (report.filters[name] !== true) missing.push(`滤镜 ${name}`)
  }
  if (typeof needs.capture === 'string' && report.capture[needs.capture] !== true) {
    missing.push(`采集设备 ${needs.capture}（本机这份构建不支持）`)
  }
  if (typeof needs.hwaccel === 'string') {
    if (!report.hwaccels.includes(needs.hwaccel)) {
      degraded.push(`硬件加速 ${needs.hwaccel} 不可用，会退回软件编码`)
    }
  }
  for (const name of SOFT_VIDEO) if (report.encoders[name] !== true) notes.push(`缺少 ${name}：软件编码 H.264 会失败`)
  for (const name of SOFT_AUDIO) if (report.encoders[name] !== true) notes.push(`缺少 ${name}：AAC 音频会失败`)

  return { ok: missing.length === 0, missing, degraded, notes }
}

/**
 * Which video encoders are usable on this machine, in the order a caller should try them.
 *
 * @param {object} report - a report from {@link capabilities}.
 * @returns {{hardware: string[], software: string[], preferred: string}} what can encode H.264.
 */
export function videoEncoderOptions(report) {
  const hardware = []
  if (report.encoders.h264_nvenc === true && report.hwaccels.includes('cuda')) hardware.push('h264_nvenc')
  if (report.encoders.h264_qsv === true && report.hwaccels.includes('qsv')) hardware.push('h264_qsv')
  if (report.encoders.h264_amf === true && report.hwaccels.includes('d3d11va')) hardware.push('h264_amf')
  const software = report.encoders.libx264 === true ? ['libx264'] : []
  return { hardware, software, preferred: software[0] ?? hardware[0] ?? 'mpeg4' }
}

/**
 * List the DirectShow capture devices ffmpeg can see.
 *
 * The device names come back in ffmpeg's stderr, and ffmpeg exits non-zero on purpose, so this
 * cannot be treated as a failure. The names are exactly what `record.audio` needs, which is why
 * this is reported verbatim rather than normalized.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{available: boolean, video: string[], audio: string[], error: string|null, note: string}>} the devices.
 */
export async function listCaptureDevices(config = {}) {
  const binary = resolveTool('ffmpeg', config)
  if (binary === null) requireTool('ffmpeg', config)
  try {
    const { stdout, stderr } = await run(binary.path, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 8 << 20,
    }).catch((error) => ({ stdout: error?.stdout ?? '', stderr: error?.stderr ?? String(error?.message ?? '') }))
    const text = `${stdout}${stderr}`
    return { available: true, ...parseDshowDevices(text), error: null, note: '这些名字可以直接传给 ffmpeg_record {action:"audio", device:"…"}。' }
  } catch (error) {
    return { available: false, video: [], audio: [], error: error instanceof Error ? error.message : String(error), note: '没能列出 DirectShow 设备。' }
  }
}

/**
 * Parse `-list_devices` output.
 *
 * The lines look like `[dshow @ …] "Microphone (Realtek Audio)" (audio)`, and the distinction
 * between an input and an output device is the trailing marker, not the position.
 *
 * @param {string} text - ffmpeg's combined output.
 * @returns {{video: string[], audio: string[]}} the device names.
 */
export function parseDshowDevices(text) {
  const video = []
  const audio = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /"([^"]+)"\s*\((video|audio)\)/.exec(line)
    if (match === null) continue
    const [, name, kind] = match
    if (kind === 'video' && !video.includes(name)) video.push(name)
    if (kind === 'audio' && !audio.includes(name)) audio.push(name)
  }
  return { video, audio }
}
