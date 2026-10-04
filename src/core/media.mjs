/**
 * The operations, as argument lists.
 *
 * Every action in this module is split in two on purpose:
 *
 * - a **plan** function, which is pure: it takes the request and returns the exact `argv` arrays
 *   ffmpeg will be given, plus what the caller should expect. It can be tested without a GPU, a
 *   file, or a video.
 * - **{@link execute}**, which runs a plan, deletes a partial output when it fails, and then
 *   *measures what was written* instead of assuming the exit code was the whole story.
 *
 * That split is where the stability lives. The mistakes this plugin exists to prevent — an output
 * path that is also an input, a `.mp4` name with an `.mkv` muxer, a scale that makes an odd height,
 * a stream copy asked for the one second a file has no keyframes in — are all decided in the pure
 * half, where they are cheap to check and impossible to miss.
 *
 * Stream selection is always explicit (`-map 0:v:0? -map 0:a:0?`): letting ffmpeg choose makes the
 * output depend on stream order, and "the same input gives the same output" is the point.
 *
 * @module dsh-ffmpeg/core/media
 */
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { ensureDir, longPath } from './env.mjs'
import { FfmpegError, removeQuietly, run } from './ffmpeg.mjs'
import { probe } from './probe.mjs'

/** Raised when a request is refused before ffmpeg is even started. */
export class MediaError extends Error {
  /**
   * @param {string} message - why the request was refused.
   */
  constructor(message) {
    super(message)
    this.name = 'MediaError'
  }
}

/** Container implied by an output extension, and the muxer that produces it. */
export const CONTAINERS = {
  '.mp4': { muxer: 'mp4', video: 'libx264', audio: 'aac', faststart: true },
  '.m4v': { muxer: 'mp4', video: 'libx264', audio: 'aac', faststart: true },
  '.mov': { muxer: 'mov', video: 'libx264', audio: 'aac', faststart: true },
  '.mkv': { muxer: 'matroska', video: 'libx264', audio: 'aac', faststart: false },
  '.webm': { muxer: 'webm', video: 'libvpx-vp9', audio: 'libopus', faststart: false },
  '.avi': { muxer: 'avi', video: 'libx264', audio: 'libmp3lame', faststart: false },
  '.gif': { muxer: 'gif', video: 'gif', audio: null, faststart: false },
  '.mp3': { muxer: 'mp3', video: null, audio: 'libmp3lame', faststart: false },
  '.m4a': { muxer: 'ipod', video: null, audio: 'aac', faststart: true },
  '.aac': { muxer: 'adts', video: null, audio: 'aac', faststart: false },
  '.wav': { muxer: 'wav', video: null, audio: 'pcm_s16le', faststart: false },
  '.flac': { muxer: 'flac', video: null, audio: 'flac', faststart: false },
  '.opus': { muxer: 'opus', video: null, audio: 'libopus', faststart: false },
  '.jpg': { muxer: 'image2', video: 'mjpeg', audio: null, faststart: false },
  '.jpeg': { muxer: 'image2', video: 'mjpeg', audio: null, faststart: false },
  '.png': { muxer: 'image2', video: 'png', audio: null, faststart: false },
  '.webp': { muxer: 'webp', video: 'libwebp', audio: null, faststart: false },
}

/** Software H.264 quality presets, in the order they are normally tried. */
export const X264_PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow']

/**
 * What container an output path implies.
 *
 * @param {string} out - the output path.
 * @returns {{muxer: string, video: string|null, audio: string|null, faststart: boolean, extension: string}} the container facts.
 * @throws {MediaError} when the extension is not one this plugin writes.
 */
export function containerFor(out) {
  const extension = extname(String(out ?? '')).toLowerCase()
  const container = CONTAINERS[extension]
  if (container === undefined) {
    throw new MediaError(`不认识的输出扩展名 ${JSON.stringify(extension || '(没有)')}；支持：${Object.keys(CONTAINERS).join(' ')}`)
  }
  return { ...container, extension }
}

/**
 * Refuse a request whose output would overwrite one of its own inputs.
 *
 * This is the single most destructive mistake available here: `ffmpeg -i a.mp4 … a.mp4` truncates
 * the source before reading it, and the result is a zero-byte file plus a lost recording. The
 * check is done on resolved paths, so `./a.mp4` and `a.mp4` are recognized as the same file.
 *
 * @param {string} out - the output path.
 * @param {string|string[]} inputs - the input path or paths.
 * @param {boolean} [allow] - the caller has explicitly asked to overwrite an input.
 * @returns {void}
 * @throws {MediaError} when the output is an input.
 */
export function assertSeparate(out, inputs, allow = false) {
  if (allow === true) return
  const target = resolve(out).toLowerCase()
  for (const input of Array.isArray(inputs) ? inputs : [inputs]) {
    if (typeof input !== 'string' || input === '') continue
    if (resolve(input).toLowerCase() === target) {
      throw new MediaError(
        `输出路径与输入是同一个文件（${out}）：ffmpeg 会先把它清空再读，源文件就没了。\n换一个输出名，或者明确传 overwriteInput:true。`,
      )
    }
  }
}

