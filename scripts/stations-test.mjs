#!/usr/bin/env node
/**
 * 功能方块测试：附魔台、铁砧、村民交易。
 *
 * 需要：26.2 服务端 + op（脚本要用 /give /xp /setblock /summon）。
 * 跑法：node scripts/stations-test.mjs [host] [port] [version] [user]
 *
 * 验的是"放进去 → 服务端算出结果 → 拿回来"这条链：
 *   1. 附魔台：给剑附魔，读回附魔列表；
 *   2. 铁砧：改名，读回 customName；
 *   3. 村民：列出交易并换一次，读回背包变化。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { enchantAt, anvilUse, tradeWith } from '../lib/stations.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'stations.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(18)} ${detail}`)
}

const session = new Session({ config: { connection: { host, port, username: user, version } }, log: () => {} })
const say = async (cmd) => {
  session.bot.chat(cmd)
  await sleep(260)
}
const count = (name) => session.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)

async function main() {
  await session.connect()
  await sleep(1000)
  const b = session.bot
  const p = b.entity.position.floored()
  rec('connect', session.isOnline, `${b.version} @ ${p}`)

  // 环境：附魔台 + 铁砧 + 经验 + 材料
  await say(`/setblock ${p.x + 2} ${p.y} ${p.z} enchanting_table`)
  await say(`/setblock ${p.x + 4} ${p.y} ${p.z} anvil`)
  await say('/xp add @s 30 levels')
  await say('/give @s diamond_sword 1')
  await say('/give @s lapis_lazuli 16')
  await say('/give @s wheat 64')
  await sleep(500)
  rec('env', true, `附魔台 (${p.x + 2},${p.y},${p.z})、铁砧 (${p.x + 4},${p.y},${p.z})、30 级、剑/青金石/小麦`)

  // 1) 附魔
  try {
    const e = await enchantAt(session, { x: p.x + 2, y: p.y, z: p.z, item: 'diamond_sword' })
    rec('enchant', e.ok && e.verified, e.summary, { before: e.evidence?.before, after: e.evidence?.after, level: e.evidence?.level })
  } catch (err) {
    rec('enchant', false, `抛错：${err.message}`)
  }
  await sleep(500)

  // 2) 铁砧改名
  try {
    const a = await anvilUse(session, { x: p.x + 4, y: p.y, z: p.z, item: 'diamond_sword', name: '小鱼' })
    rec('anvil-rename', a.ok && (a.evidence?.output?.customName === '小鱼' || a.verified), a.summary, a.evidence)
  } catch (err) {
    rec('anvil-rename', false, `抛错：${err.message}`)
  }
  await sleep(500)

  // 3) 村民交易
  try {
    await say(`/summon villager ${p.x + 2} ${p.y} ${p.z} {VillagerData:{profession:"minecraft:farmer",level:1}}`)
    await sleep(1500)
    const vills = Object.values(b.entities || {}).filter((e) => e.name === 'villager')
    rec('villager-summon', vills.length > 0, `附近村民 ${vills.length} 个：${vills.map((e) => e.position.distanceTo(b.entity.position).toFixed(1)).join(',')}`)
    const list = await tradeWith(session, { listOnly: true })
    rec('trade-list', list.ok && (list.evidence?.trades?.length ?? 0) > 0, `交易 ${list.evidence?.trades?.length ?? 0} 项：${JSON.stringify((list.evidence?.trades ?? []).slice(0, 2))}`)
    const wheatTrade = (list.evidence?.trades ?? []).find((t) => t.inputs.some((i) => i.name === 'wheat'))
    if (wheatTrade) {
      const before = count(wheatTrade.output.name)
      const r = await tradeWith(session, { tradeIndex: wheatTrade.index, count: 1 })
      rec('trade-do', r.verified, r.summary, { before, after: count(wheatTrade.output.name), trade: wheatTrade })
    } else {
      rec('trade-do', false, '村民没有收小麦的交易，跳过')
    }
  } catch (err) {
    rec('trade', false, `抛错：${err.message}`)
  }

  const passed = results.filter((r) => r.ok).length
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ target: `${host}:${port}`, version: b.version, total: results.length, passed, checks: results }, null, 2))
  console.log(`\n${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length} · 报告 ${OUT}`)
  if (passed !== results.length) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('测试崩了：', e?.stack || e)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      await session.disconnect('stations test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
