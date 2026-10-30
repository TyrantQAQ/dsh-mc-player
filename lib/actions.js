/**
 * 身体：所有会改变世界的动作都在这里。
 *
 * 三条硬规矩：
 *   1. 每个动作都必须能被打断（反射层推 abort，pathfinder / dig 立刻停）；
 *   2. 每个动作结束都要回读世界，拿不到证据就算失败（verified: false）；
 *   3. 出错不抛给调用方，返回 {ok:false, error, hint}，让大脑自己决定下一步。
 */

import { planPlacement, verifyState, describeState, blockMatches } from './placement.js'
import {
  abortable,
  asVec,
  pointAt,
  dist,
  dist2d,
  key,
  round,
  sleep,
  softWait,
  throwIfAborted,
  waitFor,
  describeError,
  AbortError,
  TimeoutError,
} from './util.js'

const TOOL_TIER = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 }

export function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\s+/g, '_')
}

function itemName(item) {
  return item?.name ?? null
}

/**
 * 右击一个实体（喂食、驯服、开村民界面都走这里）。
 *
 * 26.2 的服务器会先检查"实体在视线里"，而 mineflayer 自带的 activateEntity
 * 只是 lookAt(force=false) 之后立刻发包——服务端那边视角还是旧的，交互就被拒了。
 * 所以这里强制转头、等两个 tick 再发 Interact 包。
 */
export async function interactEntity(session, entity) {
  const bot = session.requireBot()
  if (!entity || entity.id === undefined) throw new Error('没有可交互的实体')
  const V = bot.entity.position.constructor
  const height = entity.height ?? 1.8
  await bot.lookAt(entity.position.offset(0, height * 0.5, 0), true)
  await sleep(150)
  bot._client.write('use_entity', {
    target: entity.id,
    hand: 0,
    location: new V(0, 0, 0),
    sneaking: false,
  })
  await sleep(150)
  return { ok: true, verified: true, summary: `碰了一下 ${entity.name}` }
}

export function findItems(bot, name) {
  const want = normalizeName(name)
  let items = []
  try {
    items = bot.inventory.items()
  } catch {
    return []
  }
  if (!want) return items
  const exact = items.filter((it) => it.name === want)
  if (exact.length) return exact
  return items.filter((it) => it.name.endsWith(`_${want}`) || it.name.includes(want))
}

export function countItem(bot, name) {
  return findItems(bot, name).reduce((sum, it) => sum + it.count, 0)
}

function inventoryTotal(bot) {
  try {
    return bot.inventory.items().reduce((sum, it) => sum + it.count, 0)
  } catch {
    return 0
  }
}

function blockAt(bot, pos) {
  return bot.blockAt(asVec(bot, pos), false)
}

function blockName(bot, pos) {
  try {
    return blockAt(bot, pos)?.name ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function isSolidBlock(block) {
  return Boolean(block) && block.boundingBox === 'block'
}

function feetPos(bot) {
  const p = bot.entity.position
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

/**
 * 挖这块最省时间的工具。
 *
 * 不靠名字猜"该用镐还是斧"，而是直接用游戏公式（prismarine-block 的 digTime）：
 * 把背包里每件候选工具、以及空手，都算一遍"挖穿这块要几毫秒"，取最短的。
 * 这样四件事自动成立：
 *   - 镐/斧/锹/剪刀对不对口，由 minecraft-data 的 materials 表决定（不是正则）；
 *   - 木→石→铁→钻→下界合金 的档位差异直接体现在时间上；
 *   - 效率（efficiency）附魔会进公式，附魔钻石斧自然比白板钻石斧快；
 *   - 剑砍蛛网、剪刀剪树叶这类冷门组合也能选对。
 *
 * 有 harvestTools 的方块（挖了才掉东西的那些）只考虑"挖得动"的工具；挖不动就不选。
 */
/**
 * 26.2 的物品是组件化的，prismarine-item 的 `enchants` 在这版会返回
 * `{ enchantments: [{ id, level }] }` 这种对象（不是数组、也没有 name），
 * 而 prismarine-block 的 digTime 只认 `[{ name, lvl }]` —— 直接喂进去会抛
 * "enchantments is not iterable"，结果是"带附魔的工具算不出时间、被当成挖不动"。
 *
 * 这里把 Item 类的 `enchants` getter 就地包一层，统一成 `[{ name, lvl }]`。
 * 只改这一个类的原型，不动 node_modules，一个进程补一次。
 */
const patchedItemProtos = new WeakSet()

function normalizeEnchants(raw, registry) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.enchantments) ? raw.enchantments : []
  const out = []
  for (const e of arr) {
    if (!e) continue
    const name = typeof e.name === 'string'
      ? e.name
      : registry?.enchantmentsArray?.find((x) => x.id === (e.id ?? e.type))?.name
    const lvl = e.lvl ?? e.level
    if (name && lvl != null) out.push({ name, lvl })
  }
  return out
}

export function ensureEnchantsCompat(item, registry) {
  if (!item) return
  const proto = Object.getPrototypeOf(item)
  if (!proto || patchedItemProtos.has(proto)) return
  const desc = Object.getOwnPropertyDescriptor(proto, 'enchants')
  if (!desc?.get) return
  patchedItemProtos.add(proto)
  Object.defineProperty(proto, 'enchants', {
    configurable: true,
    get() {
      return normalizeEnchants(desc.get.call(this), registry)
    },
  })
}

export function rankToolsFor(bot, block) {
  if (!block || block.name === 'air') return []
  const harvest = block.harvestTools && typeof block.harvestTools === 'object' ? block.harvestTools : null
  const creative = bot.game?.gameMode === 'creative'
  const eyeHeight = bot.entity.eyeHeight ?? 1.62
  let inWater = false
  try {
    const eyeBlock = bot.blockAt(bot.entity.position.offset(0, eyeHeight, 0))
    inWater = ['water', 'flowing_water'].includes(eyeBlock?.name)
  } catch {
    inWater = false
  }
  const notOnGround = bot.entity.onGround === false
  const effects = bot.entity.effects || {}
  const msFor = (item) => {
    try {
      if (item) ensureEnchantsCompat(item, bot.registry)
      return block.digTime(item ? item.type : null, creative, inWater, notOnGround, item?.enchants ?? [], effects)
    } catch {
      return Infinity
    }
  }
  let items = []
  try {
    items = bot.inventory.items()
  } catch {
    items = []
  }
  const rank = []
  for (const item of items) {
    if (harvest && harvest[item.type] !== true) continue
    // 快坏的工具别拿去挖：剩 1 点耐久就留着
    if (Number.isFinite(item.maxDurability) && Number.isFinite(item.durabilityUsed) && item.maxDurability - item.durabilityUsed <= 1) continue
    const ms = msFor(item)
    if (!Number.isFinite(ms)) continue
    rank.push({ item, ms })
  }
  // 空手只有在"不需要工具"的方块上才有意义
  if (!harvest) {
    const handMs = msFor(null)
    if (Number.isFinite(handMs)) rank.push({ item: null, ms: handMs })
  }
  const tierOf = (name) => {
    if (!name) return 0
    for (const [tier, weight] of Object.entries(TOOL_TIER)) if (name.startsWith(`${tier}_`)) return weight
    return 0
  }
  // 时间短的赢；时间一样（比如创造模式全是 0）就优先拿工具、再优先高 tier
  rank.sort((a, b) => a.ms - b.ms || (b.item ? 1 : 0) - (a.item ? 1 : 0) || tierOf(b.item?.name) - tierOf(a.item?.name))
  return rank
}

export function bestToolFor(bot, block) {
  return rankToolsFor(bot, block)[0]?.item ?? null
}

/** 挖这块预计要多久（毫秒）；给超时预算和返回值用 */
export function estimateDigMs(bot, block) {
  const best = rankToolsFor(bot, block)[0]
  return best ? best.ms : Infinity
}

/** 需要工具但没有：给出人能懂的话 */
function missingToolHint(bot, block) {
  const needed = block.harvestTools && typeof block.harvestTools === 'object'
    ? Object.keys(block.harvestTools).map((id) => bot.registry?.items?.[id]?.name).filter(Boolean)
    : []
  if (needed.length) return `挖 ${block.name} 至少要有：${[...new Set(needed)].join(' / ')}`
  return ''
}

export async function equipBestTool(bot, block, signal) {
  const tool = bestToolFor(bot, block)
  if (!tool) return null
  if (bot.heldItem?.name === tool.name) return tool
  throwIfAborted(signal)
  await bot.equip(tool, 'hand')
  return tool
}

export async function equipByName(bot, name, destination = 'hand') {
  const items = findItems(bot, name)
  if (!items.length) throw new Error(`背包里没有 ${name}`)
  const item = items[0]
  if (destination === 'hand' && bot.heldItem?.name === item.name) return item
  await bot.equip(item, destination)
  return item
}

// ---------------------------------------------------------------------------
// 走路
// ---------------------------------------------------------------------------

/** 核心寻路，不带动作登记，给别的动作复用 */
export async function walkTo(session, bot, target, { range = 1.5, timeoutMs = 90000 } = {}, signal) {
  const pf = session.libs?.pf
  if (!bot?.pathfinder || !pf?.goals) throw new Error('寻路组件不可用（pathfinder 没装上）')
  throwIfAborted(signal)
  const goal = new pf.goals.GoalNear(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z), Math.max(0.5, range))
  const timeout = setTimeout(() => {
    try {
      bot.pathfinder.stop()
    } catch {
      /* ignore */
    }
  }, timeoutMs)
  try {
    await abortable(bot.pathfinder.goto(goal), {
      signal,
      timeoutMs: timeoutMs + 1000,
      onAbort: () => {
        try {
          bot.pathfinder.stop()
        } catch {
          /* ignore */
        }
      },
      timeoutMessage: '走到一半超时了',
    })
  } finally {
    clearTimeout(timeout)
  }
  return dist(bot.entity.position, target)
}

