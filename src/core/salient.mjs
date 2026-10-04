/**
 * The optional learned segmentation, borrowed rather than reimplemented.
 *
 * The U²-Net salient-object model and the ONNX runtime that runs it already exist in this
 * ecosystem: the model is installed by `video_setup {action:"install_matte"}` into a sibling
 * `video-factory` checkout, and the runtime is vendored by `dsh-video-audio`. Re-fetching 4 MB of
 * model and 13 MB of runtime to run the same network from a second plugin would be waste, so this
 * module asks the sibling for a mask and preserves the answer's provenance.
 *
 * When the sibling or the model is missing, this reports **why**, and the caller falls back to the
 * appearance classes it computes itself. Nothing here is required for `ffmpeg_semantics` to work.
 *
 * @module dsh-ffmpeg/core/salient
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { PLUGIN_ROOT, siblingRoots } from './env.mjs'
import { pathToFileURL } from 'node:url'

/**
 * Every checkout that could hold `video-factory`, nearest first.
 * @param {object} [config] - normalized plugin config.
 * @returns {string[]} absolute candidate directories.
 */
export function siblingVideoFactoryRoots(config = {}) {
  const candidates = []
  if (typeof config.salientPluginPath === 'string' && config.salientPluginPath.trim() !== '') {
    candidates.push(config.salientPluginPath.trim())
  }
  for (const root of siblingRoots()) candidates.push(join(root, 'video-factory'))
  return [...new Set(candidates.map((entry) => entry.replace(/[\\/]+$/, '')))]
}

/** Cached sibling lookup. The value is a promise so two concurrent calls share one import. */
let siblingPromise = null

/**
 * Load the sibling's matting core, when it is installed.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{module: object, root: string, state: object}|null>} the module and its model state, or null.
 */
export async function loadSalient(config = {}) {
  if (siblingPromise !== null) return siblingPromise
  siblingPromise = (async () => {
    for (const root of siblingVideoFactoryRoots(config)) {
      const corePath = join(root, 'src', 'core', 'index.mjs')
      if (!existsSync(corePath)) continue
      try {
        const module = await import(pathToFileURL(corePath).href)
        if (typeof module.matteFrame !== 'function' || typeof module.matteState !== 'function') continue
        return { module, root, state: module.matteState() }
      } catch {
        // A sibling that cannot be imported counts as absent.
      }
    }
    return null
  })()
  return siblingPromise
}

/** Forget the sibling lookup. For tests. @returns {void} */
export function resetSalientCache() {
  siblingPromise = null
}

/**
 * Report whether a learned mask is available, and what it would cost.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<object>} the report.
 */
export async function salientReport(config = {}) {
  const sibling = await loadSalient(config)
  if (sibling === null) {
    return {
      available: false,
      provider: null,
      roots: siblingVideoFactoryRoots(config),
      reason: '没有找到同级 video-factory（它提供 U²-Net 模型与推理入口）。',
      installHint: '把 video-factory 与 dsh-video-audio 检出在同一目录，再运行 video_setup {action:"install_matte"}。',
    }
  }
  const state = sibling.state ?? {}
  return {
    available: state.available === true,
    provider: 'video-factory/u2net',
    root: sibling.root,
    model: state.model === true,
    runtime: state.runtime === true,
    runtimeDir: state.runtimeDir ?? null,
    missing: state.missing ?? [],
    reason: state.available === true ? null : (state.reason ?? '模型或推理运行时没装齐。'),
    installHint: 'video_setup {action:"install_matte"}；推理运行时由 dsh-video-audio 的 audio_setup {action:"install"} 提供。',
  }
}

/**
 * Cut the salient subject out of one frame and describe it as rectangles and a mask.
 *
 * @param {string} source - the image, or a video with `at` set.
 * @param {object} [options] - the call.
 * @param {number} [options.at] - the second of the video to use.
 * @param {number} [options.frameWidth] - the frame's width, used to scale the mask back to pixels.
 * @param {number} [options.frameHeight] - the frame's height.
 * @param {string} [options.maskPath] - write the greyscale mask here.
 * @param {object} [options.config] - normalized plugin config.
 * @returns {Promise<object>} the mask's geometry, or a refusal with the reason.
 */
