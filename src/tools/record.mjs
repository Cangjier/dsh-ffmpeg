/**
 * `ffmpeg_record` — capturing this machine, for a fixed number of seconds.
 *
 * @module dsh-ffmpeg/tools/record
 */
import { dirname } from 'node:path'
import { capabilities, checkNeeds } from '../core/caps.mjs'
import { ensureDir, resolveCwd } from '../core/env.mjs'
import { execute } from '../core/media.mjs'
import { MAX_RECORD_SECONDS, audioPlan as audioRecordPlan, screenPlan } from '../core/record.mjs'
import {
  CWD_PROPERTY,
  FORCE_PROPERTY,
  TIMEOUT_PROPERTY,
  FfmpegPluginError,
  defineFamilyTool,
  optionalBoolean,
  optionalObject,
  requirePositiveNumber,
  requireString,
} from './shared.mjs'

/** Every action `ffmpeg_record` dispatches. */
export const RECORD_ACTIONS = ['screen', 'microphone']

/**
 * Build the `ffmpeg_record` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createRecordTool(config, logger) {
  const where = 'ffmpeg_record'

  /**
   * Check the build can capture this way before the machine starts capturing.
   *
   * A missing `gdigrab` is discovered here, in milliseconds, instead of after a 30-second recording
   * that produced nothing.
   *
   * @param {{capture: string, encoders?: string[]}} needs - what the capture requires.
   * @returns {Promise<void>}
   * @throws {FfmpegPluginError} when the build cannot do it.
   */
  const preflight = async (needs) => {
    const report = await capabilities(config)
    const verdict = checkNeeds(report, needs)
    if (!verdict.ok) {
      throw new FfmpegPluginError(
        `这份 ffmpeg 构建缺少 ${verdict.missing.join('、')}，无法采集。\n` +
          '用 ffmpeg_setup {action:"install"} 换一份带 gdigrab / dshow 的完整构建。',
      )
    }
  }

  /**
   * Resolve one path against the call's working directory.
   * @param {string} value - the caller's path, or undefined.
   * @param {object} context - the tool context.
   * @returns {string} an absolute path.
   */
  const pathOf = (value, context) => resolveCwd(config, value ?? context.cwd)

  return defineFamilyTool({
    name: 'ffmpeg_record',
    actions: RECORD_ACTIONS,
    extraProperties: {
      out: { type: 'string', description: 'Where to write the recording. The extension picks the container: .mp4 for a screen recording, .wav / .m4a for audio.' },
      seconds: { type: 'number', description: `How long to capture, in seconds. Required, and capped at ${MAX_RECORD_SECONDS} (one hour).` },
      fps: { type: 'number', description: 'screen: capture cadence. Default 15, which is plenty for screen content and half the CPU of 30.' },
      window: { type: 'string', description: 'screen: capture this window by title instead of the whole desktop. The window must stay open, or the recording ends early.' },
      region: { type: 'object', additionalProperties: true, description: 'screen: capture only a rectangle, {x, y, width, height} in screen pixels. Cannot be combined with "window".' },
      drawMouse: { type: 'boolean', description: 'screen: draw the pointer into the recording. Default true — a demo without a cursor is hard to follow.' },
      audioDevice: { type: 'string', description: 'screen: also capture this DirectShow audio device. The name must match ffmpeg_env {action:"devices"} exactly.' },
      device: { type: 'string', description: 'microphone: the DirectShow capture device name, exactly as ffmpeg_env {action:"devices"} reports it.' },
      video: { type: 'object', additionalProperties: true, description: 'screen: encoder settings. Defaults to libx264 veryfast crf 20 yuv420p, the right trade for screen content.' },
      audio: { type: 'object', additionalProperties: true, description: 'Audio encoder settings. Defaults to aac 160k stereo for a screen recording, 48 kHz mono for a microphone.' },
      rtBufferMb: { type: 'number', description: 'DirectShow real-time buffer in MB. Default 128; raise it when samples are dropped.' },
      force: FORCE_PROPERTY,
      timeoutMs: TIMEOUT_PROPERTY,
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * Record the screen, a window or a region.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written, and how long it really is.
       */
      async screen(args, context) {
        const out = pathOf(requireString(args, 'out', `${where} screen`), context)
        const seconds = requirePositiveNumber(args, 'seconds', `${where} screen`)
        if (seconds > MAX_RECORD_SECONDS) throw new FfmpegPluginError(`${where} screen: 一次最多录 ${MAX_RECORD_SECONDS} 秒；收到 ${seconds}。`)
        const hasAudio = typeof args.audioDevice === 'string' && args.audioDevice !== ''
        await preflight({ capture: 'gdigrab', encoders: hasAudio ? ['libx264', 'aac'] : ['libx264'] })

        const plan = screenPlan({
          out,
          seconds,
          fps: Number.isFinite(args.fps) ? args.fps : undefined,
          window: typeof args.window === 'string' ? args.window : undefined,
          region: optionalObject(args, 'region', `${where} screen`),
          drawMouse: optionalBoolean(args, 'drawMouse', true, `${where} screen`),
          audioDevice: hasAudio ? args.audioDevice : undefined,
          video: optionalObject(args, 'video', `${where} screen`) ?? {},
          audio: optionalObject(args, 'audio', `${where} screen`) ?? {},
          rtBufferMb: Number.isFinite(args.rtBufferMb) ? args.rtBufferMb : undefined,
        })
        ensureDir(dirname(out))
        logger.info(`dsh-ffmpeg: 开始录屏 ${seconds}s → ${out}`)
        const result = await execute(plan, { config, timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : plan.timeoutMs })
        const actual = result.files[0]?.facts?.durationSec ?? null
        const short = actual !== null && actual < seconds * 0.9
        logger.info(`dsh-ffmpeg: 录屏结束，实际时长 ${actual ?? '?'}s（要求 ${seconds}s）`)
        return {
          ...result,
          requestedSeconds: seconds,
          actualSeconds: actual,
          notes: [
            ...result.notes,
            actual === null
              ? '读不出实际时长：录制可能没有正常结束。'
              : short
                ? `实际只录到 ${actual}s，比要求的 ${seconds}s 短：窗口被关掉、屏幕锁定，或者编码跟不上（降低 fps 或分辨率）。`
                : '录制时长与要求一致。',
          ],
          ok: result.ok && !short,
        }
      },

      /**
       * Record from a microphone or another DirectShow capture device.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async microphone(args, context) {
        const out = pathOf(requireString(args, 'out', `${where} microphone`), context)
        const seconds = requirePositiveNumber(args, 'seconds', `${where} microphone`)
        if (seconds > MAX_RECORD_SECONDS) throw new FfmpegPluginError(`${where} microphone: 一次最多录 ${MAX_RECORD_SECONDS} 秒；收到 ${seconds}。`)
        const device = requireString(args, 'device', `${where} microphone`)
        await preflight({ capture: 'dshow', encoders: ['aac'] })

        const plan = audioRecordPlan({
          out,
          seconds,
          device,
          audio: optionalObject(args, 'audio', `${where} microphone`) ?? {},
          rtBufferMb: Number.isFinite(args.rtBufferMb) ? args.rtBufferMb : undefined,
        })
        ensureDir(dirname(out))
        logger.info(`dsh-ffmpeg: 开始录音 ${seconds}s（${device}）→ ${out}`)
        const result = await execute(plan, { config, timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : plan.timeoutMs })
        const actual = result.files[0]?.facts?.durationSec ?? null
        return {
          ...result,
          requestedSeconds: seconds,
          actualSeconds: actual,
          notes: [
            ...result.notes,
            actual !== null && actual < seconds * 0.9
              ? `只录到 ${actual}s，比要求的 ${seconds}s 短：设备可能被别的程序占用。`
              : '录音长度与要求一致。',
          ],
        }
      },
    },
  })
}