async function followEntity(session, bot, entity, { range = 2, timeoutMs = 10000 }, signal) {
  const pf = session.libs?.pf
  if (!entity || !pf?.goals) throw new Error('找不到要跟的人/怪')
  const goal = new pf.goals.GoalFollow(entity, Math.max(1, range))
  bot.pathfinder.setGoal(goal, true)
  try {
    await abortable(sleep(timeoutMs), {
      signal,
      onAbort: () => {
        try {
          bot.pathfinder.stop()
        } catch {
          /* ignore */
        }
      },
    })
  } finally {
    try {
      bot.pathfinder.setGoal(null)
    } catch {
      /* ignore */
    }
  }
}

export function resolveTarget(session, args) {
  if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
    return { x: Number(args.x), y: Number(args.y), z: Number(args.z) }
  }
  if (args.place) {
    const place = session.memory.getPlace(args.place)
    if (!place) throw new Error(`记忆里没有叫「${args.place}」的地点。先 mc_memory 记一个。`)
    return { x: place.x, y: place.y, z: place.z }
  }
  return null
}

export async function move(session, args) {
  const bot = session.requireBot()
  const startedAt = Date.now()
  const startPos = { ...bot.entity.position }
  try {
    const target = resolveTarget(session, args)
    if (args.entityId !== undefined || args.player) {
      let entity = null
      if (args.entityId !== undefined) entity = bot.entities[args.entityId] ?? null
      if (!entity && args.player) entity = bot.players[args.player]?.entity ?? null
      if (!entity) return fail('move', `找不到 ${args.player ?? `实体 ${args.entityId}`}`)
      const followMs = Math.min(Number(args.durationMs) || 8000, 60000)
      const evidence = await session.runAction(
        'follow',
        `${args.player ?? args.entityId}`,
        async (signal) => {
          await followEntity(session, bot, entity, { range: args.range ?? 2, timeoutMs: followMs }, signal)
          return { followed: entity.name, distance: round(dist(bot.entity.position, entity.position), 2) }
        },
        { timeoutMs: followMs + 2000, onAbort: () => { try { bot.pathfinder.stop() } catch { /* ignore */ } } },
      )
      return {
        ok: true,
        verified: evidence.distance <= (args.range ?? 2) + 1,
        summary: `跟了 ${evidence.followed} ${followMs / 1000} 秒，现在离它 ${evidence.distance} 格`,
        evidence,
      }
    }

    if (!target) return fail('move', '要么给坐标 x/y/z，要么给 place（记忆里的地点），要么给 player/entityId 跟着走')

    const timeoutMs = Math.min(Number(args.timeoutMs) || 120000, 300000)
    const range = Number(args.range) || 1.5
    session.pushEvent('info', `动身去 ${Math.round(target.x)} ${Math.round(target.y)} ${Math.round(target.z)}`)
    const evidence = await session.runAction(
      'goto',
      `${Math.round(target.x)} ${Math.round(target.y)} ${Math.round(target.z)}`,
      async (signal) => {
        if (args.sprint !== false) bot.setControlState('sprint', true)
        const invBefore = inventoryTotal(bot)
        const remaining = await walkTo(session, bot, target, { range, timeoutMs }, signal)
        return { target, arrivedWithin: round(remaining, 2), range, blocksUsed: invBefore - inventoryTotal(bot) }
      },
      {
        timeoutMs: timeoutMs + 2000,
        timeoutMessage: '走太久，先停下。可能路被堵了。',
        onAbort: () => {
          try {
            bot.pathfinder.stop()
          } catch {
            /* ignore */
          }
        },
      },
    )
    const endPos = { ...bot.entity.position }
    const walked = round(dist(startPos, endPos), 2)
    const arrived = dist(endPos, target) <= range + 0.7
    return {
      ok: true,
      verified: arrived,
      summary: arrived
        ? `走到了（离目标 ${dist(endPos, target).toFixed(2)} 格），一共走了 ${walked} 格${evidence.blocksUsed > 0 ? `，路上垫了 ${evidence.blocksUsed} 块方块` : ''}`
        : `没走到：停在离目标 ${dist(endPos, target).toFixed(2)} 格的地方${evidence.blocksUsed > 0 ? `，路上垫了 ${evidence.blocksUsed} 块方块` : ''}`,
      evidence: {
        ...evidence,
        start: roundPos(startPos),
        end: roundPos(endPos),
        walked,
        ms: Date.now() - startedAt,
      },
      hint: arrived ? undefined : '可能是门/树/水挡路，或者目标在够不到的地方。试试 mc_move 到更近的点，或者 mc_control 手动挪。',
    }
  } catch (error) {
    return fail('move', error)
  }
}

