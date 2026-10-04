/**
 * Running an ffmpeg-family process, and being honest about how it ended.
 *
 * Four rules are enforced here because each one is a failure that reads as something else:
 *
 * 1. **Arguments are an array, never a shell string.** A Chinese filename, a space or a quote
 *    needs no escaping and cannot be re-parsed. Nothing in this plugin ever reaches a shell.
 * 2. **`-nostdin` and `-y` are always both present** (on ffmpeg). With `-nostdin` alone ffmpeg
 *    cannot answer its own overwrite prompt, so it exits 1 with an unremarkable `Duration:` line
 *    on stderr — a rerun that looks like "the file is broken" instead of "it asked a question
 *    nobody could see". ffprobe rejects `-y`, so the two get different prefixes.
 * 3. **Every run has a deadline and a bounded stderr tail.** A hung ffmpeg is otherwise an agent
 *    that never returns, and an unbounded log is a memory leak wearing a helpful face.
 * 4. **A failure carries the command, the exit code and the tail of stderr**, plus a hint when
 *    the text matches a failure this plugin has seen before. `explain()` is deliberately a table
 *    of observations, not a diagnosis engine.
 *
 * At most `maxConcurrent` ffmpeg processes run at once, because several 1080p encodes at the same
 * time make every one of them slower and one of them fail.
 *
 * @module dsh-ffmpeg/core/ffmpeg
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { FfmpegNotFound, longPath, requireTool, resolveTool } from './env.mjs'

export { FfmpegNotFound }

/** Raised when ffmpeg or ffprobe exits non-zero, is killed, or times out. */
export class FfmpegError extends Error {
  /**
   * @param {object} detail - the failure.
   * @param {string[]} detail.args - the argument list that failed.
   * @param {number|null} detail.returnCode - the exit code, null when it never started or was killed.
   * @param {string} detail.stderr - captured standard error.
   * @param {string} [detail.reason] - extra context, for example a timeout.
   * @param {string} [detail.binary] - the executable that ran.
   * @param {string} [detail.tool] - `ffmpeg` or `ffprobe`.
   */
  constructor({ args, returnCode, stderr, reason, binary, tool = 'ffmpeg' }) {
    const tail = String(stderr ?? '').trim().split('\n').slice(-25).join('\n')
    const safeArgs = args.map((argument) => (/[^\x20-\x7e]/.test(argument) ? JSON.stringify(argument) : argument))
    const hint = explain(stderr)
    super(
      `${reason === undefined ? `${tool} 退出码 ${returnCode}` : reason}\n` +
        `命令：${tool} ${safeArgs.join(' ')}\n` +
        (binary === undefined ? '' : `可执行文件：${binary}\n`) +
        `stderr（尾部）：\n${tail}` +
        (hint === null ? '' : `\n\n可能的原因：${hint}`),
    )
    this.name = 'FfmpegError'
    this.args = [...args]
    this.tool = tool
    this.binary = binary
    this.returnCode = returnCode
    this.stderr = String(stderr ?? '')
    this.hint = hint
  }
}

/** Failures that have a known, non-obvious cause. First match wins. */
const EXPLANATIONS = [
  [/No such file or directory|Invalid argument.*No such/i, '输入或输出路径不存在，或者父目录还没创建。'],
  [/Unknown encoder '([^']+)'/i, '这份 ffmpeg 构建没有该编码器；用 ffmpeg_env {action:"caps"} 看它到底支持什么。'],
  [/Unknown decoder '([^']+)'/i, '这份 ffmpeg 构建没有该解码器。'],
  [/width or height not divisible by 2/i, 'H.264 要求宽高都是偶数；把缩放写成显式偶数，或改用 yuv420p 之外的像素格式。'],
  [/moov atom not found|Invalid data found when processing input/i, '输入文件不是完整的媒体，或者根本不是媒体文件（截断的 mp4 最常见）。'],
  [/Permission denied|being used by another process/i, '文件被别的进程占用（播放器、编辑器、同步盘最常见），或者没有写权限。'],
  [/No space left on device/i, '目标磁盘满了。'],
  [/does not contain any stream|Output file #0 does not contain any stream/i, '筛选或映射把所有流都丢掉了：检查 -map 与 trim 的区间是否落在文件内。'],
  [/Error initializing filter|No such filter|Error reinitializing filters/i, '滤镜表达式被拒（参数越界、引号被吃掉或滤镜名不存在）。'],
  [/Cannot allocate memory|out of memory/i, '内存不足：降低分析分辨率或把文件切成几段处理。'],
  [/Invalid data found|Invalid NAL unit|corrupt/i, '输入流里有损坏的数据；用 ffmpeg_probe {action:"integrity"} 量化坏在哪儿。'],
  [/Impossible to convert between the formats/i, '滤镜链的像素格式或采样率对不上，把 -pix_fmt 或 aresample 写清楚。'],
  [/already exists\. Overwrite/i, '输出现存且没被允许覆盖——本插件默认带 -y，出现这条说明参数被手工改过。'],
  [/At least one output file must be specified/i, '没有给输出文件。'],
  [/Invalid duration specification/i, '时长/时间戳写法不合法：用秒数或 HH:MM:SS.mmm。'],
]

