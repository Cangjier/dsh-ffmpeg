/**
 * One recording in, a video plus its semantic structure out.
 *
 * This is the module the whole plugin is arranged around. The pipeline is:
 *
 * 1. **probe** the source for the facts the rest of it depends on (size, rotation, duration);
 * 2. **decode once** at a small size and build the timeline from consecutive-frame differences —
 *    constant memory, one pass, no filter-graph guesswork;
 * 3. **merge** segments too short to be worth naming, and cap the total;
 * 4. **per segment**: take one still at a chosen moment, segment *that* into labelled rectangles,
 *    read its text with whatever OCR provider is available, and name the segment's kind from the
 *    measured motion and appearance;
 * 5. **write** the structure document, a keyframe directory, a contact sheet, and a delivery video
 *    with chapters taken from the structure.
 *
 * Two things about the output are deliberate. First, every number in it was measured here, and the
 * vocabulary it uses — segment kinds, region labels, motion levels — is *defined by rules stated in
 * this file*, not by a model's opinion; the one thing that is a model (the optional U²-Net mask) is
 * attributed to the sibling plugin that ran it. Second, an absent measurement is `null` with a
 * reason, never a zero: "no OCR was available" and "the screen was blank" are different facts and
 * the structure keeps them apart.
 *
 * @module dsh-ffmpeg/core/semantics
 */
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { ensureDir, longPath, resolveCwd } from './env.mjs'
import { decodeRawFrames, run } from './ffmpeg.mjs'
import { MediaError, execute, verifyOutput, videoArguments, audioArguments } from './media.mjs'
import { ANALYSIS_MAX_SIDE, fitSize, loadRgb, saveStill } from './image.mjs'
import { probe } from './probe.mjs'
import { LABEL_MEANINGS, REGION_LABELS, segmentFrame } from './segmentation.mjs'
import { TimelineBuilder, mergeShortSegments, keyframeTime, DEFAULT_MAX_SEGMENT, DEFAULT_MIN_SEGMENT, DEFAULT_SCENE_THRESHOLD } from './timeline.mjs'
import { extractKeywords } from './text.mjs'
import { ocrReport, recogniseMany } from './ocr.mjs'
import { salientFrame, salientReport } from './salient.mjs'

/** Version of the structure document. Bumped when a field changes meaning. */
export const SEMANTICS_VERSION = 1

/** The segment kinds, and the rule that produces each. */
export const SEGMENT_KIND_RULES = {
  document: '几乎不动 + 画面以文字为主：正在看的一页。',
  typing: '有轻微变化 + 有文字：正在输入或小幅编辑。',
  scrolling: '中等变化 + 有文字：正在滚动或翻页。',
  video_playback: '明显变化 + 画面以彩色图像为主：在播放视频或动画。',
  animation: '明显变化 + 不以彩色图像为主：界面动画、切场或拖拽。',
  still_image: '几乎不动 + 画面以图像为主、没有文字：一张静止的图。',
  idle: '几乎不动、没有文字：空屏、桌面或暂停。',
  unknown: '证据不足，无法归类。',
}

/** The kinds this module can return, in the order the guide lists them. */
export const SEGMENT_KINDS = Object.keys(SEGMENT_KIND_RULES)

/** Default analysis options, all overridable per call. */
export const ANALYSIS_DEFAULTS = {
  fps: 4,
  maxSide: ANALYSIS_MAX_SIDE,
  sceneThreshold: DEFAULT_SCENE_THRESHOLD,
  minSegmentSec: DEFAULT_MIN_SEGMENT,
  maxSegmentSec: DEFAULT_MAX_SEGMENT,
  mergeShortSec: 0.7,
  maxSegments: 400,
  maxKeyframes: 120,
  keyframeStrategy: 'mid',
  stillFormat: 'jpg',
  stillMaxSide: 1280,
  segmentation: 'grid',
  salientMaxFrames: 12,
  text: 'auto',
  ocrScale: 1,
  ocrMaxFrames: 60,
  keywords: true,
  contactSheet: true,
  chapters: true,
  output: 'copy',
}

/**
 * Name a segment's kind from what was measured about it.
 *
 * The rule table is the whole method, and it is stated in {@link SEGMENT_KIND_RULES} so a reader of
 * the output can check the claim. `evidence` is returned beside the answer for the same reason.
 *
 * @param {object} input - `{ motion, labelShares, lineCount }`.
 * @returns {{kind: string, evidence: object}} the kind and the numbers behind it.
 */
