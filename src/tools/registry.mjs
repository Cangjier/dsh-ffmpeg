/**
 * Every tool and every action, described once.
 *
 * The resident JSON Schema of a tool is paid for on every turn, so it carries only the shape of a
 * call plus one decision-grade line per action. This file carries everything else — what an action
 * returns, what it costs, the mistake it prevents, a runnable example — and it is the source both
 * the schema and `ffmpeg_guide` are rendered from. A tool or action that exists in one place and
 * not the other is a load-time error, not a silently under-documented schema.
 *
 * @module dsh-ffmpeg/tools/registry
 */

/** Tool order, which is also the order the surface presents them in. */
export const TOOL_ORDER = [
  'ffmpeg_env',
  'ffmpeg_setup',
  'ffmpeg_probe',
  'ffmpeg_convert',
  'ffmpeg_record',
  'ffmpeg_semantics',
  'ffmpeg_run',
  'ffmpeg_guide',
]

/** Shared prose reused by several entries. */
const CWD = 'cwd: 相对路径的基准目录，默认取进程工作目录。'
const FFMPEG_NEEDED = 'ffmpeg（共享目录 ~/.dsh-plugins/ffmpeg/bin、DSH_FFMPEG、插件自己的 vendor/ffmpeg/bin、同级插件或 PATH 都能提供）。'

