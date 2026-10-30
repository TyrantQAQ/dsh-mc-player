/**
 * 驯养：狼（骨头）、猫（生鱼）、鹦鹉（种子）。
 *
 * 驯服成功时服务端会放爱心粒子——这是"成了"的证据，比看实体元数据稳。
 * 马不在这里：马是靠反复骑上去驯的，不是喂东西，以后单独做。
 */

import { sleep } from './util.js'
import { move, interactEntity } from './actions.js'

const DEFAULTS = {
  wolf: 'bone',
  cat: 'cod',
  ocelot: 'cod',
  parrot: 'wheat_seeds',
}

/** 驯服后实体的 metadata 里会多出主人的 UUID（26.2 上是第 19 位） */
export function isTamed(entity) {
  const meta = entity?.metadata
  if (!meta) return false
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return meta.some((v) => typeof v === 'string' && uuid.test(v))
}

function nearestTameable(bot, maxDistance = 8) {
  const p = bot.entity.position
  return Object.values(bot.entities || {})
    .filter((e) => e && DEFAULTS[e.name] && e.position && !isTamed(e))
    .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))
    .find((e) => e.position.distanceTo(p) <= maxDistance) ?? null
}

export async function tame(session, args) {
  const bot = session.requireBot()
  const entity = args.entityId !== undefined ? bot.entities[args.entityId] : nearestTameable(bot)
  if (!entity) throw new Error('8 格内没有能喂的（狼 / 猫 / 鹦鹉）')

  const itemName = String(args.item || DEFAULTS[entity.name] || '')
  if (!itemName) throw new Error(`不知道 ${entity.name} 吃什么`)
  const dist = () => entity.position.distanceTo(bot.entity.position)
  if (dist() > 3.2) {
    await move(session, { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y), z: Math.floor(entity.position.z), range: 1.6, timeoutMs: 8000 }).catch(() => {})
  }
  if (dist() > 3.5) throw new Error(`够不着 ${entity.name}（${dist().toFixed(1)} 格）`)

  let item = bot.inventory.items().find((i) => i.name === itemName)
  if (!item) throw new Error(`背包里没有 ${itemName}`)
  if (bot.heldItem?.name !== itemName) await bot.equip(item, 'hand')

  let hearts = 0
  let fed = 0
  let misses = 0
  const onParticles = (pkt) => {
    try {
      const t = pkt.particle?.type ?? pkt.particleId
      if (/heart/i.test(String(t))) hearts += 1
    } catch {
      /* ignore */
    }
  }
  bot._client.on('world_particles', onParticles)

  let attempts = 0
  try {
    for (; attempts < 10 && hearts === 0 && !isTamed(entity); attempts += 1) {
      if (dist() > 3.2) break
      const before = bot.inventory.items().filter((i) => i.name === itemName).reduce((s, i) => s + i.count, 0)
      await interactEntity(session, entity)
      await sleep(600)
      const after = bot.inventory.items().filter((i) => i.name === itemName).reduce((s, i) => s + i.count, 0)
      if (after < before) {
        fed += 1
        misses = 0
      } else {
        misses += 1
        if (misses >= 2) break
      }
      item = bot.inventory.items().find((i) => i.name === itemName)
      if (!item) break
      if (bot.heldItem?.name !== itemName) await bot.equip(item, 'hand')
    }
  } finally {
    bot._client.removeListener('world_particles', onParticles)
  }

  const tamed = isTamed(entity) || hearts > 0
  return {
    ok: true,
    verified: tamed,
    summary: tamed
      ? `驯服了 ${entity.name}（喂了 ${fed} 根 ${itemName}）`
      : misses >= 2
        ? `${entity.name} 不吃 ${itemName}，或者它已经被驯服了（喂了 ${attempts} 次）`
        : `喂了 ${attempts} 次 ${itemName}，还没成`,
    evidence: { entity: entity.name, entityId: entity.id, item: itemName, attempts, fed, hearts, tamedFlag: isTamed(entity) },
    hint: tamed ? undefined : '喂食要贴到 3 格内、看着它；如果骨头不减少，可能选到了已驯服的。',
  }
}
