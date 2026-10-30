/**
 * 钓鱼：拿竿、对水、甩出去、等咬钩、收杆。
 *
 * 两个坑：
 *   - 甩竿方向是服务端按"当前视角"算的，转头之后要等一下再甩，不然钩会落到背后；
 *   - mineflayer 的 bot.fish() 在 26.2/1.16 上偶尔会误取消，所以这里自己盯咬钩信号
 *     （entity.fishing_bobber.splash 或一圈 6 个 splash 粒子），自己收杆。
 */

import { sleep, waitFor } from './util.js'

function inventoryTotal(bot) {
  try {
    return bot.inventory.items().reduce((s, i) => s + i.count, 0)
  } catch {
    return 0
  }
}

export async function fishAt(session, args = {}) {
  const bot = session.requireBot()
  const count = Math.min(Math.max(Number(args.count) || 1, 1), 10)
  const maxMs = Math.min(Math.max(Number(args.maxMs) || 60000, 5000), 180000)

  let rod = null
  try {
    rod = bot.inventory.items().find((i) => i.name.includes('fishing_rod')) ?? null
  } catch {
    rod = null
  }
  if (!rod) throw new Error('背包里没有鱼竿')
  if (bot.heldItem?.name !== rod.name) await bot.equip(rod, 'hand')
  if (bot.currentWindow) throw new Error('界面开着，先关掉（mc_use action=close）')

  const waterIds = [bot.registry.blocksByName.water?.id, bot.registry.blocksByName.flowing_water?.id].filter((x) => x !== undefined)
  const waters = bot.findBlocks({ matching: waterIds, maxDistance: 16, count: 48 }) ?? []
  if (!waters.length) throw new Error('16 格内没有水，鱼钩落不下去')
  // 挑池子中间的水块：四面都是水，钩才不会落在岸上
  const V = bot.entity.position.constructor
  const isWater = (x, y, z) => {
    const b = bot.blockAt(new V(x, y, z))
    return b?.name === 'water' || b?.name === 'flowing_water'
  }
  const interior = waters.filter((pos) => isWater(pos.x + 1, pos.y, pos.z) && isWater(pos.x - 1, pos.y, pos.z) && isWater(pos.x, pos.y, pos.z + 1) && isWater(pos.x, pos.y, pos.z - 1))
  const pool = (interior.length ? interior : waters).sort((a, c) => a.distanceTo(bot.entity.position) - c.distanceTo(bot.entity.position))
  const water = pool[0]

  const before = inventoryTotal(bot)
  const bites = []
  for (let i = 0; i < count; i += 1) {
    let signal = null
    let bobber = null
    const onSound = (name) => {
      if (/fishing_bobber\.splash/.test(name)) signal = 'sound'
    }
    const onParticles = (pkt) => {
      const amount = pkt.amount ?? pkt.particles ?? 0
      if (amount >= 6) signal = 'particle'
    }
    bot.on('soundEffectHeard', onSound)
    bot._client.on('world_particles', onParticles)
    try {
      // 往水块中心再往里偏一点：钩的落点会比准星短，贴着岸边会落在岸上
      const center = water.offset(0.5, 0.5, 0.5)
      const away = center.minus(bot.entity.position).normalize().scale(0.4)
      await bot.lookAt(center.plus(away), true)
      await sleep(500) // 先让服务端收到视角，再甩竿
      bot.activateItem()
      bobber = await waitFor(() => Object.values(bot.entities || {}).find((e) => /fishing_bobber/.test(e.name || '')), { timeoutMs: 5000 })
      if (!bobber) throw new Error('鱼钩没甩出去（附近的水可能不够，或视角被挡）')
      const bitten = await waitFor(() => signal !== null, { timeoutMs: maxMs, intervalMs: 80 })
      if (!bitten) throw new Error(`等了 ${Math.round(maxMs / 1000)} 秒没鱼咬钩`)
      bot.activateItem() // 收杆
      await sleep(1500)
      bites.push({ signal, bobber: { x: bobber.position.x, y: bobber.position.y, z: bobber.position.z } })
    } catch (error) {
      return {
        ok: false,
        verified: false,
        summary: `第 ${i + 1} 次钓鱼失败：${error.message}`,
        evidence: {
          completed: bites.length,
          before,
          after: inventoryTotal(bot),
          water: { x: water.x, y: water.y, z: water.z },
          bobber: bobber ? { x: bobber.position.x, y: bobber.position.y, z: bobber.position.z, block: bot.blockAt(bobber.position)?.name ?? null } : null,
          bot: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        },
        hint: '鱼竿可能坏了、水不够深、或者鱼钩没落到水里。',
      }
    } finally {
      bot.removeListener('soundEffectHeard', onSound)
      bot._client.removeListener('world_particles', onParticles)
    }
  }
  const after = inventoryTotal(bot)
  return {
    ok: true,
    verified: after > before,
    summary: `钓了 ${count} 次，背包净变化 ${after - before >= 0 ? '+' : ''}${after - before}`,
    evidence: { times: bites.length, before, after, bites, water: { x: water.x, y: water.y, z: water.z }, rodDurability: rod.durabilityUsed ?? null },
    hint: after > before ? undefined : '钓上来的可能是垃圾（靴子、海草），也可能是没进背包。',
  }
}