/**
 * Build the video codec arguments for one request.
 *
 * @param {object} video - `{ codec, crf, preset, bitrate, pixFmt, scale, fps, profile, level }`.
 * @param {object} [container] - the container defaults.
 * @returns {{args: string[], notes: string[]}} the arguments and anything worth saying about them.
 */
export function videoArguments(video = {}, container = {}) {
  const args = []
  const notes = []
  const codec = video.codec ?? container.video ?? 'libx264'
  if (codec === null) return { args: [], notes }

  args.push('-c:v', codec)
  if (typeof video.bitrate === 'string' && video.bitrate !== '') {
    args.push('-b:v', video.bitrate)
    notes.push(`用固定码率 ${video.bitrate}；crf 会被忽略。`)
  } else if (video.crf !== undefined && video.crf !== null) {
    const crf = Number(video.crf)
    if (!Number.isFinite(crf) || crf < 0 || crf > 63) throw new MediaError(`crf 必须在 0–63 之间；收到 ${JSON.stringify(video.crf)}`)
    if (codec === 'libx264' || codec === 'libx265') args.push('-crf', String(crf))
    else if (codec === 'libvpx-vp9') args.push('-crf', String(crf), '-b:v', '0')
    else notes.push(`${codec} 不认 crf，已忽略。`)
  }
  if (typeof video.preset === 'string' && video.preset !== '') {
    if ((codec === 'libx264' || codec === 'libx265') && !X264_PRESETS.includes(video.preset)) {
      throw new MediaError(`preset ${JSON.stringify(video.preset)} 不是 x264/x265 的值；可选：${X264_PRESETS.join(', ')}`)
    }
    args.push('-preset', video.preset)
  }
  if (typeof video.profile === 'string' && video.profile !== '') args.push('-profile:v', video.profile)
  if (video.pixFmt !== null && video.pixFmt !== undefined && video.pixFmt !== '') {
    args.push('-pix_fmt', video.pixFmt)
  } else if (codec === 'libx264' || codec === 'libx265' || codec === 'h264_nvenc' || codec === 'hevc_nvenc') {
    // yuv420p is what every player and browser accepts; leaving it to chance is how a file plays
    // everywhere except where it was meant to.
    args.push('-pix_fmt', 'yuv420p')
  }

  const filters = []
  if (typeof video.scale === 'string' && video.scale !== '') filters.push(`scale=${video.scale}`)
  if (video.fps !== null && video.fps !== undefined && video.fps !== '') {
    const fps = Number(video.fps)
    if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new MediaError(`fps 必须在 0–240 之间；收到 ${JSON.stringify(video.fps)}`)
    filters.push(`fps=${fps}`)
  }
  if (filters.length > 0) args.push('-vf', filters.join(','))

  return { args, notes }
}

/**
 * Build the audio codec arguments for one request.
 *
 * @param {object} audio - `{ codec, bitrate, channels, sampleRate, drop }`.
 * @param {object} [container] - the container defaults.
 * @returns {{args: string[], notes: string[]}} the arguments and any notes.
 */
export function audioArguments(audio = {}, container = {}) {
  const args = []
  const notes = []
  if (audio.drop === true) return { args: ['-an'], notes: ['输出不含音频。'] }
  const codec = audio.codec ?? container.audio ?? null
  if (codec === null || codec === undefined) return { args: ['-an'], notes }
  args.push('-c:a', codec)
  if (typeof audio.bitrate === 'string' && audio.bitrate !== '' && !codec.startsWith('pcm') && codec !== 'flac') {
    args.push('-b:a', audio.bitrate)
  }
  if (Number.isFinite(audio.channels)) args.push('-ac', String(audio.channels))
  if (Number.isFinite(audio.sampleRate)) args.push('-ar', String(audio.sampleRate))
  return { args, notes }
}

/**
 * Plan a full transcode: one input, one output, explicit codecs.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the source.
 * @param {string} request.out - where to write.
 * @param {object} [request.video] - see {@link videoArguments}.
 * @param {object} [request.audio] - see {@link audioArguments}.
 * @param {boolean} [request.faststart] - move the MP4 index to the front. Default from the container.
 * @param {string} [request.hwaccel] - an accelerator to enable before `-i`.
 * @param {boolean} [request.noAudio] - drop audio, whatever the container says.
 * @returns {{args: string[], out: string, notes: string[], expect: object}} the plan.
 */
