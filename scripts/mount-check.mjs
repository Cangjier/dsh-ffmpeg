/**
 * A smoke check that the plugin mounts and exposes what it claims.
 *
 * Run with `node tmp/smoke.mjs`. It is not part of the test suite: it needs the real machine (an
 * ffmpeg somewhere) and it prints rather than asserts, which is what makes it useful while wiring
 * the plugin up.
 */
import { apply, normalizeConfig } from '../index.mjs'
import { TOOL_NAMES } from '../src/tools/index.mjs'

const registered = []
const logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.log(`[warn] ${message}`),
  error: (message) => console.log(`[error] ${message}`),
}

const ctx = {
  logger,
  inject(services, callback) {
    callback({ tools: { register: (definition) => registered.push(definition) } })
  },
}

const config = normalizeConfig({
  analysis: { maxKeyframes: 8 },
  ocr: { provider: 'auto' },
})
apply(ctx, config)

console.log(`\nregistered ${registered.length} tools, expected ${TOOL_NAMES.length}`)
for (const definition of registered) {
  const names = definition.parameters.properties.action.enum
  console.log(`- ${definition.name}: ${names.join(', ')}`)
  if (definition.parameters.properties.action.enum.length === 0) throw new Error(`${definition.name} has no actions`)
  if (typeof definition.description !== 'string' || definition.description.length < 20) throw new Error(`${definition.name} description too short`)
}

// Call the read-only actions that need no arguments, to prove the handlers are wired.
const env = registered.find((definition) => definition.name === 'ffmpeg_env')
const caps = await env.execute({ action: 'probe' }, { cwd: process.cwd() })
console.log(`\nffmpeg_env probe:\n${caps.text ?? JSON.stringify(caps, null, 2)}`)

const guide = registered.find((definition) => definition.name === 'ffmpeg_guide')
const overview = await guide.execute({ action: 'overview' }, { cwd: process.cwd() })
console.log(`\nffmpeg_guide overview tools: ${overview.tools.map((tool) => tool.name).join(', ')}`)
console.log(`current ffmpeg: ${JSON.stringify(overview.where.currentFfmpeg)}`)
