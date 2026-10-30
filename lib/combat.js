/**
 * 打架：挑威胁最大的先打、自动换最好的武器、血低就吃、打不过就退。
 *
 * 不做的事（刻意）：不远程、不放风筝、不追到天涯海角。苦力怕不近战——
 * 它在 26.2 上炸一下能送走半管血，插件只负责退开并报给大脑。
 */

import { sleep, dist } from './util.js'
import { move, eat, pickupDrops, attackEntity } from './actions.js'

const HOSTILES = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'witch', 'enderman', 'slime', 'magma_cube', 'pillager', 'vindicator', 'ravager', 'phantom',
  'blaze', 'piglin_brute', 'zombified_piglin', 'zoglin', 'hoglin', 'warden', 'breeze', 'silverfish', 'endermite',
])

const THREAT = {
  warden: 12, creeper: 10, ravager: 9, witch: 8, skeleton: 7, stray: 7, bogged: 7, blaze: 7, breeze: 6,
  pillager: 6, vindicator: 6, enderman: 6, phantom: 5, zombie: 5, husk: 5, drowned: 5, spider: 4,
  cave_spider: 4, slime: 3, magma_cube: 3, silverfish: 3, endermite: 3, zombified_piglin: 4,
  zoglin: 8, hoglin: 6, piglin_brute: 7,
}

const TIER = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 }

const BOW_RANGE = 7

function hasBowAndArrows(bot) {
  try {
    const items = bot.inventory.items()
    return items.some((i) => i.name === 'bow') && items.some((i) => i.name === 'arrow')
  } catch {
    return false
  }
}

/** 拉弓射一箭（只对 7 格外的目标用），射完换回近战武器 */
async function shootBow(bot, target) {
  const bow = bot.inventory.items().find((i) => i.name === 'bow')
  if (!bow) return false
  await bot.lookAt(target.position.offset(0, (target.height ?? 1.8) * 0.8, 0), true)
  if (bot.heldItem?.name !== 'bow') await bot.equip(bow, 'hand')
  const d = target.position.distanceTo(bot.entity.position)
  bot.activateItem()
  // 拉弓的时候也在后退：这才是放风筝。太远了就别再退，免得把它甩掉
  if (d < 9) bot.setControlState('back', true)
  await sleep(1100) // 拉满
  bot.deactivateItem()
  bot.setControlState('back', false)
  await sleep(250)
  await equipBestWeapon(bot)
  return true
}

export function isHostile(entity) {
  return Boolean(entity && HOSTILES.has(entity.name) && entity.position)
}

function weaponScore(item) {
  const m = /^(netherite|diamond|iron|stone|golden|wooden)_(sword|axe)$/.exec(item?.name ?? '')
  if (!m) return -1
  return (TIER[m[1]] ?? 0) * 10 + (m[2] === 'sword' ? 2 : 1)
}

export async function equipBestWeapon(bot) {
  const items = bot.inventory.items().filter((i) => weaponScore(i) > 0)
  if (!items.length) return null
  items.sort((a, b) => weaponScore(b) - weaponScore(a))
  const best = items[0]
  if (bot.heldItem?.name !== best.name) await bot.equip(best, 'hand')
  return best.name
}

function nearestThreats(bot, radius) {
  return Object.values(bot.entities || {})
    .filter(isHostile)
    .map((e) => ({ e, d: dist(bot.entity.position, e.position) }))
    .filter((x) => x.d <= radius)
    .sort((a, b) => (THREAT[b.e.name] ?? 3) - (THREAT[a.e.name] ?? 3) || a.d - b.d)
}

function inventoryTotal(bot) {
  try {
    return bot.inventory.items().reduce((s, i) => s + i.count, 0)
  } catch {
    return 0
  }
}