export async function control(session, args) {
  const bot = session.requireBot()
  const keys = Array.isArray(args.keys) ? args.keys : args.keys ? [args.keys] : []
  const valid = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']
  const bad = keys.filter((k) => !valid.includes(k))
  if (bad.length) return fail('control', `不认识的键：${bad.join(', ')}（只能是 ${valid.join('/')}）`)
  const durationMs = Math.min(Math.max(Number(args.durationMs) || 500, 50), 20000)
  const startPos = { ...bot.entity.position }
  const startHealth = bot.health
  const mistakeChance = Math.min(Math.max(Number(args.mistakeChance ?? session.baseConfig.mistakeChance ?? 0.08), 0), 0.5)
  const slipped = Math.random() < mistakeChance
  const actualMs = slipped ? Math.round(durationMs * (0.85 + Math.random() * 0.3)) : durationMs

  try {
    const evidence = await session.runAction(
      'control',
      keys.join('+') || 'look',
      async (signal) => {
        if (args.look) {
          if (args.look.at) {
            const at = args.look.at
            await softWait(bot.lookAt(pointAt(bot, at.x + 0.5, at.y + 0.5, at.z + 0.5), true))
          } else {
            let yaw = Number(args.look.yaw ?? bot.entity.yaw)
            let pitch = Number(args.look.pitch ?? bot.entity.pitch)
            if (slipped) {
              yaw += (Math.random() - 0.5) * 0.25
              pitch += (Math.random() - 0.5) * 0.12
            }
            await softWait(bot.look(yaw, pitch, true))
          }
        }
        try {
          for (const k of keys) bot.setControlState(k, true)
          await abortable(sleep(actualMs), { signal })
        } finally {
          for (const k of valid) bot.setControlState(k, false)
        }
        await sleep(80)
        return {
          keys,
          durationMs: actualMs,
          from: roundPos(startPos),
          to: roundPos(bot.entity.position),
          moved: round(dist(startPos, bot.entity.position), 2),
          healthDelta: round((bot.health ?? startHealth) - startHealth, 1),
          slipped,
        }
      },
      { timeoutMs: actualMs + 4000, onAbort: () => { for (const k of valid) { try { bot.setControlState(k, false) } catch { /* ignore */ } } } },
    )
    const movedMeters = evidence.moved
    return {
      ok: true,
      verified: movedMeters > 0.05 || keys.length === 0,
      summary: `${keys.join('+') || '转头'} ${actualMs}ms，移动了 ${movedMeters} 格${slipped ? '（手滑了一下）' : ''}`,
      evidence,
      hint: movedMeters <= 0.05 && keys.length ? '没动：可能被方块挡住，或者脚下没有立足点。' : undefined,
    }
  } catch (error) {
    return fail('control', error)
  }
}

export async function look(session, args) {
  const bot = session.requireBot()
  try {
    const evidence = await session.runAction('look', args.entityId ?? 'to', async () => {
      const before = { yaw: bot.entity.yaw, pitch: bot.entity.pitch }
      if (args.entityId !== undefined) {
        const entity = bot.entities[args.entityId]
        if (!entity) throw new Error(`没有实体 ${args.entityId}`)
        await softWait(bot.lookAt(entity.position.offset(0, 1.2, 0), true))
      } else if (args.x !== undefined) {
        await softWait(bot.lookAt(pointAt(bot, args.x + 0.5, args.y + 0.5, args.z + 0.5), true))
      } else {
        await softWait(bot.look(Number(args.yaw ?? bot.entity.yaw), Number(args.pitch ?? bot.entity.pitch), true))
      }
      return { before, after: { yaw: round(bot.entity.yaw, 3), pitch: round(bot.entity.pitch, 3) } }
    })
    return {
      ok: true,
      verified: true,
      summary: `现在朝向 yaw=${evidence.after.yaw} pitch=${evidence.after.pitch}`,
      evidence,
    }
  } catch (error) {
    return fail('look', error)
  }
}

// ---------------------------------------------------------------------------
// 挖
// ---------------------------------------------------------------------------

function roundPos(p) {
  return { x: round(p.x, 2), y: round(p.y, 2), z: round(p.z, 2) }
}

async function digOne(session, bot, block, signal) {
  const pos = { x: block.position.x, y: block.position.y, z: block.position.z }
  const beforeName = block.name
  const beforeInv = inventoryTotal(bot)
  const beforeCount = countItem(bot, block.name)

  if (block.name === 'air') return { pos, beforeName, already: true, verified: true }
  if (block.diggable === false) throw new Error(`${block.name} 挖不动`)
  if (dist(bot.entity.position, pos) > 5.2) throw new Error(`够不着 ${beforeName}（${dist(bot.entity.position, pos).toFixed(1)} 格）`)

  const estimatedMs = estimateDigMs(bot, block)
  const tool = await equipBestTool(bot, block, signal)
  if (!tool && block.harvestTools && typeof block.harvestTools === 'object' && Object.keys(block.harvestTools).length) {
    const hint = missingToolHint(bot, block)
    throw new Error(`挖 ${beforeName} 需要工具。${hint}`)
  }

  if (tool) ensureEnchantsCompat(tool, bot.registry)
  let digMs = Number.isFinite(estimatedMs) && estimatedMs > 0 ? estimatedMs : 2000
  digMs = Math.max(250, digMs)

  await softWait(bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true))
  throwIfAborted(signal)
  await abortable(bot.dig(block, true), {
    signal: signal ?? undefined,
    timeoutMs: Math.max(5000, digMs * 4),
    onAbort: () => {
      try {
        bot.stopDigging()
      } catch {
        /* ignore */
      }
    },
    timeoutMessage: '挖太久了，可能挖的是挖不动的方块',
  })
  await sleep(120)
  const after = blockAt(bot, pos)
  const afterName = after?.name ?? 'air'
  return {
    pos,
    beforeName,
    afterName,
    tool: tool?.name ?? null,
    toolEnchants: (tool?.enchants ?? []).map((e) => `${e.name ?? e.id}${e.lvl ?? e.level ?? ''}`),
    gone: afterName === 'air' || afterName !== beforeName,
    invDelta: inventoryTotal(bot) - beforeInv,
    countBefore: beforeCount,
    countAfter: countItem(bot, beforeName),
    digMs: Math.round(digMs),
  }
}

/** 捡地上的掉落物：真玩家会把东西捡起来，不是挖完就走 */
export async function pickupDrops(session, bot, signal, { radius = 6, maxItems = 4, timeoutMs = 6000 } = {}) {
  const startInv = inventoryTotal(bot)
  const got = []
  const items = Object.values(bot.entities || {})
    .filter((e) => e?.name === 'item' && e.position && dist(bot.entity.position, e.position) <= radius)
    .sort((a, b) => dist(bot.entity.position, a.position) - dist(bot.entity.position, b.position))
    .slice(0, maxItems)
  for (const entity of items) {
    throwIfAborted(signal)
    try {
      await walkTo(session, bot, entity.position, { range: 0.4, timeoutMs }, signal)
      await sleep(120)
      let dropped = null
      try {
        dropped = entity.getDroppedItem?.()?.name ?? null
      } catch {
        dropped = null
      }
      got.push({ item: dropped, at: roundPos(entity.position) })
    } catch (error) {
      if (error instanceof AbortError) throw error
      // 捡不到就算了，别把整趟挖掘拖死
    }
  }
  await sleep(200)
  return { picked: got, invDelta: inventoryTotal(bot) - startInv }
}

