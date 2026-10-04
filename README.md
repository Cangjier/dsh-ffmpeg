# dsh-ffmpeg

把 ffmpeg 变成一套**确定的、可验证的**工具：编码、裁剪、抽帧、拼合、录屏，以及
**「一次录屏进，视频 + 语义结构出」**。

插件只做两件事：**执行**与**测量**。判断——要不要这段、结果够不够好、这段录像在讲什么——全部归 DSH。
因此这里没有一处「智能」的判断藏在代码里：每个数字都能指出它是怎么量出来的，每个标签都能追到写死的规则。

```
dsh-ffmpeg/
├── index.mjs              插件入口（零依赖，无构建步骤）
├── cordis.patch.yml       bundle 补丁：一行注册，配置全部可选
├── src/
│   ├── core/              确定性内核：不 import 任何 DSH 代码，可离线测试
│   ├── tools/             模型可见的八个 ffmpeg_* 工具（文档单一来源：registry.mjs）
│   └── bin/winrt-ocr.ps1  Windows 自带识别的封装（零安装的回退）
├── tests/                 82 个测试：46 个纯函数 + 13 个工具面 + 23 个真 ffmpeg 端到端
├── scripts/               手跑脚本：挂载检查、合成素材分析、真录屏分析
└── docs/插件设计规格.md    设计与边界（为什么这样切、什么不做）
```

## 八个工具

| 工具 | 动作 | 一句话 |
| --- | --- | --- |
| `ffmpeg_env` | `probe` `caps` `devices` | 这台机器上的 ffmpeg 是哪一份、能做什么、能从哪里采集 |
| `ffmpeg_setup` | `status` `install` `remove` | 装一份版本固定、SHA-256 强制校验的构建，或看/删掉它 |
| `ffmpeg_probe` | `info` `integrity` `keyframes` | 文件是什么规格、完不完整、能在哪些点干净切开 |
| `ffmpeg_convert` | `transcode` `trim` `audio` `frames` `concat` `subtitles` `gif` | 把一份素材变成另一份，写完立刻重新测一遍 |
| `ffmpeg_record` | `screen` `microphone` | 固定时长采集本机画面或声音，录完报实际时长 |
| `ffmpeg_semantics` | `analyze` `scenes` `regions` | 把录像读成结构：时间轴、关键帧、区域标签、文字、段落类别 |
| `ffmpeg_run` | `check` `run` | 逃生舱：直接给参数数组，先 `check` 再 `run` |
| `ffmpeg_guide` | `overview` `playbook` `rules` `tool` `action` | 本插件的说明书，按需读取，不占常驻上下文 |

每个 action 的完整参数、返回、成本与坑都在 `ffmpeg_guide {action:"action", actionName:"…"}` 里；
六条成事路线（录屏并分析、交付片段、抽帧做封面、烧字幕、诊断坏文件、装机）在
`ffmpeg_guide {action:"playbook"}` 里。

## 主路线：一次录屏进，视频加语义结构出

```js
ffmpeg_record   { action:"screen", out:"demo.mp4", seconds:60, fps:15 }
ffmpeg_semantics{ action:"analyze", input:"demo.mp4", outDir:"analysis" }
```

`analyze` 做完这些事，然后交回一份结构：

1. **一次低分辨率解码**（默认长边 320px、4fps）逐帧比较相邻亮度差，建立时间轴：
   切点（`cut`）、超长强制分段（`cadence`）、文件结尾（`end`），每段都带实测运动量。
2. 合并过短的段、按上限截断，每一段**抽一帧存成图**（默认段中点）。
3. 对这一帧做**按块外观分类**：把画面切成 16×16 的小块，量边缘密度、饱和度、亮度方差，
   判定为 `text` / `picture` / `texture` / `flat` / `dark`，再把同标签的相邻块并成矩形。
4. 用可用 OCR 读这一帧的文字（同级 `dsh-ocr` 的离线引擎优先，退回 Windows 自带识别），
   并明确标注是哪一个引擎读的。
5. 按**写死的规则表**给段落命名：`document` / `typing` / `scrolling` / `video_playback` /
   `animation` / `still_image` / `idle`，规则原文随结果一起返回（`structure.kindRules`）。
6. 写四样东西：结构 JSON、关键帧目录、联系表（多段时）、以及一份**带章节的交付视频**
   （默认流复制，不重编码）。

产物长这样（节选）：

