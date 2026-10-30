#!/usr/bin/env node
/**
 * 地图记忆测试：走过一段路，再沿着走过的路回去。
 *
 * 需要：26.2 服务端（平地方便直线走）。
 * 跑法：node scripts/maptest.mjs [host] [port] [version] [user]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { MapMemory } from '../lib/mapmemory.js'
import { move } from '../lib/actions.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'map.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(14)} ${detail}`)
}

const session = new Session({ config: { connection: { host, port, username: user, version } }, log: () => {} })

async function main() {
  await session.connect()
  await sleep(800)
  const b = session.bot
  const map = new MapMemory({ session, config: { enabled: true, sampleMs: 700, minStep: 1.5 }, log: () => {} })
  session.map = map
  map.start()

  const A = b.entity.position.floored()
  rec('connect', session.isOnline, `${b.version} @ ${A}`)

  const walk = await move(session, { x: A.x + 16, y: A.y + 1, z: A.z, range: 2, timeoutMs: 60000 })
  await sleep(600)
  const B = b.entity.position.floored()
  rec('record-trail', map.trail.length >= 3, `走了 ${Math.round(B.x - A.x)} 格，记下 ${map.trail.length} 个点`, { A, B, points: map.trail.length })

  const back = await map.walkTo({ x: A.x, y: A.y, z: A.z }, { range: 2, timeoutMs: 60000 })
  rec('route-home', back.ok && back.usedTrail, `沿轨迹回去：${back.walked} 个点，离起点 ${back.distance} 格`, back)

  const dist = Number(b.entity.position.distanceTo(A).toFixed(2))
  rec('arrived', dist <= 3.5, `最后离 A 点 ${dist} 格`, { dist })

  map.stop()
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
      await session.disconnect('map test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