export async function mine(session, args) {
  const bot = session.requireBot()
  try {
    if (args.block) {
      const want = normalizeName(args.block)
      const count = Math.min(Math.max(Number(args.count) || 1, 1), 256)
      const maxDistance = Math.min(Math.max(Number(args.maxDistance) || 32, 2), 128)
      const blockType = bot.registry?.blocksByName?.[want]
      if (!blockType) return fail('mine', `不认识的方块：${args.block}`)
      const startedInv = inventoryTotal(bot)
      const dug = []
      const failed = []
      const deadline = Date.now() + Math.min(Number(args.timeoutMs) || 180000, 600000)

      const evidence = await session.runAction(
        'mine',
        `${want} x${count}`,
        async (signal) => {
          for (let i = 0; i < count; i += 1) {
            throwIfAborted(signal)
            if (Date.now() > deadline) throw new TimeoutError(`超过时间预算，只挖到 ${dug.length}/${count} 块`)
            const found = bot.findBlock({ matching: blockType.id, maxDistance, count: 1 })
            if (!found) {
              failed.push({ reason: `附近 ${maxDistance} 格内找不到 ${want} 了` })
              break
            }
            const target = { x: found.position.x, y: found.position.y, z: found.position.z }
            if (dist(bot.entity.position, target) > 4.5) {
              try {
                await walkTo(session, bot, target, { range: 2, timeoutMs: 30000 }, signal)
              } catch (error) {
                if (error instanceof AbortError) throw error
                failed.push({ at: target, reason: `走不过去：${describeError(error)}` })
                continue
              }
            }
            try {
              const result = await digOne(session, bot, blockAt(bot, target), signal)
              dug.push(result)
              if (args.pickup !== false) {
                const picked = await pickupDrops(session, bot, signal, { radius: 6, maxItems: 3, timeoutMs: 4000 })
                result.picked = picked
              }
            } catch (error) {
              if (error instanceof AbortError) throw error
              failed.push({ at: target, block: blockName(bot, target), reason: describeError(error) })
            }
          }
          return {
            dug,
            dugCount: dug.filter((d) => d.gone).length,
            failed,
            invDelta: inventoryTotal(bot) - startedInv,
            want,
          }
        },
        {
          timeoutMs: Math.min(Number(args.timeoutMs) || 180000, 600000) + 5000,
          timeoutMessage: '挖矿超时',
          onAbort: () => {
            try {
              bot.stopDigging()
            } catch {
              /* ignore */
            }
            try {
              bot.pathfinder.stop()
            } catch {
              /* ignore */
            }
          },
        },
      )

      const verified = evidence.dugCount === count && evidence.failed.length === 0
      return {
        ok: evidence.dugCount > 0,
        verified,
        summary: `挖了 ${evidence.dugCount}/${count} 块 ${want}，背包净变化 ${evidence.invDelta >= 0 ? '+' : ''}${evidence.invDelta}`,
        evidence: {
          ...evidence,
          dug: evidence.dug.slice(0, 20),
          failed: evidence.failed.slice(0, 10),
          sample: evidence.dug[0] ? { pos: evidence.dug[0].pos, before: evidence.dug[0].beforeName, after: evidence.dug[0].afterName } : null,
        },
        hint:
          evidence.dugCount < count
            ? `差 ${count - evidence.dugCount} 块。${evidence.failed[0]?.reason ? `第一个失败原因：${evidence.failed[0].reason}` : '可能附近没这种方块了、够不着、或者掉进水里/岩浆里了。'}`
            : undefined,
      }
    }

    const target = resolveTarget(session, args)
    if (!target) return fail('mine', '要么给 block（挖附近的某种方块），要么给 x/y/z（挖那一个方块）')
    const block = blockAt(bot, target)
    if (!block) return fail('mine', `那个位置没有方块数据（${target.x},${target.y},${target.z}）`)
    if (dist(bot.entity.position, block.position) > 5) {
    }
    const startedInv = inventoryTotal(bot)
    const result = await session.runAction(
      'mine',
      block.name,
      async (signal) => {
        if (dist(bot.entity.position, block.position) > 5) {
          await walkTo(session, bot, block.position, { range: 2, timeoutMs: 30000 }, signal)
        }
        const dug = await digOne(session, bot, blockAt(bot, block.position), signal)
        if (args.pickup !== false) dug.picked = await pickupDrops(session, bot, signal, { radius: 6, maxItems: 3, timeoutMs: 5000 })
        return { dug, invDelta: inventoryTotal(bot) - startedInv }
      },
      {
        timeoutMs: 60000,
        onAbort: () => {
          try {
            bot.stopDigging()
          } catch {
            /* ignore */
          }
        },
      },
    )
    const after = blockName(bot, target)
    const verified = after === 'air' && result.dug.countAfter >= result.dug.countBefore
    return {
      ok: true,
      verified,
      summary: verified
        ? `${result.dug.beforeName} 挖掉了，那格现在是空气，背包里 ${result.dug.beforeName} 从 ${result.dug.countBefore} 变成 ${result.dug.countAfter}`
        : `${result.dug.beforeName} 按说挖了，但回读不对：那格现在是 ${after}，背包净变化 ${result.invDelta}`,
      evidence: {
        pos: roundPos(block.position),
        before: result.dug.beforeName,
        after,
        tool: result.dug.tool,
        countBefore: result.dug.countBefore,
        countAfter: result.dug.countAfter,
        invDelta: result.invDelta,
        picked: result.dug.picked,
      },
      hint: verified ? undefined : '东西可能被水冲走、掉进岩浆、或者被别的玩家捡走了。',
    }
  } catch (error) {
    return fail('mine', error)
  }
}

// ---------------------------------------------------------------------------
// 放
// ---------------------------------------------------------------------------

/**
 * 核心放置。碰到"要垫在自己脚下"的情况会先跳一下再放。
 */