export const TOOL_REGISTRY = {
  ffmpeg_env: {
    purpose:
      '这台机器上的 ffmpeg 是什么、能做什么、能从哪里采集。只读，跑得很快，任何「为什么这步失败」都应该先看它。',
    needs: ['ffmpeg 用来读取版本与能力；采集设备列表需要 dshow 支持。'],
    next: ['ffmpeg_setup {action:"install"} 装一份固定的构建', 'ffmpeg_probe {action:"info"} 看素材'],
    actions: {
      probe: {
        summary: '报出 ffmpeg / ffprobe 各自的实际路径、来源（配置 / 环境变量 / 共享目录 / 本插件 vendor / 同级插件 / PATH）、版本，以及那份构建的来源记录。',
        required: [],
        use: '第一次用它、换机器、或者怀疑「到底在用哪一份 ffmpeg」。',
        avoid: '不会启动任何编码，也不会写文件；它是一次文件系统 + 两次 -version 调用。',
        returns: '{ffmpeg:{path,source,label,version}, ffprobe:{…}, vendor:{present,directory,location,files,sizeBytes,source,shared}, install:{sources,defaultSource}, concurrency, timeoutMs}',
        cost: '约 100 ms。',
        pitfalls: 'source 是 "path" 时说明用的是系统里那份，版本可能和共享目录的不同——要可复现请 install。',
        example: 'ffmpeg_env {action:"probe"}',
      },
      caps: {
        summary: '这份构建支持哪些编码器、滤镜、硬件加速与采集设备，逐项给出布尔值，并给出推荐的 H.264 编码路径。',
        required: [],
        use: '在要求某个编码器或滤镜之前；「Unknown encoder / No such filter」的第一反应。',
        avoid: '不要在每次转换前都问：结果按可执行文件缓存，重复调用是内存里的查找。',
        returns: '{ffmpeg, counts, encoders:{libx264:true,…}, filters:{subtitles:false,…}, hwaccels:[], devices:{demuxers,muxers}, capture:{gdigrab,dshow,lavfi}, encoderOptions:{hardware,software,preferred}}',
        cost: '首次约 1–2 秒（6 条 -encoders/-filters/… 命令），之后为 0。',
        pitfalls: '滤镜名区分大小写；devices.demuxers 里有 gdigrab 才可能录屏。',
        example: 'ffmpeg_env {action:"caps"}',
      },
      devices: {
        summary: '列出 DirectShow 能看到的采集设备名（摄像头 / 麦克风 / 虚拟声卡），名字原样返回。',
        required: [],
        use: '在 ffmpeg_record {action:"microphone"} 之前，device 必须与这里完全一致。',
        avoid: '列设备时 ffmpeg 会故意返回非零退出码并写在 stderr，这里已按正常结果解析。',
        returns: '{available, video:[], audio:[], error, note}',
        cost: '约 200 ms。',
        pitfalls: '设备被会议软件独占时仍然会出现在列表里，但录制会失败或录到静音。',
        example: 'ffmpeg_env {action:"devices"}',
      },
    },
  },

  ffmpeg_setup: {
    purpose: '把一份固定的 ffmpeg 装进共享目录 ~/.dsh-plugins/ffmpeg/bin（六个插件共用一份），或者看它现在是什么、把它删掉。',
    needs: ['install 需要网络（或一个本地压缩包）；status / remove 不需要。'],
    next: ['ffmpeg_env {action:"probe"} 确认装到了', 'ffmpeg_convert 开始干活'],
    actions: {
      status: {
        summary: '报告那份构建是否存在、有哪些可执行文件、多大、装自哪个来源、摘要是否校验过，以及现在实际会用哪一个 ffmpeg。',
        required: [],
        returns: '{vendor:{present,directory,binDir,location,files,sizeBytes,source,shared}, resolved:{ffmpeg,ffprobe}, sources:[…], defaultSource, wanted, note}；location 说明读的是共享目录还是旧的 vendor/ffmpeg。',
        cost: '文件系统调用，无网络。',
        use: '装之前、装之后、以及「为什么还在用系统那份」。',
        example: 'ffmpeg_setup {action:"status"}',
      },
      install: {
        summary: '下载一份构建并把 ffmpeg.exe / ffprobe.exe / ffplay.exe 解压进共享目录 ~/.dsh-plugins/ffmpeg/bin；默认来源是版本固定的 gyan 9.0.2，SHA-256 强制校验。',
        required: [],
        use: '换机器、要可复现、或机器上根本没有 ffmpeg。装一次，dsh-ffmpeg / dsh-ocr / dsh-tts / dsh-video-audio / video-factory 都能用它。',
        avoid: '共享目录里已有可执行文件时不会重复下载（要覆盖必须 force:true）。',
        returns: '{installed, source, label, version, url, bytes, sha256, pinnedSha256, verified, files, installedAt, vendor}',
        cost: '约 110 MB 下载 + 解压，几分钟；可用 archive 指定已下好的 zip。',
        pitfalls: 'source:"btbn-latest" 指向 latest，字节会变，只能记录摘要而不能校验；摘要不符时默认拒绝安装。',
        example: 'ffmpeg_setup {action:"install"}　或　ffmpeg_setup {action:"install", archive:"D:/dl/ffmpeg.zip"}',
      },
      remove: {
        summary: '删掉共享的 ffmpeg 整棵树，释放约 200–400 MB；不会碰插件自己的 vendor/ 或 PATH 上的 ffmpeg。删掉之后全家六个插件都会找不到它，直到重新 install。',
        required: [],
        returns: '{removed, directory}',
        cost: '一次递归删除。',
        use: '不再需要这份私有构建时。',
        example: 'ffmpeg_setup {action:"remove"}',
      },
    },
  },

  ffmpeg_probe: {
    purpose: '一个文件是什么、完不完整、能在哪些时间点干净地切开。只读，不写任何文件。',
    needs: [FFMPEG_NEEDED, 'ffprobe 用于一切探测。'],
    next: ['ffmpeg_convert 按这些事实决定怎么转', 'ffmpeg_semantics {action:"analyze"} 看内容'],
    actions: {
      info: {
        summary: '一个或几个文件的规格：容器、时长、码率、每条流的编码/分辨率/帧率/旋转/像素格式/采样率/声道，以及值得注意的问题列表。',
        required: ['target（一个文件）或 paths（多个文件）'],
        use: '在做任何转换之前；也是「这个文件能不能播」的第一手证据。',
        avoid: '不要用它判断内容或质量——它是规格，不是评价。',
        returns: '{files:[{path,bytes,kind,formatName,durationSec,bitRate,video,audio,subtitles,problems,…}], failed:[{path,error}]}',
        cost: '每个文件约 100–300 ms。',
        pitfalls: 'kind 是 image 时长会是 null（静态图没有时长）；rotation 已经折算进 displayWidth/Height。',
        example: 'ffmpeg_probe {action:"info", paths:["a.mp4","b.mkv"]}',
      },
      integrity: {
        summary: '完整解码一遍，报出真正解出多少帧、多少秒、与容器声明的时长差多少，以及解码器说过的每一句话。',
        required: ['target'],
        use: '怀疑截断、卡顿、时间戳错乱时；交付前的最后一道证据。',
        avoid: '它会解码整条流，长片很慢；只想看规格就用 info。',
        returns: '{ok, decodedFrames, decodedSeconds, declaredSeconds, deltaSec, messageCount, messages, stderrTail, notes}',
        cost: '约等于完整播放一遍的时间（解码比播放快，通常 1/3）。',
        pitfalls: '解码报错不等于文件不能用——有些流本来就有可恢复的警告，messages 才是原始证据。',
        example: 'ffmpeg_probe {action:"integrity", target:"rec.mp4"}',
      },
      keyframes: {
        summary: '列出视频流里关键帧的时间戳：流复制裁剪只能从这些点开始。',
        required: ['target'],
        returns: '{times:[秒], count, truncated}',
        cost: '只读包索引，约 100 ms（不解码画面）。',
        use: '在 ffmpeg_convert {action:"trim", mode:"copy"} 之前确认切点。',
        example: 'ffmpeg_probe {action:"keyframes", target:"talk.mp4"}',
      },
    },
  },

  ffmpeg_convert: {
    purpose: '把一份素材变成另一份：转码、裁剪、抽帧、拼合、烧字幕、做 GIF，以及音频的取出/替换/归一化。每步都会在写完之后重新测一遍写出来的东西。',
    needs: [FFMPEG_NEEDED, '需要的编码器/滤镜由 ffmpeg_env {action:"caps"} 报告；缺失会在动手之前拒绝。'],
    next: ['ffmpeg_probe {action:"info"} 复核产物', 'ffmpeg_semantics 分析内容'],
    actions: {
      transcode: {
        summary: '一次完成转码：显式指定容器（由输出扩展名决定）、视频编码与质量、缩放/帧率、音频编码，输出后自动测量。',
        required: ['input', 'out'],
        use: '统一素材规格、把任意文件变成任何播放器都能开的 H.264/AAC MP4（这就是默认值）。',
        avoid: '不要用它做裁剪或抽帧，那两件事各有一个 action，参数更少也更难搞错。',
        returns: '{out, notes, files:[{path,bytes,ok,problems,facts}], passes, elapsedMs, ok}',
        cost: '取决于时长与分辨率：1080p 每小时约 1–5 分钟（libx264 medium）。',
        pitfalls: '输出扩展名决定封装与默认编码；宽高为奇数、像素格式非 yuv420p 时 H.264 会失败，默认已替你指定 yuv420p。',
        example: 'ffmpeg_convert {action:"transcode", input:"raw.mkv", out:"out.mp4", video:{crf:20,preset:"medium",scale:"1280:-2"}}',
      },
      trim: {
        summary: '剪一段：mode:"encode" 逐帧精确（重新编码），mode:"copy" 秒级完成但只能从关键帧切起。',
        required: ['input', 'out', 'start 或 duration（至少一个）'],
        use: '截取素材片段；copy 用于「差不多就行」的快速粗剪。',
        avoid: 'copy 模式下不要期望精确起点：报告里的 notes 会说明实际从哪开始。',
        returns: '{out, notes, files:[…], ok}（copy 模式不重编码，因此画质与源完全一致）',
        cost: 'copy 约 1 秒；encode 与转码同量级。',
        pitfalls: 'start 必须以秒为单位；end 与 duration 同时给时以 duration 为准。',
        example: 'ffmpeg_convert {action:"trim", input:"a.mp4", out:"clip.mp4", start:12.5, duration:8}',
      },
      audio: {
        summary: '音频四件事：extract 导出、drop 丢掉、replace 换成另一个文件、normalize 两遍 loudnorm 按测量值归一化。',
        required: ['input', 'out', 'mode'],
        use: '交付前把响度统一，或把旁白贴到画面上。',
        avoid: 'normalize 会先量一遍再写一遍，因此比单遍慢一倍，但短片的响度才是可预期的。',
        returns: '{out, notes, files:[…], measured(两遍时的测量值), ok}',
        cost: 'extract/drop/replace 是流复制，秒级；normalize 需要完整解码音频两遍。',
        pitfalls: 'extract 只取第一条音频流；replace 需要 audioPath 真实存在。',
        example: 'ffmpeg_convert {action:"audio", input:"talk.mp4", out:"talk-norm.mp4", mode:"normalize", normalize:{targetI:-16}}',
      },
      frames: {
        summary: '抽帧存图：一个时间点（at）、若干时间点（times）、或固定频率（fps），长边默认不超过 1280px 且从不放大。',
        required: ['input', 'outDir 加 at / times / fps 之一'],
        use: '做封面、做联系表、给人看某一刻。',
        avoid: '要「看内容」而不是「要图」时用 ffmpeg_semantics，它会把帧读成结构。',
        returns: '{out | pattern, files:[…], notes}（按 fps 抽帧时返回 pattern，文件数量由 ffmpeg 决定）',
        cost: '每张一次快速定位 + 解一帧，约 50–200 ms。',
        pitfalls: 'times 是多个进程逐个定位：几十个时间点会有几十次进程启动。',
        example: 'ffmpeg_convert {action:"frames", input:"a.mp4", outDir:"stills", times:[1,5,9], format:"jpg"}',
      },
      concat: {
        summary: '拼接多段：mode:"copy" 秒级但要求编码参数完全一致（会逐项核对，不一致就拒绝并列出差异），mode:"encode" 先统一规格再拼。',
        required: ['inputs（至少两个）', 'out'],
        use: '把分段录制的屏幕录像接成一条。',
        avoid: 'copy 不会替你去掉分辨率差异——它只会明确告诉你哪一项不同。',
        returns: '{out, listPath, files:[…], notes, ok}',
        cost: 'copy 秒级；encode 等于把所有片段转码一遍。',
        pitfalls: 'copy 模式要求帧率/分辨率/编码/音频参数一致；录屏分段常常分辨率相同而帧率略有差异，此时用 encode。',
        example: 'ffmpeg_convert {action:"concat", inputs:["p1.mp4","p2.mp4"], out:"full.mp4", mode:"copy"}',
      },
      subtitles: {
        summary: '字幕两种进法：burn 烧进画面（重编码，谁都看得见），mux 作为独立轨道封装（不重编码，mp4 用 mov_text）。',
        required: ['input', 'out', 'srt'],
        use: '交付带字幕的成片，或把已有字幕轨塞进 MP4。',
        avoid: 'burn 会牺牲一次画质；能接受轨道就用 mux。',
        returns: '{out, notes, files:[…], ok}',
        cost: 'burn 等于转码一遍；mux 秒级。',
        pitfalls: 'srt 路径里的盘符与引号会被转义后交给 subtitle 滤镜；字幕时间轴超出片长时多余部分被丢弃。',
        example: 'ffmpeg_convert {action:"subtitles", input:"a.mp4", out:"a-sub.mp4", srt:"a.srt", mode:"burn"}',
      },
      gif: {
        summary: '把一段做成 GIF：单次滤镜图内建调色板，尺寸/帧率/循环次数都可指定。',
        required: ['input', 'out（.gif）', 'duration'],
        use: '做短循环演示。',
        avoid: 'GIF 没有音频、颜色只有 256 种；超过 10 秒的片段最好还是给 MP4。',
        returns: '{out, notes, files:[…], ok}',
        cost: '几秒片段约 1–3 秒。',
        pitfalls: '默认从 0 秒开始；要中段请给 start。',
        example: 'ffmpeg_convert {action:"gif", input:"a.mp4", out:"a.gif", start:3, duration:4, fps:12, width:640}',
      },
    },
  },

  ffmpeg_record: {
    purpose: '用 ffmpeg 采集本机画面或声音，固定时长，录完立刻测量：到底录了多久、有没有声音。',
    needs: ['ffmpeg 构建需支持 gdigrab / dshow（ffmpeg_env {action:"caps"} 的 capture 字段）。', '录音前先用 ffmpeg_env {action:"devices"} 取设备名。'],
    next: ['ffmpeg_semantics {action:"analyze"} 把这次录屏变成视频加结构'],
    actions: {
      screen: {
        summary: '录屏幕、窗口或屏幕上一块矩形，可选同时录一个 DirectShow 音频设备，必须给定时长。',
        required: ['out', 'seconds'],
        use: '录制操作演示、复现步骤，然后交给 ffmpeg_semantics。',
        avoid: '必须给秒数：录制没有「自动停」这回事，最长一次 3600 秒。',
        returns: '{out, notes, files:[{path,bytes,ok,problems,facts}], expectedDurationSec, ok}',
        cost: '实时：录 30 秒就花 30 秒。',
        pitfalls: '抓窗口时窗口关闭或最小化会让录制提前结束；region 与 window 只能选一个；多显示器时录的是整个虚拟桌面。',
        example: 'ffmpeg_record {action:"screen", out:"demo.mp4", seconds:30, fps:15, audioDevice:"麦克风 (Realtek(R) Audio)"}',
      },
      microphone: {
        summary: '只录声音，从 DirectShow 设备录固定秒数，输出 wav / m4a / mp3 等。',
        required: ['out', 'seconds', 'device'],
        use: '录旁白、录会议的一路声音。',
        avoid: '设备名必须与 ffmpeg_env {action:"devices"} 报的一字不差。',
        returns: '{out, notes, files:[…], expectedDurationSec, ok}',
        cost: '实时。',
        pitfalls: '设备被独占时可能录到静音而不是报错——所以录完一定要看 files[0].facts.audio 与时长。',
        example: 'ffmpeg_record {action:"microphone", out:"voice.wav", seconds:10, device:"麦克风 (Realtek(R) Audio)"}',
      },
    },
  },

  ffmpeg_semantics: {
    purpose:
      '把一段录像读成结构：切分时间轴、给每段抽一帧、把那一帧分成带标签的矩形、读出上面的文字、按规则给段落命名，最后写出结构 JSON + 关键帧 + 联系表 + 带章节的视频。',
    needs: [
      FFMPEG_NEEDED,
      '文字识别优先用同级 dsh-ocr 的离线引擎，没有就退回 Windows 自带识别；两者都没有时结构里 text 为 null 并说明原因。',
      'segmentation:"salient" 需要同级 video-factory 的 U²-Net 模型与 dsh-video-audio 的推理运行时。',
    ],
    next: ['按 structure.kinds 与 keywords 决定后续动作', 'ffmpeg_convert 按段落裁剪交付'],
    actions: {
      analyze: {
        summary: '完整流程：一次解码建时间轴，每段抽帧做分块与文字识别，输出 <名字>.semantics.json、关键帧目录、联系表，以及一份可直接播放的交付视频。',
        required: ['input'],
        use: '「一次录屏进，视频加语义结构出」——这是那个入口。',
        avoid: '它要完整解码一遍素材，长片很慢；只要时间轴用 action:"scenes"。',
        returns:
          '{version, generatedAt, source, options, analysis, providers, timeline, segments[{index,start,end,durationSec,startReason,endReason,startScore,sceneScore,motion,kind,kindEvidence,keyframe,regions,labelShares,dominantColors,text,salient}], structure{kinds,labelShares,keywords,regionVocabulary,kindRules,textSegments}, outputs{structure,keyframes,contactSheet,video,structureBytes}, notes}',
        cost: '一小时 1080p 录屏：解码约 1 分钟，每段抽帧+分块+识别约 0.3–1 秒（段数决定）。',
        pitfalls:
          '区域标签是按块的外观分类（确定性、无模型），不是学习式语义分割；「语义」二字来自时间轴、文字与规则化的段落命名。sceneThreshold 调小会切得更碎。',
        example: 'ffmpeg_semantics {action:"analyze", input:"demo.mp4", outDir:"analysis"}',
      },
      scenes: {
        summary: '只做时间轴：解码一遍，给出每段的起止、切分原因、运动量，不抽帧、不识别、不写文件。',
        required: ['input'],
        use: '先看结构再决定要不要花时间做完整分析；也用于「这段录屏有几件事」。',
        avoid: '不写任何文件，因此返回的是数据而不是产物；也因此不给段落类别（那需要看画面与文字）。',
        returns: '{source, options(实际生效的阈值), analysis{size,fps,decodedFrames,elapsedMs,decodeErrors}, segments[{index,start,end,durationSec,startReason,endReason,startScore,sceneScore,motion,mergedCount}], notes}',
        cost: '一次低分辨率解码，通常是片长的 1/10–1/3。',
        pitfalls: 'sceneThreshold 是「平均亮度差」而不是百分比：8 左右适合屏幕录制，切换整屏通常在 40 以上。',
        example: 'ffmpeg_semantics {action:"scenes", input:"demo.mp4", sceneThreshold:6}',
      },
      regions: {
        summary: '只分割一帧：把一张图（或视频的某一秒）分成带标签的矩形，给出每块的占比、判定数值与主色；salient 模式另取学习式显著物体掩码。',
        required: ['input'],
        use: '问「这一屏是什么布局」；也是 analyze 里分块逻辑的单独入口。',
        avoid: '这是外观分类（text / picture / texture / flat / dark），不是「按钮 / 段落」这种语义标签。',
        returns: '{input, at, source, frame, grid, regions[{label,x,y,width,height,areaRatio,score,colors}], labelShares, dominantColors, droppedRegions, vocabulary, thresholds, salient?, notes}',
        cost: '一次抽帧 + 一帧的纯 JS 统计，约 100–300 ms（salient 另约 2 秒）。',
        pitfalls: 'tileSize 越小越细也越慢；regionThresholds 可以覆盖默认判定线。',
        example: 'ffmpeg_semantics {action:"regions", input:"shot.png"}',
      },
    },
  },

  ffmpeg_run: {
    purpose:
      '逃生舱：当某个操作还没有专门的 action 时，直接给出 ffmpeg 参数数组。参数永远是数组、永不经过 shell，并且先 check 再 run。',
    needs: [FFMPEG_NEEDED],
    next: ['ffmpeg_probe {action:"info"} 复核产物'],
    actions: {
      check: {
        summary: '只做校验与回显：把最终命令行、会写哪个文件、需要哪些编码器/滤镜、有哪些风险讲清楚，不执行。',
        required: ['args'],
        use: '任何 ffmpeg_run {action:"run"} 之前的第一站。',
        avoid: '它不猜测意图：参数写错它只能报告参数本身的问题。',
        returns: '{command, tool, needs:{encoders,filters}, output:{path,extension,muxer}, warnings, wouldOverwrite}',
        cost: '免费（外加一次 caps 查询，已缓存）。',
        example: 'ffmpeg_run {action:"check", args:["-i","a.mp4","-vf","hflip","b.mp4"]}',
      },
      run: {
        summary: '执行参数数组并测量结果：退出码、耗时、stdout/stderr 尾部、写出的文件及其探测结果；失败会删掉半成品。',
        required: ['args'],
        use: 'ffmpeg 能做而这里没有专门 action 的事。',
        avoid: '不要把整个命令行写成一个字符串，那是 shell 的用法；这里每个参数必须是数组里独立的一项。',
        returns: '{code, elapsedMs, command, stdout, stderrTail, output:{path,bytes,verified,facts}|null, ok}',
        cost: '取决于参数；默认 10 分钟超时（timeoutMs 可改）。',
        pitfalls: '本插件永远自动加 -hide_banner -nostdin -y；如果参数里已经写了 -i 之后的输出同名于输入，会被拒绝，除非 overwriteInput:true。',
        example: 'ffmpeg_run {action:"run", args:["-i","a.mp4","-vf","hflip","-c:a","copy","b.mp4"]}',
      },
    },
  },

  ffmpeg_guide: {
    purpose: '这个插件的说明书：整个工具面、某个工具的完整说明、某个 action 的参数与坑、以及几条成事路线（playbook）。',
    needs: ['什么都不需要：纯计算。'],
    next: ['它描述的那个 action'],
    actions: {
      overview: {
        summary: '一页看全：8 个工具、每个工具做什么、以及最常走的几条路线。',
        required: [],
        returns: '{tools:[{name,purpose,actions}], playbooks:[{job,title,when}]}',
        cost: '无需 ffmpeg，无需磁盘。',
        example: 'ffmpeg_guide {action:"overview"}',
      },
      playbook: {
        summary: '按任务给出的分步配方：录屏并拿到语义结构、交付一个片段、抽帧做封面、烧字幕、诊断一个坏文件、把机器装好。',
        required: ['job'],
        use: '第一次做某件事时照做，比试参数快。',
        returns: '{job, title, steps:[{tool, call, why}], mistakes:[]}',
        example: 'ffmpeg_guide {action:"playbook", job:"record-and-analyze"}',
      },
      rules: {
        summary: '这个插件遵守的规则：确定性从哪来、一个数字意味着什么、失败为什么长这样、什么时候该换别的插件。',
        required: [],
        returns: '{determinism, numbers, failures, neighbours, cost}',
        example: 'ffmpeg_guide {action:"rules"}',
      },
      tool: {
        summary: '一个工具的全部：用途、何时用/不用、前提、下一步、每个 action 的参数与返回。',
        required: ['tool'],
        returns: '{name, purpose, needs, next, actions:{…}}',
        example: 'ffmpeg_guide {action:"tool", tool:"ffmpeg_semantics"}',
      },
      action: {
        summary: '一个 action 的全部参数：含义、默认值、返回形状、成本、坑与可运行示例。',
        required: ['actionName'],
        returns: '{tool, action, …entry, accepts:[参数表]}',
        example: 'ffmpeg_guide {action:"action", actionName:"transcode"}',
      },
    },
  },
}

/** Every tool name in the registry. */
export const REGISTERED_TOOLS = Object.keys(TOOL_REGISTRY)

/**
 * Look up one tool's entry.
 * @param {string} name - the tool name.
 * @returns {object|undefined} the entry.
 */
export function lookupTool(name) {
  return TOOL_REGISTRY[name]
}

/**
 * Find which tool owns an action name.
 *
 * Action names are unique across the surface on purpose: `ffmpeg_guide {action:"action"}` takes a
 * bare action name, and two tools with an action called `audio` would make that ambiguous.
 *
 * @param {string} actionName - the action.
 * @returns {{tool: string, action: string, entry: object}|null} the owner, or null.
 */
export function lookupAction(actionName) {
  const matches = []
  for (const [tool, entry] of Object.entries(TOOL_REGISTRY)) {
    if (entry.actions[actionName] !== undefined) matches.push({ tool, action: actionName, entry: entry.actions[actionName] })
  }
  if (matches.length === 0) return null
  return matches[0]
}

/** Shared `cwd` prose, exported so the schema modules do not restate it. */
export const CWD_PROSE = CWD
