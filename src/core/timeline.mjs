/**
 * Building the timeline: where one thing on screen becomes another.
 *
 * The analysis decodes a video once at a small size and hands every frame to a
 * {@link TimelineBuilder}, which decides where segments begin and end. Three rules, in order:
 *
 * - a **cut** when the frame changed enough to be a different screen (score ≥ threshold), provided
 *   the current segment has already lasted the minimum;
 * - a **cadence** break when a segment has run longer than the maximum, so a static hour does not
 *   become one segment nobody can point at;
 * - the **end** of the file.
 *
 * A segment therefore always ends for a stated reason, and the reason is part of the output. The
 * measured motion of each segment is kept, and the keyframe a caller should look at is computed
 * from the segment itself — which is why this is a small state machine rather than a filter graph.
 *
 * @module dsh-ffmpeg/core/timeline
 */
import { frameDifference } from './segmentation.mjs'

/** Default cut threshold, in mean absolute luma difference per pixel (0–255). */
export const DEFAULT_SCENE_THRESHOLD = 8

/** Default shortest segment, in seconds. */
export const DEFAULT_MIN_SEGMENT = 1

/** Default longest segment, in seconds. */
export const DEFAULT_MAX_SEGMENT = 30

/** How a segment ended. */
export const SEGMENT_REASONS = ['start', 'cut', 'cadence', 'end']

/**
 * Name a motion level from its measurement.
 *
 * The bands are observations about screen recordings, not universal truths: a talking-head video
 * sits in `low` for its whole length, and that is the correct reading of it.
 *
 * @param {number} meanAbsDiff - mean absolute luma difference per pixel.
 * @returns {'static'|'low'|'moderate'|'high'} the level.
 */
export function motionLevel(meanAbsDiff) {
  if (meanAbsDiff < 0.5) return 'static'
  if (meanAbsDiff < 3) return 'low'
  if (meanAbsDiff < 10) return 'moderate'
  return 'high'
}

/**
 * Choose the second inside a segment that is worth looking at, and reading text from.
 *
 * `mid` is the default because it is the most representative frame of a stable screen; `lead`
 * suits a screen that is still loading when the segment starts, and `last` suits a segment that
 * only becomes complete at its end.
 *
 * @param {{start: number, end: number}} segment - the segment.
 * @param {'mid'|'lead'|'last'} [strategy] - which frame to choose.
 * @param {number} [fps] - analysis frame rate, used to stay inside the segment.
 * @returns {number} the timestamp in seconds.
 */
export function keyframeTime(segment, strategy = 'mid', fps = 4) {
  const duration = Math.max(0, segment.end - segment.start)
  const guard = Math.min(0.2, duration / 4)
  if (strategy === 'lead') return Number((segment.start + Math.min(0.5, duration / 2)).toFixed(3))
  if (strategy === 'last') return Number(Math.max(segment.start, segment.end - Math.max(1 / fps, guard)).toFixed(3))
  return Number((segment.start + duration / 2).toFixed(3))
}

/**
 * The streaming segmenter.
 *
 * Feed it one frame at a time; it returns nothing while a segment is open and a finished segment
 * when one closes. Keeping only the open segment's accumulator is what allows an hour-long file
 * to be analysed in constant memory — apart from the frames deliberately kept as keyframes.
 */
export class TimelineBuilder {
  /**
   * @param {object} [options] - the thresholds.
   * @param {number} [options.sceneThreshold] - cut threshold in mean absolute luma difference.
   * @param {number} [options.minSegmentSec] - shortest segment.
   * @param {number} [options.maxSegmentSec] - longest segment.
   * @param {number} [options.fps] - frames per second of the fed stream.
   */
  constructor(options = {}) {
    this.sceneThreshold = Number.isFinite(options.sceneThreshold) ? options.sceneThreshold : DEFAULT_SCENE_THRESHOLD
    this.minSegmentSec = Number.isFinite(options.minSegmentSec) ? options.minSegmentSec : DEFAULT_MIN_SEGMENT
    this.maxSegmentSec = Number.isFinite(options.maxSegmentSec) ? options.maxSegmentSec : DEFAULT_MAX_SEGMENT
    this.fps = Number.isFinite(options.fps) ? options.fps : 4
    /** @type {object[]} */
    this.segments = []
    this.count = 0
    this.open = null
  }

  /**
   * Feed one frame.
   *
   * @param {number} timeSec - the frame's timestamp.
   * @param {Uint8Array} frame - RGB pixels.
   * @returns {object|null} the segment that just closed, when one did.
   */
  push(timeSec, frame) {
    this.count += 1
    const difference = this.previous === undefined ? null : frameDifference(this.previous, frame)
    this.previous = frame

    if (this.open === null) {
      this.open = this.#open(timeSec, 'start', null)
      if (difference !== null) this.#observe(difference, timeSec)
      return null
    }

    // A cut is decided before the difference is counted as motion. The transition difference
    // measures the change *between* two screens, so counting it inside the outgoing segment makes a
    // placid static scene report `high` motion because of the switch that ended it.
    if (difference !== null && difference.meanAbsDiff >= this.sceneThreshold && timeSec - this.open.start >= this.minSegmentSec) {
      const closed = this.#close(timeSec, 'cut', difference.meanAbsDiff)
      this.open = this.#open(timeSec, 'cut', difference.meanAbsDiff)
      return closed
    }

    this.#observe(difference ?? { meanAbsDiff: 0, changedRatio: 0, maxDiff: 0 }, timeSec)

    // A segment that has run longer than the maximum is broken anyway, so a static hour becomes a
    // series of segments a reader can point at instead of one entry nobody can navigate.
    if (timeSec - this.open.start >= this.maxSegmentSec) {
      const closed = this.#close(timeSec, 'cadence', difference?.meanAbsDiff ?? 0)
      this.open = this.#open(timeSec, 'cadence', difference?.meanAbsDiff ?? 0)
      return closed
    }
    return null
  }