```json
{
  "version": 1,
  "source": { "kind": "video", "durationSec": 6, "video": { "width": 640, "height": 360, "fps": 25 } },
  "analysis": { "mode": "decode", "size": { "width": 320, "height": 180 }, "fps": 4, "decodedFrames": 24 },
  "providers": {
    "ocr": { "provider": "winrt", "language": "zh-Hans-CN", "notes": ["…小字更不准…"] },
    "segmentation": { "mode": "grid", "appearance": "按块外观分类（确定性，无模型）", "salient": null }
  },
  "segments": [
    {
      "index": 1, "start": 3, "end": 6, "durationSec": 3,
      "startReason": "cut", "endReason": "end", "startScore": 205.9, "sceneScore": null,
      "motion": { "meanAbsDiff": 0, "level": "static", "samples": 12 },
      "kind": "document",
      "kindEvidence": { "motionLevel": "static", "textShare": 0.02, "pictureShare": 0.07, "lineCount": 1, "rule": "几乎不动 + 画面以文字为主：正在看的一页。" },
      "keyframe": { "at": 4.5, "path": "…/demo.keyframes/kf_0002.jpg" },
      "regions": [{ "label": "dark", "x": 0, "y": 0, "width": 320, "height": 180, "areaRatio": 0.93, "score": 0.99 }],
      "labelShares": { "picture": 0.07, "dark": 0.93 },
      "dominantColors": [{ "hex": "#101020", "share": 0.94 }],
      "text": { "provider": "winrt", "engine": "windows-ocr:zh-Hans-CN", "lineCount": 1, "reading": "BETA 222 screen" }
    }
  ],
  "structure": { "kinds": [ { "kind": "document", "segments": 1, "totalSec": 3, "share": 1 } ], "keywords": [] },
  "outputs": { "structure": "…/demo.semantics.json", "keyframes": "…/demo.keyframes", "contactSheet": "…/demo.contact-sheet.jpg", "video": { "path": "…/demo.mp4", "ok": true } }
}
```

## 为什么说它「更稳」

这些不是宣传语，每一条都有对应的实现与测试：

| 做法 | 防的是哪一种失败 |
| --- | --- |
| 参数永远是**数组**，永不拼字符串、永不经过 shell | 中文名、空格、引号被二次解析 |
| 永远自带 `-hide_banner -nostdin -y` | ffmpeg 问一个没人看得见的覆盖问题，然后退出码 1 |
| 显式 `-map 0:v:0? -map 0:a:0?` | 输出随流的排列顺序漂移 |
| 分析尺寸在这里算好再显式传给 ffmpeg，绝不用 `-2` | JS 侧缓冲与 ffmpeg 输出差一个像素，画面被拉斜 |
| 每次写文件之后**重新探测产物** | 退出码 0 但文件是空的 / 没音频 / 时长短了一截 |
| 失败即删掉半成品 | 一个「名字对、内容半截」的文件冒充交付物 |
| 拒绝把输出写成输入（除非显式 `overwriteInput`） | `ffmpeg -i a.mp4 … a.mp4` 先清空源文件 |
| 分析自身也可能撞名输入时自动改名并说明 | 分析一个已在同名目录里的录像时毁掉它 |
| 并发上限（默认 2） | 几个 1080p 同时编码，每一个都更慢还容易失败 |
| 动手前先问能力（`caps`） | 「Unknown encoder」在长时间解码之后才出现 |
| ffmpeg 9 的 `-filters` 标志列宽度与表头不一致也照样解析 | 误报「这份构建没有 scale 滤镜」 |
| 每个进程都有超时，超时就杀 | 挂住的 ffmpeg 变成一个不返回的 agent |
| `concat` 强制统一画布，按比例缩放 + 补黑边 | 拼接失败（`concat` 不能在输入之间重配置）或把人脸拉变形 |
| 下载可续传、`.part` 完成后才改名、摘要先校验再解压 | 200MB 下载到 90% 断掉；半个压缩包被当成品 |

## 安装