/**
 * Map a familiar stderr line to a plain-language cause.
 *
 * @param {string} stderr - captured standard error.
 * @returns {string|null} one sentence, or null when nothing matches.
 */
export function explain(stderr) {
  const text = String(stderr ?? '')
  for (const [pattern, message] of EXPLANATIONS) {
    if (pattern.test(text)) return message
  }
  return null
}

/** How many ffmpeg processes may run at once. Set by the plugin config at first use. */
let maxConcurrent = 2

/** Currently running processes. */
let inFlight = 0

/** Callers waiting for a slot, oldest first. */
const waiting = []

/**
 * Set the concurrency limit.
 * @param {number} value - at least 1.
 * @returns {number} the accepted value.
 */
export function setMaxConcurrent(value) {
  if (Number.isFinite(value) && value >= 1) maxConcurrent = Math.floor(value)
  return maxConcurrent
}

/**
 * Take one of the ffmpeg slots, waiting when they are all busy.
 * @returns {Promise<() => void>} the release function; call it exactly once.
 */
async function acquireSlot() {
  if (inFlight < maxConcurrent) {
    inFlight += 1
    return release
  }
  return new Promise((resolveSlot) => {
    waiting.push(() => {
      inFlight += 1
      resolveSlot(release)
    })
  })

  /** @returns {void} */
  function release() {
    inFlight -= 1
    const next = waiting.shift()
    if (next !== undefined) next()
  }
}

/** Default deadline for a conversion: ten minutes, which is far past any interactive edit. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** How much stdout to keep when a caller is not reading it as a stream. */
const MAX_STDOUT_BYTES = 16 << 20

/**
 * Run one ffmpeg-family process.
 *
 * @param {object} options - the invocation.
 * @param {'ffmpeg'|'ffprobe'} [options.tool] - which binary to run. Default `ffmpeg`.
 * @param {string[]} options.args - arguments, in order, after the binary.
 * @param {object} [options.config] - normalized plugin config, for binary resolution and defaults.
 * @param {string} [options.cwd] - working directory; filter graphs may reference relative paths.
 * @param {number} [options.timeoutMs] - deadline. Defaults to the configured one.
 * @param {boolean} [options.progress] - add `-progress pipe:1 -nostats` and parse stdout into progress events.
 * @param {(progress: object) => void} [options.onProgress] - called for each progress block.
 * @param {(chunk: string) => void} [options.onStderr] - called with stderr as it arrives.
 * @param {AbortSignal} [options.signal] - cancel the run.
 * @param {boolean} [options.bypassQueue] - skip the concurrency slot. For short, read-only calls.
 * @returns {Promise<{code: number, stdout: string, stdoutBuffer: Buffer, stderr: string, argv: string[], binary: string, elapsedMs: number, progress: object|null}>} the outcome.
 * @throws {FfmpegNotFound} when the binary cannot be located.
 * @throws {FfmpegError} when the process fails, is killed, or times out.
 */