export async function placeBlockAt(session, bot, { position, blockName: wantName, state, sneak = false, timeoutMs = 8000 }, signal) {
  const target = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }
  const want = normalizeName(wantName)
  const current = blockAt(bot, target)
  if (blockMatches(current, want) && verifyState(current, state)) {
    return { already: true, verified: true, pos: target, block: want }
  }
  if (current && current.boundingBox === 'block') {
    throw new Error(`那格已经有 ${current.name} 了，先挖掉`)
  }
  if (!bot.entity.onGround) {
    await waitFor(() => bot.entity.onGround, { timeoutMs: 1500, intervalMs: 20, signal })
  }
  const item = await equipByName(bot, want, 'hand')

  const here = bot.entity.position
  const isTower = Math.floor(here.x) === target.x && Math.floor(here.z) === target.z && Math.abs(here.y - target.y) < 0.8

  if (isTower) {
    // 垫柱子：跳起来往脚下放（站着放会被服务器拒，见 README 的坑）
    const ref = blockAt(bot, { x: target.x, y: target.y - 1, z: target.z })
    if (!isSolidBlock(ref)) throw new Error('脚下没东西，垫不上去')
    bot.setControlState('jump', true)
    const airborne = await waitFor(() => bot.entity.position.y >= target.y + 1.05, { timeoutMs: 1500, intervalMs: 5, signal })
    if (!airborne) throw new Error('跳不起来（头顶可能被挡住了）')
    await softWait(bot.look(bot.entity.yaw, Math.PI / 2, true), 300)
    await bot.waitForTicks?.(2)
    const placing = bot._placeBlockWithOptions
      ? bot._placeBlockWithOptions(ref, { x: 0, y: 1, z: 0 }, { swingArm: 'right', forceLook: 'ignore' })
      : bot.placeBlock(ref, { x: 0, y: 1, z: 0 })
    await abortable(placing, { signal, timeoutMs, onAbort: () => bot.setControlState('jump', false) })
    bot.setControlState('jump', false)
    await sleep(400)
    const towerAfter = blockAt(bot, target)
    return { verified: towerAfter?.name === want, pos: target, placed: towerAfter?.name ?? null, expected: want, item: item.name, tower: true }
  }

  // 普通放置：先规划（站哪、点哪块哪个面、点面上哪个点），再执行
  const planned = planPlacement({ bot, target: [target.x, target.y, target.z], name: want, state })
  if (planned.error) {
    throw new Error(`${planned.error}${planned.detail?.length ? `（${planned.detail.join('；')}）` : ''}`)
  }
  const { plan } = planned
  const standPos = { x: plan.stand[0] + 0.5, y: plan.stand[1], z: plan.stand[2] + 0.5 }
  throwIfAborted(signal)
  if (dist(bot.entity.position, standPos) > 1.4) {
    await walkTo(session, bot, standPos, { range: 0.6, timeoutMs: 25000 }, signal)
  }
  const clickVec = pointAt(bot, plan.clickPoint[0], plan.clickPoint[1], plan.clickPoint[2])
  if (process.env.MC_DEBUG_PLACE) {
    const p = bot.entity.position
    console.log('[place] stand', plan.stand, 'bot', [p.x.toFixed(2), p.y.toFixed(2), p.z.toFixed(2)], 'click', plan.clickPoint.map((n) => n.toFixed(2)), 'family', planned.family, 'expected', plan.expected)
  }
  await softWait(bot.lookAt(clickVec, true), 800)
  if (process.env.MC_DEBUG_PLACE) console.log('[place] yaw after look', bot.entity.yaw.toFixed(2), 'facing', (await import('./placement.js')).facingFromYaw(bot.entity.yaw))
  await bot.waitForTicks?.(2)
  if (sneak || plan.sneak) bot.setControlState('sneak', true)
  try {
    const placing = bot._placeBlockWithOptions
      ? bot._placeBlockWithOptions(
          blockAt(bot, plan.refPos),
          { x: plan.face[0], y: plan.face[1], z: plan.face[2] },
          { swingArm: 'right', forceLook: 'ignore', delta: { x: plan.delta[0], y: plan.delta[1], z: plan.delta[2] } },
        )
      : bot.placeBlock(blockAt(bot, plan.refPos), { x: plan.face[0], y: plan.face[1], z: plan.face[2] })
    await abortable(placing, { signal, timeoutMs })
  } finally {
    if (sneak || plan.sneak) bot.setControlState('sneak', false)
  }
  await sleep(80)
  const after = blockAt(bot, target)
  const okState = verifyState(after, plan.expected)
  return {
    verified: blockMatches(after, want) && okState,
    pos: target,
    placed: after?.name ?? null,
    expected: want,
    expectedState: plan.expected ?? null,
    actualState: after?.getProperties?.() ?? null,
    stateOk: okState,
    item: item.name,
    ref: { pos: plan.refPos, name: plan.refName, face: plan.face },
    family: planned.family,
  }
}

export async function place(session, args) {
  const bot = session.requireBot()
  try {
    const wantName = args.block ? normalizeName(args.block) : itemName(bot.heldItem)
    if (!wantName) return fail('place', '手上没拿东西，也没说放什么。给个 block，或者先在 mc_inventory 里换到手上。')

    if (args.tower !== undefined) {
      const height = Math.min(Math.max(Number(args.tower) || 1, 1), 32)
      const startY = bot.entity.position.y
      const evidence = await session.runAction(
        'tower',
        `x${height} ${wantName}`,
        async (signal) => {
          let built = 0
          for (let i = 0; i < height; i += 1) {
            throwIfAborted(signal)
            const feet = feetPos(bot)
            const result = await placeBlockAt(session, bot, { position: feet, blockName: wantName }, signal)
            if (!result.verified) break
            built += 1
            await sleep(180)
          }
          return { built, fromY: round(startY, 2), toY: round(bot.entity.position.y, 2) }
        },
        { timeoutMs: height * 4000, onAbort: () => { try { bot.setControlState('jump', false) } catch { /* ignore */ } } },
      )
      return {
        ok: evidence.built > 0,
        verified: evidence.built === height,
        summary: `垫了 ${evidence.built}/${height} 格高，现在 y=${evidence.toY}`,
        evidence,
      }
    }

    const target = resolveTarget(session, args)
    if (!target) return fail('place', '给 x/y/z（放哪一格）或者 tower（要垫几格高）')
    if (dist(bot.entity.position, target) > 4.5) {
      await walkTo(session, bot, target, { range: 2, timeoutMs: 30000 })
    }
    const result = await session.runAction('place', `${wantName}${describeState(wantName, args.state)} @ ${target.x} ${target.y} ${target.z}`, async (signal) =>
      placeBlockAt(session, bot, { position: target, blockName: wantName, state: args.state, sneak: args.sneak }, signal),
    )
    return {
      ok: result.verified,
      verified: result.verified,
      summary: result.verified
        ? `放好了：${target.x} ${target.y} ${target.z} 现在是 ${result.placed}${describeState(result.placed, result.actualState)}`
        : `放了，但那格是 ${result.placed}${describeState(result.placed, result.actualState)}，不是 ${result.expected}${describeState(result.expected, result.expectedState)}`,
      evidence: result,
      hint: result.verified ? undefined : '可能被别的方块占了、被水流冲掉，或者拿错了方块。',
    }
  } catch (error) {
    return fail('place', error)
  }
}

// ---------------------------------------------------------------------------
// 用（交互、吃、睡、打）
// ---------------------------------------------------------------------------

/**
 * 打实体。26.2 把 attack 拆成了单独的包（0x01 attack {entityId}），
 * mineflayer 的 bot.attack 还在用旧 use_entity，打上去没反应；这里两个都试。
 */
export async function attackEntity(session, entity, { swing = true } = {}) {
  const bot = session.requireBot()
  if (!entity || entity.id === undefined) throw new Error('没有攻击目标')
  let sent = false
  try {
    bot._client.write('attack', { entityId: entity.id })
    sent = true
  } catch {
    sent = false
  }
  if (!sent) {
    try {
      bot.attack(entity, false)
    } catch {
      /* ignore */
    }
  }
  if (swing) {
    try {
      bot.swingArm('right')
    } catch {
      /* ignore */
    }
  }
  return { ok: true, verified: true, summary: `打了 ${entity.name ?? entity.id}` }
}


/**
 * 创造模式：从创造物品栏"拿"一个物品到背包。
 * 等价于玩家打开创造物品栏拖一个出来（发送 creative inventory action）。
 */
export async function creativeGive(session, args) {
  const bot = session.requireBot()
  if (bot.game.gameMode !== 'creative') {
    return fail('creative', `现在是 ${bot.game.gameMode}，创造背包只在创造模式可用`)
  }
  const name = normalizeName(args.item)
  const data = bot.registry.itemsByName?.[name]
  if (!data) return fail('creative', `没有这个物品：${args.item}`)
  const count = Math.max(1, Math.min(Number(args.count) || 1, data.stackSize ?? 64))
  const slot = Number.isInteger(Number(args.slot)) ? Number(args.slot) : 36
  let Item
  try {
    const mod = await import('prismarine-item')
    const factory = mod.default ?? mod
    Item = factory(bot.version)
  } catch (error) {
    return fail('creative', `拿不了物品：${describeError(error)}`)
  }
  try {
    await bot.creative.setInventorySlot(slot, new Item(data.id, count))
  } catch (error) {
    return fail('creative', `创造背包拒绝：${describeError(error)}`)
  }
  const got = bot.inventory.items().find((i) => i.name === name)
  return {
    ok: true,
    verified: Boolean(got && got.count >= count),
    summary: `从创造背包拿了 ${name} x${count}（槽 ${slot}）`,
    evidence: { item: name, count, slot, inBag: got ? { name: got.name, count: got.count, slot: got.slot } : null },
  }
}

