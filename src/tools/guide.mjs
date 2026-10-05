/**
 * `ffmpeg_guide` — the plugin's own documentation, fetched on demand.
 *
 * @module dsh-ffmpeg/tools/guide
 */
import { PLUGIN_ROOT, SHARED_BIN_DIR, VENDOR_BIN_DIR, FFMPEG_ENV, resolveTool, sharedHomeState, siblingRoots } from '../core/env.mjs'
import { ANALYSIS_DEFAULTS, SEGMENT_KINDS, SEGMENT_KIND_RULES } from '../core/semantics.mjs'
import { LABEL_MEANINGS, REGION_LABELS } from '../core/segmentation.mjs'
import { DEFAULT_MAX_SEGMENT, DEFAULT_MIN_SEGMENT, DEFAULT_SCENE_THRESHOLD, SEGMENT_REASONS } from '../core/timeline.mjs'
import { MAX_RECORD_SECONDS } from '../core/record.mjs'
import { TOOL_REGISTRY, TOOL_ORDER, lookupAction, lookupTool } from './registry.mjs'
import { FfmpegPluginError, defineFamilyTool } from './shared.mjs'

/** Every action `ffmpeg_guide` dispatches. */
export const GUIDE_ACTIONS = ['overview', 'playbook', 'rules', 'tool', 'action']

