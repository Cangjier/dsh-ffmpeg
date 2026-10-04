/**
 * `ffmpeg_semantics` — reading a recording into structure.
 *
 * @module dsh-ffmpeg/tools/semantics
 */
import { resolveCwd } from '../core/env.mjs'
import { ANALYSIS_DEFAULTS, analyze, regions, sceneTimeline } from '../core/semantics.mjs'
import { REGION_LABELS, LABEL_MEANINGS } from '../core/segmentation.mjs'
import { CWD_PROPERTY, FfmpegPluginError, defineFamilyTool, optionalEnum, optionalObject, requireString } from './shared.mjs'

/** Every action `ffmpeg_semantics` dispatches. */
export const SEMANTICS_ACTIONS = ['analyze', 'scenes', 'regions']

/**
 * Build the `ffmpeg_semantics` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createSemanticsTool(config, logger) {
  const where = 'ffmpeg_semantics'

  return defineFamilyTool({
    name: 'ffmpeg_semantics',
    actions: SEMANTICS_ACTIONS,
    extraProperties: {
      input: { type: 'string', description: 'The video, or a single image for action "regions".' },
      outDir: { type: 'string', description: 'analyze: where the structure JSON, keyframes, contact sheet and delivery video go. Defaults to the input\u2019s own directory.' },
      at: { type: 'number', description: 'regions: the second of the video to segment. Omit for a still image.' },
      sceneThreshold: { type: 'number', description: `analyze / scenes: how different two frames must be to count as a cut, in mean absolute luma difference per pixel (0–255). Default ${ANALYSIS_DEFAULTS.sceneThreshold}; a full-screen switch is usually above 40. Lower cuts more.` },
      minSegmentSec: { type: 'number', description: `analyze / scenes: shortest segment. Default ${ANALYSIS_DEFAULTS.minSegmentSec}.` },
      maxSegmentSec: { type: 'number', description: `analyze / scenes: longest segment before a cadence break. Default ${ANALYSIS_DEFAULTS.maxSegmentSec}.` },
      mergeShortSec: { type: 'number', description: `analyze / scenes: merge segments shorter than this into the previous one. Default ${ANALYSIS_DEFAULTS.mergeShortSec}.` },
      fps: { type: 'number', description: `analyze / scenes: analysis frame rate — the cadence the timeline is measured at. Default ${ANALYSIS_DEFAULTS.fps}.` },
      maxSide: { type: 'number', description: `analyze / scenes / regions: long side of the analysis frame, in pixels. Default ${ANALYSIS_DEFAULTS.maxSide}.` },
      maxSegments: { type: 'number', description: `analyze: cap on reported segments. Default ${ANALYSIS_DEFAULTS.maxSegments}.` },
      maxKeyframes: { type: 'number', description: `analyze: how many segments get a still, and therefore regions and text. Default ${ANALYSIS_DEFAULTS.maxKeyframes}.` },
      keyframeStrategy: { type: 'string', enum: ['mid', 'lead', 'last'], description: `analyze: which moment of a segment to keep. Default ${ANALYSIS_DEFAULTS.keyframeStrategy}.` },
      stillFormat: { type: 'string', enum: ['jpg', 'png', 'webp'], description: `analyze: format of the extracted stills. Default ${ANALYSIS_DEFAULTS.stillFormat}.` },
      stillMaxSide: { type: 'number', description: `analyze: long side of each still. Default ${ANALYSIS_DEFAULTS.stillMaxSide}.` },
      segmentation: { type: 'string', enum: ['grid', 'salient', 'both', 'off'], description: `analyze / regions: "grid" (default) labels rectangles by appearance with no model; "salient" asks a sibling video-factory for a U²-Net subject mask; "both" does each; "off" skips region work.` },
      salientMaxFrames: { type: 'number', description: `analyze: how many segments get a learned mask when salient segmentation is on. Default ${ANALYSIS_DEFAULTS.salientMaxFrames}; each costs about two seconds.` },
      tileSize: { type: 'number', description: 'analyze / regions: tile side in pixels of the analysis frame. Smaller is finer and slower; default 16.' },
      regionThresholds: { type: 'object', additionalProperties: true, description: 'analyze / regions: override the appearance-classification thresholds ({flatStd, darkLuma, textEdgeDensity, textSaturation, pictureSaturation, textureEdgeDensity, minAreaRatio}).' },
      text: { type: 'string', enum: ['auto', 'off', 'sibling', 'winrt'], description: 'analyze: which OCR provider may be used. "auto" (default) prefers the sibling dsh-ocr engine and falls back to the recogniser Windows ships; "off" leaves every segment\u2019s text null.' },
      ocrLanguage: { type: 'string', description: 'analyze: recognition language — ch (default), cht, en, japan, korean, or a BCP-47 tag.' },
      ocrScale: { type: 'number', description: 'analyze: enlarge a still before recognising it, 1–3. Helps the Windows recogniser on small text.' },
      ocrMaxFrames: { type: 'number', description: `analyze: stop reading text after this many segments. Default ${ANALYSIS_DEFAULTS.ocrMaxFrames}.` },
      keywords: { type: 'boolean', description: 'analyze: extract ranked terms from the recognised text. Default true. The terms come from counts, not from a model.' },
      contactSheet: { type: 'boolean', description: 'analyze: build one montage JPEG from the keyframes. Default true.' },
      chapters: { type: 'boolean', description: 'analyze: write the segments into the delivery video as chapters. Default true.' },
      output: { type: 'string', enum: ['copy', 'encode', 'none'], description: 'analyze: the delivery video — "copy" (default) remuxes without re-encoding, "encode" normalises to H.264/AAC MP4, "none" writes no video.' },
      outputPath: { type: 'string', description: 'analyze: exact path for the delivery video. Defaults to <outDir>/<input stem>.mp4.' },
      startSec: { type: 'number', description: 'analyze / scenes: start the analysis here instead of at 0, for walking a long recording in pieces.' },
      durationSec: { type: 'number', description: 'analyze / scenes: analyse at most this many seconds from startSec.' },
      cwd: CWD_PROPERTY,
    },
    handlers: {
      /**
       * The full analysis.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the structure document.
       */
      async analyze(args, context) {
        const input = resolveCwd(config, requireString(args, 'input', `${where} analyze`))
        const structure = await analyze({
          input,
          outDir: typeof args.outDir === 'string' && args.outDir !== '' ? resolveCwd(config, args.outDir) : undefined,
          config,
          options: withConfigDefaults(config, optionsFrom(args, where)),
          onProgress: (message) => logger.info(`dsh-ffmpeg analyze: ${message}`),
        })
        logger.info(
          `dsh-ffmpeg: analyze 完成，${structure.timeline.segments} 段，${structure.structure.textSegments} 段读到文字，结构写到 ${structure.outputs.structure}`,
        )
        return structure
      },

      /**
       * The timeline only.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the timeline.
       */
      async scenes(args) {
        const input = resolveCwd(config, requireString(args, 'input', `${where} scenes`))
        const options = withConfigDefaults(config, optionsFrom(args, where))
        const timeline = await sceneTimeline({ input, config, options })
        return {
          source: {
            path: input,
            kind: timeline.facts.kind,
            durationSec: timeline.facts.durationSec,
            video: timeline.facts.video === null ? null : { codec: timeline.facts.video.codec, width: timeline.facts.video.displayWidth, height: timeline.facts.video.displayHeight, fps: timeline.facts.video.fps },
          },
          options: timeline.options,
          analysis: timeline.analysis,
          // No `kind` here on purpose: naming a segment needs the appearance and the text of a frame,
          // and this action deliberately never extracts one. A kind guessed from motion alone would
          // be a different answer wearing the same field name as the one `analyze` gives.
          segments: timeline.segments,
          notes: [...(timeline.notes ?? []), 'scenes 只建时间轴：要段落类别、区域标签与文字，用 action:"analyze"。'],
        }
      },

      /**
       * Segment one frame into labelled rectangles.
       * @param {object} args - the tool arguments.
       * @param {object} context - the tool context.
       * @returns {Promise<object>} the regions.
       */
      async regions(args) {
        const input = resolveCwd(config, requireString(args, 'input', `${where} regions`))
        const report = await regions({
          input,
          at: Number.isFinite(args.at) ? args.at : undefined,
          config,
          options: withConfigDefaults(config, optionsFrom(args, where)),
        })
        return {
          ...report,
          vocabulary: Object.fromEntries(REGION_LABELS.map((label) => [label, LABEL_MEANINGS[label]])),
          provider: { appearance: 'grid（本插件自带，无模型）', salient: report.salient?.provider ?? null },
        }
      },
    },
  })
}