export async function attack(session, args) {
  const bot = session.requireBot()
  const hits = Math.min(Math.max(Number(args.hits) || 1, 1), 40)
  const retreatBelow = Number(args.retreatBelow ?? 8)
  try {
    let entity = null
    if (args.entityId !== undefined) entity = bot.entities[args.entityId] ?? null
    if (!entity && args.nearest) {
      const p = bot.entity.position
      entity = Object.values(bot.entities || {})
        .filter((e) => e !== bot.entity && e.position && (e.kind === 'Hostile mobs' || e.type === 'mob' || e.type === 'player'))
        .sort((a, b) => dist(p, a.position) - dist(p, b.position))[0] ?? null
    }
    if (!entity) return fail('attack', '找不到攻击目标。给 entityId，或者 nearest:true')

    const evidence = await session.runAction(
      'attack',
      `${entity.name ?? entity.username ?? entity.id}`,
      async (signal) => {
        const startHealth = entity.health ?? null
        let landed = 0
        for (let i = 0; i < hits; i += 1) {
          throwIfAborted(signal)
          if (!entity.isValid || entity.isValid === false) break
          if (bot.health <= retreatBelow) {
            session.pushEvent('warn', `血只剩 ${Math.round(bot.health)}，不打了`)
            break
          }
          const d = dist(bot.entity.position, entity.position)
          if (d > 3.2) {
            try {
              await walkTo(session, bot, entity.position, { range: 1.5, timeoutMs: 4000 }, signal)
            } catch (error) {
              if (error instanceof AbortError) throw error
              break
            }
          }
          await softWait(bot.lookAt(entity.position.offset(0, 1.2, 0), true))
          await sleep(80)
          await attackEntity(session, entity)
          landed += 1
          await abortable(sleep(640), { signal })
        }
        return {
          target: entity.name ?? entity.username ?? String(entity.id),
          landed,
          targetHealthBefore: startHealth,
          targetHealthAfter: entity.health ?? null,
          gone: !entity.isValid || entity.isValid === false,
          selfHealth: round(bot.health, 1),
        }
      },
      { timeoutMs: hits * 3000 + 5000 },
    )
    const hurt = evidence.targetHealthAfter !== null && evidence.targetHealthBefore !== null
      ? evidence.targetHealthAfter < evidence.targetHealthBefore
      : evidence.gone
    return {
      ok: true,
      verified: Boolean(hurt),
      summary: `打了 ${evidence.landed} 下${evidence.gone ? '，它没了' : hurt ? `，它血量 ${evidence.targetHealthBefore} → ${evidence.targetHealthAfter}` : '，看不出掉血'}`,
      evidence,
      hint: hurt ? undefined : '可能没打中（距离/看不见），或者它免疫。',
    }
  } catch (error) {
    return fail('attack', error)
  }
}

export async function eat(session, args) {
  const bot = session.requireBot()
  try {
    const preference = args.food ? normalizeName(args.food) : null
    const before = bot.food
    const evidence = await session.runAction('eat', preference ?? '随便吃点', async (signal) => {
      const items = preference ? findItems(bot, preference) : bot.inventory.items()
      if (!items.length) throw new Error(preference ? `背包里没有 ${preference}` : '背包里没有吃的')
      let best = null
      for (const item of items) {
        const table = bot.registry?.foodsByName?.[item.name]
        const points = table?.foodPoints ?? (preference ? 1 : 0)
        if (!best || points > best.points) best = { item, points, name: item.name }
      }
      if (!best || best.points <= 0) throw new Error(preference ? `${preference} 不是能吃的东西` : '背包里没有能吃的东西')
      await bot.equip(best.item, 'hand')
      throwIfAborted(signal)
      await abortable(bot.consume(), { signal, timeoutMs: 8000 })
      await sleep(200)
      return { item: best.name, foodBefore: before, foodAfter: bot.food }
    })
    return {
      ok: true,
      verified: evidence.foodAfter > evidence.foodBefore || bot.food === 20,
      summary: `吃了 ${evidence.item}，饱食度 ${evidence.foodBefore} → ${evidence.foodAfter}`,
      evidence,
    }
  } catch (error) {
    return fail('eat', error)
  }
}

export async function sleep_(session, args) {
  const bot = session.requireBot()
  try {
    const timeOfDay = bot.time?.timeOfDay ?? 0
    const night = timeOfDay > 12800 && timeOfDay < 23200
    if (!night && !bot.isRaining) {
      throw new Error('现在是白天，睡觉没意义。等天黑了再来（雷雨天也行）')
    }
    const evidence = await session.runAction('sleep', '找床', async (signal) => {
      let bed = null
      if (args.x !== undefined) bed = blockAt(bot, args)
      if (!bed || !bed.name.endsWith('_bed')) {
        const ids = Object.values(bot.registry?.blocksByName ?? {}).filter((b) => b.name.endsWith('_bed')).map((b) => b.id)
        bed = bot.findBlock({ matching: ids, maxDistance: 24 })
      }
      if (!bed) throw new Error('24 格内没找到床')
      if (dist(bot.entity.position, bed.position) > 2.5) await walkTo(session, bot, bed.position, { range: 1.5, timeoutMs: 20000 }, signal)
      throwIfAborted(signal)
      await abortable(bot.sleep(bed), { signal, timeoutMs: 10000 })
      await sleep(300)
      return {
        bed: { x: bed.position.x, y: bed.position.y, z: bed.position.z, name: bed.name },
        sleeping: bot.isSleeping === true,
        timeBefore: bot.time?.timeOfDay ?? null,
      }
    })
    return {
      ok: evidence.sleeping,
      verified: evidence.sleeping,
      summary: evidence.sleeping ? '躺下了，等天亮' : '爬上床了但没睡着（可能是白天/打雷/床被占）',
      evidence,
      hint: evidence.sleeping ? undefined : '只能在晚上或雷雨睡觉，床也不能被占。白天睡觉是白搭。',
    }
  } catch (error) {
    return fail('sleep', error)
  }
}

