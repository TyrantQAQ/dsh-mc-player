/**
 * 功能方块：附魔台、铁砧、村民交易。
 *
 * 共同点：都是"把东西放进某个槽位 → 服务端算出结果 → 把结果拿回来"。
 * 坑在槽位编号：窗口里的槽位从 0 开始，玩家背包在窗口里不是 9~44，而是
 * 从 window.inventoryStart 开始。所以每次搬运都要换算一次。
 */

import { sleep, waitFor, describeError } from './util.js'
import { countItem, findItems } from './actions.js'
import { ensureEnchantsCompat } from './actions.js'

function blockAt(bot, p) {
  const V = bot.entity.position.constructor
  return bot.blockAt(new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), false)
}

function inventoryOffset(bot) {
  const w = bot.currentWindow
  if (!w) return 0
  return w.inventoryStart - bot.inventory.inventoryStart
}

/** 把背包里的某种物品搬到当前窗口的某个槽位（source 要换算成窗口槽位） */
export async function moveInventoryItemToSlot(bot, name, destSlot) {
  const item = bot.inventory.items().find((i) => i.name === name)
  if (!item) throw new Error(`背包里没有 ${name}`)
  const src = item.slot + inventoryOffset(bot)
  await bot.moveSlotItem(src, destSlot)
  await sleep(120)
  return item
}

function enchantList(item, registry) {
  if (!item) return []
  ensureEnchantsCompat(item, registry ?? null)
  try {
    const raw = item.enchants ?? []
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.enchants) ? raw.enchants : []
    return arr.map((e) => {
      const name = typeof e.name === 'string' ? e.name : registry?.enchantmentsArray?.find((x) => x.id === (e.id ?? e.type))?.name
      const lvl = e.lvl ?? e.level ?? ''
      return `${name ?? e.id}${lvl}`
    })
  } catch {
    return []
  }
}

/** 1.20.5+ 的 custom_name 是文本组件（对象），不是字符串 */
function textOf(value) {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text
    if (typeof value.translate === 'string') return value.translate
    // 26.2 的组件：{ type: 'string', value: '小鱼' } / { type: 'compound', value: {...} }
    if (typeof value.value === 'string' && (value.type === undefined || value.type === 'string')) return value.value
    if (value.value && typeof value.value === 'object') return textOf(value.value)
    if (Array.isArray(value.extra)) return value.extra.map(textOf).filter(Boolean).join('')
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  return String(value)
}

/** 找一个功能方块：给坐标就用坐标，否则在附近找 */
function findStation(bot, args, names) {
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    const b = blockAt(bot, args)
    if (!b) throw new Error('那个位置没有方块')
    if (!names.some((n) => b.name.includes(n))) throw new Error(`那格是 ${b.name}，不是 ${names.join('/')}`)
    return b
  }
  const ids = Object.values(bot.registry.blocksByName)
    .filter((b) => b && names.some((n) => b.name.includes(n)))
    .map((b) => b.id)
  const found = bot.findBlock({ matching: ids, maxDistance: 16 })
  if (!found) throw new Error(`16 格内没有 ${names.join('/')}`)
  return found
}

// ---------------------------------------------------------------------------
// 附魔台
// ---------------------------------------------------------------------------

