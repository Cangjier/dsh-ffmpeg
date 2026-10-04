/**
 * The `dsh-ffmpeg` Host plugin: deterministic ffmpeg tools for DSH.
 *
 * The plugin is a plain ESM module with no harness import, so a profile can install it without a
 * build step and without a dependency edge on the harness packages it composes with. It validates
 * its own config, because validating through the Loader would require the dependency this module
 * exists to avoid.
 *
 * Division of labour, which the rest of the code depends on:
 *   DSH decides what is wanted — which clip matters, whether the structure reads right, what to do
 *   next.
 *   This plugin executes and measures: same input, same output, and every write is re-probed before
 *   it is called done.
 *
 * @module dsh-ffmpeg
 */
import { registerTools } from './src/tools/index.mjs'
import { ANALYSIS_DEFAULTS } from './src/core/semantics.mjs'
import { DEFAULT_TIMEOUT_MS, setMaxConcurrent } from './src/core/ffmpeg.mjs'
import { PLUGIN_ROOT, VENDOR_BIN_DIR, resolveTool } from './src/core/env.mjs'

/** Stable Cordis plugin name. */
export const name = 'dsh-ffmpeg'

/** Services required before tools can be registered. */
export const inject = ['tools']

/** Default concurrency: two encodes, which is where a desktop stops making progress on both. */
export const DEFAULT_MAX_CONCURRENT = 2

/** Default recognition language. */
export const DEFAULT_OCR_LANGUAGE = 'ch'

/**
 * Read an optional string field, allowing null to mean "use the default".
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {string|null} fallback - the value used when the field is absent or null.
 * @param {string} where - the path used in the error message.
 * @returns {string|null} the resolved value.
 * @throws {TypeError} when the field is present and not a string.
 */
function optionalString(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new TypeError(`dsh-ffmpeg: ${where} must be a string or null`)
  return value
}

/**
 * Read an optional positive number.
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {number} fallback - the value used when the field is absent.
 * @param {string} where - the path used in the error message.
 * @returns {number} the resolved value.
 * @throws {TypeError} when the field is present and not a positive number.
 */
function optionalPositiveNumber(raw, key, fallback, where) {
  const value = raw[key]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`dsh-ffmpeg: ${where} must be a positive number`)
  }
  return value
}

/**
 * Read an optional enumeration.
 * @param {object} raw - the raw config object.
 * @param {string} key - the field name.
 * @param {string} fallback - the value used when the field is absent.
 * @param {string[]} allowed - the legal values.
 * @param {string} where - the path used in the error message.
 * @returns {string} the resolved value.
 * @throws {TypeError} when the field is present and not one of the legal values.
 */
