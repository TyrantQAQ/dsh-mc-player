#!/usr/bin/env node
/**
 * 战斗测试：挑威胁、换武器、打死、苦力怕不近战。
 *
 * 需要：26.2 服务端 + op（/kill /clear /give /summon），difficulty=normal。
 * 跑法：node scripts/fighttest.mjs [host] [port] [version] [user]
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Session } from '../lib/session.js'
import { fight, equipBestWeapon } from '../lib/combat.js'

const host = process.argv[2] || '127.0.0.1'
const port = Number(process.argv[3] || 25565)
const version = process.argv[4] || '26.2'
const user = process.argv[5] || 'xiaojingyu'
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'report', 'fight.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const rec = (id, ok, detail, data) => {
  results.push({ id, ok: Boolean(ok), detail, ...(data ? { data } : {}) })
  console.log(`${ok ? ' ok ' : 'FAIL'} ${id.padEnd(16)} ${detail}`)
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
  rec('connect', session.isOnline, `${b.version} @ ${b.entity.position.floored()}`)

  await say('/gamerule spawn_mobs false')
  // 先用和平模式清场：/kill 史莱姆会让大只分裂成小只，越杀越多
  await say('/difficulty peaceful')
  await sleep(1500)
  await say('/difficulty normal')
  await say('/kill @e[type=!player]'); await say('/clear'); await say('/kill @s')
  await sleep(2000)
  await say('/kill @e[type=!player]')
  await sleep(1200)
  const p = b.entity.position.floored()
  await say('/give @s stone_sword 1'); await say('/give @s iron_sword 1'); await say('/give @s bread 8'); await say('/give @s shield 1')
  await say(`/summon zombie ${p.x + 4} ${p.y} ${p.z}`)
  await say(`/summon zombie ${p.x - 4} ${p.y} ${p.z}`)
  await sleep(800)

  const w = await equipBestWeapon(b)
  rec('weapon', w === 'iron_sword', `换成 ${w}（背包里有石剑和铁剑）`)

  // 放风筝：弓 + 后退，两只僵尸不该摸到人
  await say('/kill @e[type=!player]'); await say('/clear'); await say('/kill @s')
  await sleep(2500)
  const pb = b.entity.position.floored()
  await say('/give @s bow 1'); await say('/give @s arrow 32'); await say('/give @s iron_sword 1'); await say('/give @s shield 1')
  await say(`/summon zombie ${pb.x + 8} ${pb.y} ${pb.z}`)
  await say(`/summon zombie ${pb.x - 8} ${pb.y} ${pb.z}`)
  await sleep(900)
  const rb = await fight(session, { radius: 16, timeoutMs: 60000 })
  const bowKills = rb.evidence.kills.filter((k) => k === 'zombie').length
  rec('kite-bow', rb.ok && bowKills >= 2 && b.health >= 15, `放风筝：${rb.summary}`, rb.evidence)

  // 穿甲 2 僵尸：这个必须稳
  await say('/kill @e[type=!player]'); await say('/clear'); await say('/kill @s')
  await sleep(2500)
  const p2 = b.entity.position.floored()
  await say('/give @s iron_sword 1'); await say('/give @s shield 1')
  await say('/give @s iron_helmet 1'); await say('/give @s iron_chestplate 1'); await say('/give @s iron_leggings 1'); await say('/give @s iron_boots 1')
  await sleep(600)
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const it = b.inventory.items().find((i) => /iron_(helmet|chestplate|leggings|boots)/.test(i.name))
    if (it) await b.equip(it, slot).catch(() => {})
  }
  await say(`/summon zombie ${p2.x + 4} ${p2.y} ${p2.z}`)
  await say(`/summon zombie ${p2.x - 4} ${p2.y} ${p2.z}`)
  await sleep(800)
  const ra = await fight(session, { radius: 12, timeoutMs: 60000 })
  const armedKills = ra.evidence.kills.filter((k) => k === 'zombie').length
  rec('armed-2v1', ra.ok && armedKills >= 2, `穿铁甲：${ra.summary}`, ra.evidence)

  // 弓箭：远距离先射
  await say('/kill @e[type=!player]'); await say('/clear'); await say('/kill @s')
  await sleep(2500)
  const q2 = b.entity.position.floored()
  await say('/give @s bow 1'); await say('/give @s arrow 32')
  await say(`/summon zombie ${q2.x + 10} ${q2.y} ${q2.z}`)
  await sleep(900)
  const arrowBefore = b.inventory.items().filter((i) => i.name === 'arrow').reduce((s2, i) => s2 + i.count, 0)
  const bw = await fight(session, { radius: 16, timeoutMs: 45000 })
  const arrowAfter = b.inventory.items().filter((i) => i.name === 'arrow').reduce((s2, i) => s2 + i.count, 0)
  rec('bow', arrowAfter < arrowBefore, `射了 ${arrowBefore - arrowAfter} 支箭；${bw.summary}`, { arrowBefore, arrowAfter, kills: bw.evidence.kills })

  // 苦力怕：不该近战，应该退
  await say('/kill @e[type=!player]'); await say('/clear'); await say('/kill @s')
  await sleep(2500)
  const q = b.entity.position.floored()
  await say('/give @s iron_sword 1')
  await say(`/summon creeper ${q.x + 3} ${q.y} ${q.z}`)
  await sleep(900)
  const c = await fight(session, { radius: 12, timeoutMs: 20000 })
  rec('creeper-avoid', c.evidence.retreated === true && c.evidence.kills.length === 0 && b.health > 0, c.summary, c.evidence)

  const passed = results.filter((x) => x.ok).length
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
      await session.disconnect('fight test done')
    } catch {}
    setTimeout(() => process.exit(process.exitCode ?? 0), 500)
  })
