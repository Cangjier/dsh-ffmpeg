/**
 * `ffmpeg_run` — the escape hatch, with guard rails.
 *
 * Every structured action in this plugin was written because a raw command line is easy to get
 * subtly wrong. That does not make raw commands unnecessary; it makes them the last resort, and a
 * last resort deserves the two things this tool provides: a **check** that says what the arguments
 * will do before they do it, and a **run** that measures the result instead of trusting the exit
 * code.
 *
 * The arguments are an array, always. Nothing here is joined into a string, so a path with a space,
 * a quote or a Chinese character needs no escaping and cannot be re-parsed.
 *
 * @module dsh-ffmpeg/tools/run
 */
import { existsSync, statSync } from 'node:fs'
import { capabilities } from '../core/caps.mjs'
import { longPath } from '../core/env.mjs'
import { run } from '../core/ffmpeg.mjs'
import { assertSeparate, verifyOutput } from '../core/media.mjs'
import {
  CWD_PROPERTY,
  TIMEOUT_PROPERTY,
  OVERWRITE_INPUT_PROPERTY,
  FfmpegPluginError,
  defineFamilyTool,
  optionalBoolean,
} from './shared.mjs'

/** Every action `ffmpeg_run` dispatches. */
export const RUN_ACTIONS = ['check', 'run']

/** Options this plugin supplies itself, and therefore removes from a caller's arguments. */
const MANAGED_OPTIONS = ['-y', '-nostdin', '-hide_banner']

/**
 * Read an ffmpeg argument array the way ffmpeg will read it, and report what it will do.
 *
 * The parse is deliberately shallow and honest about it: it finds the inputs, the output, the named
 * codecs and the filters, and it flags the shapes that are almost always a mistake. It never
 * guesses at intent.
 *
 * @param {string[]} args - the argument array.
 * @returns {{inputs: string[], output: string|null, codecs: string[], filters: string[], removed: string[], warnings: string[]}} the reading.
 */
export function inspectArgs(args) {
  const inputs = []
  const codecs = []
  const filters = []
  const removed = []
  const warnings = []
  const cleaned = []

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (MANAGED_OPTIONS.includes(argument)) {
      removed.push(argument)
      continue
    }
    if (argument === '-i') {
      const value = args[index + 1]
      if (typeof value !== 'string' || value === '') warnings.push('-i 后面没有输入路径。')
      else inputs.push(value)
      cleaned.push(argument, value)
      index += 1
      continue
    }
    if (argument === '-c:v' || argument === '-c:a' || argument === '-c:s' || argument === '-codec:v' || argument === '-codec:a' || argument === '-vcodec' || argument === '-acodec' || argument === '-c') {
      const value = args[index + 1]
      if (typeof value === 'string' && value !== '' && value !== 'copy') codecs.push(value)
      cleaned.push(argument, value)
      index += 1
      continue
    }
    const filterMatch = /^-(vf|af|filter_complex|filter:v|filter:a)$/.exec(argument)
    if (filterMatch !== null) {
      const value = args[index + 1]
      if (typeof value === 'string') {
        for (const name of filterNames(value)) filters.push(name)
      }
      cleaned.push(argument, value)
      index += 1
      continue
    }
    cleaned.push(argument)
  }

  const optionWithValue = new Set([
    '-i', '-c', '-c:v', '-c:a', '-c:s', '-vf', '-af', '-filter_complex', '-filter:v', '-filter:a', '-ss', '-t', '-to',
    '-map', '-f', '-r', '-s', '-b:v', '-b:a', '-crf', '-preset', '-pix_fmt', '-ar', '-ac', '-metadata', '-movflags',
    '-progress', '-loglevel', '-threads', '-hwaccel', '-q:v', '-q:a', '-update', '-frames:v', '-start_number',
    '-compression_level', '-avoid_negative_ts', '-map_metadata', '-map_chapters', '-rtbufsize', '-thread_queue_size',
    '-framerate', '-offset_x', '-offset_y', '-video_size', '-draw_mouse', '-loop', '-filter_threads', '-an', '-vn',
  ])
  // Flags that stand alone are removed from the "previous argument" set: leaving `-an` in it makes
  // the output look like it is preceded by an option that takes a value, and the output file is
  // then never found.
  const standalone = new Set(['-an', '-vn', '-sn', '-dn', '-shortest', '-copyts'])
  let output = null
  for (let index = cleaned.length - 1; index >= 0; index -= 1) {
    const argument = cleaned[index]
    if (argument.startsWith('-')) continue
    const previous = cleaned[index - 1]
    if (previous !== undefined && optionWithValue.has(previous) && !standalone.has(previous)) continue
    output = argument
    break
  }

  if (inputs.length === 0) warnings.push('没有 -i：ffmpeg 需要至少一个输入（lavfi 之类的虚拟输入也要写成 -f lavfi -i …）。')
  if (output === null) warnings.push('找不到输出文件：除非你刻意输出到 -f null -，否则 ffmpeg 会以 "At least one output file must be specified" 失败。')
  if (output !== null && !args.includes('-f') && !/\.[a-z0-9]{2,5}$/i.test(output)) {
    warnings.push(`输出 ${JSON.stringify(output)} 没有扩展名：请显式给 -f 指定封装格式。`)
  }

  return { inputs, output, codecs: [...new Set(codecs)], filters: [...new Set(filters)], removed, warnings }
}

