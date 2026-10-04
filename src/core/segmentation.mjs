/**
 * Turning a frame into labelled rectangles — the plugin's own segmentation, with no model.
 *
 * What this is, stated plainly, because the difference matters to anyone reading the output:
 * these are **appearance classes**, measured per tile and merged into rectangles. They describe
 * what a region looks like — dense fine edges, flat fill, colour-rich picture, structure without
 * colour — and on a screen recording that is most of what a reader wants to know. They are *not*
 * the output of a trained segmentation network, and nothing here guesses that a rectangle is a
 * button rather than a paragraph. When a learned mask is available (a sibling `video-factory`
 * checkout with the U²-Net model installed), `ffmpeg_semantics` offers that separately and says
 * which provider answered.
 *
 * Everything here is a pure function over a raw RGB buffer, which is what makes the claim
 * checkable: the same frame and the same thresholds give the same rectangles, on any machine.
 *
 * @module dsh-ffmpeg/core/segmentation
 */
import { meanColor, toHex } from './image.mjs'

/** The vocabulary. Every label describes appearance, never intent. */
export const REGION_LABELS = ['text', 'picture', 'texture', 'flat', 'dark']

/** What each label means, for the report and the guide. */
export const LABEL_MEANINGS = {
  text: '细密高频边缘、低饱和：文字、代码、表格线密集的地方。',
  picture: '色彩丰富或有连续纹理：照片、视频画面、彩色插图。',
  texture: '有结构但不彩色：灰度图表、控件、分隔线组成的区域。',
  flat: '接近单一颜色且不暗：面板、留白、纯色背景。',
  dark: '接近单一颜色且很暗：黑边、暗色主题背景。',
}

/** Default tile side, in pixels of the analysis frame. */
export const DEFAULT_TILE_SIZE = 16

/** Defaults for every threshold, all measured on the 0–255 luma scale. */
export const DEFAULT_THRESHOLDS = {
  /** Below this luma standard deviation a tile counts as flat. */
  flatStd: 4,
  /** Below this mean luma a flat tile is called dark instead. */
  darkLuma: 48,
  /** Gradient magnitude that counts as an edge pixel. */
  edgeGradient: 24,
  /** Edge-pixel share above which a low-saturation tile is called text. */
  textEdgeDensity: 0.09,
  /** Mean saturation below which a tile can be called text. */
  textSaturation: 0.22,
  /** Mean saturation above which a tile is called a picture. */
  pictureSaturation: 0.18,
  /** Edge-pixel share above which an unsaturated, structured tile is called texture. */
  textureEdgeDensity: 0.025,
  /** Smallest region worth reporting, as a share of the frame. */
  minAreaRatio: 0.004,
}

/**
 * Compute per-tile statistics for one RGB frame.
 *
 * @param {Uint8Array} data - RGB pixels, `width * height * 3` bytes.
 * @param {number} width - frame width.
 * @param {number} height - frame height.
 * @param {number} [tileSize] - tile side in pixels.
 * @returns {{cols: number, rows: number, tileSize: number, tiles: object[]}} the grid.
 */
export function tileStats(data, width, height, tileSize = DEFAULT_TILE_SIZE) {
  const cols = Math.max(1, Math.floor(width / tileSize))
  const rows = Math.max(1, Math.floor(height / tileSize))
  const tiles = []

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = col * tileSize
      const y0 = row * tileSize
      // The last tile in a row or column is clipped rather than padded: a partial tile is a real
      // tile, and dropping it would leave a strip of the frame unclassified. `x1`/`y1` are exclusive
      // so the reported width matches the pixels actually measured — a tile that claims one pixel
      // more than it counted makes every merged rectangle slightly too large, and the label shares
      // then sum to more than the frame.
      const x1 = col === cols - 1 ? width : x0 + tileSize
      const y1 = row === rows - 1 ? height : y0 + tileSize

      let sum = 0
      let sumSquares = 0
      let saturation = 0
      let edges = 0
      let pixels = 0

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * 3
          const r = data[offset]
          const g = data[offset + 1]
          const b = data[offset + 2]
          const value = 0.2126 * r + 0.7152 * g + 0.0722 * b
          sum += value
          sumSquares += value * value
          const max = Math.max(r, g, b)
          const min = Math.min(r, g, b)
          saturation += max === 0 ? 0 : (max - min) / max
          pixels += 1

          if (x + 1 < width) {
            const right = offset + 3
            const rightValue = 0.2126 * data[right] + 0.7152 * data[right + 1] + 0.0722 * data[right + 2]
            if (Math.abs(rightValue - value) > DEFAULT_THRESHOLDS.edgeGradient) edges += 1
          }
          if (y + 1 < height) {
            const below = offset + width * 3
            const belowValue = 0.2126 * data[below] + 0.7152 * data[below + 1] + 0.0722 * data[below + 2]
            if (Math.abs(belowValue - value) > DEFAULT_THRESHOLDS.edgeGradient) edges += 1
          }
        }
      }

      const count = Math.max(1, pixels)
      const mean = sum / count
      const variance = Math.max(0, sumSquares / count - mean * mean)
      tiles.push({
        col,
        row,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        meanLuma: Number(mean.toFixed(2)),
        lumaStd: Number(Math.sqrt(variance).toFixed(2)),
        saturation: Number((saturation / count).toFixed(4)),
        edgeDensity: Number((edges / (count * 2)).toFixed(4)),
      })
    }
  }

  return { cols, rows, tileSize, tiles }
}