/**
 * Merge the operator's analysis config into the options a call gave.
 *
 * Precedence is the same everywhere in this plugin: what the call asked for wins, then what the
 * profile configured, then the built-in default — and the built-in default is applied by the core,
 * not here, so there is only one copy of it.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} options - the caller's options.
 * @returns {object} the merged options.
 */
function withConfigDefaults(config, options) {
  return { ...(config.analysis ?? {}), ...options }
}

/**
 * Collect the analysis options the caller actually set.
 *
 * Only known keys are forwarded, so a typo in an option name cannot silently change nothing: the
 * schema already rejects unknown top-level fields, and this keeps the same promise one level down.
 *
 * @param {object} args - the tool arguments.
 * @param {string} where - the call name, for error messages.
 * @returns {object} the options.
 * @throws {FfmpegPluginError} when a structured option has the wrong shape.
 */
function optionsFrom(args, where) {
  const keys = [
    'sceneThreshold', 'minSegmentSec', 'maxSegmentSec', 'mergeShortSec', 'fps', 'maxSide', 'maxSegments', 'maxKeyframes',
    'keyframeStrategy', 'stillFormat', 'stillMaxSide', 'salientMaxFrames', 'tileSize', 'text',
    'ocrLanguage', 'ocrScale', 'ocrMaxFrames', 'keywords', 'contactSheet', 'chapters', 'output', 'outputPath',
    'startSec', 'durationSec',
  ]
  const options = {}
  for (const key of keys) if (args[key] !== undefined) options[key] = args[key]
  // Enumerated and structured options are only forwarded when they were actually given: writing an
  // explicit `undefined` over a default is how a caller ends up with an option that is neither the
  // default nor what they asked for.
  const segmentation = optionalEnum(args, 'segmentation', ['grid', 'salient', 'both', 'off'], undefined, where)
  if (segmentation !== undefined) options.segmentation = segmentation
  const thresholds = optionalObject(args, 'regionThresholds', where)
  if (thresholds !== undefined) options.regionThresholds = thresholds
  return options
}
