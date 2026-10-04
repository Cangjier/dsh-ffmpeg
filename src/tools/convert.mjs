/**
 * `ffmpeg_convert` — turning one piece of media into another, with the refusals in front.
 *
 * Every action here follows the same shape: work out the request, check the machine can do it
 * (capabilities, before any work starts), build the plan, execute it, and then measure what was
 * written. The measurement is not decoration — it is the only thing that distinguishes "ffmpeg
 * exited 0" from "the file you asked for exists and is what you asked for".
 *
 * @module dsh-ffmpeg/tools/convert
 */
import { existsSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { capabilities, checkNeeds } from '../core/caps.mjs'
import { ensureDir, resolveCwd } from '../core/env.mjs'
import {
  assertSeparate,
  audioPlan,
  concatPlan,
  containerFor,
  execute,
  framesPlan,
  gifPlan,
  subtitlesPlan,
  transcodePlan,
  trimPlan,
} from '../core/media.mjs'
import {
  CWD_PROPERTY,
  FORCE_PROPERTY,
  OVERWRITE_INPUT_PROPERTY,
  TIMEOUT_PROPERTY,
  FfmpegPluginError,
  defineFamilyTool,
  optionalBoolean,
  optionalEnum,
  optionalObject,
  optionalStringArray,
  requireString,
} from './shared.mjs'

/** Every action `ffmpeg_convert` dispatches. */
export const CONVERT_ACTIONS = ['transcode', 'trim', 'audio', 'frames', 'concat', 'subtitles', 'gif']

/** What each action needs from the build, checked before it runs. */
const ACTION_NEEDS = {
  transcode: { encoders: ['libx264', 'aac'], filters: ['scale'] },
  trim: { encoders: ['libx264', 'aac'] },
  audio: { encoders: ['aac'] },
  frames: { encoders: ['mjpeg'], filters: ['scale', 'fps'] },
  concat: { filters: ['concat'] },
  subtitles: { filters: ['subtitles'] },
  gif: { encoders: ['gif'], filters: ['palettegen', 'paletteuse', 'fps', 'scale'] },
}

/**
 * Build the `ffmpeg_convert` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createConvertTool(config, logger) {
  const where = 'ffmpeg_convert'

  /**
   * Check the build can do this, and return anything worth saying either way.
   *
   * @param {string} action - the action name.
   * @param {object} extra - additional needs, for example an encoder the caller chose.
   * @returns {Promise<string[]>} notes to attach to the answer.
   * @throws {FfmpegPluginError} when something required is missing.
   */
  const preflight = async (action, extra = {}) => {
    const needs = ACTION_NEEDS[action] ?? {}
    const merged = {
      encoders: [...new Set([...(needs.encoders ?? []), ...(extra.encoders ?? [])])],
      filters: [...new Set([...(needs.filters ?? []), ...(extra.filters ?? [])])],
      capture: extra.capture,
    }
    const report = await capabilities(config)
    const verdict = checkNeeds(report, merged)
    if (!verdict.ok) {
      throw new FfmpegPluginError(
        `这份 ffmpeg 构建缺少 ${verdict.missing.join('、')}，这一步无法完成。\n` +
          `用 ffmpeg_env {action:"caps"} 看它到底支持什么，或者 ffmpeg_setup {action:"install"} 换一份完整构建。`,
      )
    }
    return [...verdict.degraded, ...verdict.notes]
  }

  /**
   * Resolve one path against the call's working directory.
   * @param {string} value - the caller's path.
   * @param {object} context - the tool context.
   * @returns {string} an absolute path.
   */
  const pathOf = (value, context) => resolveCwd(config, value ?? context.cwd)

  return defineFamilyTool({
    name: 'ffmpeg_convert',
    actions: CONVERT_ACTIONS,
    extraProperties: {
      input: { type: 'string', description: 'The source file. Required by every action except concat, which takes "inputs".' },
      inputs: { type: 'array', items: { type: 'string' }, description: 'concat: two or more files to join, in order.' },
      out: { type: 'string', description: 'The output file. Its extension picks the container and the default codecs. Must not be one of the inputs.' },
      outDir: { type: 'string', description: 'frames: directory for the stills. Created when missing.' },
      prefix: { type: 'string', description: 'frames: file name stem for the stills. Default "frame".' },
      mode: {
        type: 'string',
        enum: ['encode', 'copy'],
        description: 'trim: "encode" for a frame-exact cut, "copy" for a packet copy that can only start at a keyframe. concat: "copy" when every clip already matches, "encode" when they do not. audio: extract / drop / replace / normalize. subtitles: burn / mux.',
      },
      video: { type: 'object', additionalProperties: true, description: 'Codec settings: {codec, crf, preset, bitrate, pixFmt, scale, fps, profile}. Defaults come from the container — an .mp4 gives libx264 crf 20 and yuv420p.' },
      audio: { type: 'object', additionalProperties: true, description: 'Audio settings: {codec, bitrate, channels, sampleRate, drop}. Defaults come from the container — an .mp4 gives aac 160k.' },
      start: { type: 'number', description: 'trim / gif: where the piece starts, in seconds.' },
      duration: { type: 'number', description: 'trim / gif: how long the piece is, in seconds. Alternative to "end".' },
      end: { type: 'number', description: 'trim: where the piece ends, in seconds. Used only when "duration" is absent.' },
      at: { type: 'number', description: 'frames: one timestamp to extract. Cannot be combined with times or fps.' },
      times: { type: 'array', items: { type: 'number' }, description: 'frames: several timestamps, one still each. Cannot be combined with at or fps.' },
      fps: { type: 'number', description: 'frames: extract at this cadence instead of named times. gif: frames per second of the result.' },
      maxSide: { type: 'number', description: 'frames: longest side of each still, in pixels. Never upscales. Default 1280.' },
      format: { type: 'string', enum: ['jpg', 'png', 'webp'], description: 'frames: still format. Default jpg.' },
      quality: { type: 'number', description: 'frames: JPEG quality, 2 (best) to 31 (worst). Default 3.' },
      width: { type: 'number', description: 'gif: pixel width of the result. Height follows the aspect ratio.' },
      loop: { type: 'number', description: 'gif: how many times to loop. 0 (default) means forever.' },
      audioPath: { type: 'string', description: 'audio replace: the file whose audio replaces the video\\u2019s own.' },
      normalize: { type: 'object', additionalProperties: true, description: 'audio normalize: {targetI, truePeak, range}. Defaults come from EBU R128: -16 LUFS, -1.5 dBTP, 11 LU.' },
      srt: { type: 'string', description: 'subtitles: the .srt or .ass file.' },
      style: { type: 'string', description: 'subtitles burn: extra force_style for libass, for example "FontSize=22,PrimaryColour=&H00FFFFFF".' },
      targetI: { type: 'number', description: 'audio normalize: shorthand for normalize.targetI.' },
      overwriteInput: OVERWRITE_INPUT_PROPERTY,
      force: FORCE_PROPERTY,
      timeoutMs: TIMEOUT_PROPERTY,
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * Transcode one input into one output.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async transcode(args, context) {
        const input = pathOf(requireString(args, 'input', `${where} transcode`), context)
        const out = pathOf(requireString(args, 'out', `${where} transcode`), context)
        if (!existsSync(input)) throw new FfmpegPluginError(`输入不存在：${input}`)
        assertSeparate(out, input, optionalBoolean(args, 'overwriteInput', false, where) === true)
        const request = {
          input,
          out,
          video: optionalObject(args, 'video', `${where} transcode`) ?? {},
          audio: optionalObject(args, 'audio', `${where} transcode`) ?? {},
        }
        const container = containerFor(out)
        const notes = await preflight('transcode', { encoders: [request.video.codec, request.audio.codec].filter((name) => typeof name === 'string') })
        const plan = transcodePlan(request)
        ensureDir(dirname(out))
        const result = await execute(plan, { config, timeoutMs: args.timeoutMs })
        logger.info(`dsh-ffmpeg: transcode ${input} → ${out}（${result.elapsedMs} ms，ok=${result.ok}）`)
        return { ...result, notes: [...notes, ...result.notes], container: container.muxer }
      },

      /**
       * Cut a piece out of a file.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async trim(args, context) {
        const input = pathOf(requireString(args, 'input', `${where} trim`), context)
        const out = pathOf(requireString(args, 'out', `${where} trim`), context)
        assertSeparate(out, input, optionalBoolean(args, 'overwriteInput', false, where) === true)
        const mode = optionalEnum(args, 'mode', ['encode', 'copy'], 'encode', `${where} trim`)
        const request = {
          input,
          out,
          mode,
          start: Number.isFinite(args.start) ? args.start : 0,
          duration: Number.isFinite(args.duration) ? args.duration : undefined,
          end: Number.isFinite(args.end) ? args.end : undefined,
          video: optionalObject(args, 'video', `${where} trim`) ?? {},
          audio: optionalObject(args, 'audio', `${where} trim`) ?? {},
        }
        const notes = mode === 'copy' ? [] : await preflight('trim')
        const plan = trimPlan(request)
        ensureDir(dirname(out))
        const result = await execute(plan, { config, timeoutMs: args.timeoutMs })
        logger.info(`dsh-ffmpeg: trim ${input} → ${out}（mode=${mode}，${result.elapsedMs} ms）`)
        return { ...result, notes: [...notes, ...result.notes], mode }
      },

      /**
       * Extract, drop, replace or normalize audio.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async audio(args, context) {
        const input = pathOf(requireString(args, 'input', `${where} audio`), context)
        const out = pathOf(requireString(args, 'out', `${where} audio`), context)
        const audioPath = typeof args.audioPath === 'string' ? pathOf(args.audioPath, context) : undefined
        assertSeparate(out, audioPath === undefined ? [input] : [input, audioPath], optionalBoolean(args, 'overwriteInput', false, where) === true)
        const mode = optionalEnum(args, 'mode', ['extract', 'drop', 'replace', 'normalize'], 'extract', `${where} audio`)
        const normalize = optionalObject(args, 'normalize', `${where} audio`) ?? {}
        if (Number.isFinite(args.targetI)) normalize.targetI = args.targetI
        const request = {
          input,
          out,
          mode,
          audioPath: typeof args.audioPath === 'string' ? pathOf(args.audioPath, context) : undefined,
          audio: optionalObject(args, 'audio', `${where} audio`) ?? {},
          normalize,
        }
        const needs = mode === 'normalize' ? { filters: ['loudnorm'] } : {}
        const notes = await preflight('audio', needs)
        const plan = audioPlan(request)
        ensureDir(dirname(out))
        const result = await execute(plan, { config, timeoutMs: args.timeoutMs })
        logger.info(`dsh-ffmpeg: audio ${mode} ${input} → ${out}（${result.elapsedMs} ms）`)
        return { ...result, notes: [...notes, ...result.notes], mode }
      },

      /**
       * Extract one or more stills.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async frames(args, context) {
        const input = pathOf(requireString(args, 'input', `${where} frames`), context)
        const outDir = pathOf(requireString(args, 'outDir', `${where} frames`), context)
        const hasAt = Number.isFinite(args.at)
        const hasTimes = Array.isArray(args.times) && args.times.length > 0
        const hasFps = Number.isFinite(args.fps)
        if (hasAt && hasTimes) {
          throw new FfmpegPluginError(`${where} frames: at 与 times 只能给一个（at 是一个时间点，times 是若干时间点）。`)
        }
        if (!hasAt && !hasTimes && !hasFps) {
          throw new FfmpegPluginError(`${where} frames: 需要 at（一个时间点）、times（若干时间点）或 fps（频率）之一。`)
        }
        if (hasTimes && args.times.some((value) => !Number.isFinite(value))) {
          throw new FfmpegPluginError(`${where} frames: times 里必须全是数字，单位是秒。`)
        }
        ensureDir(outDir)
        const notes = await preflight('frames')
        const plan = framesPlan({
          input,
          outDir,
          at: hasAt ? args.at : undefined,
          times: hasTimes ? args.times : undefined,
          fps: hasFps ? args.fps : undefined,
          maxSide: Number.isFinite(args.maxSide) ? args.maxSide : undefined,
          format: optionalEnum(args, 'format', ['jpg', 'png', 'webp'], 'jpg', `${where} frames`),
          quality: Number.isFinite(args.quality) ? args.quality : undefined,
          prefix: typeof args.prefix === 'string' ? args.prefix : undefined,
        })
        const result = await execute(plan, { config, timeoutMs: args.timeoutMs })
        logger.info(`dsh-ffmpeg: frames ${input} → ${outDir}（${result.files.length} 项）`)
        return { ...result, notes: [...notes, ...result.notes] }
      },

      /**
       * Join several clips.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async concat(args, context) {
        const inputs = optionalStringArray(args, 'inputs', `${where} concat`)
        if (inputs === undefined) throw new FfmpegPluginError(`${where} concat: 需要 inputs（至少两个文件）。`)
        const resolved = inputs.map((entry) => pathOf(entry, context))
        const out = pathOf(requireString(args, 'out', `${where} concat`), context)
        assertSeparate(out, resolved, optionalBoolean(args, 'overwriteInput', false, where) === true)
        const mode = optionalEnum(args, 'mode', ['copy', 'encode'], 'copy', `${where} concat`)
        const notes = mode === 'encode' ? await preflight('concat') : []
        const { plan, listPath } = await concatPlan({
          inputs: resolved,
          out,
          mode,
          video: optionalObject(args, 'video', `${where} concat`) ?? {},
          audio: optionalObject(args, 'audio', `${where} concat`) ?? {},
          config,
        })
        ensureDir(dirname(out))
        const result = await execute(plan, { config, timeoutMs: args.timeoutMs })
        logger.info(`dsh-ffmpeg: concat ${resolved.length} 段 → ${out}（mode=${mode}）`)
        return { ...result, listPath, notes: [...notes, ...result.notes], mode }
      },

      /**
       * Burn or mux subtitles.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async subtitles(args, context) {
        const input = pathOf(requireString(args, 'input', `${where} subtitles`), context)
        const out = pathOf(requireString(args, 'out', `${where} subtitles`), context)
        const srt = pathOf(requireString(args, 'srt', `${where} subtitles`), context)
        assertSeparate(out, [input, srt], optionalBoolean(args, 'overwriteInput', false, where) === true)
        const mode = optionalEnum(args, 'mode', ['burn', 'mux'], 'burn', `${where} subtitles`)
        const notes = mode === 'burn' ? await preflight('subtitles') : []
        const plan = subtitlesPlan({
          input,
          out,
          srt,
          mode,
          style: typeof args.style === 'string' ? args.style : undefined,
          video: optionalObject(args, 'video', `${where} subtitles`) ?? {},
        })
        ensureDir(dirname(out))
        const result = await execute(plan, { config, timeoutMs: args.timeoutMs })
        logger.info(`dsh-ffmpeg: subtitles ${mode} ${srt} → ${out}`)
        return { ...result, notes: [...notes, ...result.notes], mode }
      },

      /**
       * Build a GIF.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} what was written.
       */
      async gif(args, context) {
        const input = pathOf(requireString(args, 'input', `${where} gif`), context)
        const out = pathOf(requireString(args, 'out', `${where} gif`), context)
        if (extname(out).toLowerCase() !== '.gif') throw new FfmpegPluginError(`${where} gif: 输出必须以 .gif 结尾。`)
        assertSeparate(out, input, optionalBoolean(args, 'overwriteInput', false, where) === true)
        if (!Number.isFinite(args.duration)) throw new FfmpegPluginError(`${where} gif: 需要 duration（秒）。`)
        const notes = await preflight('gif')
        const plan = gifPlan({
          input,
          out,
          start: Number.isFinite(args.start) ? args.start : 0,
          duration: args.duration,
          fps: Number.isFinite(args.fps) ? args.fps : undefined,
          width: Number.isFinite(args.width) ? args.width : undefined,
          loop: Number.isFinite(args.loop) ? args.loop : undefined,
        })
        ensureDir(dirname(out))
        const result = await execute(plan, { config, timeoutMs: args.timeoutMs })
        logger.info(`dsh-ffmpeg: gif ${input} → ${out}（${result.elapsedMs} ms）`)
        return { ...result, notes: [...notes, ...result.notes] }
      },
    },
  })
}