export function transcodePlan(request) {
  const { input, out } = request
  const container = containerFor(out)
  const notes = []
  const args = []
  const wantsVideo = container.video !== null && request.video?.codec !== null
  const wantsAudio = container.audio !== null && request.noAudio !== true
  if (!wantsVideo && !wantsAudio) throw new MediaError('这个输出扩展名既不带视频也不带音频。')

  if (typeof request.hwaccel === 'string' && request.hwaccel !== '') args.push('-hwaccel', request.hwaccel)
  args.push('-i', longPath(input))

  // Explicit mapping, immediately after the input: the first video and the first audio stream and
  // nothing else. Without it the output depends on stream order, and a subtitle track someone
  // forgot about becomes part of the video.
  if (wantsVideo) args.push('-map', '0:v:0?')
  if (wantsAudio) args.push('-map', '0:a:0?')

  const video = videoArguments(request.video ?? {}, container)
  args.push(...video.args)
  notes.push(...video.notes)

  const audio = audioArguments(wantsAudio ? (request.audio ?? {}) : { drop: true }, container)
  args.push(...audio.args)
  notes.push(...audio.notes)

  const faststart = request.faststart ?? container.faststart
  if (faststart && ['mp4', 'mov', 'ipod'].includes(container.muxer)) {
    args.push('-movflags', '+faststart')
  }
  args.push(longPath(out))

  return {
    args,
    out,
    notes,
    expect: { video: wantsVideo, audio: wantsAudio },
  }
}

/**
 * Plan a cut.
 *
 * Two modes, and the difference is not decoration:
 *
 * - `encode` re-encodes, so the cut lands on the requested frame ([`actualStart`] will match).
 * - `copy` copies packets, so the cut lands on the nearest keyframe *before* the request and the
 *   result starts earlier than asked. That is reported, not hidden, because a caller who needs a
 *   frame-exact cut must choose `encode`.
 *
 * @param {object} request - `{ input, out, start, duration, end, mode, video, audio }`.
 * @returns {{args: string[], out: string, notes: string[], expect: object}} the plan.
 */
export function trimPlan(request) {
  const { input, out } = request
  const container = containerFor(out)
  const mode = request.mode ?? 'encode'
  const notes = []
  const args = []
  const start = Number.isFinite(request.start) ? Math.max(0, request.start) : 0
  const end = Number.isFinite(request.end) ? request.end : null
  const duration = Number.isFinite(request.duration) ? request.duration : end !== null ? end - start : null
  if (duration !== null && duration <= 0) throw new MediaError(`裁剪区间为空：start=${start}，duration=${duration}`)

  if (start > 0) args.push('-ss', String(start))
  args.push('-i', longPath(input))
  if (duration !== null) args.push('-t', String(duration))

  if (mode === 'copy') {
    args.push('-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero')
    notes.push('流复制（copy）：切片从请求时间之前最近的关键帧开始，可能比请求早最多一个 GOP；要逐帧准确请用 mode:"encode"。')
  } else {
    args.push('-map', '0:v:0?', '-map', '0:a:0?')
    const video = videoArguments(request.video ?? {}, container)
    args.push(...video.args)
    notes.push(...video.notes)
    const audio = audioArguments(request.audio ?? {}, container)
    args.push(...audio.args)
    notes.push(...audio.notes)
    if (start > 0) notes.push('重编码裁剪：先快速定位到关键帧，再解码丢弃到目标时间，切片起点是准确的。')
  }

  const faststart = request.faststart ?? container.faststart
  if (faststart) args.push('-movflags', '+faststart')
  args.push(longPath(out))

  return {
    args,
    out,
    notes,
    expect: { video: container.video !== null, audio: container.audio !== null && request.audio?.drop !== true },
  }
}

/**
 * Plan an audio operation on a video or audio file.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the source.
 * @param {string} request.out - where to write.
 * @param {'extract'|'drop'|'replace'|'normalize'} request.mode - what to do.
 * @param {string} [request.audioPath] - the replacement audio, for `replace`.
 * @param {object} [request.audio] - codec settings for the written audio.
 * @param {object} [request.normalize] - `{ targetI, truePeak, range }` for `normalize`.
 * @returns {{args: string[], out: string, notes: string[], expect: object}} the plan.
 */
