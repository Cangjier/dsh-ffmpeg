/**
 * The tool surface: registration, documentation coverage, schema shape, and dispatch.
 *
 * These tests are about the contract the model sees. A tool that registers with an undocumented
 * action, an action whose handler is unreachable, or a schema that accepts a field no handler reads
 * is a failure that no runtime test would catch and that a user experiences as "the tool ignored
 * what I asked for".
 *
 * @module dsh-ffmpeg/tests/plugin
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, normalizeConfig } from '../index.mjs'
import { TOOL_NAMES, registerTools, toolDefinitions } from '../src/tools/index.mjs'
import { TOOL_ORDER, TOOL_REGISTRY, lookupAction, lookupTool } from '../src/tools/registry.mjs'
import { PLAYBOOKS } from '../src/tools/guide.mjs'

/** Collect the definitions a real mount would register. */
function mount(config = normalizeConfig({})) {
  const registered = []
  const logs = []
  const logger = {
    info: (message) => logs.push(`info: ${message}`),
    warn: (message) => logs.push(`warn: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
  }
  const outcome = registerTools({ tools: { register: (definition) => registered.push(definition) } }, config, logger)
  return { registered, logs, outcome }
}

test('the registry and the declared tool list agree', () => {
  assert.deepEqual(TOOL_NAMES, TOOL_ORDER)
  assert.equal(TOOL_NAMES.length, 8)
  for (const name of TOOL_NAMES) assert.ok(lookupTool(name) !== undefined, `${name} has no registry entry`)
  assert.equal(Object.keys(TOOL_REGISTRY).length, TOOL_NAMES.length)
})

test('every action is documented, has a handler, and has a unique name', () => {
  const { registered, outcome } = mount()
  assert.deepEqual(outcome.failed, [])
  assert.equal(registered.length, TOOL_NAMES.length)

  const seen = new Map()
  for (const definition of registered) {
    const actions = definition.parameters.properties.action.enum
    const documented = Object.keys(lookupTool(definition.name).actions)
    assert.deepEqual([...actions].sort(), [...documented].sort(), `${definition.name}: schema and registry disagree`)
    for (const action of actions) {
      assert.equal(typeof definition.execute, 'function')
      assert.ok(lookupAction(action) !== null, `${action} is not findable by name`)
      assert.equal(seen.has(action), false, `action ${action} exists on both ${seen.get(action)} and ${definition.name}`)
      seen.set(action, definition.name)
    }
  }
  assert.ok(seen.size >= 25, `expected a substantial surface, found ${seen.size} actions`)
})

test('every tool description carries purpose, actions, needs, next and a guide pointer', () => {
  const { registered } = mount()
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string')
    for (const marker of ['Actions:', 'Needs:', 'Next:', 'ffmpeg_guide']) {
      assert.ok(definition.description.includes(marker), `${definition.name} description lacks "${marker}"`)
    }
    assert.ok(definition.description.length < 1400, `${definition.name} description is ${definition.description.length} characters`)
  }
})

test('every schema is closed, requires only the action, and documents each action inline', () => {
  const { registered } = mount()
  for (const definition of registered) {
    const schema = definition.parameters
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['action'])
    assert.equal(schema.additionalProperties, false)
    const help = schema.properties.action.description
    for (const action of schema.properties.action.enum) {
      assert.ok(help.includes(`${action} — `), `${definition.name}: action ${action} has no inline line`)
    }
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.output.schema.type, 'object')
  }
})

test('an unknown action is refused by name, not silently ignored', async () => {
  const { registered } = mount()
  const env = registered.find((definition) => definition.name === 'ffmpeg_env')
  await assert.rejects(() => env.execute({ action: 'nonsense' }, { cwd: process.cwd() }), /unknown action/)
  await assert.rejects(() => env.execute({}, { cwd: process.cwd() }), /unknown action/)
})

test('a handler belonging to a sibling tool is unreachable from this one', async () => {
  const { registered } = mount()
  const guide = registered.find((definition) => definition.name === 'ffmpeg_guide')
  // `transcode` is a real action of ffmpeg_convert; asking ffmpeg_guide for it must fail.
  await assert.rejects(() => guide.execute({ action: 'transcode' }, { cwd: process.cwd() }), /unknown action/)
})

test('the guide answers for every tool and every action without touching ffmpeg', async () => {
  const { registered } = mount()
  const guide = registered.find((definition) => definition.name === 'ffmpeg_guide')

  const overview = await guide.execute({ action: 'overview' }, { cwd: process.cwd() })
  assert.deepEqual(overview.tools.map((tool) => tool.name), TOOL_NAMES)
  assert.ok(overview.honesty.length >= 3)
  assert.equal(typeof overview.where.pluginRoot, 'string')

  for (const name of TOOL_NAMES) {
    const described = await guide.execute({ action: 'tool', tool: name }, { cwd: process.cwd() })
    assert.equal(described.name, name)
    assert.ok(Object.keys(described.actions).length > 0)
  }

  for (const [tool, entry] of Object.entries(TOOL_REGISTRY)) {
    for (const action of Object.keys(entry.actions)) {
      const described = await guide.execute({ action: 'action', actionName: action }, { cwd: process.cwd() })
      assert.equal(described.action, action)
      assert.equal(described.tool, tool)
      assert.equal(typeof described.summary, 'string')
    }
  }

  await assert.rejects(() => guide.execute({ action: 'action', actionName: 'nope' }, { cwd: process.cwd() }), /没有叫/)
  await assert.rejects(() => guide.execute({ action: 'tool', tool: 'nope' }, { cwd: process.cwd() }), /未知的工具/)
  await assert.rejects(() => guide.execute({ action: 'action' }, { cwd: process.cwd() }), /需要 actionName/)
})

test('every playbook names real tools and gives a runnable call', async () => {
  const { registered } = mount()
  const guide = registered.find((definition) => definition.name === 'ffmpeg_guide')
  const list = await guide.execute({ action: 'playbook' }, { cwd: process.cwd() })
  assert.deepEqual(list.playbooks.map((entry) => entry.job).sort(), Object.keys(PLAYBOOKS).sort())

  for (const job of Object.keys(PLAYBOOKS)) {
    const recipe = await guide.execute({ action: 'playbook', job }, { cwd: process.cwd() })
    // A recipe may legitimately be two calls; the two flagship ones are longer and are held to it.
    assert.ok(recipe.steps.length >= 2, `${job} has too few steps`)
    if (job === 'record-and-analyze' || job === 'deliver-a-clip') {
      assert.ok(recipe.steps.length >= 4, `${job} should walk the whole job`)
    }
    for (const step of recipe.steps) {
      assert.ok(TOOL_NAMES.includes(step.tool), `${job}: unknown tool ${step.tool}`)
      assert.ok(step.call.startsWith(step.tool), `${job}: "${step.call}" does not call ${step.tool}`)
      assert.equal(typeof step.why, 'string')
    }
    assert.ok(Array.isArray(recipe.mistakes) && recipe.mistakes.length > 0)
  }
  await assert.rejects(() => guide.execute({ action: 'playbook', job: 'nope' }, { cwd: process.cwd() }), /未知的 job/)
})

test('the rules action states the determinism, number and neighbour contracts', async () => {
  const { registered } = mount()
  const guide = registered.find((definition) => definition.name === 'ffmpeg_guide')
  const rules = await guide.execute({ action: 'rules' }, { cwd: process.cwd() })
  for (const key of ['determinism', 'numbers', 'failures', 'neighbours', 'cost']) {
    assert.ok(Array.isArray(rules[key]) && rules[key].length > 0, `rules.${key} is empty`)
  }
  assert.equal(rules.determinism.some((line) => line.includes('argv')), true)
  assert.equal(rules.neighbours.some((line) => line.includes('dsh-video-audio')), true)
})

test('apply mounts through the tools service and logs where ffmpeg came from', () => {
  const registered = []
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message), error: (message) => logs.push(message) },
    inject(services, callback) {
      assert.deepEqual(services, ['tools'])
      callback({ tools: { register: (definition) => registered.push(definition) } })
    },
  }
  apply(ctx, {})
  assert.equal(registered.length, TOOL_NAMES.length)
  assert.equal(logs.some((line) => line.includes('已注册 8 个工具')), true)
  assert.equal(logs.some((line) => line.includes('ffmpeg')), true)
})

test('an invalid config is reported and mounts nothing, rather than half-working', () => {
  const registered = []
  const logs = []
  const ctx = {
    logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message), error: (message) => logs.push(message) },
    inject(_services, callback) {
      callback({ tools: { register: (definition) => registered.push(definition) } })
    },
  }
  apply(ctx, { maxConcurrent: 'lots' })
  assert.equal(registered.length, 0)
  assert.equal(logs.some((line) => line.includes('配置无效')), true)
})

test('the public core barrel loads and every name it re-exports exists', async () => {
  // `exports["./core"]` is part of the package's contract, and a barrel that names something a module
  // does not export fails at *import* time — which would take every consumer down, not just one call.
  const core = await import('../src/core/index.mjs')
  const names = Object.keys(core)
  assert.ok(names.length > 100, `barrel exported ${names.length} names`)
  for (const name of names) assert.notEqual(core[name], undefined, `${name} re-exported but undefined`)
  for (const required of ['probe', 'transcodePlan', 'analyze', 'TimelineBuilder', 'segmentFrame', 'recognise']) {
    assert.equal(typeof core[required], 'function', `${required} is missing from the barrel`)
  }
})

test('the tool definitions are rebuilt per call and stay independent', () => {
  const first = toolDefinitions(normalizeConfig({ analysis: { fps: 2 } }), silent())
  const second = toolDefinitions(normalizeConfig({ analysis: { fps: 8 } }), silent())
  assert.equal(first.length, second.length)
  assert.notEqual(first[0], second[0])
  first[0].parameters.properties.action.enum.push('bogus')
  assert.equal(second[0].parameters.properties.action.enum.includes('bogus'), false, '枚举被共享了')
})

/** A logger that says nothing. */
function silent() {
  return { info: () => {}, warn: () => {}, error: () => {} }
}