export async function enchantAt(session, args) {
  const bot = session.requireBot()
  const targetName = args.item ? String(args.item) : bot.heldItem?.name
  if (!targetName) throw new Error('要附魔什么？给 item，或者先拿在手上')
  const block = findStation(bot, args, ['enchanting_table'])
  const table = await bot.openEnchantmentTable(block)
  let before = null
  try {
    const item = bot.inventory.items().find((i) => i.name === targetName)
    if (!item) throw new Error(`背包里没有 ${targetName}`)
    before = { name: item.name, count: item.count, enchants: enchantList(item, bot.registry) }
    await moveInventoryItemToSlot(bot, targetName, 0)

    const lapis = countItem(bot, 'lapis_lazuli')
    if (lapis <= 0) throw new Error('没有青金石，附魔台用不了')
    await moveInventoryItemToSlot(bot, 'lapis_lazuli', 1)

    const ready = await waitFor(() => table.enchantments.every((e) => e.level >= 0), { timeoutMs: 6000 })
    if (!ready) throw new Error('附魔台没给出选项（可能没放书或等级不够）')
    const options = table.enchantments.map((e, i) => ({ choice: i, level: e.level }))
    const xp = bot.experience?.level ?? 0
    const affordable = options
      .filter((o) => o.level > 0 && o.level <= xp && lapis >= o.choice + 1)
      .sort((a, b) => b.level - a.level)
    let pick = null
    if (args.choice !== undefined) {
      pick = options[Number(args.choice)]
      if (!pick || pick.level <= 0) throw new Error(`第 ${args.choice} 个选项不可用：${JSON.stringify(options)}`)
    } else {
      pick = affordable[0] ?? null
    }
    if (!pick) {
      return {
        ok: false,
        verified: false,
        summary: `没有能选的附魔：等级 ${xp}，青金石 ${lapis}，选项 ${JSON.stringify(options)}`,
        evidence: { xp, lapis, options },
        hint: '升级或补青金石再来；书架的加成也影响选项等级。',
      }
    }

    const result = await table.enchant(pick.choice)
    await sleep(200)
    const after = result ?? table.slots[0]
    const afterEnchants = enchantList(after, bot.registry)
    await bot.putAway(0)
    await sleep(150)
    if (table.slots[1]) await bot.putAway(1)
    await sleep(200)
    // 以背包里的实物为准再读一次（窗口里的 item 可能不带 registry）
    const inBag = bot.inventory.items().find((i) => i.name === before.name) ?? null
    const bagEnchants = enchantList(inBag, bot.registry)
    const finalEnchants = bagEnchants.length ? bagEnchants : afterEnchants
    return {
      ok: true,
      verified: finalEnchants.length > 0,
      summary: `附魔了 ${before.name}（选项 ${pick.choice}，等级 ${pick.level}）：${before.enchants.join(',') || '无'} → ${finalEnchants.join(',') || '无'}`,
      evidence: { item: before.name, choice: pick.choice, level: pick.level, xpBefore: xp, options, before: before.enchants, after: finalEnchants, inBag: bagEnchants, windowAfter: afterEnchants },
      hint: afterEnchants.length ? undefined : '附魔看起来没生效，检查经验/青金石是不是被扣了。',
    }
  } finally {
    try {
      table.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 铁砧
// ---------------------------------------------------------------------------

export async function anvilUse(session, args) {
  const bot = session.requireBot()
  if (!args.item) throw new Error('要给铁砧什么物品？item')
  const block = findStation(bot, args, ['anvil'])
  const w = await bot.openBlock(block)
  if (!/anvil/.test(w.type)) throw new Error(`打开的不是铁砧（${w.type}）`)
  try {
    const put = async (name, dest) => {
      const item = findItems(bot, name)[0]
      if (!item) throw new Error(`背包里没有 ${name}`)
      await bot.transfer({
        window: w,
        itemType: item.type,
        metadata: item.metadata,
        count: 1,
        nbt: item.nbt,
        sourceStart: w.inventoryStart,
        sourceEnd: w.inventoryEnd,
        destStart: dest,
        destEnd: dest + 1,
      })
      await sleep(150)
    }
    await put(args.item, 0)
    if (args.item2) await put(args.item2, 1)
    if (args.name) {
      // 26.2 的协议里还是 name_item 包
      bot._client.write('name_item', { name: String(args.name).slice(0, 35) })
      await sleep(250)
    }
    const out = await waitFor(() => w.slots[2], { timeoutMs: 3000 })
    if (!out) {
      return {
        ok: false,
        verified: false,
        summary: '铁砧没有产出：可能经验不够，或者这两件东西不能这样合',
        evidence: { window: w.type, slot0: w.slots[0]?.name ?? null, slot1: w.slots[1]?.name ?? null, xp: bot.experience?.level ?? null },
        hint: '修理/合并要花经验等级；改名至少 1 级。',
      }
    }
    const outInfo = { name: out.name, count: out.count, enchants: enchantList(out, bot.registry), customName: textOf(out.customName) }
    const beforeCount = countItem(bot, out.name)
    await bot.putAway(2)
    await sleep(200)
    const afterCount = countItem(bot, out.name)
    return {
      ok: true,
      verified: afterCount > beforeCount || Boolean(args.name && outInfo.customName),
      summary: `铁砧产出：${outInfo.name}${outInfo.customName ? `（改名「${outInfo.customName}」）` : ''}${outInfo.enchants.length ? ` [${outInfo.enchants.join(',')}]` : ''}`,
      evidence: { output: outInfo, xpBefore: bot.experience?.level ?? null, inventoryDelta: afterCount - beforeCount },
    }
  } finally {
    try {
      w.close()
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// 村民交易
// ---------------------------------------------------------------------------

export async function tradeWith(session, args) {
  const bot = session.requireBot()
  let entity = args.entityId !== undefined ? bot.entities[args.entityId] : null
  if (!entity) {
    const p = bot.entity.position
    entity = Object.values(bot.entities || {})
      .filter((e) => e && /villager|wandering_trader/.test(e.name ?? '') && e.position)
      .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0] ?? null
    if (entity && entity.position.distanceTo(p) > 8) throw new Error('最近的村民离得太远（超过 8 格）')
  }
  if (!entity) throw new Error('8 格内没有村民')

  // 村民会乱走，而且服务器对"隔空互动"卡在 3 格；先走近，再开，超时就走近重试
  const near = async () => {
    const d = entity.position.distanceTo(bot.entity.position)
    if (d <= 2.2) return d
    await actions.move(session, { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z), range: 1.2, timeoutMs: 8000 }).catch(() => {})
    return entity.position.distanceTo(bot.entity.position)
  }
  let dist = await near()
  let v = null
  for (let attempt = 0; attempt < 3 && !v; attempt += 1) {
    if (dist > 2.8) throw new Error(`走不到村民跟前（还差 ${dist.toFixed(1)} 格）`)
    try {
      // 26.2 的服务端会检查视线：先强制转头，等它收到新的视角再开界面
      await bot.lookAt(entity.position.offset(0, (entity.height ?? 1.8) * 0.5, 0), true)
      await sleep(150)
      v = await Promise.race([
        bot.openVillager(entity),
        new Promise((_, reject) => setTimeout(() => reject(new Error('open timeout')), 3000)),
      ])
    } catch (error) {
      if (attempt === 2) throw new Error(`打不开村民的交易界面（离 ${dist.toFixed(1)} 格）：${error.message}`)
      dist = await near()
    }
  }
  try {
    const ready = await waitFor(() => v.trades && v.trades.length >= 0, { timeoutMs: 6000 })
    if (!ready) throw new Error('没拿到交易列表')
    const trades = (v.trades ?? []).map((t, i) => ({
      index: i,
      inputs: (t.inputs ?? []).map((it) => ({ name: it.name, count: it.count })),
      output: { name: t.outputItem?.name ?? null, count: t.outputItem?.count ?? null },
      uses: t.nbTradeUses ?? 0,
      maxUses: t.maximumNbTradeUses ?? 0,
      disabled: t.tradeDisabled === true,
    }))
    if (args.listOnly) {
      return { ok: true, verified: true, summary: `这个村民有 ${trades.length} 个交易`, evidence: { trades: trades.slice(0, 40) } }
    }
    const index = Number(args.tradeIndex ?? 0)
    const trade = trades[index]
    if (!trade) throw new Error(`没有第 ${index} 号交易（共 ${trades.length} 个）`)
    if (trade.disabled || trade.uses >= trade.maxUses) throw new Error(`第 ${index} 号交易已经用完了`)
    const count = Math.max(1, Math.min(Number(args.count ?? 1), 64))
    const before = countItem(bot, trade.output.name)
    const spent = (trade.inputs[0]?.name ? countItem(bot, trade.inputs[0].name) : null)
    await v.trade(index, count)
    // 交易窗口开着的时候，玩家背包是窗口里的一份副本；关掉之后 inventory 才刷新
    try { v.close() } catch {}
    await sleep(500)
    const after = countItem(bot, trade.output.name)
    const spentAfter = trade.inputs[0]?.name ? countItem(bot, trade.inputs[0].name) : null
    return {
      ok: true,
      verified: after > before,
      summary: `交易了 ${trade.output.name} x${count}：背包 ${before} → ${after}（用 ${trade.inputs.map((i) => `${i.name} x${i.count}`).join(' + ')}${spent !== null ? `，${trade.inputs[0].name} ${spent} → ${spentAfter}` : ''}）`,
      evidence: { trade, before, after, spent, spentAfter },
    }
  } finally {
    try {
      v.close()
    } catch {
      /* ignore */
    }
  }
}
