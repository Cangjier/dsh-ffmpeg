/**
 * `ffmpeg_probe` — what a file is, whether it is intact, and where it can be cut.
 *
 * @module dsh-ffmpeg/tools/probe
 */
import { integrity, keyframeTimes, probe, probeMany } from '../core/probe.mjs'
import { CWD_PROPERTY, FfmpegPluginError, TIMEOUT_PROPERTY, defineFamilyTool, optionalStringArray } from './shared.mjs'

/** Every action `ffmpeg_probe` dispatches. */
export const PROBE_ACTIONS = ['info', 'integrity', 'keyframes']

/**
 * Reduce a probe result to the part worth returning: the raw ffprobe document stays out of the
 * answer unless it is asked for, because it is large and almost never what the caller wanted.
 *
 * @param {object} facts - a probe result.
 * @returns {object} the reportable subset.
 */
export function digestFacts(facts) {
  return {
    path: facts.path,
    bytes: facts.bytes,
    kind: facts.kind,
    formatName: facts.formatName,
    formatLongName: facts.formatLongName,
    durationSec: facts.durationSec,
    bitRate: facts.bitRate,
    tags: facts.tags,
    video:
      facts.video === null
        ? null
        : {
            codec: facts.video.codec,
            width: facts.video.width,
            height: facts.video.height,
            displayWidth: facts.video.displayWidth,
            displayHeight: facts.video.displayHeight,
            rotation: facts.video.rotation,
            fps: facts.video.fps,
            declaredFps: facts.video.declaredFps,
            pixFmt: facts.video.pixFmt,
            bitRate: facts.video.bitRate,
            frames: facts.video.frames,
          },
    audio:
      facts.audio === null
        ? null
        : {
            codec: facts.audio.codec,
            sampleRate: facts.audio.sampleRate,
            channels: facts.audio.channels,
            channelLayout: facts.audio.channelLayout,
            bitRate: facts.audio.bitRate,
            language: facts.audio.language,
          },
    subtitles: facts.subtitles,
    streamCount: facts.streams.length,
    streamTypes: facts.streams.map((stream) => `${stream.index}:${stream.type}:${stream.codec}`),
    problems: facts.problems,
  }
}

/**
 * Build the `ffmpeg_probe` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createProbeTool(config, logger) {
  const where = 'ffmpeg_probe'

  return defineFamilyTool({
    name: 'ffmpeg_probe',
    actions: PROBE_ACTIONS,
    extraProperties: {
      target: { type: 'string', description: 'info / integrity / keyframes: the file to inspect.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'info: several files at once instead of target. A file that fails is reported in "failed" rather than failing the call.' },
      raw: { type: 'boolean', description: 'info: include the whole ffprobe JSON document for each file. Large, and rarely what you want.' },
      limit: { type: 'number', description: 'keyframes: report at most this many timestamps. Default 200.' },
      timeoutMs: TIMEOUT_PROPERTY,
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * Report the specs of one or more files.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the reports.
       */
      async info(args) {
        const paths = optionalStringArray(args, 'paths', `${where} info`)
        const target = typeof args.target === 'string' && args.target !== '' ? args.target : undefined
        if (paths === undefined && target === undefined) {
          throw new FfmpegPluginError(`${where} info: 需要 target（一个文件）或 paths（多个文件）。`)
        }
        const list = paths ?? [target]
        const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined
        const facts = []
        const failed = []
        for (const path of list) {
          try {
            facts.push(await probe(path, config, timeoutMs))
          } catch (error) {
            failed.push({ path, error: error instanceof Error ? error.message : String(error) })
          }
        }
        for (const entry of facts) {
          if (entry.problems.length > 0) logger.info(`dsh-ffmpeg: ${entry.path} 有 ${entry.problems.length} 条值得注意的问题`)
        }
        return {
          files: facts.map((entry) => ({ ...digestFacts(entry), raw: args.raw === true ? entry.raw : undefined })),
          failed,
          notes: facts.length === 0 ? ['一个文件都没读成功。'] : [],
        }
      },

      /**
       * Decode a file end to end and report what came out.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the verdict.
       */
      async integrity(args) {
        if (typeof args.target !== 'string' || args.target === '') throw new FfmpegPluginError(`${where} integrity: 需要 target。`)
        const report = await integrity(args.target, config, {
          timeoutMs: Number.isFinite(args.timeoutMs) ? args.timeoutMs : undefined,
        })
        logger.info(`dsh-ffmpeg: integrity ${args.target} → ok=${report.ok}，解出 ${report.decodedFrames ?? '?'} 帧`)
        return report
      },

      /**
       * List the video stream's keyframe timestamps.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the timestamps.
       */
      async keyframes(args) {
        if (typeof args.target !== 'string' || args.target === '') throw new FfmpegPluginError(`${where} keyframes: 需要 target。`)
        const limit = Number.isFinite(args.limit) ? Math.max(1, Math.floor(args.limit)) : 200
        const result = await keyframeTimes(args.target, config, limit)
        return {
          path: args.target,
          ...result,
          notes:
            result.count === 0
              ? ['读不到关键帧时间戳：可能是纯音频、损坏的索引，或者这份构建不支持 -skip_frame。']
              : ['流复制裁剪只能从这些时间点开始；要任意起点请用 ffmpeg_convert {action:"trim", mode:"encode"}。'],
        }
      },
    },
  })
}
