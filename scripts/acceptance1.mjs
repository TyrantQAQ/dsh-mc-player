#!/usr/bin/env node
/**
 * 一期验收：在生存模式里"从零活过一晚，并且挖到 20 块石头（背包里真有）"。
 *
 * 流程：
 *   1. 砍 3 块木头 → 木板 → 工作台 → 木棍 → 木镐
 *   2. 往下挖，直到背包里有 20 块圆石（deepslate 也算）
 *   3. 夜里：先在一个 1×2 的密封石室里待 2 分钟（模拟"躲起来过夜"；石室是用
 *      /fill 做出来的，只测"活下来"，盖房子的能力在 placelab/build 里测），
 *      再到空地上站 40 秒（不给掩体，看反射层和血量）
 *   4. 天亮，检查还活着、背包、死亡事件
 *
 * 用法：
 *   node scripts/acceptance1.mjs [host] [port] [version] [user]
 * 需要：26.2 生存服、difficulty=normal、该用户是 op（脚本要 /tp /fill /time /difficulty）
 *
 * 结果写到 report/acceptance1.json（不动数据，只写报告）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import * as actions from '../lib/actions.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'acceptance1.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const startedAt = Date.now()
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(22)} ${detail}`)
}

const session = new Session({
  config: { connection: { host, port, username: user, version } },
  log: (...a) => console.log('[session]', ...a),
})

const bot = () => session.bot
const count = (names) => {
  try {
    return bot().inventory.items().filter((i) => names.includes(i.name)).reduce((s, i) => s + i.count, 0)
  } catch {
    return 0
  }
}
const say = (cmd) => {
  bot().chat(cmd)
  return sleep(250)
}
const blockAt = (x, y, z) => bot().blockAt(new (bot().entity.position.constructor)(x, y, z))

async function main() {
  await session.connect()
  await sleep(1200)
  const b = bot()
  const spawn = b.entity.position.floored()
  rec('spawn', true, `${b.game.gameMode} @ ${spawn.x} ${spawn.y} ${spawn.z} (${b.version})`)
  rec('mode-survival', b.game.gameMode === 'survival', b.game.gameMode)

  // ---- 1. 木头 ----
  // 世界是随机刷的，可能脚边一棵树都没有、或者长在够不着的崖下面。
  // 为了验收可重复：先铺一块 7×7 的平台，种 3 棵橡树。这是"环境准备"，不是插件能力。
  const LOG_NAMES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']
  const logCount = () => count(LOG_NAMES)
  {
    const px = spawn.x
    const py = spawn.y
    const pz = spawn.z
    await say(`/fill ${px - 3} ${py - 1} ${pz - 3} ${px + 3} ${py - 1} ${pz + 3} stone`)
    await say(`/fill ${px - 2} ${py} ${pz - 2} ${px + 2} ${py + 3} ${pz + 2} air`)
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2]]) {
      for (let k = 0; k < 4; k += 1) await say(`/setblock ${px + dx} ${py + k} ${pz + dz} oak_log`)
    }
    rec('env-plant-trees', true, `铺了 7×7 平台并种了 3 棵橡树（环境准备）`)
  }
  const logIds = Object.values(b.registry.blocksByName)
    .filter((x) => x && /(_log|_stem)$/.test(x.name) && !/crimson|warped/.test(x.name))
    .map((x) => x.id)
  let logs = 0
  let wood = null
  let lastLog = null
  const tried = new Set()
  for (let round = 0; round < 12 && logs < 3; round += 1) {
    const found = []
    for (const id of logIds) {
      const f = b.findBlock({ matching: id, maxDistance: 48 })
      if (f) found.push(f)
    }
    found.sort((a, c) => a.position.distanceTo(b.entity.position) - c.position.distanceTo(b.entity.position))
    const blk = found.find((f) => !tried.has(`${f.position.x},${f.position.y},${f.position.z}`))
    if (!blk) {
      await sleep(400)
      continue
    }
    tried.add(`${blk.position.x},${blk.position.y},${blk.position.z}`)
    if (blk.position.distanceTo(b.entity.position) > 5.1) {
      await actions.move(session, { x: blk.position.x, y: blk.position.y, z: blk.position.z, range: 2, timeoutMs: 20000 }).catch(() => {})
    }
    if (blk.position.distanceTo(b.entity.position) > 5.1) continue
    const r = await actions.mine(session, { x: blk.position.x, y: blk.position.y, z: blk.position.z })
    if (r.ok) lastLog = blk.name
    await sleep(350)
    logs = logCount()
    if (logs > 0 && !wood) wood = (lastLog ?? 'oak_log').replace(/_log$/, '')
  }
  rec('mine-wood', logs >= 3, `${logs} 块${wood ?? '?'}木头`)
  if (logs < 3) throw new Error('砍不到 3 块木头，没办法做工具')

  // ---- 2. 木板 / 工作台 / 木棍 / 木镐 ----
  const planks = await actions.craft(session, { item: `${wood}_planks`, count: 3 })
  rec('craft-planks', planks.verified, planks.summary)
  const table = await actions.craft(session, { item: 'crafting_table', count: 1 })
  rec('craft-table', table.verified, table.summary)

  // 把工作台放在脚边（找一格空气、下面有支撑）
  const p = b.entity.position.floored()
  let tableSpot = null
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
    const here = blockAt(p.x + dx, p.y, p.z + dz)
    const under = blockAt(p.x + dx, p.y - 1, p.z + dz)
    if (here?.boundingBox === 'empty' && under?.boundingBox === 'block') {
      tableSpot = { x: p.x + dx, y: p.y, z: p.z + dz }
      break
    }
  }
  if (tableSpot) {
    const placed = await actions.place(session, { ...tableSpot, block: 'crafting_table' })
    rec('place-table', placed.verified, placed.summary)
  } else {
    rec('place-table', false, '脚边没有能放工作台的空地')
  }

  const sticks = await actions.craft(session, { item: 'stick', count: 1 })
  rec('craft-sticks', sticks.verified, sticks.summary)
  const pick = await actions.craft(session, { item: 'wooden_pickaxe', count: 1 })
  rec('craft-pickaxe', pick.verified, pick.summary)

  // ---- 3. 往下挖 20 块石头 ----
  let stone = count(['cobblestone', 'cobbled_deepslate'])
  let digs = 0
  const stoneNames = new Set(['stone', 'deepslate', 'cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'coal_ore', 'iron_ore', 'copper_ore'])
  const surface = { ...b.entity.position }
  while (stone < 20 && digs < 60) {
    const q = b.entity.position
    if (b.health <= 6) {
      rec('health-low', false, `挖到一半血只剩 ${b.health}，停了`)
      break
    }
    const target = { x: Math.floor(q.x), y: Math.floor(q.y) - 1, z: Math.floor(q.z) }
    const under = blockAt(target.x, target.y, target.z)
    if (!under || ['bedrock', 'lava', 'water', 'flowing_lava'].includes(under.name)) {
      rec('dig-stop', false, `脚下方块是 ${under?.name ?? '未知'}，再挖不安全`)
      break
    }
    const r = await actions.mine(session, target)
    if (!r.ok) {
      await sleep(400)
      continue
    }
    digs++
    await sleep(280) // 等掉落物进背包
    if (stoneNames.has(under.name)) {
      const now = count(['cobblestone', 'cobbled_deepslate'])
      if (now > stone) stone = now
    }
  }
  rec('mine-stone', stone >= 20, `背包里圆石 ${stone} 块（挖了 ${digs} 格，最深到 y=${Math.floor(b.entity.position.y)}）`, { stone, digs })
  rec('pickaxe-used', (b.inventory.items().find((i) => i.name === 'wooden_pickaxe')?.durabilityUsed ?? 0) > 0, `木镐耐久已用 ${b.inventory.items().find((i) => i.name === 'wooden_pickaxe')?.durabilityUsed ?? 0}`)

  // ---- 4. 过一夜 ----
  const sx = spawn.x
  const sy = spawn.y
  const sz = spawn.z
  await say(`/tp ${sx + 0.5} ${sy} ${sz + 0.5}`)
  await sleep(400)
  // 3×3×3 石头壳，里面掏一个 1×2 的洞
  await say(`/fill ${sx - 1} ${sy} ${sz - 1} ${sx + 1} ${sy + 2} ${sz + 1} stone`)
  await say(`/fill ${sx} ${sy} ${sz} ${sx} ${sy + 1} ${sz} air`)
  await say(`/tp ${sx + 0.5} ${sy} ${sz + 0.5}`)
  await say('/difficulty normal')
  await say('/time set 13000')
  rec('night-start', true, `时间设到夜里，躲进密封石室 (${sx}, ${sy}, ${sz})`)

  let minHealth = b.health
  let died = false
  b.once('death', () => { died = true })
  const nightStart = Date.now()
  while (Date.now() - nightStart < 120000) {
    await sleep(20000)
    if (b.health < minHealth) minHealth = b.health
    if (b.health <= 0 || died) break
  }
  rec('night-shelter', !died && b.health > 0, `密封石室里待了 ${Math.round((Date.now() - nightStart) / 1000)}s，血量最低 ${minHealth}，现在 ${b.health}`)

  // 空地站 40 秒（不给掩体）
  await say(`/fill ${sx + 5} ${sy - 1} ${sz} ${sx + 9} ${sy - 1} ${sz + 4} stone`)
  await say(`/tp ${sx + 7.5} ${sy} ${sz + 2.5}`)
  const openStart = Date.now()
  let openMin = b.health
  while (Date.now() - openStart < 40000) {
    await sleep(10000)
    if (b.health < openMin) openMin = b.health
    if (b.health <= 0 || died) break
  }
  rec('night-open', !died && b.health > 0, `空地上 ${Math.round((Date.now() - openStart) / 1000)}s，血量最低 ${openMin}，现在 ${b.health}`)

  await say('/time set day')
  await sleep(500)
  rec('alive-morning', !died && b.health > 0, `血 ${b.health}，饱食度 ${b.food}，背包 ${b.inventory.items().length} 种`)

  const passed = results.filter((r) => r.ok).length
  const summary = {
    target: `${host}:${port}`,
    version: b.version,
    elapsedMs: Date.now() - startedAt,
    total: results.length,
    passed,
    failed: results.length - passed,
    checks: results,
    inventory: b.inventory.items().map((i) => ({ name: i.name, count: i.count })),
    note: '过夜用的石室由 /fill 搭建；建造能力由 placelab / mc_build 单独验证',
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2))
  console.log(`\n${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length} · 报告 ${OUT}`)
  if (passed !== results.length) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('验收崩了：', e?.stack || e)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await session.disconnect('acceptance done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 600)
  })
