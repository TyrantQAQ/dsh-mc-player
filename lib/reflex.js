/**
 * 小脑：每秒 20 次看有没有马上会死的事，命中就动手，不等大脑。
 *
 * 设计上刻意分成两半：
 *   senseWorld(bot)      —— 只读，把 mineflayer 的状态压成一个朴素对象
 *   decide(world, cfg)   —— 纯函数，不碰 bot，所以能拿假 bot 单测
 *   ReflexLayer.act()    —— 唯一真正操作 bot 的地方，吞掉所有异常
 *
 * 小脑不替大脑做决定：它只保命，其余一律上报。
 */

import { sleep, dist, bearingLabel, describeError, asVec, softWait, normalizeOxygen } from './util.js'

export const DEFAULT_REFLEX = {
  enabled: true,
  creeperRange: 4,
  creeperBackoffMs: 700,
  lowHealth: 6,
  lowOxygen: 8,
  surroundCount: 3,
  surroundRange: 8,
  eatThresholdFood: 18,
  panicHealth: 12,
  attackWindowMs: 3000,
}

const HOSTILE_NAMES = new Set([
  'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'enderman', 'endermite', 'witch', 'pillager', 'vindicator',
  'evoker', 'ravager', 'phantom', 'blaze', 'ghast', 'piglin', 'piglin_brute', 'hoglin', 'zoglin',
  'zombified_piglin', 'silverfish', 'slime', 'magma_cube', 'vex', 'guardian', 'elder_guardian',
  'shulker', 'wither', 'warden', 'breeze',
])

const FOOD_FALLBACK = new Set([
  'apple', 'golden_apple', 'enchanted_golden_apple', 'bread', 'carrot', 'golden_carrot',
  'baked_potato', 'potato', 'beetroot', 'beetroot_soup', 'melon_slice', 'pumpkin_pie',
  'cooked_beef', 'beef', 'cooked_porkchop', 'porkchop', 'cooked_chicken', 'chicken',
  'cooked_mutton', 'mutton', 'cooked_rabbit', 'rabbit', 'cooked_salmon', 'salmon',
  'cooked_cod', 'cod', 'tropical_fish', 'pufferfish', 'cookie', 'cake', 'mushroom_stew',
  'rabbit_stew', 'suspicious_stew', 'sweet_berries', 'glow_berries', 'dried_kelp',
  'honey_bottle', 'rotten_flesh', 'spider_eye', 'poisonous_potato', 'chorus_fruit',
])

function blockInfo(bot, pos) {
  try {
    const block = bot.blockAt(asVec(bot, pos), false)
    if (!block) return { name: 'unknown', solid: false, liquid: null }
    const name = block.name || 'unknown'
    const liquid = name.includes('lava') ? 'lava' : name === 'water' || name.includes('water') ? 'water' : null
    const solid = block.boundingBox === 'block'
    return { name, solid, liquid }
  } catch {
    return { name: 'unknown', solid: false, liquid: null }
  }
}

function foodInfo(bot, item) {
  try {
    const table = bot.registry?.foodsByName?.[item.name]
    if (table && Number.isFinite(table.foodPoints)) return table.foodPoints
  } catch {
    /* 老版本没有 foodsByName，走下面的兜底 */
  }
  return FOOD_FALLBACK.has(item.name) ? 4 : 0
}

