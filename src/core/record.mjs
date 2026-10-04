/**
 * Capturing the screen, a window, or a microphone, with a fixed length.
 *
 * Recording is the one operation whose input is the machine itself, which makes it the one that
 * fails in ways no argument validation can prevent: a window that closes mid-capture, a device
 * that is busy, a busy CPU that drops frames, a resolution the encoder refuses. So the plan here
 * is conservative on purpose —
 *
 * - a **fixed duration** is required, so a capture can never run forever;
 * - the two capture inputs get a `thread_queue_size` and an `rtbufsize`, because the default queue
 *   is the usual cause of "it recorded 3 of the 10 seconds and then stalled";
 * - the dimensions are only forced when the caller forces them, since gdigrab refuses a `video_size`
 *   that the desktop cannot satisfy;
 * - and the result is **measured**: the length actually written is compared with the length asked
 *   for, and a short take is reported as a short take rather than as a success.
 *
 * @module dsh-ffmpeg/core/record
 */
import { containerFor, MediaError, videoArguments, audioArguments } from './media.mjs'
import { longPath } from './env.mjs'

/** Longest capture this plugin will plan, in seconds. */
export const MAX_RECORD_SECONDS = 3600

/** Default capture cadence. Screen content changes far slower than film, and 15 fps halves the CPU. */
export const DEFAULT_CAPTURE_FPS = 15

/**
 * Escape a value that goes inside an ffmpeg option string.
 *
 * With an argument array there is no shell, but ffmpeg's own parser still treats `:` and `\`
 * specially inside `key=value` inputs, and a window title is exactly the kind of string that
 * contains them.
 *
 * @param {string} value - the raw value.
 * @returns {string} the escaped value.
 */
export function escapeOptionValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * Plan a screen or window capture.
 *
 * @param {object} request - the request.
 * @param {string} request.out - the output file.
 * @param {number} request.seconds - how long to capture.
 * @param {number} [request.fps] - capture cadence. Default 15.
 * @param {{x: number, y: number, width: number, height: number}} [request.region] - capture this rectangle instead of the whole desktop.
 * @param {string} [request.window] - capture this window title instead of the desktop.
 * @param {boolean} [request.drawMouse] - draw the pointer. Default true; it is usually the point of a demo recording.
 * @param {string} [request.audioDevice] - a DirectShow audio device name, from `ffmpeg_env {action:"devices"}`.
 * @param {object} [request.video] - codec settings.
 * @param {object} [request.audio] - codec settings.
 * @param {number} [request.rtBufferMb] - DirectShow real-time buffer, in MB. Default 128.
 * @returns {{args: string[], out: string, notes: string[], expect: object, timeoutMs: number, expectedDurationSec: number}} the plan.
 * @throws {MediaError} when the request is not captureable.
 */