export function describeSegmentKind(input) {
  const level = input.motion?.level ?? 'static'
  const shares = input.labelShares ?? {}
  const textShare = shares.text ?? 0
  const pictureShare = shares.picture ?? 0
  const lineCount = Number.isFinite(input.lineCount) ? input.lineCount : 0
  const hasText = lineCount > 0 || textShare >= 0.05
  const visual = pictureShare >= 0.25

  let kind = 'unknown'
  if (level === 'static') kind = hasText ? 'document' : visual ? 'still_image' : 'idle'
  else if (level === 'low') kind = hasText ? 'typing' : visual ? 'video_playback' : 'idle'
  else if (level === 'moderate') kind = hasText ? 'scrolling' : visual ? 'video_playback' : 'animation'
  else kind = visual ? 'video_playback' : 'animation'

  return {
    kind,
    evidence: {
      motionLevel: level,
      meanAbsDiff: input.motion?.meanAbsDiff ?? null,
      textShare,
      pictureShare,
      lineCount,
      rule: SEGMENT_KIND_RULES[kind],
    },
  }
}

/**
 * Normalize the analysis options, refusing values that would make the output meaningless.
 *
 * @param {object} [raw] - the caller's options.
 * @returns {object} the resolved options.
 * @throws {MediaError} when a value is out of range.
 */
export function normalizeOptions(raw = {}) {
  const options = { ...ANALYSIS_DEFAULTS, ...raw }
  const positive = (name, value, min, max) => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0 || number > max || number < min) {
      throw new MediaError(`${name} 必须在 ${min}–${max} 之间；收到 ${JSON.stringify(value)}`)
    }
    return number
  }
  options.fps = positive('fps', options.fps, 0.1, 30)
  options.maxSide = positive('maxSide', options.maxSide, 64, 1920)
  options.sceneThreshold = positive('sceneThreshold', options.sceneThreshold, 0.01, 255)
  options.minSegmentSec = positive('minSegmentSec', options.minSegmentSec, 0.1, 600)
  options.maxSegmentSec = positive('maxSegmentSec', options.maxSegmentSec, options.minSegmentSec, 3600)
  options.maxSegments = positive('maxSegments', options.maxSegments, 1, 5000)
  options.maxKeyframes = positive('maxKeyframes', options.maxKeyframes, 1, 2000)
  if (!['grid', 'salient', 'both', 'off'].includes(options.segmentation)) {
    throw new MediaError(`segmentation 只能是 grid / salient / both / off；收到 ${JSON.stringify(options.segmentation)}`)
  }
  if (!['mid', 'lead', 'last'].includes(options.keyframeStrategy)) {
    throw new MediaError(`keyframeStrategy 只能是 mid / lead / last；收到 ${JSON.stringify(options.keyframeStrategy)}`)
  }
  if (!['jpg', 'png', 'webp'].includes(options.stillFormat)) {
    throw new MediaError(`stillFormat 只能是 jpg / png / webp；收到 ${JSON.stringify(options.stillFormat)}`)
  }
  if (!['auto', 'off', 'sibling', 'winrt'].includes(options.text)) {
    throw new MediaError(`text 只能是 auto / off / sibling / winrt；收到 ${JSON.stringify(options.text)}`)
  }
  if (!['copy', 'encode', 'none'].includes(options.output)) {
    throw new MediaError(`output 只能是 copy / encode / none；收到 ${JSON.stringify(options.output)}`)
  }
  return options
}

/**
 * Stage 1–3: probe the source and build the timeline.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the source.
 * @param {object} [request.config] - normalized plugin config.
 * @param {object} [request.options] - analysis options.
 * @param {(message: string, detail?: object) => void} [request.onProgress] - progress lines.
 * @returns {Promise<object>} `{ facts, segments, analysis, options }`.
 * @throws {MediaError} when the source cannot be analysed.
 */
