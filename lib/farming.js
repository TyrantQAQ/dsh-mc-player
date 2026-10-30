/**
 * 种地：锄地、下种、收成熟的。
 *
 * 只碰原版四种主粮（wheat / carrots / potatoes / beetroots）——
 * 它们的方块状态简单（就一个 age），验证起来干净。
 */

import { sleep, waitFor } from './util.js'
import { pickupDrops } from './actions.js'

export const CROPS = {
  wheat: { seed: 'wheat_seeds', block: 'wheat', maxAge: 7 },
  carrots: { seed: 'carrot', block: 'carrots', maxAge: 7 },
  potatoes: { seed: 'potato', block: 'potatoes', maxAge: 7 },
  beetroots: { seed: 'beetroot_seeds', block: 'beetroots', maxAge: 3 },
}

const TILLABLE = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'dirt_path'])

function blockAt(bot, p) {
  const V = bot.entity.position.constructor
  return bot.blockAt(new V(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), false)
}

function ageOf(block) {
  try {
    const props = block?.getProperties?.() ?? {}
    return Number(props.age)
  } catch {
    return NaN
  }
}

function cropSpec(name) {
  const key = String(name || '').toLowerCase()
  return CROPS[key] ?? null
}

export async function farm(session, args) {
  const bot = session.requireBot()
  const action = String(args.action || 'harvest').toLowerCase()
  if (action === 'till') return till(session, args)
  if (action === 'plant') return plant(session, args)
  if (action === 'harvest') return harvest(session, args)
  throw new Error(`不认识的 action：${action}（till / plant / harvest）`)
}

async function till(session, args) {
  const bot = session.requireBot()
  const target = blockAt(bot, args)
  if (!target) throw new Error('那格没有方块')
  if (target.name === 'farmland') {
    return { ok: true, verified: true, summary: '那格已经是耕地了', evidence: { pos: args } }
  }
  if (!TILLABLE.has(target.name)) throw new Error(`那格是 ${target.name}，锄不了`)
  const above = blockAt(bot, { x: args.x, y: args.y + 1, z: args.z })
  if (above && above.boundingBox === 'block') throw new Error('上面有方块，锄不了')
  const hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'))
  if (!hoe) throw new Error('背包里没有锄头')
  if (bot.heldItem?.name !== hoe.name) await bot.equip(hoe, 'hand')
  await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true)
  await bot.activateBlock(target)
  const ok = await waitFor(() => blockAt(bot, args)?.name === 'farmland', { timeoutMs: 3000 })
  return {
    ok: true,
    verified: Boolean(ok),
    summary: ok ? `锄好了：${args.x} ${args.y} ${args.z} 现在是耕地` : `锄了，但那格是 ${blockAt(bot, args)?.name}`,
    evidence: { pos: args, block: blockAt(bot, args)?.name ?? null },
  }
}

async function plant(session, args) {
  const bot = session.requireBot()
  const spec = cropSpec(args.crop)
  if (!spec) throw new Error(`不认识的作物：${args.crop}（支持 ${Object.keys(CROPS).join(' / ')}）`)
  const ground = blockAt(bot, args)
  if (!ground || !['farmland', 'dirt', 'grass_block'].includes(ground.name)) {
    throw new Error(`那格是 ${ground?.name ?? '空的'}，要先锄成耕地`)
  }
  const above = blockAt(bot, { x: args.x, y: args.y + 1, z: args.z })
  if (above && above.boundingBox === 'block') throw new Error('上面有方块，种不下')
  const seed = bot.inventory.items().find((i) => i.name === spec.seed)
  if (!seed) throw new Error(`背包里没有 ${spec.seed}`)
  if (bot.heldItem?.name !== seed.name) await bot.equip(seed, 'hand')
  await bot.lookAt(ground.position.offset(0.5, 0.5, 0.5), true)
  await bot.activateBlock(ground)
  const cropBlock = await waitFor(() => {
    const b = blockAt(bot, { x: args.x, y: args.y + 1, z: args.z })
    return b?.name === spec.block ? b : null
  }, { timeoutMs: 3000 })
  return {
    ok: true,
    verified: Boolean(cropBlock),
    summary: cropBlock ? `种下了 ${spec.block}（age=${ageOf(cropBlock)}）` : `种了，但上面是 ${blockAt(bot, { x: args.x, y: args.y + 1, z: args.z })?.name}`,
    evidence: { pos: args, crop: spec.block, age: cropBlock ? ageOf(cropBlock) : null },
  }
}

async function harvest(session, args) {
  const bot = session.requireBot()
  const radius = Math.min(Math.max(Number(args.radius) || 8, 2), 32)
  const cropNames = Object.values(CROPS).map((c) => c.block)
  const ids = cropNames.map((n) => bot.registry.blocksByName[n]?.id).filter((x) => x !== undefined)
  const startedInv = bot.inventory.items().reduce((s, i) => s + i.count, 0)
  const harvested = []
  const failed = []
  let positions = []
  try {
    positions = bot.findBlocks({ matching: ids, maxDistance: radius, count: 64 }) ?? []
  } catch {
    positions = []
  }
  for (const pos of positions) {
    const block = blockAt(bot, pos)
    if (!block) continue
    const spec = Object.values(CROPS).find((c) => c.block === block.name)
    if (!spec || ageOf(block) < spec.maxAge) continue
    try {
      await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true)
      await bot.dig(block)
      await sleep(150)
      if (args.replant !== false) {
        const ground = blockAt(bot, { x: pos.x, y: pos.y - 1, z: pos.z })
        if (ground?.name === 'farmland') {
          const seed = bot.inventory.items().find((it) => it.name === spec.seed)
          if (seed) {
            if (bot.heldItem?.name !== seed.name) await bot.equip(seed, 'hand')
            await bot.activateBlock(ground)
            await sleep(100)
          }
        }
      }
      harvested.push({ pos: { x: pos.x, y: pos.y, z: pos.z }, crop: block.name })
    } catch (error) {
      failed.push({ pos, reason: error?.message || String(error) })
    }
  }
  const picked = await pickupDrops(session, bot, undefined, { radius: 6, maxItems: 8, timeoutMs: 5000 })
  const invDelta = bot.inventory.items().reduce((s, i) => s + i.count, 0) - startedInv
  return {
    ok: true,
    verified: harvested.length > 0 && invDelta > 0,
    summary: `收了 ${harvested.length} 株成熟作物，背包净变化 ${invDelta >= 0 ? '+' : ''}${invDelta}`,
    evidence: { harvested: harvested.slice(0, 20), failed: failed.slice(0, 5), invDelta, picked, radius, scanned: positions.length },
    hint: harvested.length ? undefined : '附近没有成熟作物（看 age 是不是满了），或者还没浇水/没光照。',
  }
}