export function screenPlan(request) {
  const { out } = request
  const container = containerFor(out)
  if (container.video === null) throw new MediaError(`屏幕录制要写视频容器；${out} 不是。`)
  const seconds = Number(request.seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new MediaError('屏幕录制必须给出正数的秒数（seconds）。')
  if (seconds > MAX_RECORD_SECONDS) {
    throw new MediaError(`一次最多录 ${MAX_RECORD_SECONDS} 秒（1 小时）；收到 ${seconds}。分成几段录，或者用更长的工具。`)
  }
  const fps = Number.isFinite(request.fps) ? request.fps : DEFAULT_CAPTURE_FPS
  if (fps <= 0 || fps > 60) throw new MediaError(`录制帧率必须在 0–60 之间；收到 ${request.fps}`)
  const notes = []
  const args = []

  // The queue is raised on both inputs: gdigrab hands frames over while libx264 is still working,
  // and the default queue is small enough that a busy machine starts dropping instead of waiting.
  if (request.window !== undefined && request.region !== undefined) {
    throw new MediaError('window 与 region 只能选一个：抓窗口时不能同时指定矩形。')
  }

  args.push('-thread_queue_size', '512')
  if (typeof request.window === 'string' && request.window !== '') {
    args.push('-f', 'gdigrab', '-framerate', String(fps), '-i', `title=${escapeOptionValue(request.window)}`)
    notes.push(`抓窗口「${request.window}」：窗口关掉或最小化，录制会提前结束。`)
  } else {
    args.push('-f', 'gdigrab', '-framerate', String(fps))
    if (request.region !== undefined && request.region !== null) {
      const { x = 0, y = 0, width, height } = request.region
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new MediaError('region 需要 width 与 height（正整数），x/y 可选，默认 0。')
      }
      args.push('-offset_x', String(Math.round(x)), '-offset_y', String(Math.round(y)), '-video_size', `${Math.round(width)}x${Math.round(height)}`)
      notes.push(`只录屏幕上的 ${Math.round(width)}x${Math.round(height)} @ (${Math.round(x)},${Math.round(y)})。`)
    } else {
      notes.push('录整个桌面（含所有显示器组成的虚拟桌面）。')
    }
    args.push('-draw_mouse', request.drawMouse === false ? '0' : '1')
    args.push('-i', 'desktop')
  }

  const hasAudio = typeof request.audioDevice === 'string' && request.audioDevice !== ''
  if (hasAudio) {
    const rtBufferMb = Number.isFinite(request.rtBufferMb) ? request.rtBufferMb : 128
    args.push('-thread_queue_size', '512', '-rtbufsize', `${rtBufferMb}M`, '-f', 'dshow', '-i', `audio=${escapeOptionValue(request.audioDevice)}`)
    notes.push(`同时录 ${request.audioDevice}；设备名要和 ffmpeg_env {action:"devices"} 报的完全一致。`)
  } else {
    notes.push('只录画面，没有声音。')
  }

  args.push('-t', String(seconds))
  const video = videoArguments({ codec: 'libx264', preset: 'veryfast', crf: 20, ...(request.video ?? {}) }, container)
  args.push(...video.args)
  notes.push(...video.notes)
  if (video.args.length === 0) throw new MediaError('屏幕录制需要视频编码器。')

  if (hasAudio) {
    const audio = audioArguments({ bitrate: '160k', ...(request.audio ?? {}) }, container)
    args.push(...audio.args)
    notes.push(...audio.notes)
  } else {
    args.push('-an')
  }

  if (['mp4', 'mov', 'ipod'].includes(container.muxer)) args.push('-movflags', '+faststart')
  args.push(longPath(out))

  return {
    args,
    out,
    notes,
    expect: { video: true, audio: hasAudio },
    // A capture that overruns its own duration by a minute is hung, not slow.
    timeoutMs: Math.round(seconds * 1000) + 60_000,
    expectedDurationSec: seconds,
  }
}

/**
 * Plan an audio-only capture from a DirectShow device.
 *
 * @param {object} request - `{ out, seconds, device, sampleRate, channels, bitrate, codec, rtBufferMb }`.
 * @returns {{args: string[], out: string, notes: string[], expect: object, timeoutMs: number, expectedDurationSec: number}} the plan.
 * @throws {MediaError} when the request is not captureable.
 */
export function audioPlan(request) {
  const { out, device } = request
  const container = containerFor(out)
  if (container.audio === null) throw new MediaError(`${out} 不是音频容器。`)
  const seconds = Number(request.seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) throw new MediaError('录音必须给出正数的秒数（seconds）。')
  if (seconds > MAX_RECORD_SECONDS) throw new MediaError(`一次最多录 ${MAX_RECORD_SECONDS} 秒；收到 ${seconds}。`)
  if (typeof device !== 'string' || device === '') {
    throw new MediaError('录音需要 device：先用 ffmpeg_env {action:"devices"} 看本机能录哪些设备。')
  }
  const rtBufferMb = Number.isFinite(request.rtBufferMb) ? request.rtBufferMb : 128
  const args = [
    '-thread_queue_size', '512',
    '-rtbufsize', `${rtBufferMb}M`,
    '-f', 'dshow',
    '-i', `audio=${escapeOptionValue(device)}`,
    '-t', String(seconds),
    '-map', '0:a:0',
  ]
  const audio = audioArguments({ sampleRate: 48000, channels: 1, bitrate: '160k', ...(request.audio ?? {}) }, container)
  args.push(...audio.args)
  args.push('-vn', longPath(out))

  return {
    args,
    out,
    notes: [
      `从「${device}」录 ${seconds} 秒。`,
      'DirectShow 的设备名区分中英文与括号，必须和列出来的一字不差。',
      '录不到声音时先看设备是否被别的程序独占（会议软件、录音机都会抢占）。',
    ],
    expect: { video: false, audio: true },
    timeoutMs: Math.round(seconds * 1000) + 60_000,
    expectedDurationSec: seconds,
  }
}