/**
 * Extract filter names from a filter-graph string.
 *
 * @param {string} graph - the value of `-vf` / `-af` / `-filter_complex`.
 * @returns {string[]} the names found, in order of appearance.
 */
export function filterNames(graph) {
  const names = []
  for (const match of String(graph).matchAll(/(?:^|[;,])\s*(?:\[[^\]]*\]\s*)*([a-zA-Z][a-zA-Z0-9_]*)\s*(?:=|\[|,|;|$)/g)) {
    names.push(match[1])
  }
  return names
}

/**
 * Build the `ffmpeg_run` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createRunTool(config, logger) {
  const where = 'ffmpeg_run'

  /**
   * Validate the arguments and describe the call without making it.
   * @param {object} args - the tool arguments.
   * @returns {Promise<object>} the description.
   */
  const describe = async (args) => {
    const list = args.args
    if (!Array.isArray(list) || list.length === 0) throw new FfmpegPluginError(`${where}: args 必须是非空字符串数组，例如 ["-i","a.mp4","b.mp4"]。`)
    if (list.some((entry) => typeof entry !== 'string')) throw new FfmpegPluginError(`${where}: args 里每一项都必须是字符串。`)
    if (list.some((entry) => entry.includes('\n'))) throw new FfmpegPluginError(`${where}: 参数里不能有换行。`)

    const reading = inspectArgs(list)
    const over = optionalBoolean(args, 'overwriteInput', false, where) === true
    let samePathAsInput = null
    if (reading.output !== null && reading.inputs.length > 0) {
      try {
        assertSeparate(longPath(reading.output), reading.inputs.map((entry) => longPath(entry)), over)
      } catch (error) {
        // Reported as a structured field as well as prose: `check` describes the danger, and `run`
        // refuses on it. A warning alone would let `run` truncate the caller's source file.
        samePathAsInput = reading.output
        reading.warnings.push(error instanceof Error ? error.message : String(error))
      }
    }

    const caps = await capabilities(config).catch(() => null)
    const missing = []
    if (caps !== null) {
      // Only a watched capability can be reported as missing: the plugin does not enumerate every
      // encoder a build has, and claiming "no" from an absence of evidence would be a lie.
      for (const codec of reading.codecs) if (caps.encoders[codec] === false) missing.push(`编码器 ${codec}`)
      for (const filter of reading.filters) if (caps.filters[filter] === false) missing.push(`滤镜 ${filter}`)
    }
    for (const name of reading.removed) reading.warnings.push(`参数里的 ${name} 已被本插件接管（自动加上），无需重复。`)

    return {
      ...reading,
      tool: 'ffmpeg',
      args: list,
      command: `ffmpeg ${list.map((entry) => (/[\s"]/.test(entry) ? JSON.stringify(entry) : entry)).join(' ')}`,
      overwriteInput: over,
      samePathAsInput,
      wouldOverwrite: reading.output !== null && existsSync(reading.output) ? { path: reading.output, bytes: statSync(reading.output).size } : null,
      unavailable: missing,
      capabilities: caps === null ? null : { path: caps.ffmpeg.path, version: caps.ffmpeg.version },
    }
  }

  return defineFamilyTool({
    name: 'ffmpeg_run',
    actions: RUN_ACTIONS,
    extraProperties: {
      args: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The ffmpeg arguments after the binary, one array entry per argument: ["-i","in.mp4","-vf","scale=640:-2","out.mp4"]. Never one long string — there is no shell here, and a single string would be passed to ffmpeg as one nonsensical argument.',
      },
      raw: { type: 'boolean', description: 'run: also return the full stdout of the process (bounded).' },
      overwriteInput: OVERWRITE_INPUT_PROPERTY,
      timeoutMs: TIMEOUT_PROPERTY,
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * Describe the call without making it.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the description.
       */
      async check(args) {
        return describe(args)
      },

      /**
       * Make the call and measure what it produced.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} the outcome.
       */
      async run(args) {
        const reading = await describe(args)
        if (reading.samePathAsInput !== null) {
          throw new FfmpegPluginError(
            `ffmpeg_run: 输出 ${reading.samePathAsInput} 同时是输入，ffmpeg 会先清空它再读，源文件就没了。\n` +
              '换一个输出名，或者确认要覆盖后传 overwriteInput:true。',
          )
        }
        const cleaned = args.args.filter((entry) => !MANAGED_OPTIONS.includes(entry))
        const started = Date.now()
        const result = await run({ tool: 'ffmpeg', args: cleaned, config, timeoutMs: args.timeoutMs })

        let output = null
        if (reading.output !== null && existsSync(reading.output)) {
          output = await verifyOutput(reading.output, { config, minBytes: 1 })
        }
        logger.info(`dsh-ffmpeg: run 退出码 ${result.code}，用时 ${result.elapsedMs} ms`)
        return {
          code: result.code,
          elapsedMs: result.elapsedMs,
          command: reading.command,
          warnings: reading.warnings,
          unavailable: reading.unavailable,
          stdout: args.raw === true ? result.stdout.slice(0, 200_000) : undefined,
          stderrTail: result.stderr.trim().split('\n').slice(-20).join('\n'),
          output,
          ok: output === null ? true : output.ok,
        }
      },
    },
  })
}