export async function sceneTimeline(request) {
  const config = request.config ?? {}
  const options = normalizeOptions(request.options)
  const input = request.input
  if (typeof input !== 'string' || input.trim() === '') throw new MediaError('需要 input：要分析的文件路径。')
  if (!existsSync(input)) throw new MediaError(`输入文件不存在：${input}`)

  const facts = await probe(input, config)
  const progress = request.onProgress ?? (() => {})
  if (facts.kind === 'audio') {
    throw new MediaError(`${input} 只有音频流，没有画面可分析。要处理声音请用 dsh-video-audio 的 audio_* 工具。`)
  }

  if (facts.video === null) throw new MediaError(`${input} 里没有视频流。`)

  const sourceWidth = facts.video.displayWidth ?? facts.video.width
  const sourceHeight = facts.video.displayHeight ?? facts.video.height
  const size = fitSize(sourceWidth, sourceHeight, options.maxSide)

  // An image has no timeline to build; it is one segment containing one frame.
  if (facts.kind === 'image' || facts.durationSec === null || facts.durationSec === 0) {
    return {
      facts,
      options,
      analysis: {
        mode: 'single-frame',
        size,
        fps: options.fps,
        sourceSize: { width: sourceWidth, height: sourceHeight },
        sceneThreshold: options.sceneThreshold,
        decodedFrames: 0,
        decodedSeconds: 0,
        elapsedMs: 0,
        decodeErrors: null,
        truncated: false,
      },
      segments: [
        {
          index: 0,
          start: 0,
          end: 0,
          durationSec: 0,
          startReason: 'start',
          endReason: 'end',
          sceneScore: null,
          motion: { meanAbsDiff: 0, changedRatio: 0, maxDiff: 0, level: 'static', samples: 1 },
          mergedCount: 1,
        },
      ],
    }
  }

  const builder = new TimelineBuilder({
    sceneThreshold: options.sceneThreshold,
    minSegmentSec: options.minSegmentSec,
    maxSegmentSec: options.maxSegmentSec,
    fps: options.fps,
  })
  const started = Date.now()
  const decoded = await decodeRawFrames({
    input,
    width: size.width,
    height: size.height,
    fps: options.fps,
    start: Number.isFinite(options.startSec) ? options.startSec : undefined,
    duration: Number.isFinite(options.durationSec) ? options.durationSec : undefined,
    config,
    timeoutMs: options.decodeTimeoutMs,
    onFrame: (frame, index, timeSec) => {
      builder.push(timeSec, frame)
    },
  })

  const rawSegments = builder.finish(decoded.timedOut === true ? decoded.frames / options.fps : facts.durationSec)
  let segments = mergeShortSegments(rawSegments, options.mergeShortSec)
  const notes = []
  if (segments.length > options.maxSegments) {
    notes.push(`识别出 ${segments.length} 段，超过 maxSegments=${options.maxSegments}，只保留前 ${options.maxSegments} 段；想覆盖全长请提高 sceneThreshold。`)
    segments = segments.slice(0, options.maxSegments)
  }
  if (decoded.code !== 0 && decoded.frames > 0) {
    notes.push(`解码在中途报错（退出码 ${decoded.code}），已按读到的部分分析。stderr 尾部：${decoded.stderr.split('\n').slice(-3).join(' | ')}`)
  }
  if (decoded.frames === 0) {
    throw new MediaError(`一帧都没解出来，无法分析：${decoded.stderr.split('\n').slice(-5).join('\n')}`)
  }

  return {
    facts,
    options,
    analysis: {
      mode: 'decode',
      size,
      fps: options.fps,
      sourceSize: { width: sourceWidth, height: sourceHeight },
      sceneThreshold: options.sceneThreshold,
      decodedFrames: decoded.frames,
      decodedSeconds: Number((decoded.frames / options.fps).toFixed(3)),
      elapsedMs: Date.now() - started,
      decodeErrors: decoded.code === 0 ? null : decoded.stderr.split('\n').slice(-5).join('\n'),
      truncated: decoded.timedOut,
    },
    segments,
    notes,
  }
}

/**
 * Stage 5: write ffmetadata chapters for a structure.
 *
 * Chapters are how the semantic structure reaches a human in a player rather than in a JSON file,
 * so every segment becomes one, titled with its time, kind and first line of text.
 *
 * @param {object} structure - the structure document.
 * @param {string} path - where to write the metadata file.
 * @returns {string} the path written.
 */
