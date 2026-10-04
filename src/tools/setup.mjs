/**
 * `ffmpeg_setup` — provisioning a private, version-pinned build.
 *
 * @module dsh-ffmpeg/tools/setup
 */
import { resetCapabilityCache } from '../core/caps.mjs'
import { resetToolCache, resolveTool } from '../core/env.mjs'
import { FFMPEG_SOURCES, installFfmpeg, installState, removeFfmpeg } from '../core/install.mjs'
import { InstallError } from '../core/net.mjs'
import { FfmpegPluginError, FORCE_PROPERTY, defineFamilyTool, optionalBoolean, optionalEnum } from './shared.mjs'

/** Every action `ffmpeg_setup` dispatches. */
export const SETUP_ACTIONS = ['status', 'install', 'remove']

/**
 * Build the `ffmpeg_setup` tool.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object} a raw tool definition.
 */
export function createSetupTool(config, logger) {
  const where = 'ffmpeg_setup'

  return defineFamilyTool({
    name: 'ffmpeg_setup',
    actions: SETUP_ACTIONS,
    extraProperties: {
      source: {
        type: 'string',
        enum: Object.keys(FFMPEG_SOURCES),
        description: `install: which build to fetch. Default "${'gyan-release'}" — version-pinned with an enforced SHA-256. "btbn-latest" follows a moving tag and can only record its digest.`,
      },
      force: FORCE_PROPERTY,
      archive: {
        type: 'string',
        description: 'install: use this local zip instead of downloading. The pinned digest is still checked, so a local file is never an unverified one. Resolved against the process working directory, not "cwd".',
      },
      allowDigestMismatch: {
        type: 'boolean',
        description: 'install: accept a download whose SHA-256 differs from the pinned one. Only after confirming the archive really was republished upstream.',
      },
    },
    handlers: {
      /**
       * Report what is installed and what would answer.
       * @returns {object} the state.
       */
      status() {
        return installState(config)
      },

      /**
       * Download and unpack a build into this plugin's vendor directory.
       * @param {object} args - the tool arguments.
       * @returns {Promise<object>} what was installed.
       */
      async install(args) {
        const source = optionalEnum(args, 'source', Object.keys(FFMPEG_SOURCES), undefined, `${where} install`)
        const force = optionalBoolean(args, 'force', false, `${where} install`)
        const allowDigestMismatch = optionalBoolean(args, 'allowDigestMismatch', false, `${where} install`)
        const archive = typeof args.archive === 'string' && args.archive !== '' ? args.archive : undefined

        try {
          const result = await installFfmpeg({
            source,
            force,
            archive,
            allowDigestMismatch,
            onProgress: (line) => logger.info(`dsh-ffmpeg install: ${line}`),
          })
          resetToolCache()
          resetCapabilityCache()
          const installed = resolveAfterInstall(config)
          logger.info(`dsh-ffmpeg: 安装结果 installed=${result.installed}；现在生效的是 ${installed.ffmpeg?.path ?? '(仍然没有)'}`)
          return { ...result, resolved: installed }
        } catch (error) {
          if (error instanceof InstallError) throw new FfmpegPluginError(`安装 ffmpeg 失败：${error.message}`)
          throw error
        }
      },

      /**
       * Remove the private build.
       * @returns {object} what was removed.
       */
      remove() {
        const result = removeFfmpeg()
        resetToolCache()
        resetCapabilityCache()
        return { ...result, resolved: resolveAfterInstall(config) }
      },
    },
  })
}

/**
 * What would answer now, after a change to the vendor directory.
 *
 * @param {object} config - normalized plugin config.
 * @returns {{ffmpeg: object|null, ffprobe: object|null}} the resolved binaries.
 */
function resolveAfterInstall(config) {
  return { ffmpeg: resolveTool('ffmpeg', config), ffprobe: resolveTool('ffprobe', config) }
}