export async function run(options) {
  const { tool = 'ffmpeg', args, cwd, config = {}, onProgress, onStderr, signal } = options
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : Number.isFinite(config.defaultTimeoutMs) ? config.defaultTimeoutMs : DEFAULT_TIMEOUT_MS
  const binary = resolveTool(tool, config)
  if (binary === null) {
    // Reuse the throwing resolver for the message, so there is exactly one place that explains
    // where ffmpeg was looked for.
    requireTool(tool, config)
  }

  const base = tool === 'ffmpeg' ? ['-hide_banner', '-nostdin', '-y'] : ['-hide_banner']
  const argv = options.progress === true ? [...base, ...args, '-progress', 'pipe:1', '-nostats'] : [...base, ...args]

  const release = options.bypassQueue === true ? () => {} : await acquireSlot()
  const started = Date.now()
  try {
    return await new Promise((resolveRun, rejectRun) => {
      const child = spawn(binary.path, argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdoutChunks = []
      let stdoutBytes = 0
      let stderr = ''
      let settled = false
      let timedOut = false
      let aborted = false
      let lastProgress = null

      const finish = (callback, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener?.('abort', onAbort)
        callback(value)
      }

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      /** @returns {void} */
      const onAbort = () => {
        aborted = true
        child.kill('SIGKILL')
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })

      child.stdout.on('data', (chunk) => {
        if (options.progress === true) {
          const block = parseProgress(chunk.toString('utf8'))
          if (block !== null) {
            lastProgress = block
            onProgress?.(block)
          }
          return
        }
        if (stdoutBytes < MAX_STDOUT_BYTES) {
          stdoutChunks.push(chunk)
          stdoutBytes += chunk.length
        }
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        // Keep the tail bounded: the last lines are the ones that matter, and a runaway log must
        // not become a runaway allocation.
        stderr = (stderr + chunk).slice(-200_000)
        onStderr?.(chunk)
      })

      child.on('error', (error) => {
        finish(rejectRun, new FfmpegError({ args, returnCode: null, stderr, binary: binary.path, tool, reason: `无法启动 ${binary.path}：${error.message}` }))
      })

      child.on('close', (code) => {
        const elapsedMs = Date.now() - started
        const stdoutBuffer = Buffer.concat(stdoutChunks)
        const stdout = stdoutBuffer.toString('utf8')
        if (timedOut) {
          finish(rejectRun, new FfmpegError({ args, returnCode: code, stderr, binary: binary.path, tool, reason: `${tool} 超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止` }))
          return
        }
        if (aborted) {
          finish(rejectRun, new FfmpegError({ args, returnCode: code, stderr, binary: binary.path, tool, reason: `${tool} 被调用方取消` }))
          return
        }
        if (code !== 0) {
          finish(rejectRun, new FfmpegError({ args, returnCode: code, stderr, binary: binary.path, tool }))
          return
        }
        finish(resolveRun, { code, stdout, stdoutBuffer, stderr, argv, binary: binary.path, elapsedMs, progress: lastProgress })
      })
    })
  } finally {
    release()
  }
}

/**
 * Parse one `-progress` block out of a stdout chunk.
 *
 * ffmpeg writes `key=value` lines and ends each block with `progress=continue` (or `end`). A
 * chunk may hold part of a block, so the parse takes whatever complete keys it has and leaves the
 * rest: a missing key is reported as null rather than as zero, because "no frames yet" and "zero
 * frames" are different facts.
 *
 * @param {string} text - the chunk.
 * @returns {object|null} the progress block, or null when the chunk held no keys.
 */
export function parseProgress(text) {
  const result = {}
  let seen = false
  for (const line of String(text).split('\n')) {
    const match = /^([a-z_]+)=(.*)$/.exec(line.trim())
    if (match === null) continue
    seen = true
    const [, key, raw] = match
    const numeric = Number(raw)
    result[key] = Number.isFinite(numeric) && raw.trim() !== '' ? numeric : raw
  }
  if (!seen) return null
  // ffmpeg reports `out_time_ms` in MICROseconds — a long-standing misnomer that is kept for
  // compatibility — and writes the same number again as `out_time_us`. Reading the name instead of
  // the value would report a ten-minute encode as 0.6 seconds long.
  const outTimeUs = Number.isFinite(result.out_time_us) ? result.out_time_us : Number.isFinite(result.out_time_ms) ? result.out_time_ms : null
  return {
    frame: result.frame ?? null,
    fps: result.fps ?? null,
    outTimeUs,
    outTimeSec: outTimeUs === null ? null : outTimeUs / 1_000_000,
    totalSize: Number.isFinite(result.total_size) ? result.total_size : null,
    bitrateKbps: result.bitrate === undefined || result.bitrate === 'N/A' ? null : Number.parseFloat(result.bitrate),
    speed: typeof result.speed === 'string' ? result.speed.replace(/x$/, '') : null,
    done: result.progress === 'end',
  }
}

/**
 * Read an ffprobe JSON document for one file.
 *
 * @param {string[]} args - arguments after the binary.
 * @param {object} [config] - normalized plugin config.
 * @param {number} [timeoutMs] - deadline; a probe that hangs means an unreadable file.
 * @returns {Promise<object>} the parsed document.
 * @throws {FfmpegNotFound} when ffprobe is missing.
 * @throws {FfmpegError} when ffprobe fails or prints something that is not JSON.
 */