function optionalEnum(raw, key, fallback, allowed, where) {
  const value = optionalString(raw, key, fallback, where)
  if (!allowed.includes(value)) {
    throw new TypeError(`dsh-ffmpeg: ${where} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate and normalize the row's config.
 *
 * Misconfiguration fails loud here, at activation, rather than surfacing later as a confusing tool
 * error. Nothing is required: with an empty config the plugin still works, using whatever ffmpeg it
 * can find.
 *
 * @param {object} [raw] - the row's `config`.
 * @returns {object} the normalized config.
 * @throws {TypeError} when a field has the wrong type or an impossible value.
 */
export function normalizeConfig(raw) {
  const config = raw ?? {}
  const analysis = config.analysis ?? {}
  const ocr = config.ocr ?? {}

  const maxConcurrent = optionalPositiveNumber(config, 'maxConcurrent', DEFAULT_MAX_CONCURRENT, 'config.maxConcurrent')
  if (maxConcurrent > 8) throw new TypeError('dsh-ffmpeg: config.maxConcurrent above 8 will make every encode slower, not faster')

  return {
    projectRoot: optionalString(config, 'projectRoot', null, 'config.projectRoot'),
    ffmpegPath: optionalString(config, 'ffmpegPath', null, 'config.ffmpegPath'),
    ffprobePath: optionalString(config, 'ffprobePath', null, 'config.ffprobePath'),
    maxConcurrent: Math.floor(maxConcurrent),
    defaultTimeoutMs: optionalPositiveNumber(config, 'defaultTimeoutMs', DEFAULT_TIMEOUT_MS, 'config.defaultTimeoutMs'),
    ocrProvider: optionalEnum(ocr, 'provider', 'auto', ['auto', 'sibling', 'winrt', 'off'], 'config.ocr.provider'),
    ocrLanguage: optionalString(ocr, 'language', DEFAULT_OCR_LANGUAGE, 'config.ocr.language'),
    ocrPluginPath: optionalString(ocr, 'pluginPath', null, 'config.ocr.pluginPath'),
    salientPluginPath: optionalString(config, 'salientPluginPath', null, 'config.salientPluginPath'),
    analysis: {
      // The analysis defaults live in the core module so the guide, the schema descriptions and the
      // behaviour all read from one place; this only lets an operator move them.
      sceneThreshold: optionalPositiveNumber(analysis, 'sceneThreshold', ANALYSIS_DEFAULTS.sceneThreshold, 'config.analysis.sceneThreshold'),
      minSegmentSec: optionalPositiveNumber(analysis, 'minSegmentSec', ANALYSIS_DEFAULTS.minSegmentSec, 'config.analysis.minSegmentSec'),
      maxSegmentSec: optionalPositiveNumber(analysis, 'maxSegmentSec', ANALYSIS_DEFAULTS.maxSegmentSec, 'config.analysis.maxSegmentSec'),
      fps: optionalPositiveNumber(analysis, 'fps', ANALYSIS_DEFAULTS.fps, 'config.analysis.fps'),
      maxSide: optionalPositiveNumber(analysis, 'maxSide', ANALYSIS_DEFAULTS.maxSide, 'config.analysis.maxSide'),
      maxKeyframes: optionalPositiveNumber(analysis, 'maxKeyframes', ANALYSIS_DEFAULTS.maxKeyframes, 'config.analysis.maxKeyframes'),
      ocrMaxFrames: optionalPositiveNumber(analysis, 'ocrMaxFrames', ANALYSIS_DEFAULTS.ocrMaxFrames, 'config.analysis.ocrMaxFrames'),
    },
  }
}

/**
 * Mount the tools.
 *
 * Registration is wrapped so a failure to reach the `tools` service is logged clearly instead of
 * looking like a silent no-op: a plugin that loads but exposes nothing is the hardest kind of
 * failure to notice.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} rawConfig - the row's config.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    ctx.logger.error(`dsh-ffmpeg: 配置无效，插件未注册任何工具：${error.message}`)
    return
  }

  setMaxConcurrent(config.maxConcurrent)

  ctx.inject(['tools'], (toolsCtx) => {
    const outcome = registerTools(toolsCtx, config, ctx.logger)
    if (outcome.registered.length === 0) {
      ctx.logger.error('dsh-ffmpeg: 没有注册任何工具，插件实际上不可用')
      return
    }
    // Say out loud which ffmpeg this machine will use, and whether it is there at all. It costs a
    // few stat() calls and starts nothing: a missing ffmpeg is worth a warning, because every
    // working action would otherwise fail one at a time with the same cause.
    try {
      const ffmpeg = resolveTool('ffmpeg', config)
      const ffprobe = resolveTool('ffprobe', config)
      if (ffmpeg === null) {
        ctx.logger.warn(
          `dsh-ffmpeg: 没有找到 ffmpeg。按顺序找过配置、环境变量、${VENDOR_BIN_DIR}、同级插件与 PATH；` +
            '运行 ffmpeg_setup {action:"install"} 可以装一份固定的构建。',
        )
      } else {
        const line =
          `dsh-ffmpeg: ffmpeg = ${ffmpeg.path}（来源：${ffmpeg.label}）` +
          (ffprobe === null ? '；但没有找到 ffprobe，探测类工具会失败' : `；ffprobe = ${ffprobe.path}`) +
          `；插件根目录 ${PLUGIN_ROOT}`
        if (ffprobe === null) ctx.logger.warn(line)
        else ctx.logger.info(line)
      }
    } catch (error) {
      ctx.logger.warn(`dsh-ffmpeg: 环境检查失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