插件是纯 ESM，无依赖、无构建步骤。profile 里加一行即可：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": { "dsh-ffmpeg": "link:C:/Users/Admin/Documents/GitHub/dsh-plugins/dsh-ffmpeg" },
  "dsh": { "profile": { "bundles": ["…", "dsh-ffmpeg"] } }
}
```

```sh
pnpm install          # 在 profile 目录里
# 重启 DSH，让 profile 重新加载
```

ffmpeg 本身按这个顺序查找，**任何一处有就能用**：

1. 配置里的 `ffmpegPath` / `ffprobePath`
2. 环境变量 `DSH_FFMPEG` / `DSH_FFPROBE`
3. 本插件 `vendor/ffmpeg/bin/`（`ffmpeg_setup {action:"install"}` 会装到这里）
4. 同级插件的 `vendor/ffmpeg/bin`（`video-factory`、`dsh-video-audio`、`dsh-ocr`）
5. `PATH`

什么都没有也能开机：所有工具照常注册，只是每个动作会明确告诉你缺什么、怎么补。

```js
ffmpeg_setup { action:"install" }                       // gyan 9.0.2 essentials，SHA-256 强制校验
ffmpeg_setup { action:"install", archive:"D:/dl/ffmpeg.zip" }   // 用本地压缩包，摘要仍然校验
ffmpeg_setup { action:"install", source:"btbn-latest" } // 跟最新，只能记录摘要
```

## 配置

全部可选，`cordis.patch.yml` 里有注释版：

```yaml
- insert:
    - id: dsh-ffmpeg
      name: dsh-ffmpeg
      config:
        ffmpegPath: null          # null = 自动发现
        projectRoot: null         # 相对路径的基准目录
        maxConcurrent: 2          # 同时最多几个 ffmpeg 进程
        defaultTimeoutMs: 600000  # 单次编码超时
        analysis:                 # ffmpeg_semantics 的默认值
          sceneThreshold: 8       # 平均亮度差，不是百分比
          minSegmentSec: 1
          maxSegmentSec: 30
          fps: 4
          maxSide: 320
          maxKeyframes: 120
          ocrMaxFrames: 60
        ocr:
          provider: auto          # auto / sibling / winrt / off
          language: ch
          pluginPath: null        # 同级 dsh-ocr 的目录
        salientPluginPath: null   # 同级 video-factory 的目录
```

## 可选的两处集成（都不是必需）

- **文字**：同级 `dsh-ocr` 装了离线引擎就用它（PP-OCR，小字混排明显更准）；
  否则退回 Windows 自带识别——零安装，但小字会读错，所以结果里永远写明是哪个引擎读的。
  两者都没有时，`text` 是 `null` 并附原因，而不是空的字符串。
- **分割**：`segmentation:"salient"` 会向同级 `video-factory` 要一张 U²-Net 显著物体掩码
  （模型由 `video_setup {action:"install_matte"}` 提供，推理运行时由 `dsh-video-audio` 提供）。
  不可用时会说明原因并退回自带的外观分类。

## 这个插件不假装的事

- `regions` 的标签是**外观分类**：按块量边缘密度、饱和度、亮度方差后归类。
  它不会说「这是一个按钮」。没装模型时它也不会假装自己做了语义分割。
- 段落类别（`document` / `typing` / …）是**写死的规则表**，输入只有实测运动量与外观占比。
  规则原文随结果返回，可以逐条核对。
- `keywords` 是**按出现次数排的词表**，不是摘要。中文按 2–4 字 n-gram 统计，
  被更长同频词吸收（`语义` 被 `语义分割` 吸收），所以不是分词。
- 整条链路里唯一的学习模型是可选的那张显著物体掩码，结果里标明 `provider`。
- OCR 结果当**线索**用，不要当精确数据——尤其是 Windows 自带识别。

## 与其他插件的关系

| 事情 | 归谁 |
| --- | --- |
| 编码、裁剪、抽帧、拼合、录屏、把录像读成结构 | **dsh-ffmpeg**（本插件） |
| 制造、修复、测量声音（`audio_*`） | dsh-video-audio |
| 成片流程：素材 → 场景 → 拼接 → 交付（`video_*`） | video-factory |
| 屏幕上的文字定位与点击（`text_*`、`computer_*`） | dsh-ocr、dsh-computer-use |

## 开发

```sh
node --test                          # 全部 82 个测试（没有 ffmpeg 时自动跳过 23 个端到端）
node --test tests/core.test.mjs      # 只跑纯函数
node scripts/mount-check.mjs         # 挂载检查：注册了哪些工具、用的是哪份 ffmpeg
node scripts/analyze-demo.mjs        # 拿合成素材跑一遍 analyze，打印结构
node scripts/record-demo.mjs         # 真的录 3 秒屏幕再分析（写入 tmp/，已被 gitignore）
```

测试自己生成素材（`lavfi` + `drawtext`），所以仓库里没有二进制文件，也不需要联网。
`tests/helpers.mjs` 里的合成录像刻意包含三种要区分的东西：彩色运动画面 + 文字、
纯暗画面 + 另一段文字、以及一条音轨。

## 许可

MIT。
