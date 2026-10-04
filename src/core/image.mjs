/**
 * Pixels in, pixels out — the small amount of image arithmetic this plugin needs, and the two
 * ways it gets pixels from ffmpeg.
 *
 * There is no image library here on purpose. Every pixel this plugin reads arrives as raw
 * `rgb24` straight out of ffmpeg, so the only decoder involved is ffmpeg itself — which is the
 * tool the plugin is about, is version-pinned or discoverable, and already has to be present.
 * A PNG decoder written by hand would be a second, worse copy of that.
 *
 * The arithmetic is deliberately allocation-light: analysis decodes thousands of frames, and a
 * copy per frame is the difference between a scan that finishes and one that thrashes.
 *
 * @module dsh-ffmpeg/core/image
 */
import { statSync } from 'node:fs'
import { run } from './ffmpeg.mjs'

/** Default long side for analysis frames. Small enough to be cheap, large enough to see a layout. */
export const ANALYSIS_MAX_SIDE = 320

/**
 * Compute the output size of a fit-to-box scale, keeping the aspect ratio and even dimensions.
 *
 * Even dimensions are not a style choice: H.264 and most hardware paths refuse an odd width or
 * height, and `scale=-2` silently rounds, so the arithmetic is done here where it can be tested.
 *
 * @param {number} width - source width.
 * @param {number} height - source height.
 * @param {number} [maxSide] - longest side of the result.
 * @param {object} [options] - `{ mode: 'fit'|'width'|'height', even: boolean }`.
 * @returns {{width: number, height: number, scale: number}} the target size and the factor applied.
 */
export function fitSize(width, height, maxSide = ANALYSIS_MAX_SIDE, options = {}) {
  const even = options.even !== false
  const safeWidth = Math.max(2, Math.round(Number(width) || 2))
  const safeHeight = Math.max(2, Math.round(Number(height) || 2))
  const mode = options.mode ?? 'fit'

  let scale = 1
  if (mode === 'width') scale = Number(maxSide) / safeWidth
  else if (mode === 'height') scale = Number(maxSide) / safeHeight
  else scale = Math.min(1, Number(maxSide) / Math.max(safeWidth, safeHeight))

  const round = (value) => {
    const rounded = Math.max(2, Math.round(value))
    if (!even) return rounded
    return rounded % 2 === 0 ? rounded : rounded + 1
  }
  const targetWidth = round(safeWidth * scale)
  const targetHeight = round(safeHeight * scale)
  return { width: targetWidth, height: targetHeight, scale: targetWidth / safeWidth }
}

/**
 * Decode one image, or one frame of a video, into raw RGB at a bounded size.
 *
 * @param {string} source - the image or video.
 * @param {object} [options] - the decode.
 * @param {number} [options.at] - for a video, the second to take.
 * @param {number} [options.maxSide] - long side of the result. Default {@link ANALYSIS_MAX_SIDE}.
 * @param {number|null} [options.width] - force this width instead of fitting.
 * @param {number|null} [options.height] - force this height instead of fitting.
 * @param {object} [options.config] - normalized plugin config.
 * @returns {Promise<{width: number, height: number, data: Uint8Array, source: string, at: number|null}>} the pixels.
 * @throws {import('./ffmpeg.mjs').FfmpegError} when ffmpeg cannot read the source.
 */