export function writeChapters(structure, path) {
  const lines = [';FFMETADATA1']
  for (const segment of structure.segments) {
    const start = Math.round(segment.start * 1000)
    const end = Math.max(start + 1, Math.round(segment.end * 1000))
    const excerpt = typeof segment.text?.reading === 'string' ? segment.text.reading.split('\n')[0].slice(0, 48) : ''
    const title = `${formatClock(segment.start)} ${segment.kind}${excerpt === '' ? '' : ` · ${excerpt}`}`
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=${title.replace(/\n/g, ' ')}`)
  }
  writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8' })
  return path
}

/**
 * Format a time as `mm:ss`, or `h:mm:ss` past an hour.
 * @param {number} seconds - the time.
 * @returns {string} the clock reading.
 */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`
}

/**
 * Whether a file's streams can be remuxed into an MP4 without re-encoding.
 *
 * A remux that fails is a confusing error at the end of a long analysis, so the decision is made
 * up front from the probe: an unsupported codec switches the delivery to a re-encode with a note.
 *
 * @param {object} facts - a probe result.
 * @returns {{ok: boolean, reason: string|null}} the verdict.
 */
export function canRemuxToMp4(facts) {
  const videoOk = ['h264', 'hevc', 'mpeg4', 'av1', 'vp9', 'mjpeg'].includes(facts.video?.codec)
  const audioOk = facts.audio === null || ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'opus'].includes(facts.audio.codec)
  if (!videoOk) return { ok: false, reason: `视频编码是 ${facts.video?.codec ?? '未知'}，MP4 直接封装多数播放器不认。` }
  if (!audioOk) return { ok: false, reason: `音频编码是 ${facts.audio?.codec ?? '未知'}，MP4 直接封装多数播放器不认。` }
  return { ok: true, reason: null }
}

/**
 * Stage 4–5: the full analysis.
 *
 * @param {object} request - the request.
 * @param {string} request.input - the source file.
 * @param {string} [request.outDir] - where the outputs go. Defaults to the input's directory.
 * @param {object} [request.config] - normalized plugin config.
 * @param {object} [request.options] - analysis options.
 * @param {(message: string, detail?: object) => void} [request.onProgress] - progress lines.
 * @returns {Promise<object>} the structure document, plus an `outputs` section naming what was written.
 * @throws {MediaError} when a step cannot be completed.
 */
