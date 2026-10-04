/**
 * Shared test fixtures: a synthetic "screen recording" and a throwaway directory.
 *
 * The fixture is built with ffmpeg itself (`lavfi` sources), so the tests do not carry a binary
 * blob and do not depend on anything outside this repository. It deliberately contains the three
 * things the analysis has to tell apart: a colourful moving scene with text, a flat dark scene with
 * different text, and an audio track.
 *
 * @module dsh-ffmpeg/tests/helpers
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resetToolCache, resolveTool, versionOf } from '../src/core/env.mjs'

const run = promisify(execFile)

/** Where every test artefact goes. Gitignored. */
export const TEST_ROOT = join(import.meta.dirname, '..', 'tmp', 'test-media')

/** The font the fixture burns in, so OCR has something to find. */
export const TEST_FONT = 'C:/Windows/Fonts/arial.ttf'

/**
 * Whether this machine can run the ffmpeg-backed tests at all.
 * @returns {Promise<{ok: boolean, ffmpeg: object|null, version: string|null, reason: string|null}>} the verdict.
 */
export async function ffmpegAvailable() {
  resetToolCache()
  const ffmpeg = resolveTool('ffmpeg')
  if (ffmpeg === null) return { ok: false, ffmpeg: null, version: null, reason: '这台机器上没有找到 ffmpeg' }
  const version = await versionOf(ffmpeg.path)
  if (version === null) return { ok: false, ffmpeg, version: null, reason: `${ffmpeg.path} 不能执行 -version` }
  return { ok: true, ffmpeg, version, reason: null }
}

/**
 * Create a fresh working directory.
 * @param {string} name - the subdirectory name.
 * @returns {string} its absolute path.
 */
export function workDir(name) {
  const directory = join(TEST_ROOT, name)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  return directory
}

/**
 * Build the synthetic recording once per process.
 *
 * @param {string} [directory] - where to put it. Defaults to the test root.
 * @returns {Promise<string>} the path to `demo.mp4`.
 */
export async function demoClip(directory = TEST_ROOT) {
  mkdirSync(directory, { recursive: true })
  const target = join(directory, 'demo.mp4')
  if (existsSync(target)) return target

  const ffmpeg = resolveTool('ffmpeg')
  if (ffmpeg === null) throw new Error('没有 ffmpeg，无法生成测试素材')
  const font = existsSync(TEST_FONT) ? TEST_FONT : 'C:/Windows/Fonts/segoeui.ttf'
  const drawtext = (text) =>
    `drawtext=fontfile='${font.replace(/:/g, '\\:')}':text='${text}':x=24:y=24:fontsize=30:fontcolor=white`

  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'color=c=0x101020:size=640x360:rate=25:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-filter_complex',
    `[0:v]${drawtext('ALPHA 111 ffmpeg')}[a];[1:v]${drawtext('BETA 222 screen')}[b];[a][b]concat=n=2:v=1:a=0[v]`,
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-t', '6',
    target,
  ]
  await run(ffmpeg.path, args, { timeout: 120_000, windowsHide: true, maxBuffer: 8 << 20 })
  return target
}

/**
 * Build a short flat clip, for the tests that need two files to join.
 *
 * @param {string} target - the output path.
 * @param {object} [options] - `{ seconds, size, rate, color }`.
 * @returns {Promise<string>} the output path.
 */
export async function flatClip(target, options = {}) {
  const ffmpeg = resolveTool('ffmpeg')
  if (ffmpeg === null) throw new Error('没有 ffmpeg，无法生成测试素材')
  const seconds = options.seconds ?? 1
  const size = options.size ?? '320x180'
  const rate = options.rate ?? 25
  const color = options.color ?? '0x203040'
  mkdirSync(dirname(target), { recursive: true })
  await run(
    ffmpeg.path,
    [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `color=c=${color}:size=${size}:rate=${rate}:duration=${seconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=330:duration=${seconds}`,
      '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-t', String(seconds),
      target,
    ],
    { timeout: 120_000, windowsHide: true, maxBuffer: 8 << 20 },
  )
  return target
}

/**
 * Write a subtitle file next to a clip.
 * @param {string} directory - where to write it.
 * @returns {string} the .srt path.
 */
export function writeSrt(directory) {
  const path = join(directory, 'demo.srt')
  const body = ['1', '00:00:00,500 --> 00:00:02,500', 'HELLO SUBTITLE', '', '2', '00:00:03,000 --> 00:00:05,000', 'SECOND LINE', ''].join('\n')
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, body, { encoding: 'utf8' })
  return path
}