/** 只读感知。任何一步失败都不该让 agent 崩掉。 */
export function senseWorld(bot, cfg = DEFAULT_REFLEX) {
  const entity = bot?.entity
  const pos = entity?.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null
  const yaw = entity?.yaw ?? 0
  const feet = pos ? blockInfo(bot, { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }) : null
  const head = pos ? blockInfo(bot, { x: Math.floor(pos.x), y: Math.floor(pos.y + 1.62), z: Math.floor(pos.z) }) : null
  const below = pos ? blockInfo(bot, { x: Math.floor(pos.x), y: Math.floor(pos.y - 0.2), z: Math.floor(pos.z) }) : null

  const entities = bot?.entities ? Object.values(bot.entities) : []
  const hostiles = []
  let creeper = null
  for (const e of entities) {
    if (!e?.position || e === bot.entity || e.isValid === false) continue
    const d = pos ? dist(pos, e.position) : Infinity
    const isHostile = HOSTILE_NAMES.has(e.name) || e.kind === 'Hostile mobs'
    if (e.name === 'creeper' && (!creeper || d < creeper.distance)) {
      creeper = { id: e.id, name: e.name, distance: d, position: { x: e.position.x, y: e.position.y, z: e.position.z } }
    }
    if (isHostile && d <= (cfg.surroundRange ?? 8)) {
      hostiles.push({
        id: e.id,
        name: e.name,
        distance: Math.round(d * 10) / 10,
        bearing: bearingLabel(yaw, pos, e.position),
        position: { x: e.position.x, y: e.position.y, z: e.position.z },
      })
    }
  }
  hostiles.sort((a, b) => a.distance - b.distance)

  let bestFood = null
  let hasFood = false
  try {
    for (const item of bot.inventory?.items?.() ?? []) {
      const points = foodInfo(bot, item)
      if (points > 0) {
        hasFood = true
        if (!bestFood || points > bestFood.points || (points === bestFood.points && bestFood.name === 'rotten_flesh')) {
          bestFood = { slot: item.slot, name: item.name, count: item.count, points }
        }
      }
    }
  } catch {
    /* 背包读不到就先当没吃的 */
  }

  const inLiquid = feet?.liquid || head?.liquid || null
  const headIsDoor = /_door$|_fence_gate$|_trapdoor$/.test(String(head?.name || ''))
  const suffocating = Boolean(head?.solid) && !inLiquid && !headIsDoor
  return {
    at: Date.now(),
    alive: Boolean(entity) && (bot.health ?? 20) > 0,
    health: bot.health ?? 20,
    food: bot.food ?? 20,
    oxygen: normalizeOxygen(bot.oxygenLevel ?? 20),
    isSleeping: bot.isSleeping === true,
    position: pos,
    yaw,
    feetBlock: feet?.name ?? 'unknown',
    headBlock: head?.name ?? 'unknown',
    underBlock: below?.name ?? 'unknown',
    inLiquid,
    suffocating,
    creeper,
    hostiles,
    hostileCount: hostiles.length,
    hasFood,
    bestFood,
    // 打架的时候，由 mc_fight 自己的节奏管"吃/撤/被围"，小脑别和它抢
    fighting: Boolean(bot.__fighting),
  }
}

/**
 * 纯判断。返回优先级最高的一条，或者 null。
 * 冷却也在这里算，避免"每 tick 都喊一次苦力怕"。
 */