export async function fight(session, args = {}) {
  const bot = session.requireBot()
  const radius = Math.min(Math.max(Number(args.radius) || 12, 4), 32)
  const retreatBelow = Math.min(Math.max(Number(args.retreatBelow) || 6, 2), 20)
  const eatBelow = Math.min(Math.max(Number(args.eatBelow) || 12, 3), 20)
  const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 90000, 5000), 300000)

  const weapon = await equipBestWeapon(bot)
  bot.__fighting = true

  // 有盾就举盾：格挡能吃掉大部分近战伤害，冷却/后退的时候举着，出手前放下
  const shield = (() => {
    try {
      return bot.inventory.items().find((i) => i.name === 'shield') ?? null
    } catch {
      return null
    }
  })()
  let shieldUp = false
  const setShield = async (on) => {
    if (!shield || shieldUp === on) return
    try {
      if (on) bot.activateItem(true)
      else bot.deactivateItem()
      shieldUp = on
      await sleep(60)
    } catch {
      /* ignore */
    }
  }
  if (shield) await bot.equip(shield, 'offhand').catch(() => {})
  const startHealth = bot.health
  const startInv = inventoryTotal(bot)
  const gone = []
  const onGone = (entity) => {
    if (entity && HOSTILES.has(entity.name)) gone.push(entity.name)
  }
  bot.on('entityGone', onGone)

  let eaten = 0
  let retreated = false
  let lastAttack = 0
  let rounds = 0
  let eatCooldown = 0
  let eatError = null
  let focusId = null
  try {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      rounds += 1
      if (rounds > 4000) break // 防跑飞：一步至少 150ms，4000 步足够打十分钟
      await sleep(150)
      const threats = nearestThreats(bot, radius)
      if (!threats.length) break
      if (bot.health <= 0) break

      if (bot.health <= retreatBelow) {
        retreated = true
        const t = threats[0]
        const p = bot.entity.position
        const away = p.offset((p.x - t.e.position.x) || 1, 0, (p.z - t.e.position.z) || 1).normalize().scale(8)
        await move(session, { x: Math.floor(p.x + away.x), y: Math.floor(p.y) + 1, z: Math.floor(p.z + away.z), range: 2, timeoutMs: 6000 }).catch(() => {})
        break
      }

      const nearestD = threats[0]?.d ?? 99
      if (bot.health <= eatBelow && Date.now() >= eatCooldown && (nearestD > 5 || bot.health <= 8)) {
        try {
          const r = await eat(session, {})
          if (r.ok) eaten += 1
        } catch (error) {
          eatError = error?.message || String(error)
          eatCooldown = Date.now() + 4000 // 吃不成别每轮重试
        }
        continue
      }

      const target = threats.find((t) => t.e.id === focusId) ?? threats[0]
      focusId = target.e.id
      if (process.env.FIGHT_DEBUG) console.log('[fight]', rounds, 'health', bot.health.toFixed(1), 'target', target.e.name, 'd', target.d.toFixed(1), 'all', threats.map((t) => `${t.e.name}:${t.d.toFixed(1)}`).join(','))
      if (target.e.name === 'creeper') {
        if (target.d < 5) {
          // 苦力怕：退开，不近战
          const p = bot.entity.position
          const away = p.offset((p.x - target.e.position.x) || 1, 0, (p.z - target.e.position.z) || 1).normalize().scale(6)
          await move(session, { x: Math.floor(p.x + away.x), y: Math.floor(p.y) + 1, z: Math.floor(p.z + away.z), range: 2, timeoutMs: 5000 }).catch(() => {})
        }
        // 如果只剩苦力怕，交给大脑/离开
        const nonCreeper = threats.find((t) => t.e.name !== 'creeper')
        if (!nonCreeper) {
          retreated = true
          break
        }
        continue
      }

      // 有弓就放风筝：射完退两步，别让它贴上来
      if (target.d > 3 && hasBowAndArrows(bot)) {
        await shootBow(bot, target.e)
        if (target.d < 9) {
          bot.setControlState('back', true)
          await sleep(420)
          bot.setControlState('back', false)
        }
        continue
      }

      if (target.d > 3.0) {
        // 走近：近距离用小步，远距离用寻路，免得每步都绕大圈
        if (target.d > 5) {
          await move(session, { x: Math.floor(target.e.position.x), y: Math.floor(target.e.position.y), z: Math.floor(target.e.position.z), range: 2.2, timeoutMs: 4000 }).catch(() => {})
        } else {
          await bot.lookAt(target.e.position.offset(0, (target.e.height ?? 1.8) * 0.6, 0), true)
          bot.setControlState('forward', true)
          await sleep(220)
          bot.setControlState('forward', false)
        }
        continue
      }

      if (Date.now() - lastAttack >= 620) {
        try {
          await setShield(false)
          await bot.lookAt(target.e.position.offset(0, (target.e.height ?? 1.8) * 0.6, 0), true)
          await attackEntity(session, target.e)
          if (process.env.FIGHT_DEBUG) console.log('[fight] attack', target.e.name, 'd', target.d.toFixed(2), 'hp', target.e.metadata?.[9])
          lastAttack = Date.now()
          // 打完退半步：拖过攻击冷却，少挨打
          await setShield(true)
          bot.setControlState('back', true)
          await sleep(450)
          bot.setControlState('back', false)
        } catch (error) {
          if (process.env.FIGHT_DEBUG) console.log('[fight] attack failed:', error?.message || error)
        }
      } else {
        // 冷却里保持距离，别贴脸站着挨打
        bot.setControlState('back', true)
        await sleep(160)
        bot.setControlState('back', false)
      }
      await sleep(60)
    }
  } finally {
    bot.__fighting = false
    await setShield(false)
    bot.removeListener('entityGone', onGone)
    try {
      bot.clearControlStates()
    } catch {
      /* ignore */
    }
  }

  // 打完顺手捡一下战利品
  const picked = await pickupDrops(session, bot, undefined, { radius: 8, maxItems: 16, timeoutMs: 8000 }).catch(() => null)
  const invDelta = inventoryTotal(bot) - startInv
  const left = nearestThreats(bot, radius).length
  return {
    ok: true,
    verified: gone.length > 0,
    summary: gone.length
      ? `打死了 ${gone.length} 只（${[...new Set(gone)].join(', ')}），血 ${Math.round(startHealth)} → ${Math.round(bot.health)}，剩 ${left} 只`
      : `没打死东西：附近有 ${left} 只，血 ${Math.round(bot.health)}${retreated ? '，退了' : ''}`,
    evidence: {
      weapon: weapon ?? '空手',
      kills: gone,
      health: { before: startHealth, after: bot.health },
      eaten,
      eatError,
      retreated,
      left,
      invDelta,
      picked,
      rounds,
    },
    hint: retreated && left ? '血不够/对面太硬，先撤了；补血补装备再来。' : undefined,
  }
}
