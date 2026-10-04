/**
 * `ffmpeg_env` — what this machine has, before anything is attempted.
 *
 * @module dsh-ffmpeg/tools/env
 */
import { capabilities, listCaptureDevices, resetCapabilityCache, videoEncoderOptions } from '../core/caps.mjs'
import { setMaxConcurrent } from '../core/ffmpeg.mjs'
import { installState } from '../core/install.mjs'
import { resolveTool, vendoredState, versionOf } from '../core/env.mjs'
import { CWD_PROPERTY, defineFamilyTool } from './shared.mjs'

/** Every action `ffmpeg_env` dispatches. */
export const ENV_ACTIONS = ['probe', 'caps', 'devices']

/**
 * Build the `ffmpeg_env` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createEnvTool(config, logger) {
  const where = 'ffmpeg_env'

  return defineFamilyTool({
    name: 'ffmpeg_env',
    actions: ENV_ACTIONS,
    extraProperties: {
      refresh: { type: 'boolean', description: 'caps: ignore the cached capability report and ask the build again.' },
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * Report which executables would answer, and where they came from.
       * @returns {Promise<object>} the report.
       */
      async probe() {
        const ffmpeg = resolveTool('ffmpeg', config)
        const ffprobe = resolveTool('ffprobe', config)
        const versions = await Promise.all([
          ffmpeg === null ? Promise.resolve(null) : versionOf(ffmpeg.path),
          ffprobe === null ? Promise.resolve(null) : versionOf(ffprobe.path),
        ])
        return {
          ffmpeg: ffmpeg === null ? null : { ...ffmpeg, version: versions[0] },
          ffprobe: ffprobe === null ? null : { ...ffprobe, version: versions[1] },
          vendor: vendoredState(),
          install: installState(config),
          concurrency: setMaxConcurrent(config.maxConcurrent),
          timeoutMs: config.defaultTimeoutMs,
          notes:
            ffmpeg === null
              ? ['没有可用的 ffmpeg：几乎每个 action 都会失败，先跑 ffmpeg_setup {action:"install"}。']
              : ffmpeg.source === 'path'
                ? ['当前用的是 PATH 上的 ffmpeg：换机器或换版本会改变结果，要可复现请 ffmpeg_setup {action:"install"}。']
                : [],
        }
      },

      /**
       * Report what the build can encode, filter and capture.
       * @param {object} args - `{ refresh }`.
       * @returns {Promise<object>} the capability report.
       */
      async caps(args) {
        if (args.refresh === true) resetCapabilityCache()
        const report = await capabilities(config, { refresh: args.refresh === true })
        const options = videoEncoderOptions(report)
        const missingBasics = []
        if (report.encoders.libx264 !== true) missingBasics.push('libx264（软件 H.264）')
        if (report.encoders.aac !== true) missingBasics.push('aac')
        if (report.capture.gdigrab !== true) missingBasics.push('gdigrab（录屏）')
        if (report.capture.dshow !== true) missingBasics.push('dshow（录音与摄像头）')
        logger.info(`dsh-ffmpeg: caps 来自 ${report.ffmpeg.path}`)
        return {
          ...report,
          encoderOptions: options,
          missingBasics,
          notes:
            missingBasics.length === 0
              ? ['这份构建具备本插件需要的全部基础能力。']
              : [`这份构建缺少：${missingBasics.join('、')}。相关 action 会在动手之前拒绝。`],
        }
      },

      /**
       * List the DirectShow capture devices.
       * @returns {Promise<object>} the device list.
       */
      async devices() {
        return listCaptureDevices(config)
      },
    },
  })
}
