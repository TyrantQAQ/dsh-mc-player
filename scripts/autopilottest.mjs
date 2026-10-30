#!/usr/bin/env node
/**
 * 自主目标（autopilot）的端到端测试。
 *
 * 需要：26.2 生存服 + op（脚本要用 /fill /setblock /tp）。
 * 跑法：node scripts/autopilottest.mjs [host] [port] [version] [user]
 *
 * 验三件事：
 *   1. 给一个 gather 计划，它自己把木头砍够、记账、把计划标成 done；
 *   2. manual 步骤会让它暂停等大脑；
 *   3. 做不成的步骤连续失败 3 次后 blocked，而不是无限重试。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { Autopilot, DEFAULT_AUTOPILOT } from '../lib/autopilot.js'
import { createPlan } from '../lib/goals.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'autopilot.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail) => {
  results.push({ id, ok: Boolean(ok), detail })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(20)} ${detail}`)
}

const session = new Session({ config: { connection: { host, port, username: user, version } }, log: () => {} })
const autopilot = new Autopilot({ session, config: { ...DEFAULT_AUTOPILOT, intervalMs: 1000, cooldownMs: 150, minHealth: 6 }, log: () => {} })
session.planProvider = () => autopilot.summary()
session.autopilotProvider = () => autopilot.status()

const count = (name) => session.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)
const say = async (cmd) => {
  session.bot.chat(cmd)
  await sleep(220)
}

async function waitFor(fn, timeoutMs, step = 400) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await sleep(step)
  }
  return false
}

async function main() {
  await session.connect()
  await sleep(1000)
  const b = session.bot
  rec('connect', session.isOnline, `${b.version} @ ${b.entity.position.floored()}`)

  // 环境准备：铺平台、种树
  const p = b.entity.position.floored()
  await say(`/fill ${p.x - 3} ${p.y - 1} ${p.z - 3} ${p.x + 3} ${p.y - 1} ${p.z + 3} stone`)
  await say(`/fill ${p.x - 2} ${p.y} ${p.z - 2} ${p.x + 2} ${p.y + 3} ${p.z + 2} air`)
  for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2]]) {
    for (let k = 0; k < 4; k += 1) await say(`/setblock ${p.x + dx} ${p.y + k} ${p.z + dz} oak_log`)
  }
  rec('env', true, `平台 + 3 棵橡树 @ ${p.x} ${p.y} ${p.z}`)

  autopilot.start()

  // 1) gather 计划
  autopilot.setPlan(createPlan({ text: '砍 5 块木头', steps: [{ kind: 'gather', block: 'oak_log', count: 5 }] }))
  const done = await waitFor(() => autopilot.plan?.status === 'done', 120000)
  const logs = count('oak_log')
  rec('gather-done', done && logs >= 5, `计划状态=${autopilot.plan?.status}，背包木头=${logs}，日志=${JSON.stringify(autopilot.plan?.log?.slice(-2))}`)

  // 2) manual 暂停
  autopilot.setPlan(createPlan({ text: '需要人决定', steps: [{ kind: 'manual', text: '要不要下矿？' }] }))
  const paused = await waitFor(() => autopilot.plan?.status === 'paused', 15000)
  rec('manual-pause', paused, `计划状态=${autopilot.plan?.status}，note=${autopilot.plan?.note}`)

  // 3) 做不成 → blocked
  autopilot.setPlan(createPlan({ text: '挖基岩（挖不动）', steps: [{ kind: 'gather', block: 'bedrock', count: 1 }] }))
  const blocked = await waitFor(() => autopilot.plan?.status === 'blocked', 30000)
  const failedStep = autopilot.plan?.steps?.[0]
  rec('blocked-after-retries', blocked && failedStep?.attempts >= 3, `计划状态=${autopilot.plan?.status}，尝试=${failedStep?.attempts}，note=${autopilot.plan?.note}`)

  // 4) resume 之后能重试
  autopilot.resume()
  rec('resume', autopilot.plan?.status === 'active' && failedStep?.status === 'pending', `恢复后状态=${autopilot.plan?.status}`)

  autopilot.stop()
  const passed = results.filter((r) => r.ok).length
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ target: `${host}:${port}`, version: b.version, total: results.length, passed, checks: results, plan: autopilot.summary() }, null, 2))
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
      await session.disconnect('autopilot test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