export function decide(world, cfg = DEFAULT_REFLEX, lastAt = new Map(), now = Date.now()) {
  if (!cfg.enabled || !world?.alive || !world.position) return null
  const cooled = (id, ms) => now - (lastAt.get(id) ?? -Infinity) >= ms

  onLava: {
    if (world.inLiquid !== 'lava') break onLava
    if (!cooled('lava', 1500)) break onLava
    return {
      id: 'lava',
      priority: 100,
      interrupt: true,
      kind: 'float',
      reason: '掉进岩浆了，先保命',
      event: { level: 'danger', text: `掉进岩浆（${Math.round(world.position.x)}, ${Math.round(world.position.y)}, ${Math.round(world.position.z)}）` },
    }
  }

  onSuffocate: {
    if (!world.suffocating) break onSuffocate
    if (!cooled('suffocate', 800)) break onSuffocate
    return {
      id: 'suffocate',
      priority: 95,
      interrupt: true,
      kind: 'unstuck',
      reason: '头卡进方块里了',
      event: { level: 'danger', text: `头卡在 ${world.headBlock} 里，闷得慌` },
    }
  }

  onDrown: {
    if (!(world.oxygen <= (cfg.lowOxygen ?? 8))) break onDrown
    if (!world.inLiquid) break onDrown
    if (!cooled('drown', 2000)) break onDrown
    return {
      id: 'drown',
      priority: 90,
      interrupt: true,
      kind: 'surface',
      reason: '氧气快没了',
      event: { level: 'danger', text: `氧气只剩 ${Math.round(world.oxygen)}，往上浮` },
    }
  }

  onCreeper: {
    const c = world.creeper
    if (!c || c.distance > (cfg.creeperRange ?? 4)) break onCreeper
    if (!cooled('creeper', 1800)) break onCreeper
    return {
      id: 'creeper',
      priority: 80,
      interrupt: true,
      kind: 'backoff',
      target: c,
      reason: '苦力怕贴脸了，退',
      event: { level: 'danger', text: `苦力怕离我 ${c.distance.toFixed(1)} 格，正在后退` },
    }
  }

  onLowHealth: {
    if (world.fighting) break onLowHealth
    if (!(world.health <= (cfg.lowHealth ?? 6))) break onLowHealth
    if (!world.hasFood) break onLowHealth
    if (!cooled('low_health', 5000)) break onLowHealth
    return {
      id: 'low_health',
      priority: 70,
      interrupt: true,
      kind: 'eat',
      food: world.bestFood,
      reason: '血太少了，吃东西',
      event: { level: 'danger', text: `血只剩 ${Math.round(world.health)}，掏东西吃` },
    }
  }

  // 空手被一只怪追着打也会死。这不算"被围"，但一样是保命的范畴。
  onUnderAttack: {
    if (world.fighting) break onUnderAttack
    if (!world.underAttack) break onUnderAttack
    if (world.health > (cfg.panicHealth ?? 12)) break onUnderAttack
    if (!world.hostiles?.length || world.hostiles[0].distance > 5) break onUnderAttack
    if (!cooled('under_attack', 4000)) break onUnderAttack
    return {
      id: 'under_attack',
      priority: 65,
      interrupt: true,
      kind: 'retreat',
      target: world.hostiles[0],
      reason: '正在挨打，血也不多',
      event: {
        level: 'danger',
        text: `被 ${world.hostiles[0].name} 追着打（${world.hostiles[0].distance} 格，${world.hostiles[0].bearing}），血 ${Math.round(world.health)}`,
      },
    }
  }

  onSurrounded: {
    if (world.fighting) break onSurrounded
    if (!(world.hostileCount >= (cfg.surroundCount ?? 3))) break onSurrounded
    if (!cooled('surrounded', 4000)) break onSurrounded
    return {
      id: 'surrounded',
      priority: 60,
      interrupt: true,
      kind: 'hold',
      reason: '被围住了，停手',
      event: {
        level: 'danger',
        text: `周围有 ${world.hostileCount} 只怪：${world.hostiles.slice(0, 4).map((h) => `${h.name}(${h.distance}格,${h.bearing})`).join('、')}`,
      },
    }
  }

  return null
}

/** 真正动手的地方。所有异常都在这里吃掉——小脑不能把进程带走。 */
export class ReflexLayer {
  constructor({ getConfig, onInterrupt, onEvent, log } = {}) {
    this.getConfig = getConfig || (() => DEFAULT_REFLEX)
    this.onInterrupt = onInterrupt || (() => {})
    this.onEvent = onEvent || (() => {})
    this.log = log || (() => {})
    this.bot = null
    this.lastAt = new Map()
    this.recent = []
    this.busy = false
    this.ticks = 0
    this.lastWorld = null
    this.lastHealth = null
    this.lastDamageAt = 0
  }

  attach(bot) {
    this.detach()
    this.bot = bot
    this.lastAt.clear()
    this.ticks = 0
    this.onTick = () => this.tick()
    bot.on('physicsTick', this.onTick)
  }

  detach() {
    if (this.bot && this.onTick) {
      try {
        this.bot.removeListener('physicsTick', this.onTick)
      } catch {
        /* ignore */
      }
    }
    this.bot = null
    this.onTick = null
  }

  tick() {
    const bot = this.bot
    if (!bot || this.busy || bot !== this.bot) return
    this.ticks += 1
    const cfg = { ...DEFAULT_REFLEX, ...(this.getConfig?.() || {}) }
    if (!cfg.enabled) return
    let world
    try {
      world = senseWorld(bot, cfg)
    } catch (error) {
      this.log('感知失败', describeError(error))
      return
    }
    const now = Date.now()
    if (this.lastHealth !== null && world.health < this.lastHealth - 0.5) this.lastDamageAt = now
    this.lastHealth = world.health
    world.underAttack = world.alive && now - this.lastDamageAt <= (cfg.attackWindowMs ?? 3000)
    this.lastWorld = world
    const decision = decide(world, cfg, this.lastAt, now)
    if (!decision) return
    this.lastAt.set(decision.id, Date.now())
    this.recent.push({ id: decision.id, at: Date.now(), text: decision.event.text })
    if (this.recent.length > 20) this.recent.shift()
    try {
      this.onEvent?.(decision.event)
    } catch {
      /* ignore */
    }
    if (decision.interrupt) {
      try {
        this.onInterrupt?.(decision)
      } catch {
        /* ignore */
      }
    }
    this.busy = true
    this.act(decision, world)
      .catch((error) => this.log('反射动作失败', decision.id, describeError(error)))
      .finally(() => {
        this.busy = false
      })
  }

