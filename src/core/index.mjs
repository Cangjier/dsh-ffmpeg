/**
 * The deterministic core of `dsh-ffmpeg`, as one barrel file.
 *
 * Nothing in this tree imports DSH. That is what makes the plugin's central claims checkable
 * offline: the argument builders, the size arithmetic, the region labelling, the timeline state
 * machine and the loudnorm parse are all ordinary functions and can be tested without a harness,
 * a model, or a network.
 *
 * @module dsh-ffmpeg/core
 */

export {
  FFMPEG_ENV,
  FFPROBE_ENV,
  FfmpegNotFound,
  PLUGIN_ROOT,
  SIBLING_PLUGINS,
  VENDOR_BIN_DIR,
  VENDOR_DIR,
  binaryCandidates,
  binaryName,
  ensureDir,
  longPath,
  requireTool,
  resetToolCache,
  resolveCwd,
  resolveTool,
  siblingRoots,
  vendoredState,
  versionOf,
} from './env.mjs'

export {
  DEFAULT_TIMEOUT_MS,
  FfmpegError,
  decodeRawFrames,
  explain,
  parseProgress,
  removeQuietly,
  run,
  runProbe,
  setMaxConcurrent,
} from './ffmpeg.mjs'

export {
  FFMPEG_SOURCES,
  DEFAULT_SOURCE,
  WANTED_BINARIES,
  extractBinaries,
  findEndOfCentralDirectory,
  installFfmpeg,
  installState,
  removeFfmpeg,
} from './install.mjs'

export { InstallError, downloadFile, probeUrl, proxyVariables, sha256File } from './net.mjs'

export {
  WATCHED_ENCODERS,
  WATCHED_FILTERS,
  capabilities,
  checkNeeds,
  listCaptureDevices,
  parseDevices,
  parseDshowDevices,
  parseHwaccels,
  parseListNames,
  resetCapabilityCache,
  videoEncoderOptions,
} from './caps.mjs'

export {
  ProbeError,
  classify,
  integrity,
  keyframeTimes,
  parseRational,
  probe,
  probeMany,
  rotationOf,
  streamProblems,
} from './probe.mjs'

export {
  ANALYSIS_MAX_SIDE,
  fitSize,
  loadRgb,
  luma,
  meanColor,
  pixelAt,
  saveStill,
  toHex,
} from './image.mjs'

export {
  DEFAULT_THRESHOLDS,
  DEFAULT_TILE_SIZE,
  LABEL_MEANINGS,
  REGION_LABELS,
  classifyTile,
  dominantColors,
  frameDifference,
  mergeRegions,
  segmentFrame,
  tileStats,
} from './segmentation.mjs'

export {
  DEFAULT_MAX_SEGMENT,
  DEFAULT_MIN_SEGMENT,
  DEFAULT_SCENE_THRESHOLD,
  SEGMENT_REASONS,
  TimelineBuilder,
  keyframeTime,
  mergeShortSegments,
  motionLevel,
} from './timeline.mjs'

export { STOP_WORDS, collapsePrefixes, extractKeywords, isCjk } from './text.mjs'

export {
  OCR_LANGUAGES,
  OCR_PROVIDERS,
  WINRT_SCRIPT,
  languageTag,
  loadSiblingOcr,
  ocrReport,
  recognise,
  recogniseMany,
  siblingOcrRoots,
} from './ocr.mjs'

export { loadSalient, resetSalientCache, salientFrame, salientReport, siblingVideoFactoryRoots } from './salient.mjs'

export {
  ANALYSIS_DEFAULTS,
  SEGMENT_KINDS,
  SEGMENT_KIND_RULES,
  SEMANTICS_VERSION,
  analyze,
  canRemuxToMp4,
  deliverVideo,
  describeSegmentKind,
  formatClock,
  makeContactSheet,
  normalizeOptions,
  regions,
  sceneTimeline,
  summarizeKinds,
  summarizeLabels,
  writeChapters,
} from './semantics.mjs'

export {
  CONTAINERS as MEDIA_CONTAINERS,
  MediaError,
  X264_PRESETS,
  assertSeparate,
  audioArguments,
  audioPlan,
  concatPlan,
  containerFor,
  execute,
  formatTime,
  framesPlan,
  gifPlan,
  parseLoudnorm,
  subtitlesPlan,
  substituteLoudnorm,
  transcodePlan,
  trimPlan,
  verifyOutput,
  videoArguments,
} from './media.mjs'

export {
  DEFAULT_CAPTURE_FPS,
  MAX_RECORD_SECONDS,
  audioPlan as audioRecordPlan,
  escapeOptionValue,
  screenPlan,
} from './record.mjs'