/**
 * Classify one tile by appearance.
 *
 * The order is the argument: flatness is checked before structure, because a text-free black bar
 * and a dense code block can share a luma mean and nothing else, and structure is checked before
 * colour, because coloured text should be read as text.
 *
 * @param {object} tile - one entry from {@link tileStats}.
 * @param {object} [thresholds] - overrides for {@link DEFAULT_THRESHOLDS}.
 * @returns {{label: string, score: number}} the label and how far it is from the threshold.
 */
export function classifyTile(tile, thresholds = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...thresholds }
  if (tile.lumaStd < limits.flatStd) {
    const label = tile.meanLuma < limits.darkLuma ? 'dark' : 'flat'
    return { label, score: Number((1 - tile.lumaStd / limits.flatStd).toFixed(3)) }
  }
  if (tile.edgeDensity >= limits.textEdgeDensity && tile.saturation <= limits.textSaturation) {
    return { label: 'text', score: Number(Math.min(1, tile.edgeDensity / (limits.textEdgeDensity * 2)).toFixed(3)) }
  }
  if (tile.saturation >= limits.pictureSaturation) {
    return { label: 'picture', score: Number(Math.min(1, tile.saturation / (limits.pictureSaturation * 2)).toFixed(3)) }
  }
  if (tile.edgeDensity >= limits.textureEdgeDensity) {
    return { label: 'texture', score: Number(Math.min(1, tile.edgeDensity / (limits.textureEdgeDensity * 4)).toFixed(3)) }
  }
  // Structured but quiet: still not a flat fill, so it is reported as the weakest kind of texture
  // rather than being forced into `flat`, which would claim a uniformity the numbers deny.
  return { label: 'texture', score: 0.1 }
}

/**
 * Merge labelled tiles into the largest rectangles that keep one label.
 *
 * Runs of equal labels are built along each row and then grown downwards, which produces a
 * small set of rectangles rather than one per tile — the difference between an answer a reader
 * can use and a 200-entry list.
 *
 * @param {object[]} tiles - tiles with a `label` field.
 * @param {object} grid - `{ cols, rows, tileSize }`.
 * @param {number} width - frame width.
 * @param {number} height - frame height.
 * @returns {object[]} regions with `{label, x, y, width, height, tiles, score}`.
 */
export function mergeRegions(tiles, grid, width, height) {
  const at = (col, row) => tiles[row * grid.cols + col]
  const consumed = new Set()
  const taken = (col, row) => consumed.has(`${col}:${row}`)
  const regions = []

  for (let row = 0; row < grid.rows; row += 1) {
    let col = 0
    while (col < grid.cols) {
      const start = at(col, row)
      // A tile claimed by a rectangle that grew down from an earlier row is skipped: re-claiming it
      // would report overlapping regions, and their areas would sum to more than the frame.
      if (start === undefined || start.label === undefined || taken(col, row)) {
        col += 1
        continue
      }
      let end = col
      while (end + 1 < grid.cols && at(end + 1, row)?.label === start.label && !taken(end + 1, row)) end += 1

      // How far down the whole run keeps the same label and is still unclaimed.
      let bottom = row
      while (bottom + 1 < grid.rows) {
        let same = true
        for (let c = col; c <= end; c += 1) {
          const tile = at(c, bottom + 1)
          if (tile === undefined || tile.label !== start.label || taken(c, bottom + 1)) {
            same = false
            break
          }
        }
        if (!same) break
        bottom += 1
      }

      let scoreSum = 0
      let count = 0
      for (let r = row; r <= bottom; r += 1) {
        for (let c = col; c <= end; c += 1) {
          consumed.add(`${c}:${r}`)
          scoreSum += at(c, r)?.score ?? 0
          count += 1
        }
      }

      const left = start.x
      const top = start.y
      const rightTile = at(end, row)
      const bottomTile = at(col, bottom)
      const regionWidth = rightTile.x + rightTile.width - left
      const regionHeight = bottomTile.y + bottomTile.height - top
      regions.push({
        label: start.label,
        x: left,
        y: top,
        width: regionWidth,
        height: regionHeight,
        areaRatio: Number(((regionWidth * regionHeight) / (width * height)).toFixed(4)),
        tiles: count,
        score: Number((scoreSum / Math.max(1, count)).toFixed(3)),
      })
      col = end + 1
    }
  }
  return regions
}