export async function use(session, args) {
  const bot = session.requireBot()
  const action = String(args.action || 'block').toLowerCase()
  try {
    if (action === 'sleep') return await sleep_(session, args)
    if (action === 'eat') return await eat(session, args)
    if (action === 'attack') return await attack(session, args)

    if (action === 'wake') {
      await session.runAction('wake', '', async () => {
        bot.wake()
      })
      return { ok: true, verified: bot.isSleeping !== true, summary: '起来了', evidence: { sleeping: bot.isSleeping === true } }
    }

    if (action === 'close') {
      const window = bot.currentWindow
      if (!window) return { ok: true, verified: true, summary: '本来就没开着界面', evidence: { window: null } }
      await session.runAction('close', '', async () => {
        window.close()
      })
      await sleep(150)
      return { ok: true, verified: bot.currentWindow === null, summary: '界面关掉了，能走路了', evidence: { stillOpen: bot.currentWindow !== null } }
    }

    if (action === 'item') {
      const evidence = await session.runAction('useItem', '', async (signal) => {
        if (args.item) await equipByName(bot, args.item, args.offhand ? 'offhand' : 'hand')
        const before = itemName(args.offhand ? bot.inventory.slots[45] : bot.heldItem)
        bot.activateItem(Boolean(args.offhand))
        await abortable(sleep(Math.min(Number(args.holdMs) || 400, 30000)), { signal })
        bot.deactivateItem()
        await sleep(120)
        return { item: before, used: true }
      })
      return { ok: true, verified: null, summary: `用了 ${evidence.item}`, evidence, hint: '用物品的效果只能从 mc_status 里看变化（比如血、箭、水）。' }
    }

    if (action === 'entity') {
      const entity = bot.entities[args.entityId]
      if (!entity) return fail('use', `没有实体 ${args.entityId}`)
      const startInv = inventoryTotal(bot)
      const evidence = await session.runAction('useEntity', entity.name ?? String(args.entityId), async (signal) => {
        if (args.item) await equipByName(bot, args.item, 'hand')
        if (dist(bot.entity.position, entity.position) > 3) await walkTo(session, bot, entity.position, { range: 1.5, timeoutMs: 10000 }, signal)
        await interactEntity(session, entity)
        await sleep(300)
        return {
          entity: entity.name ?? entity.username ?? String(args.entityId),
          item: itemName(bot.heldItem),
          invDelta: inventoryTotal(bot) - startInv,
        }
      })
      return {
        ok: true,
        verified: evidence.invDelta > 0 ? true : null,
        summary: `对 ${evidence.entity} 用了 ${evidence.item ?? '手'}${evidence.invDelta ? `，背包 +${evidence.invDelta}` : ''}`,
        evidence,
        hint: evidence.invDelta > 0 ? undefined : '喂食/剪毛/挤奶这类动作没法直接回读，去 mc_status 看背包和实体状态。',
      }
    }

    // 默认：右键方块（门、按钮、拉杆、工作台、箱子……）
    const target = resolveTarget(session, args)
    if (!target) return fail('use', '给 x/y/z（哪一格方块），或者 action=entity/sleep/eat/attack/item/close')
    if (dist(bot.entity.position, target) > 4.5) await walkTo(session, bot, target, { range: 2, timeoutMs: 20000 })
    const evidence = await session.runAction('useBlock', `${target.x} ${target.y} ${target.z}`, async (signal) => {
      const block = blockAt(bot, target)
      if (!block) throw new Error('那格没有方块')
      const beforeProps = safeProps(block)
      await softWait(bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true))
      throwIfAborted(signal)
      await abortable(bot.activateBlock(block), { signal, timeoutMs: 5000 })
      await sleep(250)
      const afterBlock = blockAt(bot, target)
      let contents = null
      if (bot.currentWindow) {
        // 开箱子/工作台会留下一个界面，界面开着就走不了路：看一眼就顺手关上
        contents = readWindow(bot.currentWindow).slice(0, 40)
        try {
          bot.currentWindow.close()
          await sleep(120)
        } catch {
          /* ignore */
        }
      }
      return {
        block: block.name,
        beforeProps,
        afterProps: safeProps(afterBlock),
        windowOpen: contents !== null,
        contents,
      }
    })
    const changed = JSON.stringify(evidence.beforeProps) !== JSON.stringify(evidence.afterProps)
    return {
      ok: true,
      verified: changed || Boolean(evidence.windowOpen),
      summary: evidence.windowOpen
        ? `打开了 ${evidence.block} 的界面`
        : changed
          ? `用了 ${evidence.block}，状态变了`
          : `右键了 ${evidence.block}，但看不出变化`,
      evidence,
      hint: changed || evidence.windowOpen ? undefined : '门/按钮这些应该会变状态；没变可能是够不着或者被挡住。',
    }
  } catch (error) {
    return fail('use', error)
  }
}

