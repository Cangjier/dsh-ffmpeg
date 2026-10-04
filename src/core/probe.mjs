/**
 * What a media file is, and whether it is intact.
 *
 * ffprobe's JSON is complete and unpleasant: durations arrive as strings, frame rates as `30000/1001`,
 * rotation hides in stream side data, and a still image has no duration at all. Every consumer in
 * this plugin wants the same six facts, so they are normalized exactly once, here, and the raw
 * document is kept beside them for the cases where the answer is unusual.
 *
 * Integrity is the second half: a decode pass that reports what the decoder actually managed to
 * read, rather than what the header promised. A file can declare ten minutes and contain four.
 *
 * @module dsh-ffmpeg/core/probe
 */
import { existsSync, statSync } from 'node:fs'
import { run, runProbe } from './ffmpeg.mjs'

/** Raised when a file cannot be probed at all. */
export class ProbeError extends Error {
  /**
   * @param {string} message - what could not be read.
   */
  constructor(message) {
    super(message)
    this.name = 'ProbeError'
  }
}

/**
 * Turn ffprobe's rational spelling of a frame rate into a number.
 *
 * @param {string|undefined} value - for example `30000/1001`.
 * @returns {number|null} frames per second, or null when it is unknown or nonsensical.
 */
export function parseRational(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  const [numerator, denominator] = value.split('/').map((part) => Number(part))
  if (!Number.isFinite(numerator)) return null
  if (denominator === undefined) return numerator === 0 ? null : numerator
  if (!Number.isFinite(denominator) || denominator === 0) return null
  const result = numerator / denominator
  return result === 0 ? null : result
}

/**
 * Read the rotation ffprobe recorded for a video stream, in degrees clockwise.
 *
 * The value lives in the stream's `side_data_list` on modern builds and in the `rotate` tag on old
 * ones; ffmpeg itself applies it while decoding, so a caller that computes output dimensions
 * without it will scale a portrait video as if it were landscape.
 *
 * @param {object} stream - one ffprobe stream.
 * @returns {number} 0, 90, 180 or 270.
 */
export function rotationOf(stream) {
  const side = Array.isArray(stream?.side_data_list) ? stream.side_data_list : []
  for (const entry of side) {
    if (typeof entry?.rotation === 'number') return ((Math.round(entry.rotation) % 360) + 360) % 360
  }
  const tag = Number(stream?.tags?.rotate)
  if (Number.isFinite(tag)) return ((Math.round(tag) % 360) + 360) % 360
  return 0
}

/**
 * Normalize one ffprobe stream.
 * @param {object} stream - a stream from `-show_streams`.
 * @returns {object} the same stream, flattened.
 */
function normalizeStream(stream) {
  const type = stream.codec_type
  const rotation = type === 'video' ? rotationOf(stream) : 0
  const width = Number(stream.width) || null
  const height = Number(stream.height) || null
  const rotated = rotation === 90 || rotation === 270
  return {
    index: stream.index,
    type,
    codec: stream.codec_name ?? null,
    codecLong: stream.codec_long_name ?? null,
    profile: stream.profile ?? null,
    width,
    height,
    displayWidth: rotated ? height : width,
    displayHeight: rotated ? width : height,
    rotation,
    fps: parseRational(stream.avg_frame_rate) ?? parseRational(stream.r_frame_rate),
    declaredFps: parseRational(stream.r_frame_rate),
    pixFmt: stream.pix_fmt ?? null,
    sampleRate: stream.sample_rate === undefined ? null : Number(stream.sample_rate),
    channels: stream.channels ?? null,
    channelLayout: stream.channel_layout ?? null,
    bitRate: stream.bit_rate === undefined ? null : Number(stream.bit_rate),
    durationSec: Number(stream.duration) || null,
    frames: stream.nb_frames === undefined ? null : Number(stream.nb_frames),
    language: stream.tags?.language ?? null,
    title: stream.tags?.title ?? null,
    isDefault: stream.disposition?.default === 1,
  }
}

/**
 * Decide what kind of file this is, from its normalized facts.
 *
 * @param {object} facts - a normalized probe result.
 * @returns {'video'|'audio'|'image'|'unknown'} the kind.
 */
