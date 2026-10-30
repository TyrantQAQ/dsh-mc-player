/**
 * 挂机干活：守着一个"机器"的点，反复做同一件事。
 *
 * 现在支持两种：
 *   - mine：刷石机/刷矿机的出料口——那格一变成实心方块就挖掉，等它再长出来。
 *   - stand：铁傀儡农场/刷怪塔这种"站着就行"的地方——站在点上，偶尔捡捡脚边的东西。
 *
 * 它不会"看懂"建筑；它只认你告诉它的那个坐标。位置由大脑通过 mc_memory / mc_afk 指定。
 */

import { sleep, dist } from './util.js'
import { mine as mineAction, pickupDrops, move } from './actions.js'

export const DEFAULT_MACHINE = {
  intervalMs: 800,
  maxMinutes: 30,
}

const SKIP_NAMES = /water|lava|air|bedrock|barrier|light/
const MACHINE_BLOCKS = /hopper|chest|furnace|dispenser|dropper|observer|piston|redstone|repeater|comparator|lever|button|water|lava|cobblestone|stone|rail|trapdoor|slab|stairs|barrel|brewing|enchanting|anvil|spawner|torch|lantern|glass|trapdoor|fence|sign/

/** 扫一圈附近的"机器相"方块，给大脑一个描述，不是识别 */
export function scanNearby(bot, radius = 8) {
  const counts = {}
  const p = bot?.entity?.position
  if (!p) return []
  const V = p.constructor
  const r = Math.min(Math.max(Number(radius) || 8, 2), 12)
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dz = -r; dz <= r; dz += 1) {
        const b = bot.blockAt(new V(Math.floor(p.x) + dx, Math.floor(p.y) + dy, Math.floor(p.z) + dz))
        if (!b || !MACHINE_BLOCKS.test(b.name)) continue
        counts[b.name] = (counts[b.name] ?? 0) + 1
      }
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }))
}

function at(bot, p) {
  try {
    const V = bot.entity.position.constructor
    return bot.blockAt(new V(p.x, p.y, p.z))
  } catch {
    return null
  }
}

export class MachineWatcher {
  constructor({ session, config = {}, log = () => {} }) {
    this.session = session
    this.cfg = { ...DEFAULT_MACHINE, ...(config || {}) }
    this.log = log
    this.timer = null
    this.state = null
  }

  get running() {
    return Boolean(this.state && this.timer)
  }

  start({ target, mode = 'mine', place = null, maxMinutes = this.cfg.maxMinutes, drop = false } = {}) {
    if (!target) throw new Error('得给一个目标点（x/y/z）')
    this.stop()
    this.state = {
      target,
      mode,
      place,
      drop,
      startedAt: Date.now(),
      deadline: Date.now() + Math.min(Math.max(Number(maxMinutes) || 30, 1), 240) * 60000,
      mined: 0,
      picked: 0,
      errors: 0,
      lastError: null,
    }
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log('[machine] tick 失败', e?.message || e))
    }, Math.max(400, this.cfg.intervalMs))
    if (this.timer.unref) this.timer.unref()
    return this.status()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    const was = this.state
    this.state = null
    return was
  }

  status() {
    if (!this.state) return { running: false }
    return {
      running: true,
      mode: this.state.mode,
      place: this.state.place,
      target: this.state.target,
      mined: this.state.mined,
      picked: this.state.picked,
      idleSeconds: Math.round((Date.now() - this.state.startedAt) / 1000),
      remainingMinutes: Math.max(0, Math.round((this.state.deadline - Date.now()) / 60000)),
      lastError: this.state.lastError,
    }
  }

  async tick() {
    const s = this.session
    const st = this.state
    if (!st) return
    if (Date.now() > st.deadline) {
      s.pushEvent('info', `挂机时间到了（挖了 ${st.mined} 个）`)
      this.stop()
      return
    }
    const bot = s.bot
    if (!s.isOnline || s.action || bot?.currentWindow || s.fighting || bot?.__fighting) return

    if (st.mode === 'stand') {
      // 站着别动，偶尔把脚边的东西捡了
      const p = bot.entity.position
      if (dist(p, st.target) > 2.5) {
        if (s.map?.walkTo) await s.map.walkTo(st.target, { range: 1.5, timeoutMs: 30000 }).catch(() => {})
        else await move(s, { x: Math.floor(st.target.x), y: Math.floor(st.target.y), z: Math.floor(st.target.z), range: 1.5, timeoutMs: 30000 }).catch(() => {})
      }
      await pickupDrops(s, bot, undefined, { radius: 4, maxItems: 4, timeoutMs: 2000 }).catch(() => {})
      return
    }

    // mine：那格有实心方块就挖
    const block = at(bot, st.target)
    if (!block || block.boundingBox !== 'block' || SKIP_NAMES.test(block.name)) return
    if (dist(bot.entity.position, st.target) > 4.8) {
      if (s.map?.walkTo) await s.map.walkTo(st.target, { range: 2, timeoutMs: 30000 }).catch(() => {})
      else await move(s, { x: Math.floor(st.target.x), y: Math.floor(st.target.y), z: Math.floor(st.target.z), range: 2, timeoutMs: 30000 }).catch(() => {})
      return
    }
    try {
      const r = await mineAction(s, { x: st.target.x, y: st.target.y, z: st.target.z })
      if (r.ok) {
        st.mined += 1
        st.lastError = null
        if (st.drop) await bot.drop?.(bot.heldItem?.type, 1).catch(() => {})
      } else {
        st.errors += 1
        st.lastError = r.summary
      }
    } catch (error) {
      st.errors += 1
      st.lastError = error?.message || String(error)
    }
  }
}