function safeProps(block) {
  try {
    return block?.getProperties?.() ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 合成 / 容器 / 背包 / 指令
// ---------------------------------------------------------------------------

export async function craft(session, args) {
  const bot = session.requireBot()
  try {
    const want = normalizeName(args.item)
    const count = Math.min(Math.max(Number(args.count) || 1, 1), 64 * 9)
    const def = bot.registry?.itemsByName?.[want]
    if (!def) return fail('craft', `不认识的物品：${args.item}`)
    const evidence = await session.runAction('craft', `${want} x${count}`, async (signal) => {
      let table = null
      const tableType = bot.registry?.blocksByName?.crafting_table
      if (tableType) table = bot.findBlock({ matching: tableType.id, maxDistance: 32 })
      const needsTable = !bot.recipesFor(def.id, null, 1, null).length
      if (needsTable && !table) {
        throw new Error('这个要在工作台上做，但 32 格内没有工作台')
      }
      if (needsTable && dist(bot.entity.position, table.position) > 2.5) {
        await walkTo(session, bot, table.position, { range: 2, timeoutMs: 30000 }, signal)
        table = blockAt(bot, table.position) ?? table
      }
      const recipes = bot.recipesFor(def.id, null, 1, needsTable ? table : null)
      const recipe = recipes[0]
      if (!recipe) throw new Error(`材料不够，合不了 ${want}`)
      const before = countItem(bot, want)
      throwIfAborted(signal)
      await abortable(bot.craft(recipe, count, needsTable ? table : null), { signal, timeoutMs: 60000 })
      await sleep(150)
      return { item: want, before, after: countItem(bot, want), table: needsTable ? { x: table.position.x, y: table.position.y, z: table.position.z } : null }
    })
    const gained = evidence.after - evidence.before
    return {
      ok: true,
      verified: gained >= count,
      summary: `合成了 ${want}：${evidence.before} → ${evidence.after}（+${gained}）`,
      evidence,
      hint: gained < count ? '数量不对：可能材料只够做一部分，或者中途被打断了。' : undefined,
    }
  } catch (error) {
    return fail('craft', error)
  }
}

function readWindow(window) {
  const out = []
  try {
    window.slots.forEach((item, slot) => {
      if (item) out.push({ slot, name: item.name, count: item.count })
    })
  } catch {
    /* ignore */
  }
  return out
}

export async function container(session, args) {
  const bot = session.requireBot()
  const action = String(args.action || 'open').toLowerCase()
  try {
    if (action === 'smelt') {
      return await smelt(session, args)
    }
    const target = resolveTarget(session, args)
    if (!target) return fail('container', '给 x/y/z（箱子/熔炉在哪一格）')
    const block = blockAt(bot, target)
    if (!block) return fail('container', '那格没有方块')
    if (dist(bot.entity.position, target) > 4.5) await walkTo(session, bot, target, { range: 2, timeoutMs: 25000 })
    const startInv = inventoryTotal(bot)

    if (action === 'open') {
      const evidence = await session.runAction('openContainer', block.name, async (signal) => {
        const window = await abortable(bot.openContainer(blockAt(bot, target)), { signal, timeoutMs: 8000 })
        await sleep(200)
        const contents = readWindow(window)
        window.close()
        await sleep(150)
        return { container: block.name, contents: contents.slice(0, 60), slots: window.slots?.length ?? null }
      })
      return { ok: true, verified: true, summary: `${evidence.container} 里有 ${evidence.contents.length} 种东西`, evidence }
    }

    if (action === 'withdraw' || action === 'deposit') {
      const itemNameWanted = normalizeName(args.item)
      if (!itemNameWanted) return fail('container', '要拿/要放什么？给 item')
      const def = bot.registry?.itemsByName?.[itemNameWanted]
      if (!def) return fail('container', `不认识的物品：${args.item}`)
      const count = Math.min(Math.max(Number(args.count) || 1, 1), 64 * 27)
      const evidence = await session.runAction(action, `${itemNameWanted} x${count}`, async (signal) => {
        const window = await abortable(bot.openContainer(blockAt(bot, target)), { signal, timeoutMs: 8000 })
        await sleep(150)
        if (action === 'withdraw') await window.withdraw(def.id, count, null)
        else await window.deposit(def.id, count, null)
        await sleep(250)
        window.close()
        await sleep(150)
        return { item: itemNameWanted, count, invDelta: inventoryTotal(bot) - startInv, contents: readWindow(window).slice(0, 40) }
      })
      const signed = action === 'withdraw' ? evidence.count : -evidence.count
      return {
        ok: true,
        verified: action === 'withdraw' ? evidence.invDelta > 0 : evidence.invDelta < 0,
        summary: `${action === 'withdraw' ? '拿了' : '放了'} ${itemNameWanted} x${evidence.count}，背包净变化 ${evidence.invDelta >= 0 ? '+' : ''}${evidence.invDelta}`,
        evidence,
      }
    }

    if (action === 'close') {
      if (bot.currentWindow) bot.currentWindow.close()
      return { ok: true, verified: true, summary: '界面关了', evidence: {} }
    }

    return fail('container', `不认识的 action：${action}（open/withdraw/deposit/smelt/close）`)
  } catch (error) {
    try {
      bot.currentWindow?.close()
    } catch {
      /* ignore */
    }
    return fail('container', error)
  }
}

async function smelt(session, args) {
  const bot = session.requireBot()
  const target = resolveTarget(session, args)
  if (!target) return fail('container', '熔炉在哪一格？给 x/y/z')
  const itemWanted = normalizeName(args.item)
  if (!itemWanted) return fail('container', '要烧什么？给 item')
  const count = Math.min(Math.max(Number(args.count) || 1, 1), 64)
  const block = blockAt(bot, target)
  if (!block || !/furnace|smoker|blast_furnace/.test(block.name)) return fail('container', `那格是 ${block?.name ?? '空的'}，不是熔炉`)
  if (dist(bot.entity.position, target) > 4.5) await walkTo(session, bot, target, { range: 2, timeoutMs: 25000 })
  const fuelName = args.fuel ? normalizeName(args.fuel) : null
  try {
    const evidence = await session.runAction('smelt', `${itemWanted} x${count}`, async (signal) => {
      const furnace = await abortable(bot.openFurnace(blockAt(bot, target)), { signal, timeoutMs: 8000 })
      const def = bot.registry?.itemsByName?.[itemWanted]
      if (!def) throw new Error(`不认识的物品：${args.item}`)
      await furnace.putInput(def.id, null, count)
      if (countItem(bot, fuelName ?? 'coal') > 0 || fuelName) {
        const fuelDef = fuelName ? bot.registry?.itemsByName?.[fuelName] : bot.registry?.itemsByName?.coal
        if (fuelDef) {
          try {
            await furnace.putFuel(fuelDef.id, null, Math.max(1, Math.ceil(count / 8)))
          } catch {
            /* 燃料放不进去就先这样，可能炉子里还有 */
          }
        }
      }
      const deadline = Date.now() + Math.min(Number(args.timeoutMs) || 120000, 300000)
      let output = null
      while (Date.now() < deadline) {
        throwIfAborted(signal)
        output = furnace.outputItem()
        if (output && output.count >= count) break
        await abortable(sleep(1000), { signal })
      }
      const taken = output ? await furnace.takeOutput() : null
      await sleep(200)
      furnace.close()
      return { item: itemWanted, taken: taken ? { name: taken.name, count: taken.count } : null, inBag: countItem(bot, itemWanted) }
    })
    return {
      ok: Boolean(evidence.taken),
      verified: Boolean(evidence.taken),
      summary: evidence.taken ? `烧好了：${evidence.item} x${evidence.taken.count}，背包里现在 ${evidence.inBag}` : '等太久没烧出来',
      evidence,
      hint: evidence.taken ? undefined : '可能是燃料不够、原料放不进去，或者熔炉被占着。',
    }
  } catch (error) {
    try {
      bot.currentWindow?.close()
    } catch {
      /* ignore */
    }
    return fail('container', error)
  }
}

export async function inventory(session, args) {
  const bot = session.requireBot()
  const action = String(args.action || 'list').toLowerCase()
  try {
    if (action === 'list') {
      return { ok: true, verified: true, summary: '看背包', evidence: { items: bot.inventory.items().map((it) => ({ name: it.name, count: it.count, slot: it.slot })) } }
    }
    if (action === 'equip') {
      const dest = ['hand', 'offhand', 'head', 'torso', 'legs', 'feet'].includes(args.destination) ? args.destination : 'hand'
      const item = await equipByName(bot, args.item, dest)
      const held = dest === 'hand' ? itemName(bot.heldItem) : itemName(bot.inventory.slots[dest === 'offhand' ? 45 : { head: 5, torso: 6, legs: 7, feet: 8 }[dest]])
      return { ok: true, verified: held === item.name, summary: `${item.name} 换到${dest === 'hand' ? '手上' : dest === 'offhand' ? '副手' : '身上'}了`, evidence: { item: item.name, destination: dest, held } }
    }
    if (action === 'drop') {
      const item = findItems(bot, args.item)[0]
      if (!item) return fail('inventory', `背包里没有 ${args.item}`)
      const count = Math.min(Math.max(Number(args.count) || item.count, 1), item.count)
      const before = countItem(bot, item.name)
      await session.runAction('drop', `${item.name} x${count}`, async () => {
        await bot.toss(item.type, item.metadata ?? null, count)
        await sleep(200)
      })
      const after = countItem(bot, item.name)
      return { ok: true, verified: after <= before - count, summary: `扔掉 ${item.name} x${count}，剩 ${after}`, evidence: { before, after } }
    }
    if (action === 'quickbar') {
      const slot = Math.min(Math.max(Number(args.slot) || 0, 0), 8)
      bot.setQuickBarSlot(slot)
      await sleep(100)
      return { ok: true, verified: bot.quickBarSlot === slot, summary: `快捷栏换到第 ${slot + 1} 格（${itemName(bot.heldItem) ?? '空'}）`, evidence: { slot, held: itemName(bot.heldItem) } }
    }
    return fail('inventory', `不认识的 action：${action}（list/equip/drop/quickbar）`)
  } catch (error) {
    return fail('inventory', error)
  }
}

export async function command(session, args) {
  const bot = session.requireBot()
  const raw = String(args.command || '').trim()
  if (!raw) return fail('command', '要执行什么指令？')
  const text = raw.startsWith('/') ? raw : `/${raw}`
  try {
    await session.runAction('command', text, async () => {
      bot.chat(text)
      await sleep(150)
    })
    return {
      ok: true,
      verified: null,
      summary: `发了 ${text}`,
      evidence: { command: text },
      hint: '指令没回执，只能从 mc_status 看世界有没有变。生存服里大多数指令没权限，用了就是作弊，慎重。',
    }
  } catch (error) {
    return fail('command', error)
  }
}

function fail(tool, error) {
  if (error instanceof AbortError) {
    return { ok: false, verified: false, summary: `${tool} 被打断了`, evidence: { error: describeError(error) }, hint: '保命反射或者别的动作打断了它。看看现在周围什么情况。' }
  }
  if (error instanceof TimeoutError) {
    return { ok: false, verified: false, summary: `${tool} 超时`, evidence: { error: describeError(error) }, hint: '时间到了还没做完，可以再试一次，或者换个做法。' }
  }
  return {
    ok: false,
    verified: false,
    summary: `${tool} 失败：${describeError(error)}`,
    evidence: { error: describeError(error) },
    hint: hintFor(error),
  }
}

function hintFor(error) {
  const msg = String(error?.message || '')
  if (/还没连上/.test(msg)) return '先 mc_connect。'
  if (/够不着/.test(msg)) return '先走到跟前（mc_move），再动手。'
  if (/寻路/.test(msg)) return '寻路可能被地形卡住了，试试 mc_control 手动挪一下。'
  if (/busy|没做完/i.test(msg)) return '等上一个动作结束，或者先 mc_status 看它在干嘛。'
  return undefined
}

export { fail }