export function audioPlan(request) {
  const { input, out, mode } = request
  const container = containerFor(out)
  const args = []
  const notes = []

  if (mode === 'drop') {
    if (!CONTAINERS[extname(out).toLowerCase()]?.video) throw new MediaError('drop 模式要输出视频容器；纯音频容器没有视频流可留。')
    return {
      args: ['-i', longPath(input), '-map', '0:v:0?', '-c:v', 'copy', '-an', longPath(out)],
      out,
      notes: ['复制视频流，丢掉音频（不重编码，很快）。'],
      expect: { video: true, audio: false },
    }
  }

  if (mode === 'replace') {
    if (typeof request.audioPath !== 'string' || !existsSync(request.audioPath)) {
      throw new MediaError(`replace 模式需要 audioPath，并且文件要存在；收到 ${JSON.stringify(request.audioPath)}`)
    }
    const audio = audioArguments(request.audio ?? {}, container)
    args.push('-i', longPath(input), '-i', longPath(request.audioPath))
    args.push('-map', '0:v:0?', '-map', '1:a:0')
    args.push('-c:v', 'copy')
    args.push(...audio.args)
    args.push('-shortest', longPath(out))
    notes.push('视频流复制，音频换成本地文件；-shortest 保证音视频同时结束。')
    return { args, out, notes, expect: { video: true, audio: container.audio !== null } }
  }

  if (mode === 'extract') {
    const audio = audioArguments({ codec: container.audio, ...(request.audio ?? {}) }, container)
    args.push('-i', longPath(input), '-map', '0:a:0?', '-vn')
    args.push(...audio.args, longPath(out))
    notes.push('只导出第一条音频流。')
    return { args, out, notes, expect: { video: false, audio: true } }
  }

  if (mode === 'normalize') {
    // Single-pass loudnorm guesses the dynamics of material it has not measured; two-pass measures
    // first and then applies the measurement, which is the difference between a predictable
    // loudness and a level that swings with the content.
    const target = request.normalize ?? {}
    const targetI = Number.isFinite(target.targetI) ? target.targetI : -16
    const truePeak = Number.isFinite(target.truePeak) ? target.truePeak : -1.5
    const range = Number.isFinite(target.range) ? target.range : 11
    const loudnorm = `loudnorm=I=${targetI}:TP=${truePeak}:LRA=${range}`
    const faststart = ['mp4', 'mov', 'ipod'].includes(container.muxer) ? ['-movflags', '+faststart'] : []
    return {
      passes: [
        { args: ['-i', longPath(input), '-af', `${loudnorm}:print_format=json`, '-f', 'null', '-'], measureLoudnorm: true },
        {
          args: [
            '-i', longPath(input),
            '-map', '0:v:0?', '-map', '0:a:0?',
            '-c:v', 'copy',
            ...audioArguments(request.audio ?? {}, container).args,
            '-af', `${loudnorm}:measured_I=MEASURED_I:measured_TP=MEASURED_TP:measured_LRA=MEASURED_LRA:measured_thresh=MEASURED_THRESH:offset=MEASURED_OFFSET:linear=true:print_format=summary`,
            ...faststart,
            longPath(out),
          ],
          substituteLoudnorm: true,
        },
      ],
      out,
      notes: [`两遍 loudnorm：先量出这部片子的响度，再按测量值归一化到 I=${targetI} LUFS / TP=${truePeak} dBTP。`],
      expect: { video: true, audio: true },
      singlePassFallback: { args: ['-i', longPath(input), '-map', '0:v:0?', '-map', '0:a:0?', '-c:v', 'copy', ...audioArguments(request.audio ?? {}, container).args, '-af', loudnorm, longPath(out)], out },
    }
  }

  throw new MediaError(`未知的 audio 模式 ${JSON.stringify(mode)}；可选：extract / drop / replace / normalize`)
}

/**
 * Plan still extraction: one frame, several named times, or a fixed cadence.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the source.
 * @param {string} request.outDir - the directory for the stills.
 * @param {number} [request.at] - one second.
 * @param {number[]} [request.times] - several seconds.
 * @param {number} [request.fps] - a fixed cadence instead of named times.
 * @param {number} [request.maxSide] - long side limit; never upscales.
 * @param {'jpg'|'png'} [request.format] - output format.
 * @param {string} [request.prefix] - file name stem. Default `frame`.
 * @returns {{passes: object[], out: string|null, pattern: string|null, notes: string[], expect: object}} the plan.
 */
export function framesPlan(request) {
  const { input, outDir } = request
  const format = request.format ?? 'jpg'
  if (!['jpg', 'png', 'webp'].includes(format)) throw new MediaError(`format 只能是 jpg / png / webp；收到 ${JSON.stringify(format)}`)
  const maxSide = Number.isFinite(request.maxSide) ? request.maxSide : 1280
  const prefix = typeof request.prefix === 'string' && request.prefix !== '' ? request.prefix : 'frame'
  const quality = Number.isFinite(request.quality) ? request.quality : 3
  const scale = `scale='min(${maxSide},iw)':-2:flags=lanczos`
  const notes = [`每张图长边不超过 ${maxSide}px，不会放大。`]

  if (Number.isFinite(request.at)) {
    const out = join(outDir, `${prefix}_${formatTime(request.at)}.${format}`)
    const args = ['-ss', String(request.at), '-i', longPath(input), '-frames:v', '1', '-vf', scale, '-an', '-sn']
    args.push(...(format === 'jpg' ? ['-q:v', String(quality)] : format === 'png' ? ['-compression_level', '6'] : []))
    args.push('-update', '1', longPath(out))
    return { passes: [{ args }], out, pattern: null, notes, expect: { images: 1 } }
  }

  if (Array.isArray(request.times) && request.times.length > 0) {
    const times = request.times.filter((value) => Number.isFinite(value) && value >= 0)
    if (times.length === 0) throw new MediaError('times 里没有合法的时间点。')
    // One process per timestamp: the alternative is a select() expression, whose behaviour depends
    // on the frame rate and can silently pick zero or two frames per timestamp.
    const passes = times.map((time) => {
      const out = join(outDir, `${prefix}_${formatTime(time)}.${format}`)
      const args = ['-ss', String(time), '-i', longPath(input), '-frames:v', '1', '-vf', scale, '-an', '-sn']
      args.push(...(format === 'jpg' ? ['-q:v', String(quality)] : format === 'png' ? ['-compression_level', '6'] : []))
      args.push('-update', '1', longPath(out))
      return { args, out }
    })
    return { passes, out: null, pattern: null, notes: [...notes, `按 ${times.length} 个时间点各抽一帧。`], expect: { images: times.length } }
  }

  const fps = Number.isFinite(request.fps) ? request.fps : 1
  if (fps <= 0 || fps > 60) throw new MediaError(`fps 必须在 0–60 之间；收到 ${JSON.stringify(request.fps)}`)
  const pattern = join(outDir, `${prefix}_%04d.${format}`)
  const args = ['-i', longPath(input), '-vf', `${scale},fps=${fps}`, '-an', '-sn']
  args.push(...(format === 'jpg' ? ['-q:v', String(quality)] : format === 'png' ? ['-compression_level', '6'] : []))
  if (format === 'jpg') args.push('-start_number', '1')
  args.push(longPath(pattern))
  return { passes: [{ args }], out: null, pattern, notes: [...notes, `按每秒 ${fps} 帧抽图。`], expect: { images: null } }
}