/** The recipes. Each is a few calls in the order that works, with the reason each one is there. */
export const PLAYBOOKS = {
  'record-and-analyze': {
    title: '录一次屏，拿到视频与语义结构',
    when: '要演示、复现或留证，并且希望之后能按内容检索这段录像。',
    steps: [
      { tool: 'ffmpeg_env', call: 'ffmpeg_env {action:"caps"}', why: '先确认这份构建能录屏（capture.gdigrab）与编码（libx264）。' },
      { tool: 'ffmpeg_env', call: 'ffmpeg_env {action:"devices"}', why: '要录声音的话，设备名必须一字不差。' },
      { tool: 'ffmpeg_record', call: 'ffmpeg_record {action:"screen", out:"demo.mp4", seconds:60, fps:15}', why: '固定时长录制；录完会报实际时长，短了会说明原因。' },
      { tool: 'ffmpeg_semantics', call: 'ffmpeg_semantics {action:"analyze", input:"demo.mp4", outDir:"analysis"}', why: '一次解码建时间轴，逐段抽帧、分块、读字，输出结构 JSON + 关键帧 + 联系表 + 带章节的视频。' },
      { tool: 'ffmpeg_probe', call: 'ffmpeg_probe {action:"info", target:"analysis/demo.mp4"}', why: '复核交付视频的规格。' },
    ],
    mistakes: [
      '录屏时不要同时跑重活：编码跟不上会让 gdigrab 丢帧，报告里的实际时长会短于要求。',
      'sceneThreshold 默认 8；演示里频繁切窗口时可以调到 15–25 以免切得过碎。',
      'OCR 结果当线索，不要当精确数据：Windows 自带识别对小字混排会读错，装了同级 dsh-ocr 才会准。',
    ],
  },
  'deliver-a-clip': {
    title: '从长素材里交付一个片段',
    when: '要把一段录屏/会议剪出来发给别人，要求任何播放器都能开。',
    steps: [
      { tool: 'ffmpeg_probe', call: 'ffmpeg_probe {action:"info", target:"raw.mkv"}', why: '先看时长、编码、像素格式——奇数宽高或非常见像素格式会在编码时才炸。' },
      { tool: 'ffmpeg_convert', call: 'ffmpeg_convert {action:"trim", input:"raw.mkv", out:"clip.mp4", start:75, duration:42, mode:"encode"}', why: 'mode:"encode" 才是逐帧精确的起点；copy 只能从关键帧切。' },
      { tool: 'ffmpeg_convert', call: 'ffmpeg_convert {action:"audio", input:"clip.mp4", out:"clip-final.mp4", mode:"normalize"}', why: '两遍 loudnorm 按测得的响度归一化，短片也不会忽大忽小。' },
      { tool: 'ffmpeg_probe', call: 'ffmpeg_probe {action:"integrity", target:"clip-final.mp4"}', why: '交付前解码一遍，确认没有截断。' },
    ],
    mistakes: ['输出名不要和输入相同（默认会被拒绝）；要覆盖必须显式 overwriteInput:true。'],
  },
  'frames-and-cover': {
    title: '抽几张图，或做一张封面',
    when: '要封面、要联系表、要给人看某一刻。',
    steps: [
      { tool: 'ffmpeg_probe', call: 'ffmpeg_probe {action:"info", target:"a.mp4"}', why: '确定时长，别抽到片尾之外。' },
      { tool: 'ffmpeg_convert', call: 'ffmpeg_convert {action:"frames", input:"a.mp4", outDir:"stills", times:[3,18,42], format:"png"}', why: '指定时间点各抽一帧，长边不超过 1280 且不会放大。' },
    ],
    mistakes: ['at / times / fps 三选一；times 的每一项都是秒。'],
  },
  'burn-subtitles': {
    title: '把字幕交给播放器，或者烧进画面',
    when: '成片要带字幕交付。',
    steps: [
      { tool: 'ffmpeg_env', call: 'ffmpeg_env {action:"caps"}', why: 'burn 需要 subtitles 滤镜（libass）。' },
      { tool: 'ffmpeg_convert', call: 'ffmpeg_convert {action:"subtitles", input:"a.mp4", out:"a-sub.mp4", srt:"a.srt", mode:"burn"}', why: '烧进画面：重编码一次，任何播放器都看得见。' },
      { tool: 'ffmpeg_convert', call: 'ffmpeg_convert {action:"subtitles", input:"a.mp4", out:"a-mux.mp4", srt:"a.srt", mode:"mux"}', why: '只封装轨道：不重编码，但播放器要支持字幕轨。' },
    ],
    mistakes: ['mp4 的字幕轨用 mov_text，不是 srt；mux 模式已经替你选好。'],
  },
  'diagnose-a-bad-file': {
    title: '一个文件「有问题」时按顺序查',
    when: '播放卡顿、时长不对、转换报错。',
    steps: [
      { tool: 'ffmpeg_env', call: 'ffmpeg_env {action:"probe"}', why: '先确认用的是哪份 ffmpeg——不同构建行为不同。' },
      { tool: 'ffmpeg_probe', call: 'ffmpeg_probe {action:"info", target:"bad.mp4", raw:true}', why: '看规格与 problems 列表。' },
      { tool: 'ffmpeg_probe', call: 'ffmpeg_probe {action:"integrity", target:"bad.mp4"}', why: '解码一遍：解出多少帧/秒，与容器声明差多少，解码头说了什么。' },
      { tool: 'ffmpeg_probe', call: 'ffmpeg_probe {action:"keyframes", target:"bad.mp4"}', why: '若打算流复制裁剪，先知道能切在哪。' },
    ],
    mistakes: ['解码时的警告不都等于坏文件；要看 decodedSeconds 与 declaredSeconds 的差距。'],
  },
  'bootstrap-machine': {
    title: '把这台机器装好',
    when: '新机器、或共享目录与 vendor 都是空的。',
    steps: [
      { tool: 'ffmpeg_setup', call: 'ffmpeg_setup {action:"status"}', why: '看现在有没有、会先用哪一个。' },
      { tool: 'ffmpeg_setup', call: 'ffmpeg_setup {action:"install"}', why: '下载版本固定、SHA-256 强制校验的那份，装进共享目录 ~/.dsh-plugins/ffmpeg/bin——六个插件共用这一份。' },
      { tool: 'ffmpeg_env', call: 'ffmpeg_env {action:"caps"}', why: '确认 gdigrab / dshow / libx264 / subtitles 都在。' },
    ],
    mistakes: ['共享目录里已有构建时 install 不会重复下载；要换构建用 force:true。'],
  },
}

