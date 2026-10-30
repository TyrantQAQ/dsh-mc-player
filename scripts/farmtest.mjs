#!/usr/bin/env node
/**
 * 种地 + 钓鱼测试。
 *
 * 需要：26.2 服务端 + op（/give /setblock /fill）。
 * 跑法：node scripts/farmtest.mjs [host] [port] [version] [user]
 *
 * 验：锄地 → 下种 → 收成熟作物（含补种），以及钓一次鱼。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { farm } from '../lib/farming.js'
import { fishAt } from '../lib/fishing.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'farm.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(16)} ${detail}`)
}

const session = new Session({ config: { connection: { host, port, username: user, version } }, log: () => {} })
const say = async (cmd) => {
  session.bot.chat(cmd)
  await sleep(250)
}
const count = (name) => session.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)
const blockAt = (x, y, z) => session.bot.blockAt(new (session.bot.entity.position.constructor)(x, y, z))

async function main() {
  await session.connect()
  await sleep(1000)
  const b = session.bot
  const p = b.entity.position.floored()
  rec('connect', session.isOnline, `${b.version} @ ${p}`)

  const fx = p.x + 2
  const fy = p.y - 1
  const fz = p.z
  await say(`/setblock ${fx} ${fy} ${fz} dirt`)
  await say('/give @s iron_hoe 1')
  await say('/give @s wheat_seeds 16')
  await sleep(500)

  try {
    const t = await farm(session, { action: 'till', x: fx, y: fy, z: fz })
    rec('till', t.verified && blockAt(fx, fy, fz)?.name === 'farmland', t.summary)
  } catch (e) {
    rec('till', false, `抛错：${e.message}`)
  }
  try {
    const pl = await farm(session, { action: 'plant', x: fx, y: fy, z: fz, crop: 'wheat' })
    rec('plant', pl.verified && blockAt(fx, fy + 1, fz)?.name === 'wheat', pl.summary)
  } catch (e) {
    rec('plant', false, `抛错：${e.message}`)
  }

  // 催熟：直接把作物方块换成 age=7
  await say(`/setblock ${fx} ${fy + 1} ${fz} wheat[age=7]`)
  await sleep(300)
  try {
    const before = count('wheat')
    const h = await farm(session, { action: 'harvest', radius: 8 })
    const after = count('wheat')
    rec('harvest', h.verified && after > before, h.summary, { before, after, evidence: h.evidence })
  } catch (e) {
    rec('harvest', false, `抛错：${e.message}`)
  }

  // 钓鱼：造一个水池
  const wx = p.x + 5
  const wz = p.z
  await say(`/fill ${wx - 2} ${p.y} ${wz - 2} ${wx + 2} ${p.y} ${wz + 2} water`)
  await say(`/fill ${wx - 2} ${p.y - 1} ${wz - 2} ${wx + 2} ${p.y - 1} ${wz + 2} stone`)
  await say('/give @s fishing_rod 1')
  await sleep(400)
  try {
    const f = await fishAt(session, { count: 1, maxMs: 45000 })
    rec('fish', f.ok && f.verified, f.summary, f.evidence)
  } catch (e) {
    rec('fish', false, `抛错：${e.message}`)
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
      await session.disconnect('farm test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