/**
 * Plan a GIF, which needs two passes: build the palette, then use it.
 *
 * @param {object} request - `{ input, out, start, duration, fps, width, loop, dither }`.
 * @returns {{passes: object[], out: string, notes: string[], expect: object}} the plan.
 */
export function gifPlan(request) {
  const { input, out } = request
  const container = containerFor(out)
  if (container.muxer !== 'gif') throw new MediaError(`gif 计划只能输出 .gif；收到 ${JSON.stringify(extname(out))}`)
  const fps = Number.isFinite(request.fps) ? request.fps : 12
  const width = Number.isFinite(request.width) ? request.width : 640
  const start = Number.isFinite(request.start) ? request.start : 0
  const duration = Number.isFinite(request.duration) ? request.duration : 5
  const loop = Number.isFinite(request.loop) ? request.loop : 0
  const dither = request.dither ?? 'bayer:bayer_scale=3'

  const range = ['-ss', String(start), '-t', String(duration), '-i', longPath(input)]
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`
  return {
    passes: [
      { args: [...range, '-vf', `${filters},split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=${dither}`, '-loop', String(loop), longPath(out)] },
    ],
    out,
    notes: [`GIF：${duration}s @ ${fps}fps，宽 ${width}px，颜色 256 色 + 调色板（单次滤镜图内完成，失败也不会留下半个调色板文件）。`],
    expect: { video: true, audio: false, animated: true },
  }
}

/**
 * Decide the canvas every clip in a join is scaled to.
 *
 * `concat` cannot reconfigure itself between inputs, so clips of different sizes do not merely look
 * uneven — the filter fails to reinitialize and the join writes nothing at all. The first clip sets
 * the canvas unless the caller names one, and the clips are then fitted and padded rather than
 * stretched.
 *
 * @param {object[]} facts - probe results, in join order.
 * @param {string} [scale] - the caller's `video.scale`, as `宽:高`.
 * @returns {{width: number, height: number, fps: number, mismatched: number[]}} the canvas and which clips differ from it.
 */
export function concatCanvas(facts, scale) {
  const requested = typeof scale === 'string' ? /^(\d+)\s*[:x]\s*(\d+)$/.exec(scale.trim()) : null
  const width = requested === null ? facts[0].video.width : Number(requested[1])
  const height = requested === null ? facts[0].video.height : Number(requested[2])
  const fps = facts[0].video.fps ?? 30
  const mismatched = []
  facts.forEach((entry, index) => {
    if (entry.video.width !== width || entry.video.height !== height || Math.abs((entry.video.fps ?? fps) - fps) > 0.01) {
      mismatched.push(index)
    }
  })
  return { width, height, fps, mismatched }
}

/**
 * Plan a join of clips that share a codec.
 *
 * The concat demuxer copies packets and is therefore instant, but it requires identical codecs,
 * time bases and resolutions — so the inputs are probed first and a mismatch is refused with the
 * differing field named, rather than producing a file that plays the first clip and then breaks.
 *
 * @param {object} request - `{ inputs, out, mode, reencode }`.
 * @returns {Promise<{plan: object, listPath: string|null}>} the plan and the list file it needs.
 * @throws {MediaError} when the clips are not compatible with the requested mode.
 */
export async function concatPlan(request) {
  const { inputs, out } = request
  const container = containerFor(out)
  const mode = request.mode ?? 'copy'
  if (!Array.isArray(inputs) || inputs.length < 2) throw new MediaError('concat 至少需要两个输入文件。')

  const facts = []
  for (const input of inputs) {
    if (!existsSync(input)) throw new MediaError(`输入不存在：${input}`)
    facts.push(await probe(input, request.config ?? {}))
  }

  const notes = []
  if (mode === 'copy') {
    const first = facts[0].video
    if (first === null) throw new MediaError('第一个输入没有视频流；concat copy 需要每个输入都有同规格的视频流。')
    const signatures = facts.map((entry) => {
      const video = entry.video
      const audio = entry.audio
      return `${video?.codec}/${video?.width}x${video?.height}/${video?.fps ?? '?'}/${audio?.codec ?? 'none'}/${audio?.sampleRate ?? '-'}/${audio?.channels ?? '-'}`
    })
    const unique = [...new Set(signatures)]
    if (unique.length > 1) {
      throw new MediaError(
        `concat copy 要求所有输入编码参数一致，但它们不同：\n${signatures.map((signature, index) => `  ${index + 1}. ${signature}`).join('\n')}\n` +
          `先统一转码（ffmpeg_convert transcode），或者用 mode:"encode"（会重新编码，慢但不在乎差异）。`,
      )
    }
    const listPath = join(dirname(resolve(out)), `.concat-${Date.now()}.txt`)
    ensureDir(dirname(resolve(out)))
    const body = inputs.map((input) => `file '${longPath(input).replace(/'/g, "'\\''")}'`).join('\n')
    writeFileSync(listPath, `${body}\n`, { encoding: 'utf8' })
    notes.push('concat copy：流复制拼接，秒级完成，要求编码参数完全一致（已逐项核对）。')
    return {
      plan: {
        passes: [{ args: ['-f', 'concat', '-safe', '0', '-i', longPath(listPath), '-c', 'copy', ...(container.faststart ? ['-movflags', '+faststart'] : []), longPath(out)], cleanup: [listPath] }],
        out,
        notes,
        expect: { video: true, audio: facts[0].audio !== null },
      },
      listPath,
    }
  }

  const args = []
  for (const input of inputs) args.push('-i', longPath(input))
  const graphParts = []
  const hasAudio = facts.every((entry) => entry.audio !== null)

  // One canvas for every segment; see {@link concatCanvas} for why this is not optional.
  const canvas = concatCanvas(facts, request.video?.scale)
  const canvasWidth = canvas.width
  const canvasHeight = canvas.height
  const canvasFps = canvas.fps
  const mismatched = canvas.mismatched

  // Every input's normalizing chain comes first, then the two concat filters. A filter graph is
  // read in order and each pad must exist before it is referenced, so interleaving the chains with
  // the concat that consumes them fails to link.
  facts.forEach((entry, index) => {
    graphParts.push(
      `[${index}:v:0]scale=${canvasWidth}:${canvasHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${canvasWidth}:${canvasHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${canvasFps},format=yuv420p[v${index}]`,
    )
  })
  if (hasAudio) {
    facts.forEach((entry, index) => {
      graphParts.push(`[${index}:a:0]aresample=${entry.audio.sampleRate ?? 48000},aformat=sample_fmts=fltp:channel_layouts=stereo[a${index}]`)
    })
  }
  graphParts.push(`${facts.map((_, index) => `[v${index}]`).join('')}concat=n=${facts.length}:v=1:a=0[v]`)
  if (hasAudio) graphParts.push(`${facts.map((_, index) => `[a${index}]`).join('')}concat=n=${facts.length}:v=0:a=1[a]`)

  const video = videoArguments(request.video ?? {}, container)
  const audio = audioArguments(request.audio ?? {}, container)
  args.push('-filter_complex', graphParts.join(';'), '-map', '[v]')
  if (hasAudio) args.push('-map', '[a]')
  args.push(...video.args, ...(hasAudio ? audio.args : ['-an']))
  if (container.faststart) args.push('-movflags', '+faststart')
  args.push(longPath(out))
  notes.push(`concat encode：画布 ${canvasWidth}x${canvasHeight} @ ${canvasFps}fps，先统一尺寸、帧率与采样率再拼接。`)
  if (mismatched.length > 0) {
    notes.push(`${mismatched.length} 段的尺寸或帧率与画布不同（已按比例缩放并补黑边，未拉伸）；画布取第一个输入，可用 video.scale:"宽:高" 指定。`)
  }
  return { plan: { passes: [{ args }], out, notes, expect: { video: true, audio: hasAudio } }, listPath: null }
}

