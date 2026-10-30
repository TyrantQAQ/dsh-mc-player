#!/usr/bin/env node
/**
 * 记机器测试：站到"机器"旁边看着它，mc_mark 记下来，再让 mc_afk 去挂。
 *
 * 需要：26.2 服务端 + op（摆测试方块用）。
 * 跑法：node scripts/marktest.mjs [host] [port] [version] [user]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { registerTools } from '../lib/tools.js'
import { MachineWatcher } from '../lib/machine.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'mark.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(16)} ${detail}`)
}

const session = new Session({ config: { connection: { host, port, username: user, version } }, log: () => {} })
const tools = new Map()
const ctx = {
  tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name) } },
  effect(fn) { return fn() },
}
registerTools(ctx, { session, log: () => {}, config: {}, autopilot: null })

async function main() {
  await session.connect()
  await sleep(600)
  const b = session.bot
  const p = b.entity.position.floored()
  const V = p.constructor
  // 摆一台"机器"：一块圆石 + 一个漏斗
  b.chat(`/setblock ${p.x + 2} ${p.y} ${p.z} cobblestone`)
  b.chat(`/setblock ${p.x + 2} ${p.y - 1} ${p.z} hopper`)
  b.chat('/give @s iron_pickaxe 1')
  await sleep(700)
  rec('connect', session.isOnline, `${b.version} @ ${p}`)

  // 看着出料口，记下来
  await b.lookAt(new V(p.x + 2.5, p.y + 0.5, p.z + 0.5), true)
  await sleep(200)
  const cursor = b.blockAtCursor(5)
  const mark = await tools.get('mc_mark').execute({ name: '刷石机', kind: 'cobble_gen' })
  const place = session.memory.getPlace('刷石机')
  rec('mark', Boolean(mark.ok) && place?.kind === 'cobble_gen' && place?.mode === 'mine', mark.summary, { place, cursor: cursor?.name })
  rec('anchor', Boolean(place?.target && place?.standAt), `出料口 ${JSON.stringify(place?.target)}，站位 ${JSON.stringify(place?.standAt)}`)
  rec('nearby', (place?.nearby ?? []).some((n) => n.name === 'hopper'), `附近认到 ${(place?.nearby ?? []).map((n) => `${n.name}×${n.count}`).join('、')}`)

  // 让它去挂
  session.machine = new MachineWatcher({ session, config: { intervalMs: 600 }, log: () => {} })
  const start = await tools.get('mc_afk').execute({ action: 'start', place: '刷石机', maxMinutes: 1 })
  await sleep(4000)
  const st = await tools.get('mc_afk').execute({ action: 'status' })
  const stop = await tools.get('mc_afk').execute({ action: 'stop' })
  rec('afk', Boolean(start.ok) && (st.evidence?.status?.mined ?? 0) >= 1, `挂机挖了 ${st.evidence?.status?.mined ?? 0} 个；${stop.summary}`)

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
      await session.disconnect('mark test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
