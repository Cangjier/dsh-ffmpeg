/**
 * Registers every model-facing `ffmpeg_*` tool.
 *
 * The tool list comes from `registry.mjs`, so a tool cannot be registered without being documented
 * and cannot be documented without being registered — a mismatch fails at load time rather than
 * surfacing as a silently under-documented schema.
 *
 * @module dsh-ffmpeg/tools
 */
import { createConvertTool } from './convert.mjs'
import { createEnvTool } from './env.mjs'
import { createGuideTool } from './guide.mjs'
import { createProbeTool } from './probe.mjs'
import { createRecordTool } from './record.mjs'
import { createRunTool } from './run.mjs'
import { createSemanticsTool } from './semantics.mjs'
import { createSetupTool } from './setup.mjs'
import { TOOL_ORDER } from './registry.mjs'

/** Every tool name this plugin registers, in presentation order. */
export const TOOL_NAMES = [...TOOL_ORDER]

/**
 * Build every tool definition.
 *
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {object[]} raw tool definitions, in `TOOL_ORDER`.
 */
export function toolDefinitions(config, logger) {
  return [
    createEnvTool(config, logger),
    createSetupTool(config, logger),
    createProbeTool(config, logger),
    createConvertTool(config, logger),
    createRecordTool(config, logger),
    createSemanticsTool(config, logger),
    createRunTool(config, logger),
    createGuideTool(config, logger),
  ]
}

/**
 * Register every tool on a context that already carries the `tools` service.
 *
 * A failing registration must not take the whole plugin down: the rest are still useful, and the
 * failure is reported to the log.
 *
 * @param {object} toolsCtx - the sub-context providing `tools`.
 * @param {object} config - normalized plugin config.
 * @param {object} logger - the host plugin's logger.
 * @returns {{registered: string[], failed: {name: string, error: string}[]}} the outcome.
 */
export function registerTools(toolsCtx, config, logger) {
  const registered = []
  const failed = []
  for (const definition of toolDefinitions(config, logger)) {
    try {
      toolsCtx.tools.register(definition)
      registered.push(definition.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ name: definition.name, error: message })
      logger.error(`dsh-ffmpeg: 注册工具 ${definition.name} 失败：${message}`)
    }
  }
  logger.info(`dsh-ffmpeg: 已注册 ${registered.length} 个工具：${registered.join(', ')}`)
  return { registered, failed }
}