export function classify(facts) {
  const video = facts.video
  const format = String(facts.formatName ?? '')
  if (video === null && facts.audio !== null) return 'audio'
  if (video === null) return 'unknown'
  if (format.includes('image2') || format.includes('png_pipe') || format.includes('jpeg_pipe') || format.includes('webp')) return 'image'
  if (facts.durationSec === null || facts.durationSec === 0) return video.frames !== null && video.frames <= 1 ? 'image' : 'unknown'
  return 'video'
}

/**
 * Probe one file.
 *
 * @param {string} path - the file.
 * @param {object} [config] - normalized plugin config.
 * @param {number} [timeoutMs] - deadline.
 * @returns {Promise<object>} normalized facts, with the raw ffprobe document under `raw`.
 * @throws {ProbeError} when the file is missing or cannot be read.
 */
export async function probe(path, config = {}, timeoutMs = 60_000) {
  if (typeof path !== 'string' || path.trim() === '') throw new ProbeError('probe：没有给出文件路径。')
  if (!existsSync(path)) throw new ProbeError(`文件不存在：${path}`)

  let document
  try {
    document = await runProbe(
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_error', path],
      config,
      timeoutMs,
    )
  } catch (error) {
    throw new ProbeError(`ffprobe 读不了这个文件：${error instanceof Error ? error.message : String(error)}`)
  }
  if (document === null) throw new ProbeError(`ffprobe 没有输出：${path}`)

  const streams = Array.isArray(document.streams) ? document.streams.map(normalizeStream) : []
  const format = document.format ?? {}
  const stats = statSync(path)
  const facts = {
    path,
    bytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    formatName: format.format_name ?? null,
    formatLongName: format.format_long_name ?? null,
    durationSec: Number(format.duration) || null,
    bitRate: format.bit_rate === undefined ? null : Number(format.bit_rate),
    sizeFromFormat: format.size === undefined ? null : Number(format.size),
    tags: {
      title: format.tags?.title ?? null,
      encoder: format.tags?.encoder ?? null,
      comment: format.tags?.comment ?? null,
    },
    streams,
    video: streams.find((stream) => stream.type === 'video') ?? null,
    audio: streams.find((stream) => stream.type === 'audio') ?? null,
    subtitles: streams.filter((stream) => stream.type === 'subtitle').length,
    raw: document,
  }
  facts.kind = classify(facts)
  facts.problems = streamProblems(facts)
  return facts
}

/**
 * Name the facts about a probe result that usually mean trouble downstream.
 *
 * Nothing here is a verdict — a video with no audio is a perfectly good video. These are the
 * observations that decide whether a later step needs a conversion first, and they are reported so
 * a caller can choose instead of being surprised.
 *
 * @param {object} facts - a normalized probe result.
 * @returns {string[]} one line per observation.
 */
export function streamProblems(facts) {
  const problems = []
  const video = facts.video
  if (facts.kind === 'unknown') problems.push('既有视频流也有时长，但格式名不像任何已知容器；很可能文件不完整。')
  if (facts.kind === 'video' && video !== null) {
    if (video.pixFmt !== null && !['yuv420p', 'yuvj420p', 'nv12'].includes(video.pixFmt)) {
      problems.push(`像素格式是 ${video.pixFmt}：多数播放器与 H.264 默认只接受 yuv420p，转码时最好显式指定。`)
    }
    if (video.width % 2 !== 0 || video.height % 2 !== 0) {
      problems.push(`${video.width}x${video.height} 的宽或高是奇数：H.264 要求偶数，编码前需要 pad 或 scale。`)
    }
    if (video.fps === null) problems.push('帧率读不出来（可能是可变帧率）：要合成或抽帧时请显式指定输出帧率。')
  }
  if (facts.video !== null && facts.audio !== null && facts.durationSec !== null) {
    const raw = Array.isArray(facts.raw?.streams) ? facts.raw.streams : []
    const startOf = (type) => {
      const stream = raw.find((entry) => entry.codec_type === type)
      const value = Number(stream?.start_time)
      return Number.isFinite(value) ? value : null
    }
    const videoStart = startOf('video')
    const audioStart = startOf('audio')
    if (videoStart !== null && audioStart !== null && Math.abs(videoStart - audioStart) > 0.05) {
      problems.push(
        `音视频起始时间不同（视频 ${videoStart}s，音频 ${audioStart}s）：剪辑或合并后可能逐段累积偏移。`,
      )
    }
  }
  return problems
}

