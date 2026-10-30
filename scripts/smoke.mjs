#!/usr/bin/env node
/**
 * 冒烟测试：不连服务器，验证插件能挂上、工具面完整、离线时也能好好说话。
 * 跑法：node scripts/smoke.mjs
 */

import { apply } from '../lib/index.js'

const tools = new Map()
const disposers = []
const ctx = {
  tools: {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`重复注册：${definition.name}`)
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  inject() {},
}

apply(ctx, {
  autoConnect: false,
  connection: { host: '127.0.0.1', port: 25565, username: '小鲸鱼', auth: 'offline' },
})

let bad = 0
const expect = (name, condition, detail = '') => {
  if (condition) console.log(`  ✓ ${name}`)
  else {
    bad += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log(`\n注册了 ${tools.size} 个工具`)

const required = [
  'mc_status', 'mc_connect', 'mc_move', 'mc_control', 'mc_mine', 'mc_place', 'mc_use',
  'mc_inventory', 'mc_craft', 'mc_container', 'mc_build', 'mc_memory', 'mc_command', 'mc_reflex', 'mc_goal',
]
for (const name of required) expect(`有 ${name}`, tools.has(name))

for (const [name, def] of tools) {
  expect(`${name} 有说明`, typeof def.description === 'string' && def.description.length > 20)
  expect(`${name} 参数是对象 schema`, def.parameters?.type === 'object' && typeof def.parameters.properties === 'object')
  expect(`${name} 有输出 schema`, def.output?.schema?.type === 'object' && typeof def.output.render === 'function')
  let jsonOk = true
  try {
    JSON.stringify(def.parameters)
    JSON.stringify(def.output.schema)
  } catch {
    jsonOk = false
  }
  expect(`${name} schema 能序列化`, jsonOk)
}

const run = async () => {
  console.log('\n离线时的表现')
  const status = await tools.get('mc_status').execute({}, { signal: new AbortController().signal })
  expect('mc_status 离线也能回话', status.ok === true && status.evidence.online === false)
  expect('mc_status 给提示', typeof status.hint === 'string' && status.hint.length > 0)

  const mine = await tools.get('mc_mine').execute({ block: 'stone', count: 1 }, { signal: new AbortController().signal })
  expect('没上线就挖矿 → 明确说没连上', mine.ok === false && /还没连上/.test(mine.summary), mine.summary)

  const reflex = await tools.get('mc_reflex').execute({}, { signal: new AbortController().signal })
  expect('mc_reflex 能读阈值', reflex.evidence.settings?.creeperRange === 4)

  const memory = await tools.get('mc_memory').execute({ action: 'get' }, { signal: new AbortController().signal })
  expect('mc_memory 能读', memory.ok === true)

  const connect = await tools.get('mc_connect').execute({ action: 'status' }, { signal: new AbortController().signal })
  expect('mc_connect status 不连也能用', connect.evidence.state === 'offline')

  const rendered = tools.get('mc_status').output.render({}, status)
  expect('渲染出文本块', Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0].text.length > 10)

  for (const dispose of disposers) dispose()
  expect('卸载后工具清空了', tools.size === 0)

  console.log('')
  if (bad) {
    console.log(`✗ ${bad} 条没过`)
    process.exitCode = 1
  } else {
    console.log('✓ 冒烟通过')
  }
}

run().catch((error) => {
  console.error('冒烟自己崩了：', error)
  process.exitCode = 1
})
