#!/usr/bin/env node
/**
 * 酿造台 + 驯养测试。
 *
 * 需要：26.2 服务端 + op（/give /setblock /summon）。
 * 跑法：node scripts/brewtest.mjs [host] [port] [version] [user]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { brew, isWaterBottle, potionId } from '../lib/brewing.js'
import { tame } from '../lib/taming.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'brew.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(14)} ${detail}`)
}

const session = new Session({ config: { connection: { host, port, username: user, version } }, log: () => {} })
const say = async (cmd) => {
  session.bot.chat(cmd)
  await sleep(260)
}

async function main() {
  await session.connect()
  await sleep(1000)
  const b = session.bot
  const p = b.entity.position.floored()
  rec('connect', session.isOnline, `${b.version} @ ${p}`)

  await say(`/setblock ${p.x + 2} ${p.y} ${p.z} brewing_stand`)
  await say('/give @s potion[potion_contents={potion:"minecraft:water"}] 3')
  await say('/give @s nether_wart 1')
  await say('/give @s blaze_powder 1')
  await sleep(600)
  const waterBottles = b.inventory.items().filter((i) => isWaterBottle(i))
  rec('env-brew', waterBottles.length >= 1, `水瓶 ${waterBottles.length} 瓶（用 /give potion[potion_contents=...]）`)
  if (waterBottles.length) {
    try {
      const r = await brew(session, { x: p.x + 2, y: p.y, z: p.z, ingredient: 'nether_wart', timeoutMs: 40000 })
      const brewed = (r.evidence?.brewed ?? []).filter((x) => x && !/water/.test(x))
      rec('brew', r.ok && r.verified && brewed.length > 0, r.summary, { before: r.evidence?.before, after: r.evidence?.afterInWindow, inventory: r.evidence?.inventoryPotions })
    } catch (e) {
      rec('brew', false, `抛错：${e.message}`)
    }
  }

  // 驯养：召一只狼，喂骨头
  await say(`/summon wolf ${p.x + 3} ${p.y} ${p.z}`)
  await say('/give @s bone 16')
  await sleep(1200)
  try {
    const t = await tame(session, {})
    rec('tame', t.ok && t.verified, t.summary, t.evidence)
  } catch (e) {
    rec('tame', false, `抛错：${e.message}`)
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
      await session.disconnect('brew test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