/**
 * Probe several files at once.
 *
 * A failure on one file is reported for that file rather than failing the call: the useful answer
 * to "which of these can I use" is a list, not an exception.
 *
 * @param {string[]} paths - the files.
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{facts: object[], failed: {path: string, error: string}[]}>} what could be read.
 */
export async function probeMany(paths, config = {}) {
  const facts = []
  const failed = []
  for (const path of paths) {
    try {
      facts.push(await probe(path, config))
    } catch (error) {
      failed.push({ path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { facts, failed }
}

/**
 * Decode a file from end to end and report what the decoder managed to read.
 *
 * This is the measurement a header cannot give: how many frames actually decode, how much media
 * time they cover, and every message the decoder emitted. A file whose decoded duration is far
 * short of its declared duration is truncated, no matter how healthy its header looks.
 *
 * @param {string} path - the file.
 * @param {object} [config] - normalized plugin config.
 * @param {object} [options] - `{ timeoutMs, maxMessages }`.
 * @returns {Promise<object>} the verdict and the measurements behind it.
 */
export async function integrity(path, config = {}, options = {}) {
  if (!existsSync(path)) throw new ProbeError(`文件不存在：${path}`)
  const maxMessages = Number.isFinite(options.maxMessages) ? options.maxMessages : 40
  const messages = []
  let lastProgress = null

  const result = await run({
    tool: 'ffmpeg',
    args: ['-v', 'error', '-i', path, '-map', '0', '-f', 'null', '-'],
    config,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30 * 60 * 1000,
    progress: true,
    onProgress: (block) => {
      lastProgress = block
    },
    onStderr: (chunk) => {
      for (const line of chunk.split('\n')) {
        const text = line.trim()
        if (text !== '' && messages.length < maxMessages) messages.push(text)
      }
    },
  }).catch((error) => error)

  const failed = result instanceof Error
  const stderr = result.stderr
  const decodedSeconds = failed ? null : (lastProgress?.outTimeSec ?? null)
  const facts = await probe(path, config).catch(() => null)
  const declaredSeconds = facts?.durationSec ?? null
  const deltaSec = decodedSeconds !== null && declaredSeconds !== null ? Number((decodedSeconds - declaredSeconds).toFixed(3)) : null

  const notes = []
  if (failed) notes.push(`解码没有跑完：${result.message.split('\n')[0]}`)
  if (deltaSec !== null && Math.abs(deltaSec) > Math.max(0.5, (declaredSeconds ?? 0) * 0.02)) {
    notes.push(`解出来的时长与容器声明的相差 ${deltaSec} 秒，超过 2%：文件可能被截断，或时间戳不可信。`)
  }
  if (messages.length > 0) notes.push(`解码头报了 ${messages.length} 条消息（最多保留 ${maxMessages} 条）。`)

  return {
    path,
    ok: !failed && messages.length === 0 && (deltaSec === null || Math.abs(deltaSec) <= Math.max(0.5, (declaredSeconds ?? 0) * 0.02)),
    decodedFrames: failed ? null : (lastProgress?.frame ?? null),
    decodedSeconds,
    declaredSeconds,
    deltaSec,
    messageCount: messages.length,
    messages,
    stderrTail: String(stderr ?? '').trim().split('\n').slice(-10).join('\n'),
    notes,
  }
}

/**
 * List the timestamps ffmpeg would let a stream copy start at.
 *
 * Cutting a video by copying packets can only begin at a keyframe, so "why is my clip three
 * seconds late" is answered by this list rather than by trial and error.
 *
 * @param {string} path - the file.
 * @param {object} [config] - normalized plugin config.
 * @param {number} [limit] - at most this many timestamps. Default 200.
 * @returns {Promise<{times: number[], truncated: boolean, count: number}>} the keyframe times.
 */
export async function keyframeTimes(path, config = {}, limit = 200) {
  const result = await run({
    tool: 'ffprobe',
    args: [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time',
      '-of', 'csv=p=0',
      path,
    ],
    config,
    timeoutMs: 120_000,
    bypassQueue: true,
  }).catch(() => null)
  const times = String(result?.stdout ?? '')
    .split('\n')
    .map((line) => Number(line.trim().replace(/,$/, '')))
    .filter((value) => Number.isFinite(value))
  return { times: times.slice(0, limit), truncated: times.length > limit, count: times.length }
}
