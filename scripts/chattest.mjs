#!/usr/bin/env node
/**
 * 游戏内聊天测试：聊天只是"耳朵和嘴"——话要原样转给大脑，回话走 mc_chat say。
 *
 * 需要：26.2 离线服 + 两个号（xiaojingyu / owner）。
 * 跑法：node scripts/chattest.mjs [host] [port] [version]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { registerTools } from '../lib/tools.js'
import { ChatLink } from '../lib/chat.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'chat.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(16)} ${detail}`)
}

const A = new Session({ config: { connection: { host, port, username: 'xiaojingyu', version } }, log: () => {} })
await A.connect()
const tools = new Map()
registerTools({ tools: { register(d) { tools.set(d.name, d); return () => {} } }, effect(fn) { return fn() } }, { session: A, log: () => {}, config: {}, autopilot: null })
const woke = []
A.chatLink = new ChatLink({
  session: A,
  config: { enabled: true },
  log: () => {},
  wake: async (line) => { woke.push(line); return true },
})
A.chatLink.start()
await sleep(1500)

const B = new Session({ config: { connection: { host, port, username: 'owner', version } }, log: () => {} })
await B.connect()
await sleep(2500)
rec('connect', A.isOnline && B.isOnline, `A ${A.bot.username}；B ${B.bot.username}`)

B.bot.chat('这个是刷石机')
await sleep(1200)
rec('forwarded', woke.some((l) => l.includes('owner') && l.includes('刷石机')), `转给大脑：${JSON.stringify(woke.slice(-2))}`, { woke })

const read = await tools.get('mc_chat').execute({ action: 'read' })
rec('read', read.ok && read.evidence?.messages?.length >= 1, read.summary, read.evidence)

const heard = []
B.bot.on('chat', (u, m) => heard.push(`${u}: ${m}`))
const say = await tools.get('mc_chat').execute({ action: 'say', text: '我看到了' })
await sleep(800)
rec('say', say.ok && heard.some((m) => m.includes('我看到了')), `B 听到：${JSON.stringify(heard.slice(-2))}`)

// 转不过去的时候：变成待办
A.chatLink.wake = async () => false
B.bot.chat('造个房子')
await sleep(1200)
rec('pending-fallback', A.chatLink.pending.length >= 1, `待办：${JSON.stringify(A.chatLink.pending.slice(-1))}`)

const passed = results.filter((r) => r.ok).length
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ target: `${host}:${port}`, version, total: results.length, passed, checks: results }, null, 2))
console.log(`\n${passed === results.length ? 'PASS' : 'FAIL'} ${passed}/${results.length} · 报告 ${OUT}`)
A.chatLink.stop()
try { await A.disconnect('done'); await B.disconnect('done') } catch {}
setTimeout(() => process.exit(passed === results.length ? 0 : 1), 500)