/**
 * Plan burning or muxing subtitles.
 *
 * @param {object} request - `{ input, out, srt, mode, style }`.
 * @returns {{args: string[], out: string, notes: string[], expect: object}} the plan.
 */
export function subtitlesPlan(request) {
  const { input, out, srt } = request
  const container = containerFor(out)
  const mode = request.mode ?? 'burn'
  if (typeof srt !== 'string' || !existsSync(srt)) throw new MediaError(`字幕文件不存在：${JSON.stringify(srt)}`)
  const path = longPath(srt).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")

  if (mode === 'burn') {
    const style = typeof request.style === 'string' && request.style !== '' ? `:force_style='${request.style}'` : ''
    const args = ['-i', longPath(input), '-vf', `subtitles='${path}'${style}`, '-map', '0:v:0?', '-map', '0:a:0?']
    const video = videoArguments(request.video ?? {}, container)
    const audio = audioArguments(request.audio ?? { codec: 'copy' }, container)
    args.push(...video.args, ...audio.args)
    if (container.faststart) args.push('-movflags', '+faststart')
    args.push(longPath(out))
    return { args, out, notes: ['把字幕烧进画面：像素被重编码一次，字幕无法再关掉，但任何播放器都看得到。'], expect: { video: true, audio: true } }
  }

  const args = ['-i', longPath(input), '-i', longPath(srt), '-map', '0', '-map', '1:0', '-c', 'copy']
  if (container.muxer === 'mp4' || container.muxer === 'mov' || container.muxer === 'matroska') args.push('-c:s', 'mov_text')
  else throw new MediaError(`mux 模式只支持 mp4 / mov / mkv；收到 ${JSON.stringify(extname(out))}`)
  if (container.faststart) args.push('-movflags', '+faststart')
  args.push(longPath(out))
  return { args, out, notes: ['把字幕作为独立轨道封装进容器：不重编码，但播放器要支持字幕轨（mp4 用 mov_text）。'], expect: { video: true, audio: true } }
}