  /**
   * Close whatever is open.
   *
   * @param {number} endSec - the end of the file, or of the analysed range.
   * @returns {object[]} every segment, in order.
   */
  finish(endSec) {
    if (this.open !== null) {
      const end = Math.max(endSec, this.open.start)
      this.#close(end, 'end', this.open.lastDiff)
      this.open = null
    }
    return this.segments.map((segment, index) => ({ index, ...segment }))
  }

  /**
   * Start a segment.
   * @param {number} start - its start time.
   * @param {string} reason - why it started.
   * @param {number|null} sceneScore - the difference that caused the cut.
   * @returns {object} the accumulator.
   */
  #open(start, reason, sceneScore) {
    return { start, reason, sceneScore, lastDiff: 0, diffSum: 0, diffMax: 0, changedSum: 0, samples: 0 }
  }

  /**
   * Add one difference to the open segment.
   * @param {{meanAbsDiff: number, changedRatio: number, maxDiff: number}} difference - the measurement.
   * @param {number} timeSec - the frame's timestamp.
   * @returns {void}
   */
  #observe(difference, timeSec) {
    if (this.open === null) return
    this.open.diffSum += difference.meanAbsDiff
    this.open.changedSum += difference.changedRatio
    this.open.diffMax = Math.max(this.open.diffMax, difference.maxDiff)
    this.open.lastDiff = difference.meanAbsDiff
    this.open.samples += 1
    this.open.lastTime = timeSec
  }

  /**
   * Turn the accumulator into a segment and record it.
   *
   * Recording happens here rather than in the caller because a closed segment that the caller
   * forgets to keep is a segment silently missing from the timeline — a bug that looks exactly like
   * "the recording had one long scene in it".
   *
   * @param {number} end - the end time.
   * @param {string} reason - why it ended.
   * @param {number} sceneScore - the difference at the boundary.
   * @returns {object} the segment.
   */
  #close(end, reason, sceneScore) {
    const segment = this.open
    const samples = Math.max(1, segment.samples)
    const meanAbsDiff = Number((segment.diffSum / samples).toFixed(3))
    const closed = {
      start: Number(segment.start.toFixed(3)),
      end: Number(end.toFixed(3)),
      durationSec: Number((end - segment.start).toFixed(3)),
      startReason: segment.reason,
      endReason: reason,
      // Two scores, because a segment has two edges: the difference that opened it and the one that
      // closed it. A single number would silently mean "the end" for one segment and "the start" for
      // the next, and an end-of-file boundary has no difference at all.
      startScore: segment.sceneScore === null ? null : Number(segment.sceneScore.toFixed(3)),
      sceneScore: reason === 'end' ? null : sceneScore === null ? null : Number(sceneScore.toFixed(3)),
      motion: {
        meanAbsDiff,
        changedRatio: Number((segment.changedSum / samples).toFixed(4)),
        maxDiff: Number(segment.diffMax.toFixed(2)),
        level: motionLevel(meanAbsDiff),
        samples,
      },
    }
    this.segments.push(closed)
    return closed
  }
}

/**
 * Merge segments that are too short to be worth reporting on their own.
 *
 * A screen recording made of small changes produces a burst of two-frame segments; reporting them
 * as separate entries buries the structure the caller asked for. Merging is deterministic and
 * keeps the reason of the first segment, with the merged-away count recorded instead of hidden.
 *
 * @param {object[]} segments - segments from {@link TimelineBuilder}.
 * @param {number} minSeconds - merge anything shorter than this.
 * @returns {object[]} the merged segments, reindexed.
 */
export function mergeShortSegments(segments, minSeconds) {
  if (!Number.isFinite(minSeconds) || minSeconds <= 0) return segments
  const merged = []
  for (const segment of segments) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && segment.durationSec < minSeconds) {
      previous.end = segment.end
      previous.durationSec = Number((previous.end - previous.start).toFixed(3))
      previous.endReason = segment.endReason
      previous.mergedCount = (previous.mergedCount ?? 1) + 1
      previous.motion.meanAbsDiff = Number(
        ((previous.motion.meanAbsDiff * previous.motion.samples + segment.motion.meanAbsDiff * segment.motion.samples) /
          Math.max(1, previous.motion.samples + segment.motion.samples)).toFixed(3),
      )
      previous.motion.samples += segment.motion.samples
      previous.motion.level = motionLevel(previous.motion.meanAbsDiff)
      continue
    }
    merged.push({ ...segment, mergedCount: 1 })
  }
  return merged.map((segment, index) => ({ ...segment, index }))
}
