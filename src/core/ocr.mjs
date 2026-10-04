/**
 * Reading the text off a frame, with whatever this machine has.
 *
 * Two providers, tried in that order, and the answer always says which one spoke:
 *
 * 1. **The sibling `dsh-ocr` plugin**, when its checkout is beside this one and an offline engine
 *    is installed in it. That engine (PP-OCR) is the accurate one, especially on small mixed-script
 *    UI text, and it is already on disk for anyone using this ecosystem. It is loaded by path, not
 *    by importing a package name, because a `link:`-installed plugin resolves its own directory,
 *    not the profile's `node_modules`.
 * 2. **The recogniser Windows ships**, through `src/bin/winrt-ocr.ps1`. Zero install, always
 *    present, and measurably worse on small text — which is why the provider is named in the
 *    output rather than hidden.
 *
 * A frame that cannot be read is not an error: the analysis reports the segment with `text: null`
 * and the reason, because "no OCR here" and "a blank screen" must not look the same.
 *
 * @module dsh-ffmpeg/core/ocr
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PLUGIN_ROOT, siblingRoots } from './env.mjs'

const run = promisify(execFile)

/** Which provider a call may use. */
export const OCR_PROVIDERS = ['auto', 'sibling', 'winrt', 'off']

/** The Windows recogniser script shipped with this plugin. */
export const WINRT_SCRIPT = fileURLToPath(new URL('../bin/winrt-ocr.ps1', import.meta.url))

/** Recognition languages this plugin names, in both spellings callers use. */
export const OCR_LANGUAGES = {
  ch: 'zh-Hans-CN',
  'zh-cn': 'zh-Hans-CN',
  'zh-hans': 'zh-Hans-CN',
  cht: 'zh-Hant-TW',
  'zh-tw': 'zh-Hant-TW',
  'zh-hant': 'zh-Hant-TW',
  en: 'en-US',
  eng: 'en-US',
  japan: 'ja-JP',
  ja: 'ja-JP',
  korean: 'ko-KR',
  ko: 'ko-KR',
  cyrillic: 'ru-RU',
  ru: 'ru-RU',
}

/**
 * Turn a short language name into a BCP-47 tag the recognisers accept.
 * @param {string|undefined} language - `ch`, `en`, or an already-tagged value.
 * @returns {string} a language tag.
 */
export function languageTag(language) {
  if (typeof language !== 'string' || language.trim() === '') return 'zh-Hans-CN'
  const key = language.trim().toLowerCase()
  if (OCR_LANGUAGES[key] !== undefined) return OCR_LANGUAGES[key]
  return /^[a-z]{2}(-[a-z0-9]+)*$/i.test(language.trim()) ? language.trim() : 'zh-Hans-CN'
}

/**
 * Every checkout that could hold `dsh-ocr`, nearest first.
 * @param {object} [config] - normalized plugin config.
 * @returns {string[]} absolute candidate directories.
 */
export function siblingOcrRoots(config = {}) {
  const candidates = []
  if (typeof config.ocrPluginPath === 'string' && config.ocrPluginPath.trim() !== '') {
    candidates.push(config.ocrPluginPath.trim())
  }
  for (const root of siblingRoots()) candidates.push(join(root, 'dsh-ocr'))
  return [...new Set(candidates.map((entry) => entry.replace(/[\\/]+$/, '')))]
}

/**
 * Load the sibling plugin's deterministic core, when it is there.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<{module: object, root: string, corePath: string}|null>} the loaded module, or null.
 */
export async function loadSiblingOcr(config = {}) {
  for (const root of siblingOcrRoots(config)) {
    const corePath = join(root, 'src', 'core', 'index.mjs')
    if (!existsSync(corePath)) continue
    try {
      const module = await import(pathToFileURL(corePath).href)
      if (typeof module.recogniseImage !== 'function') continue
      return { module, root, corePath }
    } catch {
      // A sibling that cannot be imported is reported as absent: its absence is not this plugin's
      // failure, and a half-installed sibling must not take the analysis down with it.
    }
  }
  return null
}

/** Cached sibling lookup, so the import happens once per process. */
let siblingCache = null

/**
 * Report which OCR provider would answer, without reading anything.
 *
 * @param {object} [config] - normalized plugin config.
 * @returns {Promise<object>} the availability report.
 */
export async function ocrReport(config = {}) {
  const preferred = config.ocrProvider ?? 'auto'
  const sibling = await loadSiblingOcr(config)
  let siblingEngine = null
  if (sibling !== null && typeof sibling.module.resolveOcrEngine === 'function') {
    try {
      const engine = sibling.module.resolveOcrEngine({})
      if (engine !== null) siblingEngine = { engine: engine.kind ?? 'unknown', source: engine.source ?? null }
    } catch {
      siblingEngine = null
    }
  }
  const winrtAvailable = process.platform === 'win32' && existsSync(WINRT_SCRIPT)

  let provider = 'none'
  const notes = []
  if (preferred === 'off') {
    provider = 'off'
    notes.push('按配置关闭了 OCR：分析里只会有画面结构，没有文字。')
  } else if (preferred === 'sibling' && sibling !== null && siblingEngine !== null) {
    provider = 'sibling'
  } else if (preferred === 'winrt' && winrtAvailable) {
    provider = 'winrt'
  } else if (sibling !== null && siblingEngine !== null) {
    provider = 'sibling'
  } else if (winrtAvailable) {
    provider = 'winrt'
    if (sibling !== null) notes.push('找到了同级 dsh-ocr，但它里面没有装离线引擎，退回 Windows 自带识别（小字更不准）。')
    else notes.push('没有找到同级 dsh-ocr，用 Windows 自带识别（小字更不准）。')
  } else if (sibling === null) {
    notes.push('既没有同级 dsh-ocr，也没有可用的 Windows 识别。')
  }
  const roots = siblingOcrRoots(config)
  if (sibling === null) notes.push(`找过的 dsh-ocr 位置：${roots.join(' / ')}`)

  return {
    preferred,
    provider,
    language: languageTag(config.ocrLanguage),
    sibling:
      sibling === null
        ? { present: false, roots }
        : { present: true, root: sibling.root, engine: siblingEngine, note: siblingEngine === null ? '同级 dsh-ocr 里没有装离线引擎。' : null },
    winrt: { available: winrtAvailable, script: WINRT_SCRIPT },
    notes,
  }
}