  async act(decision, world = this.lastWorld) {
    const bot = this.bot
    if (!bot) return
    switch (decision.kind) {
      case 'backoff':
        return this.backoff(bot, decision, world)
      case 'eat':
        return this.eat(bot, decision.food)
      case 'float':
        return this.floatUp(bot, 1400, true)
      case 'surface':
        return this.floatUp(bot, 1200, false)
      case 'unstuck':
        return this.unstuck(bot)
      case 'hold':
        this.stopAll(bot)
        return
      case 'retreat':
        return this.retreat(bot, decision)
      default:
        return
    }
  }

  /** 苦力怕：转身、后退、有盾就举 */
  async backoff(bot, decision) {
    const target = decision.target
    const cfg = { ...DEFAULT_REFLEX, ...(this.getConfig?.() || {}) }
    const ms = cfg.creeperBackoffMs ?? 700
    try {
      const pos = bot.entity?.position
      if (pos && target?.position) {
        const away = Math.atan2(-(pos.x - target.position.x), -(pos.z - target.position.z))
        await softWait(bot.look(away, 0, true), 400)
      }
      bot.setControlState('back', true)
      bot.setControlState('sprint', true)
      await sleep(ms)
    } finally {
      this.stopAll(bot)
      await this.raiseShield(bot)
    }
  }

  async raiseShield(bot) {
    try {
      const offhand = bot.inventory?.slots?.[45]
      const held = bot.heldItem
      if (offhand?.name === 'shield') {
        bot.activateItem(true)
        await sleep(1200)
        bot.deactivateItem()
      } else if (held?.name === 'shield') {
        bot.activateItem()
        await sleep(1200)
        bot.deactivateItem()
      }
    } catch {
      /* 举不起盾就算了，活着更重要 */
    }
  }

  async eat(bot, food) {
    try {
      if (!food) return
      let item = null
      try {
        item = bot.inventory?.items?.().find((i) => i.slot === food.slot) ?? null
      } catch {
        item = null
      }
      if (!item) return
      await bot.equip(item, 'hand')
      await bot.consume()
    } catch (error) {
      this.log('吃东西失败', describeError(error))
    } finally {
      this.stopAll(bot)
    }
  }

  async floatUp(bot, ms, tryWater) {
    try {
      if (tryWater) {
        const bucket = (() => {
          try {
            return bot.inventory?.items?.().find((i) => i.name === 'water_bucket') ?? null
          } catch {
            return null
          }
        })()
        if (bucket) {
          await bot.equip(bucket, 'hand')
          await softWait(bot.look(bot.entity.yaw, Math.PI / 2, true), 400)
          bot.activateItem()
          await sleep(400)
          bot.deactivateItem()
          this.log('放了桶水')
        }
      }
      await softWait(bot.look(bot.entity.yaw, -Math.PI / 2, true), 400)
      bot.setControlState('jump', true)
      bot.setControlState('sprint', true)
      await sleep(ms)
    } finally {
      this.stopAll(bot)
    }
  }

  /** 挨打时的本能：先停手，背对最近的怪退两步 */
  async retreat(bot, decision) {
    const target = decision.target
    try {
      const pos = bot.entity?.position
      if (pos && target?.position) {
        const away = Math.atan2(-(pos.x - target.position.x), -(pos.z - target.position.z))
        await softWait(bot.look(away, 0, true), 400)
      }
      bot.setControlState('back', true)
      bot.setControlState('sprint', true)
      await sleep(600)
    } finally {
      this.stopAll(bot)
    }
  }

  async unstuck(bot) {
    const dirs = ['forward', 'back', 'left', 'right']
    try {
      const dir = dirs[Math.floor(Math.random() * dirs.length)]
      bot.setControlState(dir, true)
      bot.setControlState('jump', true)
      await sleep(450)
    } finally {
      this.stopAll(bot)
    }
  }

  stopAll(bot) {
    try {
      for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
        bot.setControlState(key, false)
      }
    } catch {
      /* bot 已经没了 */
    }
  }

  history() {
    return this.recent.slice(-8)
  }
}
