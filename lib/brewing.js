/**
 * 酿造台：把水瓶放进去、材料放进顶格、烈焰粉当燃料，等它酿好，把药水拿出来。
 *
 * 槽位（原版 BrewingStandMenu）：0/1/2 = 瓶子，3 = 材料，4 = 燃料。
 * 验证以"药水的 potion_contents 变了"为准，不看时间。
 */

import { sleep, waitFor } from './util.js'

function componentOf(item, name) {
  try {
    return item?.componentMap?.get(name)?.data ?? null
  } catch {
    return null
  }
}

export function potionId(item) {
  if (!item) return null
  if (item.name !== 'potion') return null
  const contents = componentOf(item, 'potion_contents')
  if (!contents) return null
  // 26.2 的 potion_contents 是 { potionId: 0 } 这种数字（0 = water），不是字符串
  return contents.potion ?? contents.potionId ?? contents.id ?? null
}

function isWater(potion) {
  if (potion === null || potion === undefined) return false
  if (typeof potion === 'number') return potion === 0
  return /water/.test(String(potion))
}

export function isWaterBottle(item) {
  return item?.name === 'potion' && isWater(potionId(item))
}

export async function brew(session, args) {
  const bot = session.requireBot()
  if (!args.ingredient) throw new Error('要酿什么？给 ingredient（比如 nether_wart / sugar / glowstone_dust）')

  let stand = null
  if (args.x !== undefined) {
    const V = bot.entity.position.constructor
    stand = bot.blockAt(new V(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z)), false)
    if (stand?.name !== 'brewing_stand') throw new Error(`那格是 ${stand?.name}，不是酿造台`)
  } else {
    stand = bot.findBlock({ matching: bot.registry.blocksByName.brewing_stand.id, maxDistance: 16 })
  }
  if (!stand) throw new Error('16 格内没有酿造台')

  const w = await bot.openBlock(stand)
  if (!/brewing_stand/.test(w.type)) throw new Error(`打开的不是酿造台（${w.type}）`)

  // 窗口开着的时候，玩家背包读到的可能是旧副本；直接扫窗口里的背包区最稳。
  // w.slots 里的 Item 的 .slot 就是窗口槽位，不用再换算。
  const findInWindow = (pred) => {
    for (let i = w.inventoryStart; i < w.inventoryEnd; i += 1) {
      const it = w.slots[i]
      if (it && pred(it)) return it
    }
    return null
  }
  const transfer = async (item, dest) => {
    const src = item.slot
    await bot.clickWindow(src, 0, 0)
    await sleep(150)
    await bot.clickWindow(dest, 0, 0)
    await sleep(200)
    // 只有真的还拿在手上才放回去；刚点完时 selectedItem 可能还没更新
    if (w.selectedItem) {
      await bot.clickWindow(src, 0, 0)
      await sleep(150)
    }
  }

  if (!findInWindow((i) => isWaterBottle(i))) throw new Error('背包里没有水瓶（potion[water]）')
  let placed = 0
  for (const slot of [0, 1, 2]) {
    const bottle = findInWindow((i) => isWaterBottle(i))
    if (!bottle) break
    await transfer(bottle, slot)
    placed += 1
  }

  const ingredient = findInWindow((i) => i.name === args.ingredient)
  if (!ingredient) throw new Error(`背包里没有 ${args.ingredient}`)
  await transfer(ingredient, 3)

  const fuel = findInWindow((i) => i.name === 'blaze_powder')
  if (fuel) await transfer(fuel, 4)

  const before = [0, 1, 2].map((s) => potionId(w.slots[s]))
  const done = await waitFor(() => [0, 1, 2].some((s) => {
    const id = potionId(w.slots[s])
    return id !== null && !isWater(id)
  }), { timeoutMs: Math.min(Math.max(Number(args.timeoutMs) || 45000, 5000), 180000) })

  const afterInWindow = [0, 1, 2].map((s) => potionId(w.slots[s]))
  for (const slot of [0, 1, 2]) {
    if (w.slots[slot]) {
      try {
        await bot.putAway(slot)
      } catch {
        /* 拿不出来就算了，下面按背包核对 */
      }
    }
  }
  try {
    w.close()
  } catch {
    /* ignore */
  }
  await sleep(400)

  const inventoryPotions = bot.inventory.items().filter((i) => i.name === 'potion').map((i) => potionId(i))
  const brewed = inventoryPotions.filter((p) => p !== null && !isWater(p))
  return {
    ok: true,
    verified: brewed.length > 0,
    summary: done
      ? `酿好了：${before.filter(Boolean).length} 瓶水 → ${brewed.join(', ')}（放了 ${placed} 瓶）`
      : `等了 ${Math.round((Number(args.timeoutMs) || 45000) / 1000)} 秒没酿出来（材料/燃料/瓶子检查一下）`,
    evidence: { placed, ingredient: args.ingredient, before, afterInWindow, inventoryPotions, brewed },
    hint: brewed.length ? undefined : '酿造台需要：水瓶、正确的材料、烈焰粉燃料；材料不对不会开始。',
  }
}