/**
 * Read one image.
 *
 * @param {string} imagePath - the image to read.
 * @param {object} [options] - the call.
 * @param {object} [options.config] - normalized plugin config.
 * @param {string} [options.language] - language name or tag; defaults to the configured one.
 * @param {number} [options.scale] - enlarge before recognising. 1–3.
 * @param {number} [options.minScore] - drop lines below this confidence when a provider reports one.
 * @returns {Promise<{provider: string, engine: string|null, lines: object[], text: string, elapsedMs: number, note: string|null}>} the reading.
 * @throws {Error} when the requested provider cannot answer.
 */
export async function recognise(imagePath, options = {}) {
  const config = options.config ?? {}
  if (!existsSync(imagePath)) throw new Error(`OCR 的输入图片不存在：${imagePath}`)

  const report = await ocrReport(config)
  const provider = options.provider ?? report.provider
  const language = languageTag(options.language ?? config.ocrLanguage)
  const scale = Number.isFinite(options.scale) ? Math.max(1, Math.min(3, Math.round(options.scale))) : 1

  if (provider === 'off' || provider === 'none') {
    throw new Error(`没有可用的 OCR：${report.notes.join(' ')}`)
  }

  if (provider === 'sibling') {
    const sibling = siblingCache ?? (siblingCache = await loadSiblingOcr(config))
    if (sibling === null) throw new Error(`配置要求用同级 dsh-ocr，但没有找到：${siblingOcrRoots(config).join(' / ')}`)
    const started = Date.now()
    const result = await sibling.module.recogniseImage(imagePath, {
      config: {},
      language: typeof options.language === 'string' ? options.language : config.ocrLanguage,
      scale,
      minScore: options.minScore,
      maxSideLen: options.maxSideLen,
    })
    return {
      provider: 'sibling',
      engine: `dsh-ocr:${result.engine ?? 'unknown'}@${result.source ?? sibling.root}`,
      lines: (result.lines ?? []).map((line) => ({
        text: line.text,
        score: line.score ?? null,
        x: line.x ?? null,
        y: line.y ?? null,
        width: line.width ?? null,
        height: line.height ?? null,
      })),
      text: result.text ?? (result.lines ?? []).map((line) => line.text).join('\n'),
      elapsedMs: result.elapsedMs ?? Date.now() - started,
      note: null,
    }
  }

  if (process.platform !== 'win32') {
    throw new Error('Windows 自带的识别只在 Windows 上存在；请安装同级 dsh-ocr 的离线引擎。')
  }

  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINRT_SCRIPT, '-Path', imagePath, '-Language', language]
  if (scale > 1) args.push('-Scale', String(scale))
  const started = Date.now()
  try {
    const { stdout } = await run('powershell.exe', args, { timeout: 180_000, windowsHide: true, maxBuffer: 16 << 20 })
    const parsed = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
    const lines = (parsed.lines ?? []).map((line) => ({
      text: line.text,
      score: null,
      x: line.x ?? null,
      y: line.y ?? null,
      width: line.width ?? null,
      height: line.height ?? null,
    }))
    return {
      provider: 'winrt',
      engine: `windows-ocr:${parsed.language ?? language}`,
      lines,
      text: lines.map((line) => line.text).join('\n'),
      elapsedMs: parsed.elapsedMs ?? Date.now() - started,
      note: 'Windows 自带识别：小字混排容易读错，只当作线索，不要当精确数据。',
    }
  } catch (error) {
    const detail = error?.stderr !== undefined && String(error.stderr).trim() !== '' ? String(error.stderr).trim().split('\n').slice(-4).join('\n') : String(error?.message ?? error)
    throw new Error(`Windows OCR 失败：${detail}`)
  }
}

/**
 * Read several images, in order, surviving an unreadable one.
 *
 * @param {{path: string, index?: number, at?: number}[]} items - the images.
 * @param {object} [options] - passed to {@link recognise}.
 * @param {(message: string) => void} [options.onProgress] - one line per image.
 * @returns {Promise<{readings: object[], failed: object[], provider: string|null, totalMs: number}>} the readings.
 */
export async function recogniseMany(items, options = {}) {
  const readings = []
  const failed = []
  let provider = null
  const started = Date.now()
  for (const item of items) {
    try {
      const reading = await recognise(item.path, options)
      provider = reading.provider
      readings.push({ ...item, ...reading })
      options.onProgress?.(`读到 ${reading.lines.length} 行：${item.path}`)
    } catch (error) {
      failed.push({ ...item, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { readings, failed, provider, totalMs: Date.now() - started }
}