/**
 * Build the `ffmpeg_guide` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createGuideTool(config, logger) {
  return defineFamilyTool({
    name: 'ffmpeg_guide',
    actions: GUIDE_ACTIONS,
    extraProperties: {
      tool: { type: 'string', enum: TOOL_ORDER, description: 'tool: which tool to describe in full.' },
      actionName: { type: 'string', description: 'action: the action to describe in full, for example "transcode" or "analyze".' },
      job: { type: 'string', enum: Object.keys(PLAYBOOKS), description: 'playbook: which recipe to expand. Omit to list them.' },
    },
    handlers: {
      /**
       * The whole surface in one page.
       * @returns {object} the overview.
       */
      overview() {
        return {
          plugin: 'dsh-ffmpeg',
          purpose:
            '把 ffmpeg 变成一套确定的、可验证的工具：编码、裁剪、抽帧、录屏，以及「一次录屏进，视频加语义结构出」。插件只执行与测量；什么值得要、结果够不够好，全部由 DSH 判断。',
          tools: TOOL_ORDER.map((name) => ({
            name,
            purpose: TOOL_REGISTRY[name].purpose,
            actions: Object.keys(TOOL_REGISTRY[name].actions),
          })),
          playbooks: Object.entries(PLAYBOOKS).map(([job, entry]) => ({ job, title: entry.title, when: entry.when })),
          where: {
            pluginRoot: PLUGIN_ROOT,
            sharedBin: SHARED_BIN_DIR,
            legacyVendorBin: VENDOR_BIN_DIR,
            envOverride: FFMPEG_ENV,
            sharedHome: sharedHomeState(),
            siblingRoots: siblingRoots(),
            currentFfmpeg: resolveTool('ffmpeg', config),
          },
          defaults: {
            analysis: ANALYSIS_DEFAULTS,
            scene: { threshold: DEFAULT_SCENE_THRESHOLD, minSegmentSec: DEFAULT_MIN_SEGMENT, maxSegmentSec: DEFAULT_MAX_SEGMENT, reasons: SEGMENT_REASONS },
            regionLabels: Object.fromEntries(REGION_LABELS.map((label) => [label, LABEL_MEANINGS[label]])),
            segmentKinds: SEGMENT_KIND_RULES,
            maxRecordSeconds: MAX_RECORD_SECONDS,
          },
          honesty: [
            '区域标签是「外观分类」：按块测量边缘密度、饱和度、亮度方差后归类，不是学习式语义分割。',
            '段落类别（document / typing / scrolling / …）是写死的规则表，输入是测到的运动量与外观占比；规则原文在 structure.kindRules 里。',
            '看似的「智能」只有一处是模型：segmentation:"salient" 借用同级 video-factory 的 U²-Net，输出里标明 provider。',
            '关键词是按次数排出来的词表，不是摘要。',
          ],
        }
      },

      /**
       * One recipe, or the list of them.
       * @param {object} args - the tool arguments.
       * @returns {object} the recipe.
       */
      playbook(args) {
        if (typeof args.job !== 'string' || args.job === '') {
          return { playbooks: Object.entries(PLAYBOOKS).map(([job, entry]) => ({ job, title: entry.title, when: entry.when })) }
        }
        const entry = PLAYBOOKS[args.job]
        if (entry === undefined) throw new FfmpegPluginError(`ffmpeg_guide playbook: 未知的 job ${JSON.stringify(args.job)}；可选：${Object.keys(PLAYBOOKS).join(', ')}。`)
        return { job: args.job, ...entry }
      },

      /**
       * The rules this plugin works by.
       * @returns {object} the rules.
       */
      rules() {
        return {
          determinism: [
            '同样的输入与参数得到同样的输出：参数永远是 argv 数组，没有 shell，没有字符串拼接。',
            '本插件永远自己加 -hide_banner -nostdin -y；调用方不需要（也不该）自己加。',
            '流映射永远是显式的（-map 0:v:0? / -map 0:a:0?），所以输出不依赖流的排列顺序。',
            '分析用的分辨率由这里算好再显式传给 ffmpeg，绝不用 -2 或滤镜表达式让 ffmpeg 自己决定——那会让 JS 侧的缓冲和 ffmpeg 的尺寸差一个像素。',
            '编码进程有并发上限（默认 2）：几个 1080p 一起跑会让每一个都更慢，还容易失败。',
          ],
          numbers: [
            'sceneScore 是「平均亮度差」（0–255 的 MAD），不是百分比：8 左右适合屏幕录制，整屏切换通常 40 以上。',
            'region 的 score 是「离判定线的余量」，不是概率。',
            'motion.level 的档位（static < 0.5 ≤ low < 3 ≤ moderate < 10 ≤ high）是经验值，写在这里而不是藏在代码里。',
            '时长、帧数、响度这些数字都来自解码或测量，不是推算。',
          ],
          failures: [
            '失败时给出：退出码、完整参数、可执行文件、stderr 尾部，以及匹配到已知失败时的中文解释。',
            '写文件失败会删掉半成品：一个「名字对、内容半截」的文件比一个明确的错误危险得多。',
            '每次写完之后都会重新探测产物：有没有流、有多大、时长对不对。exit code 0 不等于交付成立。',
            '本插件拒绝把输出写成输入（那会先清空源文件），除非显式 overwriteInput:true。',
          ],
          neighbours: [
            '声音的制造、修复与测量属于 dsh-video-audio（audio_*）；本插件只做「取出来/换掉/归一化」。',
            '成片流程（素材 → 场景 → 拼接 → 交付）属于 video-factory（video_*）。',
            '屏幕上的文字定位与点击属于 dsh-ocr（text_*）与 dsh-computer-use（computer_*）。',
            '本插件的 analyze 只是把录像读成结构；要不要据此剪、怎么讲，是 DSH 的决定。',
          ],
          cost: [
            '探测（probe/info/keyframes）约 0.1–0.5 秒；能力查询首次 1–2 秒后缓存。',
            '先看 scenes（低分辨率解码一遍）再决定要不要 analyze：后者还要逐段抽帧、分块、识别。',
            '区域分块是纯 JS，一帧约几十毫秒；学习式 salient 约 2 秒一帧（默认最多 12 帧）。',
          ],
        }
      },

      /**
       * One tool in full.
       * @param {object} args - the tool arguments.
       * @returns {object} the tool entry.
       */
      tool(args) {
        const name = args.tool
        const entry = lookupTool(name)
        if (entry === undefined) throw new FfmpegPluginError(`ffmpeg_guide tool: 未知的工具 ${JSON.stringify(name)}；可选：${TOOL_ORDER.join(', ')}。`)
        return {
          name,
          purpose: entry.purpose,
          needs: entry.needs,
          next: entry.next,
          actions: entry.actions,
        }
      },

      /**
       * One action in full.
       * @param {object} args - the tool arguments.
       * @returns {object} the action entry.
       */
      action(args) {
        const name = args.actionName
        if (typeof name !== 'string' || name === '') throw new FfmpegPluginError('ffmpeg_guide action: 需要 actionName，例如 "transcode"。')
        const found = lookupAction(name)
        if (found === null) {
          const all = Object.values(TOOL_REGISTRY).flatMap((entry) => Object.keys(entry.actions))
          throw new FfmpegPluginError(`ffmpeg_guide action: 没有叫 ${JSON.stringify(name)} 的 action；全部：${[...new Set(all)].sort().join(', ')}。`)
        }
        return { tool: found.tool, action: found.action, ...found.entry }
      },
    },
  })
}

/** Every action name on the surface, for the error message above and for tests. */
export function allActionNames() {
  return [...new Set(Object.values(TOOL_REGISTRY).flatMap((entry) => Object.keys(entry.actions)))].sort()
}