export async function salientFrame(source, options = {}) {
  const report = await salientReport(options.config ?? {})
  if (!report.available) {
    return { available: false, provider: report.provider, reason: report.reason, installHint: report.installHint }
  }
  const sibling = await loadSalient(options.config ?? {})
  const started = Date.now()
  const result = await sibling.module.matteFrame(source, {
    at: options.at,
    config: {},
    onProgress: options.onProgress,
  })

  const side = result.side
  const alpha = result.alpha
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 127

  let minX = side
  let minY = side
  let maxX = -1
  let maxY = -1
  let foreground = 0
  const columnShares = new Array(side).fill(0)
  const rowShares = new Array(side).fill(0)

  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      if (alpha[y * side + x] < threshold) continue
      foreground += 1
      columnShares[x] += 1
      rowShares[y] += 1
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }

  const total = side * side
  const frameWidth = Number.isFinite(options.frameWidth) ? options.frameWidth : side
  const frameHeight = Number.isFinite(options.frameHeight) ? options.frameHeight : side
  const box =
    maxX < 0
      ? null
      : {
          x: Math.round((minX / side) * frameWidth),
          y: Math.round((minY / side) * frameHeight),
          width: Math.round(((maxX - minX + 1) / side) * frameWidth),
          height: Math.round(((maxY - minY + 1) / side) * frameHeight),
          normalized: {
            x: Number((minX / side).toFixed(4)),
            y: Number((minY / side).toFixed(4)),
            width: Number(((maxX - minX + 1) / side).toFixed(4)),
            height: Number(((maxY - minY + 1) / side).toFixed(4)),
          },
        }

  let maskPath = null
  if (typeof options.maskPath === 'string' && options.maskPath !== '' && typeof sibling.module.writeMaskPng === 'function') {
    maskPath = await sibling.module.writeMaskPng(alpha, side, options.maskPath, { config: {} })
  }

  return {
    available: true,
    provider: report.provider,
    source: sibling.root,
    side,
    maskSize: side,
    frame: { width: frameWidth, height: frameHeight },
    threshold,
    foregroundRatio: Number((foreground / total).toFixed(4)),
    meanLevel: result.statistics?.meanLevel ?? null,
    box,
    // Occupancy profiles are the cheap way to say *where* the subject is without exporting a mask:
    // each entry is the share of that column (or row) that belongs to the subject.
    columnProfile: summarizeProfile(columnShares, side),
    rowProfile: summarizeProfile(rowShares, side),
    maskPath,
    elapsedMs: Date.now() - started,
    notes: ['U²-Net 输出的是「显著物体 vs 背景」，与 grid 模式的「外观类别」不是同一件事，输出里两者分开标注。'],
  }
}

/**
 * Reduce a per-column (or per-row) occupancy array to a few numbers.
 * @param {number[]} shares - raw counts per column.
 * @param {number} side - the mask side.
 * @returns {{start: number, end: number, peak: number}} normalized start, end and peak of the occupied band.
 */
function summarizeProfile(shares, side) {
  const threshold = side * 0.05
  let start = -1
  let end = -1
  let peak = 0
  let peakAt = 0
  for (let index = 0; index < shares.length; index += 1) {
    if (shares[index] >= threshold) {
      if (start < 0) start = index
      end = index
    }
    if (shares[index] > peak) {
      peak = shares[index]
      peakAt = index
    }
  }
  return {
    start: start < 0 ? null : Number((start / side).toFixed(4)),
    end: end < 0 ? null : Number((end / side).toFixed(4)),
    peak: Number((peak / side).toFixed(4)),
    peakAt: Number((peakAt / side).toFixed(4)),
  }
}

/** Re-exported so the guide can name the plugin root the search starts from. */
export const SEARCH_FROM = PLUGIN_ROOT
