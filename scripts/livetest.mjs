#!/usr/bin/env node
/**
 * 端到端联调：真的连一个服务器，走、挖、放、看状态。
 *
 * ⚠️ 会真的动那个服里的方块。只能对着自己的测试服跑：
 *   node scripts/livetest.mjs 127.0.0.1 25565 1.16.5
 *
 * 第一个参数是地址，第二个端口，第三个协议版本（可省）。
 */

import { apply } from '../lib/index.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || ''

const tools = new Map()
const disposers = []
const ctx = {
  tools: { register: (def) => (tools.set(def.name, def), () => tools.delete(def.name)) },
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return dispose
  },
  inject() {},
}

apply(ctx, { autoConnect: false, connection: { host, port, username: '小鲸鱼', auth: 'offline', version } })

const sig = () => ({ signal: new AbortController().signal })
const call = (name, args = {}) => tools.get(name).execute(args, sig())
const jsonOk = (value) => {
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

let bad = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  ✓ ${name}`)
  else {
    bad += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const main = async () => {
  console.log(`\n连 ${host}:${port}${version ? ` (${version})` : ''}`)
  const started = Date.now()
  const connect = await call('mc_connect', version ? { version } : {})
  check('连上了', connect.ok === true, connect.summary)
  if (!connect.ok) throw new Error(connect.summary)
  console.log(`  连接耗时 ${Date.now() - started}ms`)

  const status = await call('mc_status')
  check('mc_status 是纯 JSON', jsonOk(status), 'JSON 序列化失败')
  check('世界信息齐了', Boolean(status.evidence.world?.dimension) && typeof status.evidence.self?.health === 'number')
  const start = status.evidence.self.position
  console.log(`  出生点 ${start.x} ${start.y} ${start.z}，脚下 ${status.evidence.world.feetBlock?.name}`)

  const target = { x: Math.round(start.x) + 4, y: Math.round(start.y), z: Math.round(start.z) + 4 }
  const move = await call('mc_move', target)
  check('走过去并回读了距离', move.verified === true, move.summary)

  const control = await call('mc_control', { keys: ['forward'], durationMs: 400 })
  check('按住前进真的动了', control.evidence?.moved > 0.05, control.summary)

  // 草方块（1.16 不掉草方块、掉土），挖表面的，掉落物才捡得到
  const mine = await call('mc_mine', { block: 'grass_block', count: 4, maxDistance: 16 })
  check('挖了 4 块草方块', mine.evidence?.dugCount === 4, mine.summary)
  check('挖出来的东西进了背包', (mine.evidence?.invDelta ?? 0) >= 4, JSON.stringify(mine.evidence?.dug?.map((d) => d.picked)))
  if (mine.evidence?.dugCount !== 3) console.log('    挖掘证据：', JSON.stringify(mine.evidence, null, 2).slice(0, 2000))

  const afterMine = await call('mc_inventory', { action: 'list' })
  const dirt = afterMine.evidence.items.filter((i) => i.name === 'dirt').reduce((s, i) => s + i.count, 0)
  check('背包里真有土', dirt >= 4, `dirt=${dirt}`)

  // 挪到没被挖过的新地方再放/盖，免得撞上自己挖出来的坑
  const settleMove = await call('mc_move', { x: Math.round(start.x) + 10, y: Math.round(start.y), z: Math.round(start.z) + 10 })
  check('走到新地方（没乱垫方块）', settleMove.evidence?.blocksUsed === 0, `blocksUsed=${settleMove.evidence?.blocksUsed}`)
  const here = (await call('mc_status')).evidence.self.position
  const ground = Math.round(here.y)

  console.log(`  站在 ${here.x.toFixed(2)} ${here.y.toFixed(2)} ${here.z.toFixed(2)}，准备放在 ${Math.round(here.x) + 1} ${ground} ${Math.round(here.z)}`)
  const place = await call('mc_place', { x: Math.round(here.x) + 1, y: ground, z: Math.round(here.z), block: 'dirt' })
  check('放了一块土并回读了方块', place.verified === true, place.summary)
  if (!place.verified) console.log('    放置证据：', JSON.stringify(place.evidence))
  console.log('  放完背包：', JSON.stringify((await call('mc_inventory', { action: 'list' })).evidence.items))

  // 图纸施工：在手边摆两格土，走完算料→放置→验收
  const blueprint = {
    name: 'livetest 两格墙',
    origin: { x: Math.round(here.x) + 3, y: ground, z: Math.round(here.z) },
    ops: [{ op: 'fill', from: [0, 0, 0], to: [0, 0, 1], block: 'dirt' }],
  }
  // 垫柱子：跳起来往脚下放（服务器会拒绝"站着放自己脚下"）
  const tower = await call('mc_place', { block: 'dirt', tower: 1 })
  check('垫了一格柱子', tower.verified === true, tower.summary)
  console.log('  垫完背包：', JSON.stringify((await call('mc_inventory', { action: 'list' })).evidence.items), JSON.stringify(tower.evidence))

  const bagBeforeBuild = await call('mc_inventory', { action: 'list' })
  console.log('  盖之前的背包：', JSON.stringify(bagBeforeBuild.evidence.items))
  const buildResult = await call('mc_build', { blueprint })
  check('图纸施工并逐格验收', buildResult.verified === true, buildResult.summary)

  const craftFail = await call('mc_craft', { item: 'diamond_pickaxe', count: 1 })
  check('材料不够时合成会说清楚', craftFail.ok === false && /合不了|材料不够|材料|工作台/.test(craftFail.summary), craftFail.summary)

  const sleepFail = await call('mc_use', { action: 'sleep' })
  check('白天睡觉会被拦下（不崩）', sleepFail.ok === false && /白天|床/.test(sleepFail.summary), sleepFail.summary)

  const status2 = await call('mc_status')
  check('事件还在往回带', Array.isArray(status2.evidence.events))

  const reflex = await call('mc_reflex')
  check('反射层在线（有世界快照）', Boolean(reflex.evidence.lastWorld), JSON.stringify(reflex.evidence.lastWorld))

  const disconnect = await call('mc_connect', { action: 'disconnect' })
  check('下线了', disconnect.ok === true, disconnect.summary)

  for (const dispose of disposers) dispose()
  console.log('')
  if (bad) {
    console.log(`✗ ${bad} 条没过`)
    process.exitCode = 1
  } else {
    console.log('✓ 端到端通过')
  }
}

main().catch((error) => {
  console.error('联调崩了：', error)
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }
  process.exitCode = 1
})