export async function analyze(request) {
  const config = request.config ?? {}
  const progress = request.onProgress ?? (() => {})
  const options = normalizeOptions(request.options)
  const input = request.input
  const timeline = await sceneTimeline({ input, config, options, onProgress: progress })
  const { facts } = timeline
  const notes = [...(timeline.notes ?? [])]
  // The recognition language is a plugin setting first and a per-call override second, so a caller
  // that never mentions it still gets the configured one.
  if (options.ocrLanguage === undefined) options.ocrLanguage = config.ocrLanguage

  const outDir = request.outDir !== undefined && request.outDir !== null
    ? resolveCwd(config, request.outDir)
    : dirname(input)
  const stem = basename(input, extname(input))
  const keyframeDir = ensureDir(join(outDir, `${stem}.keyframes`))
  const structurePath = join(outDir, `${stem}.semantics.json`)

  progress(`时间轴：${timeline.segments.length} 段，分析用了 ${(timeline.analysis.elapsedMs / 1000).toFixed(1)} 秒`)

  // OCR availability is resolved once: asking per frame would re-import the sibling plugin's core
  // dozens of times.
  const ocr = options.text === 'off' ? { provider: 'off', notes: ['按调用要求关闭了文字识别。'] } : await ocrReport({ ...config, ocrProvider: options.text === 'auto' ? undefined : options.text, ocrLanguage: options.ocrLanguage })
  progress(`文字识别：${ocr.provider}`)

  let salient = null
  if (options.segmentation === 'salient' || options.segmentation === 'both') {
    salient = await salientReport(config)
    progress(`学习式分割：${salient.available ? salient.provider : `不可用（${salient.reason}）`}`)
    if (!salient.available && options.segmentation === 'salient') {
      notes.push(`要求了 segmentation:"salient"，但不可用：${salient.reason} 已退回外观类别（grid）。`)
    }
  }

  const stills = []
  const segments = []
  let stillIndex = 0
  let ocrCount = 0
  let salientCount = 0
  const ocrFailures = []

  for (const segment of timeline.segments) {
    const wanted = stills.length < options.maxKeyframes
    // Every enrichment field starts as null and is filled in only when it is actually measured, so
    // an unenriched segment and an enriched one have exactly the same keys. A dropped key would
    // mean "this run does not do masks" and "this segment got no mask" look identical.
    const enriched = {
      ...segment,
      keyframe: null,
      frame: null,
      regions: null,
      labelShares: null,
      regionGrid: null,
      dominantColors: null,
      salient: null,
      text: null,
    }

    if (wanted) {
      stillIndex += 1
      const at = timeline.analysis.mode === 'single-frame' ? 0 : keyframeTime(segment, options.keyframeStrategy, options.fps)
      const stillPath = join(keyframeDir, `kf_${String(stillIndex).padStart(4, '0')}.${options.stillFormat}`)
      let still = null
      try {
        if (timeline.analysis.mode === 'single-frame' && extname(input).toLowerCase() === `.${options.stillFormat}`) {
          still = { path: input, bytes: statSync(input).size }
        } else {
          still = await saveStill(input, { out: stillPath, at, maxSide: options.stillMaxSide, config })
        }
      } catch (error) {
        notes.push(`第 ${segment.index} 段抽帧失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
      if (still !== null) {
        stills.push(still.path)
        enriched.keyframe = { at, path: still.path, relativePath: relativeTo(outDir, still.path), bytes: still.bytes }
      }

      const frameSource = still?.path ?? input
      if (options.segmentation === 'off') {
        // Left as the nulls set above.
      } else {
        try {
          const rgb = await loadRgb(frameSource, { at: still === null ? at : null, maxSide: ANALYSIS_MAX_SIDE, config })
          const segmentation = segmentFrame(rgb.data, rgb.width, rgb.height, {
            tileSize: options.tileSize,
            thresholds: options.regionThresholds,
          })
          enriched.frame = { width: rgb.width, height: rgb.height }
          enriched.regions = segmentation.regions
          enriched.labelShares = segmentation.labelShares
          enriched.dominantColors = segmentation.dominantColors
          enriched.regionGrid = segmentation.grid
        } catch (error) {
          notes.push(`第 ${segment.index} 段分块失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
        }
      }

      if (salient !== null && salient.available && salientCount < options.salientMaxFrames) {
        salientCount += 1
        try {
          const source = still?.path ?? input
          const maskPath = join(keyframeDir, `kf_${String(stillIndex).padStart(4, '0')}.mask.png`)
          const mask = await salientFrame(source, {
            at: still === null ? at : null,
            frameWidth: timeline.analysis.sourceSize?.width ?? facts.video.width,
            frameHeight: timeline.analysis.sourceSize?.height ?? facts.video.height,
            maskPath,
            config,
          })
          enriched.salient = mask
        } catch (error) {
          notes.push(`第 ${segment.index} 段的显著性分割失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
        }
      }

      if (ocr.provider !== 'off' && ocr.provider !== 'none' && ocrCount < options.ocrMaxFrames && still !== null) {
        ocrCount += 1
        const outcome = await recogniseMany(
          [{ path: still.path, index: segment.index, at }],
          { config: { ...config, ocrLanguage: options.ocrLanguage }, provider: ocr.provider, language: options.ocrLanguage, scale: options.ocrScale, onProgress: () => {} },
        )
        const reading = outcome.readings[0]
        if (reading !== undefined) {
          enriched.text = {
            provider: reading.provider,
            engine: reading.engine,
            lineCount: reading.lines.length,
            reading: reading.text,
            lines: reading.lines,
            elapsedMs: reading.elapsedMs,
            note: reading.note,
          }
        } else if (outcome.failed.length > 0) {
          ocrFailures.push({ index: segment.index, error: outcome.failed[0].error })
          enriched.text = { provider: ocr.provider, lineCount: 0, reading: '', lines: [], error: outcome.failed[0].error }
        }
      }
    } else {
      // Beyond maxKeyframes: the timeline facts stay, the measured enrichments do not exist and are
      // already null.
    }

    const described = describeSegmentKind({
      motion: enriched.motion,
      labelShares: enriched.labelShares,
      lineCount: enriched.text?.lineCount ?? 0,
    })
    enriched.kind = described.kind
    enriched.kindEvidence = described.evidence
    segments.push(enriched)
  }

  if (stills.length === 0) notes.push('没有任何关键帧被写出来（maxKeyframes 太小或抽帧全部失败）。')
  if (timeline.segments.length > stills.length) notes.push(`${timeline.segments.length - stills.length} 段没有关键帧（maxKeyframes=${options.maxKeyframes}）。`)
  if (ocrFailures.length > 0) notes.push(`${ocrFailures.length} 段的文字识别失败，第一条：${ocrFailures[0].error}`)

  const withText = segments.filter((segment) => (segment.text?.lineCount ?? 0) > 0)
  const keywords = options.keywords === true
    ? extractKeywords(
        withText.map((segment) => ({ text: segment.text.reading, index: segment.index, at: segment.start })),
        { maxKeywords: options.maxKeywords ?? 20 },
      )
    : []

  const outputs = { keyframes: keyframeDir, structure: structurePath, contactSheet: null, video: null }

  const structure = {
    version: SEMANTICS_VERSION,
    generatedAt: new Date().toISOString(),
    source: {
      path: input,
      bytes: facts.bytes,
      kind: facts.kind,
      durationSec: facts.durationSec,
      formatName: facts.formatName,
      video: facts.video === null ? null : {
        codec: facts.video.codec,
        width: facts.video.displayWidth ?? facts.video.width,
        height: facts.video.displayHeight ?? facts.video.height,
        fps: facts.video.fps,
        pixFmt: facts.video.pixFmt,
        rotation: facts.video.rotation,
      },
      audio: facts.audio === null ? null : { codec: facts.audio.codec, channels: facts.audio.channels, sampleRate: facts.audio.sampleRate },
      problems: facts.problems,
    },
    options,
    analysis: timeline.analysis,
    providers: {
      ocr: { provider: ocr.provider, language: ocr.language, sibling: ocr.sibling, winrt: ocr.winrt, framesRead: ocrCount, notes: ocr.notes },
      segmentation: {
        mode: options.segmentation,
        appearance: 'ffmpeg_semantics 自带的按块外观分类（确定性，无模型）',
        salient: salient === null ? null : { provider: salient.provider, available: salient.available, reason: salient.reason, framesRead: salientCount },
      },
    },
    timeline: {
      segments: segments.length,
      durationSec: facts.durationSec,
      decodedFrames: timeline.analysis.decodedFrames,
      size: timeline.analysis.size,
      fps: timeline.analysis.fps,
    },
    segments,
    structure: {
      kinds: summarizeKinds(segments),
      labelShares: summarizeLabels(segments),
      regionVocabulary: Object.fromEntries(REGION_LABELS.map((label) => [label, LABEL_MEANINGS[label]])),
      kindRules: SEGMENT_KIND_RULES,
      keywords,
      textSegments: withText.length,
    },
    outputs,
    notes,
  }

  // The contact sheet is built before the video: it is cheap, and a failure in it must not cost the
  // delivery video that the caller asked for.
  if (options.contactSheet === true && stills.length > 1) {
    try {
      outputs.contactSheet = await makeContactSheet(stills, join(outDir, `${stem}.contact-sheet.jpg`), { config, onProgress: progress })
    } catch (error) {
      notes.push(`联系表生成失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  } else if (stills.length === 1) {
    outputs.contactSheet = null
    notes.push('只有一段，没有生成联系表；那一帧就是 kf_0001。')
  }

  if (options.output !== 'none' && timeline.analysis.mode !== 'single-frame') {
    try {
      outputs.video = await deliverVideo({
        input,
        outDir,
        stem,
        facts,
        structure,
        options,
        config,
        onProgress: progress,
      })
      if (outputs.video?.fallbackReason != null) notes.push(outputs.video.fallbackReason)
      notes.push(...(outputs.video?.notes ?? []))
    } catch (error) {
      notes.push(`交付视频生成失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
  }

  writeFileSync(structurePath, `${JSON.stringify(structure, null, 2)}\n`, { encoding: 'utf8' })
  structure.outputs.structureBytes = statSync(structurePath).size

  return structure
}

/**
 * Write the delivery video: the recording, remuxed or re-encoded, with chapters.
 *
 * @param {object} request - `{ input, outDir, stem, facts, structure, options, config, onProgress }`.
 * @returns {Promise<object>} what was written and whether it verified.
 */
export async function deliverVideo(request) {
  const { input, outDir, stem, facts, structure, options, config } = request
  const progress = request.onProgress ?? (() => {})
  const notes = []
  let target = typeof options.outputPath === 'string' && options.outputPath !== ''
    ? resolveCwd(config, options.outputPath)
    : join(outDir, `${stem}.mp4`)
  // Analysing a file that is already named `<stem>.mp4` in its own directory would aim the delivery
  // at the source file. ffmpeg truncates an output before reading it, so this would destroy the very
  // recording being analysed — the worst outcome available anywhere in this plugin.
  if (target.toLowerCase() === String(input).toLowerCase()) {
    target = join(outDir, `${stem}.analyzed.mp4`)
    notes.push(`交付视频本来会写到输入文件本身（${input}），已改用 ${target}；源文件没有被碰。`)
  }
  ensureDir(dirname(target))

  const chaptersPath = options.chapters === true && structure.segments.length > 1 ? join(outDir, `${stem}.chapters.txt`) : null
  if (chaptersPath !== null) writeChapters(structure, chaptersPath)

  const remux = canRemuxToMp4(facts)
  const mode = options.output === 'encode' || !remux.ok ? 'encode' : 'copy'
  const fallbackReason =
    options.output === 'encode'
      ? undefined
      : remux.ok
        ? undefined
        : `output:"copy" 被改用重编码：${remux.reason}`

  let plan
  if (mode === 'copy') {
    const args = ['-i', longPath(input)]
    if (chaptersPath !== null) args.push('-i', longPath(chaptersPath), '-map', '0', '-map_metadata', '1', '-map_chapters', '1')
    args.push('-c', 'copy')
    if (extname(target).toLowerCase() === '.mp4' || extname(target).toLowerCase() === '.mov') args.push('-movflags', '+faststart')
    args.push(longPath(target))
    plan = { passes: [{ args }], out: target, notes: ['交付视频：流复制封装，不重编码，画面与源文件逐帧一致。'], expect: { video: true, audio: facts.audio !== null } }
  } else {
    // The encode path is built here rather than by patching a plan from `media.mjs`: every `-i`
    // has to precede every output option, and "move the metadata input back into place afterwards"
    // is exactly the kind of argument surgery that works until the day it quietly does not.
    const args = ['-i', longPath(input)]
    if (chaptersPath !== null) args.push('-i', longPath(chaptersPath))
    args.push('-map', '0:v:0?', '-map', '0:a:0?')
    if (chaptersPath !== null) args.push('-map_metadata', '1', '-map_chapters', '1')
    const video = videoArguments(options.encodeVideo ?? { codec: 'libx264', crf: 20, preset: 'medium' }, { video: 'libx264' })
    const audio = audioArguments({ codec: 'aac', bitrate: '160k' }, { audio: 'aac' })
    args.push(...video.args, ...audio.args, '-movflags', '+faststart', longPath(target))
    plan = {
      passes: [{ args }],
      out: target,
      notes: ['交付视频：重编码为 H.264/AAC 的 MP4，任何播放器都能开。', ...video.notes, ...audio.notes],
      expect: { video: true, audio: facts.audio !== null },
    }
  }

  progress(`交付视频：${mode === 'copy' ? '流复制' : '重编码'} → ${target}`)
  const result = await execute(plan, { config, onProgress: undefined, timeoutMs: options.encodeTimeoutMs })
  const verified = await verifyOutput(target, {
    config,
    video: true,
    audio: facts.audio !== null,
    expectedDurationSec: facts.durationSec ?? undefined,
    durationToleranceSec: 2,
  })
  return {
    path: target,
    mode,
    chaptersPath,
    bytes: statSync(target).size,
    ok: verified.ok,
    problems: verified.problems,
    facts: verified.facts,
    passes: result.passes,
    elapsedMs: result.elapsedMs,
    fallbackReason: fallbackReason ?? null,
    notes: [...notes, ...(result.notes ?? [])],
  }
}

/**
 * Build one contact sheet from the extracted stills.
 *
 * @param {string[]} stills - the still paths, in order.
 * @param {string} out - where to write the sheet.
 * @param {object} [options] - `{ config, onProgress, columns, cellWidth }`.
 * @returns {Promise<string>} the sheet path.
 */
export async function makeContactSheet(stills, out, options = {}) {
  const columns = Number.isFinite(options.columns) ? options.columns : 5
  const cellWidth = Number.isFinite(options.cellWidth) ? options.cellWidth : 320
  const directory = dirname(stills[0])
  const extension = extname(stills[0])
  const pattern = join(directory, `kf_%04d${extension}`)
  const args = [
    '-i', longPath(pattern),
    '-vf', `scale=${cellWidth}:-2,tile=${columns}x${Math.max(1, Math.ceil(stills.length / columns))}:padding=6:margin=8:color=0x101010`,
    '-frames:v', '1', '-q:v', '3', '-update', '1', longPath(out),
  ]
  await run({ tool: 'ffmpeg', args, config: options.config ?? {}, timeoutMs: 180_000 })
  options.onProgress?.(`联系表：${stills.length} 帧 → ${out}`)
  return out
}

/**
 * Stage 4 for one frame, without any timeline: label the rectangles in a picture.
 *
 * @param {object} request - `{ input, at, config, options }`.
 * @returns {Promise<object>} the region report.
 * @throws {MediaError} when the frame cannot be read.
 */
export async function regions(request) {
  const config = request.config ?? {}
  const input = request.input
  if (typeof input !== 'string' || input.trim() === '') throw new MediaError('需要 input：要分割的图片或视频。')
  if (!existsSync(input)) throw new MediaError(`文件不存在：${input}`)
  const options = normalizeOptions({ ...request.options, segmentation: request.options?.segmentation ?? 'grid' })

  const facts = await probe(input, config)
  const rgb = await loadRgb(input, {
    at: Number.isFinite(request.at) ? request.at : null,
    maxSide: options.maxSide,
    config,
  })
  const segmentation = segmentFrame(rgb.data, rgb.width, rgb.height, {
    tileSize: options.tileSize,
    thresholds: options.regionThresholds,
  })

  const result = {
    input,
    at: Number.isFinite(request.at) ? request.at : null,
    source: { kind: facts.kind, width: facts.video?.displayWidth ?? null, height: facts.video?.displayHeight ?? null },
    frame: { width: rgb.width, height: rgb.height },
    grid: segmentation.grid,
    regions: segmentation.regions,
    labelShares: segmentation.labelShares,
    dominantColors: segmentation.dominantColors,
    droppedRegions: segmentation.droppedRegions,
    vocabulary: Object.fromEntries(REGION_LABELS.map((label) => [label, LABEL_MEANINGS[label]])),
    thresholds: segmentation.thresholds,
    notes: ['这是按块的外观分类（确定性、无模型），不是学习式语义分割；每个区域都带着判定它的数值。'],
  }

  if (options.segmentation === 'salient' || options.segmentation === 'both') {
    result.salient = await salientFrame(input, {
      at: Number.isFinite(request.at) ? request.at : null,
      frameWidth: facts.video?.displayWidth ?? rgb.width,
      frameHeight: facts.video?.displayHeight ?? rgb.height,
      maskPath: typeof request.maskPath === 'string' ? request.maskPath : undefined,
      config,
    })
    if (result.salient.available !== true) result.notes.push(`学习式分割不可用：${result.salient.reason}`)
  }
  return result
}

/**
 * Total the segments by kind.
 * @param {object[]} segments - the analysed segments.
 * @returns {{kind: string, segments: number, totalSec: number, share: number}[]} the totals, longest first.
 */
export function summarizeKinds(segments) {
  const total = segments.reduce((sum, segment) => sum + (segment.durationSec ?? 0), 0)
  const byKind = new Map()
  for (const segment of segments) {
    const entry = byKind.get(segment.kind) ?? { kind: segment.kind, segments: 0, totalSec: 0 }
    entry.segments += 1
    entry.totalSec += segment.durationSec ?? 0
    byKind.set(segment.kind, entry)
  }
  return [...byKind.values()]
    .map((entry) => ({ ...entry, totalSec: Number(entry.totalSec.toFixed(3)), share: total > 0 ? Number((entry.totalSec / total).toFixed(4)) : 0 }))
    .sort((left, right) => right.totalSec - left.totalSec)
}

/**
 * Average the appearance labels across every enriched segment.
 * @param {object[]} segments - the analysed segments.
 * @returns {Record<string, number>} the mean share per label.
 */
export function summarizeLabels(segments) {
  const sums = {}
  let count = 0
  for (const segment of segments) {
    if (segment.labelShares === null || segment.labelShares === undefined) continue
    count += 1
    for (const [label, share] of Object.entries(segment.labelShares)) sums[label] = (sums[label] ?? 0) + share
  }
  if (count === 0) return {}
  return Object.fromEntries(Object.entries(sums).map(([label, sum]) => [label, Number((sum / count).toFixed(4))]))
}

/**
 * Render a path relative to a directory, for a structure document that stays readable.
 * @param {string} directory - the base directory.
 * @param {string} path - the absolute path.
 * @returns {string} the relative path.
 */
function relativeTo(directory, path) {
  const base = directory.endsWith('\\') || directory.endsWith('/') ? directory : `${directory}${process.platform === 'win32' ? '\\' : '/'}`
  return path.toLowerCase().startsWith(base.toLowerCase()) ? path.slice(base.length) : path
}