export async function loadRgb(source, options = {}) {
  const { at = null, config = {} } = options
  const maxSide = options.maxSide ?? ANALYSIS_MAX_SIDE

  // The target size is computed here and passed to ffmpeg explicitly, never as `-2` or a filter
  // expression: a one-pixel disagreement between the size the filter chooses and the size this
  // module expects would shear every frame, and it is exactly the kind of bug that looks like a
  // broken file rather than a wrong number.
  const size = await outputSize(source, { maxSide, width: options.width, height: options.height, config })

  const args = ['-v', 'error']
  if (at !== null) args.push('-ss', String(at))
  args.push('-i', source)
  if (at !== null) args.push('-frames:v', '1')
  args.push('-vf', `scale=${size.width}:${size.height}:flags=bilinear`)
  args.push('-an', '-sn', '-dn', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-')

  const result = await run({ tool: 'ffmpeg', args, config, timeoutMs: 120_000 })
  const buffer = result.stdoutBuffer
  const expected = size.width * size.height * 3
  if (buffer.length < expected) {
    throw new Error(
      `解码 ${source} 得到的像素比预期少（${buffer.length} < ${expected} 字节，期望 ${size.width}x${size.height}）。`,
    )
  }
  return {
    width: size.width,
    height: size.height,
    data: new Uint8Array(buffer.buffer, buffer.byteOffset, expected),
    source,
    at,
  }
}

/**
 * Work out the size {@link loadRgb} will produce, from the source's own dimensions.
 *
 * @param {string} source - the image or video.
 * @param {object} options - `{ maxSide, width, height, config }`.
 * @returns {Promise<{width: number, height: number, scale: number}>} the target size.
 */
async function outputSize(source, options) {
  if (Number.isFinite(options.width) && Number.isFinite(options.height)) {
    const even = (value) => {
      const rounded = Math.max(2, Math.round(value))
      return rounded % 2 === 0 ? rounded : rounded + 1
    }
    const width = even(options.width)
    const height = even(options.height)
    return { width, height, scale: width / Math.max(1, options.width) }
  }
  const { probe } = await import('./probe.mjs')
  const facts = await probe(source, options.config)
  const video = facts.video ?? null
  if (video === null) {
    throw new Error(`没有视频流可解码：${source}（这是一${facts.kind === 'audio' ? '个纯音频文件' : '个无法识别的文件'}）`)
  }
  const width = video.displayWidth ?? video.width
  const height = video.displayHeight ?? video.height
  return fitSize(width, height, options.maxSide ?? ANALYSIS_MAX_SIDE)
}

/**
 * Read one pixel.
 * @param {Uint8Array} data - RGB pixels.
 * @param {number} width - row length in pixels.
 * @param {number} x - column.
 * @param {number} y - row.
 * @returns {{r: number, g: number, b: number}} the pixel.
 */
export function pixelAt(data, width, x, y) {
  const offset = (y * width + x) * 3
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2] }
}

/**
 * The mean colour of a rectangle, ignoring nothing.
 *
 * @param {Uint8Array} data - RGB pixels.
 * @param {number} width - row length in pixels.
 * @param {{x: number, y: number, width: number, height: number}} rect - the region.
 * @returns {{r: number, g: number, b: number}} the mean, rounded.
 */
export function meanColor(data, width, rect) {
  let r = 0
  let g = 0
  let b = 0
  let count = 0
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      const offset = (y * width + x) * 3
      r += data[offset]
      g += data[offset + 1]
      b += data[offset + 2]
      count += 1
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0 }
  return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
}

/**
 * Render a colour as `#rrggbb`.
 * @param {{r: number, g: number, b: number}} color - the colour.
 * @returns {string} the hex spelling.
 */
export function toHex(color) {
  const part = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`
}

/**
 * Perceived brightness of a colour, 0–255.
 * @param {{r: number, g: number, b: number}} color - the colour.
 * @returns {number} the luma value.
 */
export function luma(color) {
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b
}

/**
 * Extract one still from an image or video and write it as PNG or JPEG.
 *
 * @param {string} source - the image or video.
 * @param {object} options - the extraction.
 * @param {string} options.out - where to write.
 * @param {number} [options.at] - for a video, the second to take.
 * @param {number} [options.maxSide] - do not exceed this long side; never upscales.
 * @param {number} [options.quality] - JPEG quality, 2 (best) to 31 (worst). Default 3.
 * @param {object} [options.config] - normalized plugin config.
 * @returns {Promise<{path: string, bytes: number, elapsedMs: number}>} what was written.
 * @throws {import('./ffmpeg.mjs').FfmpegError} when ffmpeg fails.
 */
export async function saveStill(source, options) {
  const { out, at = null, config = {} } = options
  const maxSide = options.maxSide ?? 1280
  const quality = Number.isFinite(options.quality) ? options.quality : 3
  const isPng = /\.png$/i.test(out)
  const args = ['-v', 'error']
  if (at !== null) args.push('-ss', String(at))
  args.push('-i', source)
  args.push('-frames:v', '1')
  args.push('-vf', `scale='min(${maxSide},iw)':-2:flags=lanczos`)
  args.push('-an', '-sn', '-dn')
  if (isPng) args.push('-compression_level', '6')
  else args.push('-q:v', String(quality))
  args.push('-update', '1', out)

  const result = await run({ tool: 'ffmpeg', args, config, timeoutMs: 180_000 })
  return { path: out, bytes: statSync(out).size, elapsedMs: result.elapsedMs }
}