/**
 * Segment one frame into labelled regions.
 *
 * @param {Uint8Array} data - RGB pixels.
 * @param {number} width - frame width.
 * @param {number} height - frame height.
 * @param {object} [options] - `{ tileSize, thresholds, maxRegions, colors }`.
 * @returns {object} the regions, the label shares and the dominant colours.
 */
export function segmentFrame(data, width, height, options = {}) {
  const limits = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) }
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE
  const maxRegions = Number.isFinite(options.maxRegions) ? options.maxRegions : 24

  const grid = tileStats(data, width, height, tileSize)
  const classified = grid.tiles.map((tile) => {
    const { label, score } = classifyTile(tile, limits)
    return { ...tile, label, score }
  })

  const merged = mergeRegions(classified, grid, width, height)
  const kept = merged
    .filter((region) => region.areaRatio >= limits.minAreaRatio)
    .sort((left, right) => right.areaRatio - left.areaRatio)
    .slice(0, maxRegions)
    .map((region) => ({
      ...region,
      colors: [toHex(meanColor(data, width, region))],
    }))

  const dropped = merged.filter((region) => region.areaRatio < limits.minAreaRatio)
  const shares = {}
  for (const region of merged) {
    shares[region.label] = Number(((shares[region.label] ?? 0) + region.areaRatio).toFixed(4))
  }

  return {
    grid: { cols: grid.cols, rows: grid.rows, tileSize: grid.tileSize },
    regions: kept,
    labelShares: shares,
    droppedRegions: dropped.length,
    dominantColors: dominantColors(data, { maxColors: options.colors ?? 4 }),
    thresholds: limits,
  }
}

/**
 * The colours that cover the most pixels, quantized so near-identical shades are one entry.
 *
 * @param {Uint8Array} data - RGB pixels.
 * @param {object} [options] - `{ maxColors, bits }`.
 * @returns {{hex: string, share: number}[]} the colours, most common first.
 */
export function dominantColors(data, options = {}) {
  const maxColors = Number.isFinite(options.maxColors) ? options.maxColors : 4
  const shift = 8 - (Number.isFinite(options.bits) ? options.bits : 4)
  const buckets = new Map()
  let total = 0

  for (let offset = 0; offset + 2 < data.length; offset += 3) {
    const key = ((data[offset] >> shift) << 8) | ((data[offset + 1] >> shift) << 4) | (data[offset + 2] >> shift)
    const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 }
    bucket.count += 1
    bucket.r += data[offset]
    bucket.g += data[offset + 1]
    bucket.b += data[offset + 2]
    buckets.set(key, bucket)
    total += 1
  }

  return [...buckets.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, maxColors)
    // The reported colour is the MEAN of the pixels in the bucket, not the quantized bucket centre:
    // a bucket centre for pure white would come back as #f0f0f0, which is a colour that was never
    // in the frame.
    .map((bucket) => ({
      hex: toHex({ r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count }),
      share: Number((bucket.count / Math.max(1, total)).toFixed(4)),
    }))
}

/**
 * How different two frames are, in the two ways this plugin needs.
 *
 * `meanAbsDiff` is the average luma change per pixel and drives cut detection; `changedRatio` is
 * the share of pixels that moved at all, which tells a whole-screen switch from a progress bar.
 * Two frames of the same size are required: the analysis decode guarantees it.
 *
 * @param {Uint8Array} previous - RGB pixels of the earlier frame.
 * @param {Uint8Array} current - RGB pixels of the later frame.
 * @returns {{meanAbsDiff: number, changedRatio: number, maxDiff: number}} the measurement.
 */
export function frameDifference(previous, current) {
  const length = Math.min(previous.length, current.length)
  let sum = 0
  let changed = 0
  let max = 0
  let pixels = 0

  for (let offset = 0; offset + 2 < length; offset += 3) {
    const previousLuma = 0.2126 * previous[offset] + 0.7152 * previous[offset + 1] + 0.0722 * previous[offset + 2]
    const currentLuma = 0.2126 * current[offset] + 0.7152 * current[offset + 1] + 0.0722 * current[offset + 2]
    const difference = Math.abs(currentLuma - previousLuma)
    sum += difference
    if (difference > 12) changed += 1
    if (difference > max) max = difference
    pixels += 1
  }

  return {
    meanAbsDiff: Number((sum / Math.max(1, pixels)).toFixed(3)),
    changedRatio: Number((changed / Math.max(1, pixels)).toFixed(4)),
    maxDiff: Number(max.toFixed(2)),
  }
}