export async function runProbe(args, config = {}, timeoutMs = 60_000) {
  const result = await run({ tool: 'ffprobe', args, config, timeoutMs, bypassQueue: true })
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new FfmpegError({
      args,
      returnCode: 0,
      stderr: result.stdout,
      tool: 'ffprobe',
      reason: `ffprobe 的输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * Decode a video to raw RGB frames and hand each one over as it becomes whole.
 *
 * One pass over the file answers every visual question this plugin asks — cuts, motion, region
 * labels, dominant colours — so this is the only decode of the source that the analysis does.
 * Frames are delivered at a small analysis size, which is what makes the pass cheap; the
 * full-resolution stills a human or an OCR engine needs are pulled afterwards, one seek each.
 *
 * `onFrame` is synchronous on purpose: the frame buffer is reused, so a caller that keeps one
 * must copy it.
 *
 * @param {object} options - the decode.
 * @param {string} options.input - the file to decode.
 * @param {number} options.width - output width in pixels; must be even.
 * @param {number} options.height - output height in pixels; must be even.
 * @param {number} [options.fps] - frames per second to keep. Default 4.
 * @param {number} [options.start] - start decoding here, in seconds.
 * @param {number} [options.duration] - stop after this many seconds.
 * @param {object} [options.config] - normalized plugin config.
 * @param {number} [options.timeoutMs] - deadline for the whole pass.
 * @param {(frame: Uint8Array, index: number, timeSec: number) => void} options.onFrame - one whole frame of `width*height*3` bytes.
 * @param {number} [options.maxFrames] - stop after this many frames, for a bounded probe.
 * @returns {Promise<{frames: number, bytes: number, stderr: string, elapsedMs: number, timedOut: boolean, code: number|null}>} what the pass produced.
 * @throws {FfmpegNotFound} when ffmpeg is missing.
 */
export async function decodeRawFrames(options) {
  const { input, width, height, fps = 4, start, duration, config = {}, onFrame, maxFrames } = options
  if (!existsSync(input)) {
    throw new FfmpegError({ args: [], returnCode: null, stderr: '', tool: 'ffmpeg', reason: `要分析的输入文件不存在：${input}` })
  }
  const binary = resolveTool('ffmpeg', config)
  if (binary === null) requireTool('ffmpeg', config)

  const frameBytes = width * height * 3
  const args = ['-hide_banner', '-nostdin', '-v', 'error']
  if (Number.isFinite(start) && start > 0) args.push('-ss', String(start))
  args.push('-i', longPath(input))
  if (Number.isFinite(duration) && duration > 0) args.push('-t', String(duration))
  args.push('-an', '-sn', '-dn', '-vf', `fps=${fps},scale=${width}:${height}:flags=bilinear`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-')

  const release = await acquireSlot()
  const started = Date.now()
  return await new Promise((resolveDecode) => {
    const child = spawn(binary.path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let pending = Buffer.alloc(0)
    let frames = 0
    let bytes = 0
    let stderr = ''
    let timedOut = false
    let stopped = false
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30 * 60 * 1000
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const stop = () => {
      if (stopped) return
      stopped = true
      child.kill('SIGKILL')
    }

    child.stdout.on('data', (chunk) => {
      if (stopped) return
      bytes += chunk.length
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes)
        pending = pending.subarray(frameBytes)
        const timeSec = start !== undefined && start > 0 ? start + frames / fps : frames / fps
        frames += 1
        onFrame(frame, frames - 1, timeSec)
        if (Number.isFinite(maxFrames) && frames >= maxFrames) {
          stop()
          break
        }
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-100_000)
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      release()
      resolveDecode({ frames, bytes, stderr: `${stderr}\n无法启动 ${binary.path}：${error.message}`, elapsedMs: Date.now() - started, timedOut: false, code: null })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      release()
      resolveDecode({ frames, bytes, stderr: stderr.trim(), elapsedMs: Date.now() - started, timedOut, code })
    })
  })
}

/**
 * Delete a file if it is there, and never throw about it.
 *
 * Partial outputs are the normal debris of a failed encode, and leaving one behind is how a
 * "conversion failed" turns into a "delivery is corrupt" two steps later.
 *
 * @param {string} path - the file to remove.
 * @returns {boolean} whether it is gone now.
 */
export function removeQuietly(path) {
  try {
    if (existsSync(path)) rmSync(path, { force: true })
    return !existsSync(path)
  } catch {
    return false
  }
}
