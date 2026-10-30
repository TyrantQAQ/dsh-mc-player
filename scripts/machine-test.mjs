#!/usr/bin/env node
/**
 * 挂机测试：搭一个刷石机，让它守着出料口挖。
 *
 * 需要：26.2 服务端 + op（搭机器用 /fill /setblock）。
 * 跑法：node scripts/machine-test.mjs [host] [port] [version] [user]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { MachineWatcher } from '../lib/machine.js'
import { move } from '../lib/actions.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'machine.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(16)} ${detail}`)
}

const session = new Session({ config: { connection: { host, port, username: user, version } }, log: () => {} })
const say = async (cmd) => {
  session.bot.chat(cmd)
  await sleep(300)
}
const blockAt = (x, y, z) => session.bot.blockAt(new (session.bot.entity.position.constructor)(x, y, z))

async function main() {
  await session.connect()
  await sleep(800)
  const b = session.bot
  const p = b.entity.position.floored()
  const target = { x: p.x + 3, y: p.y, z: p.z }

  // 模拟刷石机：出料口那格反复长圆石（真机器由玩家自己搭，这里只验"一出现就挖"的循环）
  await say(`/setblock ${target.x} ${target.y - 1} ${target.z} stone`)
  await say(`/setblock ${target.x} ${target.y} ${target.z} cobblestone`)
  await sleep(600)
  rec('target-block', blockAt(target.x, target.y, target.z)?.name === 'cobblestone', `出料口放了 ${blockAt(target.x, target.y, target.z)?.name}`, { target })

  await say('/give @s iron_pickaxe 1')
  await sleep(400)
  const cobbleBefore = b.inventory.items().filter((i) => i.name === 'cobblestone').reduce((s2, i) => s2 + i.count, 0)
  const m = new MachineWatcher({ session, config: { intervalMs: 600 }, log: () => {} })
  session.machine = m
  m.start({ target, mode: 'mine', maxMinutes: 2 })

  // 25 秒里每隔 3 秒"重新出料"，看它是不是每次都挖
  for (let i = 0; i < 8; i += 1) {
    await sleep(3000)
    const st = m.status()
    if (st.mined > i) await say(`/setblock ${target.x} ${target.y} ${target.z} cobblestone`)
  }
  const st = m.status()
  const cobbleAfter = b.inventory.items().filter((i) => i.name === 'cobblestone').reduce((s2, i) => s2 + i.count, 0)
  m.stop()
  rec('mine-loop', st.mined >= 3, `反复出料 8 次，它挖了 ${st.mined} 个；圆石 ${cobbleBefore} → ${cobbleAfter}`, { status: st, cobbleBefore, cobbleAfter })
  rec('pickup', cobbleAfter > cobbleBefore, `背包圆石 +${cobbleAfter - cobbleBefore}`)

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
      await session.disconnect('machine test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