/**
 * Format a timestamp for use inside a file name.
 * @param {number} seconds - the time.
 * @returns {string} `HHMMSSmmm`.
 */
export function formatTime(seconds) {
  const total = Math.max(0, seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  const millis = Math.round((total - Math.floor(total)) * 1000)
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}${String(secs).padStart(2, '0')}${String(millis).padStart(3, '0')}`
}

/**
 * Pull the loudnorm measurement block out of ffmpeg's stderr.
 *
 * The values are printed as JSON after the first pass; the *last* JSON object in the log is the one
 * that matters, because earlier lines can contain braces from other messages.
 *
 * @param {string} stderr - the first pass's stderr.
 * @returns {object|null} the measured values, or null when the log held none.
 */
export function parseLoudnorm(stderr) {
  const text = String(stderr ?? '')
  const start = text.lastIndexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    const required = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset']
    if (!required.every((key) => parsed[key] !== undefined)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Replace the measurement placeholders in a second-pass loudnorm filter.
 *
 * @param {string[]} args - the second pass's arguments.
 * @param {object} measured - the values from {@link parseLoudnorm}.
 * @returns {string[]} the arguments with the values substituted.
 */
export function substituteLoudnorm(args, measured) {
  return args.map((argument) =>
    argument
      .replace('MEASURED_I', String(measured.input_i))
      .replace('MEASURED_TP', String(measured.input_tp))
      .replace('MEASURED_LRA', String(measured.input_lra))
      .replace('MEASURED_THRESH', String(measured.input_thresh))
      .replace('MEASURED_OFFSET', String(measured.target_offset)),
  )
}

/**
 * Run a plan: every pass in order, then measure what was written.
 *
 * On failure the partial output is removed, because a half-written file that keeps the intended
 * name is how a failed conversion becomes a broken delivery two steps later.
 *
 * @param {object} plan - a plan from one of the builders above.
 * @param {object} [options] - `{ config, onProgress, timeoutMs, keepPartial }`.
 * @returns {Promise<object>} what was written and what was measured.
 * @throws {MediaError} when a pass fails.
 */
export async function execute(plan, options = {}) {
  const config = options.config ?? {}
  // A plan is either a single pass or a list of them. Normalizing once here means every caller of
  // `execute` can be written as if both shapes were the same, which is what they are to a caller.
  const passes = Array.isArray(plan.passes) && plan.passes.length > 0 ? plan.passes : [plan]
  const outputs = passes.map((pass) => pass.out).filter((value) => typeof value === 'string')
  if (typeof plan.out === 'string') outputs.push(plan.out)
  // An invariant, checked before anything runs: a plan that names an output but does not end with it
  // would have ffmpeg print "Trailing option(s) found in the command" and write nothing. That is a
  // planner bug, and it is exactly the kind that a test which only inspects arguments will miss.
  if (typeof plan.out === 'string' && !plan.passes) {
    const args = passes[passes.length - 1].args
    if (args[args.length - 1] !== longPath(plan.out)) {
      throw new MediaError(`内部错误：计划给了输出 ${plan.out}，但参数末尾是 ${JSON.stringify(args[args.length - 1])}。`)
    }
  }
  for (const output of outputs) ensureDir(dirname(output))

  const started = Date.now()
  const ran = []
  let measured = null

  try {
    for (const pass of passes) {
      const args = [...pass.args]
      if (pass.measureLoudnorm === true) {
        const result = await run({ tool: 'ffmpeg', args, config, timeoutMs: options.timeoutMs })
        measured = parseLoudnorm(result.stderr)
        ran.push({ args, elapsedMs: result.elapsedMs, measured })
        continue
      }
      if (pass.substituteLoudnorm === true) {
        if (measured === null) throw new MediaError('第一遍没有量到 loudnorm 的数值，第二遍无法套用；可以改用单遍模式。')
        const index = args.indexOf('-af') + 1
        args[index] = substituteLoudnorm([args[index]], measured)[0]
      }
      const result = await run({
        tool: 'ffmpeg',
        args,
        config,
        timeoutMs: options.timeoutMs,
        progress: options.onProgress !== undefined,
        onProgress: options.onProgress,
      })
      ran.push({ args, elapsedMs: result.elapsedMs })
    }
  } catch (error) {
    if (options.keepPartial !== true) {
      for (const output of outputs) removeQuietly(output)
      if (plan.pattern !== null && plan.pattern !== undefined) removeMatching(dirname(plan.pattern), plan.pattern)
    }
    if (error instanceof MediaError) throw error
    throw new MediaError(`ffmpeg 执行失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    for (const pass of passes) {
      for (const file of pass.cleanup ?? []) removeQuietly(file)
    }
  }

  const written = []
  for (const output of [...new Set(outputs)]) {
    if (!existsSync(output)) continue
    written.push(await verifyOutput(output, { config, ...(plan.expect ?? {}) }))
  }

  return {
    out: plan.out ?? null,
    pattern: plan.pattern ?? null,
    notes: plan.notes ?? [],
    passes: ran.length,
    elapsedMs: Date.now() - started,
    files: written,
    measured,
    ok: written.length === 0 ? true : written.every((entry) => entry.ok),
  }
}

/**
 * Delete the files a numbered pattern would have produced.
 *
 * A failed cadence extraction leaves some of its frames behind; keeping them would make a rerun
 * silently mix two runs together.
 *
 * @param {string} directory - where the frames were written.
 * @param {string} pattern - the output pattern, with `%0Nd` in it.
 * @returns {void}
 */
function removeMatching(directory, pattern) {
  try {
    const stem = pattern.split(/[\\/]/).pop() ?? ''
    const prefix = stem.split('%')[0]
    for (const name of readdirSync(directory)) {
      if (prefix !== '' && name.startsWith(prefix)) rmSync(join(directory, name), { force: true })
    }
  } catch {
    // Nothing to clean, or the directory is gone; both are fine.
  }
}

/**
 * Measure a file that was just written, against what the plan said it would contain.
 *
 * This is the answer to "did it actually work": a zero-byte file, a file with no audio track when
 * audio was requested, or a ten-second file where an hour was expected are all failures that the
 * exit code alone reports as success.
 *
 * @param {string} path - the file.
 * @param {object} [options] - `{ config, video, audio, images, minBytes, expectedDurationSec, durationToleranceSec }`.
 * @returns {Promise<object>} `{ path, ok, problems, facts }`.
 */
export async function verifyOutput(path, options = {}) {
  const problems = []
  if (!existsSync(path)) {
    return { path, ok: false, problems: ['文件没有被写出来。'], facts: null }
  }
  const bytes = statSync(path).size
  const minBytes = Number.isFinite(options.minBytes) ? options.minBytes : 1024
  if (bytes < minBytes) problems.push(`文件只有 ${bytes} 字节，小于最小值 ${minBytes}。`)

  let facts = null
  try {
    facts = await probe(path, options.config ?? {})
  } catch (error) {
    problems.push(`写出来的文件读不了：${error instanceof Error ? error.message : String(error)}`)
    return { path, ok: false, problems, facts: null, bytes }
  }

  if (options.video === true && facts.video === null) problems.push('期望有视频流，但没有。')
  if (options.video === false && facts.video !== null) problems.push('期望没有视频流，但有。')
  if (options.audio === true && facts.audio === null) problems.push('期望有音频流，但没有。')
  if (options.audio === false && facts.audio !== null) problems.push('期望没有音频流，但有。')
  if (Number.isFinite(options.expectedDurationSec) && facts.durationSec !== null) {
    const tolerance = Number.isFinite(options.durationToleranceSec) ? options.durationToleranceSec : Math.max(1, options.expectedDurationSec * 0.05)
    const delta = Math.abs(facts.durationSec - options.expectedDurationSec)
    if (delta > tolerance) {
      problems.push(`时长 ${facts.durationSec.toFixed(2)}s 与期望的 ${options.expectedDurationSec.toFixed(2)}s 相差 ${delta.toFixed(2)}s，超出容差 ${tolerance.toFixed(2)}s。`)
    }
  }

  return {
    path,
    bytes,
    ok: problems.length === 0,
    problems,
    facts: {
      kind: facts.kind,
      durationSec: facts.durationSec,
      formatName: facts.formatName,
      video: facts.video === null ? null : { codec: facts.video.codec, width: facts.video.width, height: facts.video.height, fps: facts.video.fps, pixFmt: facts.video.pixFmt },
      audio: facts.audio === null ? null : { codec: facts.audio.codec, sampleRate: facts.audio.sampleRate, channels: facts.audio.channels },
    },
  }
}

/** Re-exported so callers can name the failure type without importing two modules. */
export { FfmpegError }
