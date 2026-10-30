/**
 * 地图记忆：把走过的路记成一条"面包屑"。
 *
 * 用它的场景：离家很远、寻路失败、或者只是要原路回去——
 * 有走过的点就沿着点走，比让寻路器从零开始瞎试稳。
 *
 * 只记位置，不记方块；走过的地方会覆盖旧点（同一个 4 格范围内只留最新的）。
 */

import { sleep, dist } from './util.js'
import { move } from './actions.js'

export const DEFAULT_MAP = {
  enabled: true,
  sampleMs: 2000,
  minStep: 2.5,
  maxPoints: 800,
}

function keyOf(p) {
  return `${Math.floor(p.x / 4)},${Math.floor(p.z / 4)}`
}

/**
 * 纯函数：给一条按时间排的轨迹，规划从 from 到 to 该按什么顺序走。
 * 返回要依次路过的点（不含 from/to 本身）。走不到就返回空。
 */
export function planTrailRoute(trail, from, to) {
  if (!Array.isArray(trail) || trail.length < 3) return []
  const nearest = (p) => {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < trail.length; i += 1) {
      const d = dist(p, trail[i])
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return { index: best, distance: bestD }
  }
  const a = nearest(from)
  const b = nearest(to)
  if (a.index < 0 || b.index < 0) return []
  if (Math.abs(a.index - b.index) <= 1) return []
  const dir = b.index > a.index ? 1 : -1
  const out = []
  for (let k = a.index + dir; k !== b.index + dir && out.length < 200; k += dir) out.push(trail[k])
  return out
}

export class MapMemory {
  constructor({ session, config = {}, log = () => {} }) {
    this.session = session
    this.cfg = { ...DEFAULT_MAP, ...(config || {}) }
    this.log = log
    this.timer = null
    this.lastSample = null
    this.lastSave = 0
    const saved = session.memory?.data?.trail
    this.trail = Array.isArray(saved) ? saved.slice(-this.cfg.maxPoints) : []
  }

  start() {
    if (this.timer || !this.cfg.enabled) return
    this.timer = setInterval(() => this.tick(), Math.max(500, this.cfg.sampleMs))
    if (this.timer.unref) this.timer.unref()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  #persist() {
    const s = this.session
    if (!s.memory?.data) return
    s.memory.data.trail = this.trail.slice(-this.cfg.maxPoints)
    s.memory.save?.()
  }

  tick() {
    const s = this.session
    if (!s.isOnline || s.fighting || s.bot?.__fighting) return
    const p = s.bot?.entity?.position
    if (!p) return
    const here = { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)), z: Number(p.z.toFixed(1)), at: Date.now() }
    if (this.lastSample && dist(this.lastSample, here) < this.cfg.minStep) return
    this.lastSample = here
    this.trail.push(here)
    if (this.trail.length > this.cfg.maxPoints) this.trail.splice(0, this.trail.length - this.cfg.maxPoints)
    if (Date.now() - this.lastSave > 5000) {
      this.lastSave = Date.now()
      this.#persist()
    }
  }

  summary() {
    const last = this.trail[this.trail.length - 1] ?? null
    return { points: this.trail.length, last }
  }

  recent(n = 10) {
    return this.trail.slice(-n)
  }

  clear() {
    this.trail = []
    this.#persist()
  }

  /**
   * 走去一个点：先用轨迹里的路，按点走；轨迹帮不上忙（太少/离得远）就交给寻路器。
   * 返回 { ok, usedTrail, arrived, walked, skipped }
   */
  async walkTo(target, { range = 1.5, timeoutMs = 120000 } = {}) {
    const s = this.session
    const bot = s.requireBot()
    const from = bot.entity.position
    const deadline = Date.now() + timeoutMs
    const route = planTrailRoute(this.trail, from, target)
    let walked = 0
    const skipped = []
    if (route.length) {
      for (const point of route) {
        if (dist(bot.entity.position, target) <= range) break
        if (Date.now() > deadline) break
        try {
          const r = await move(s, { x: point.x, y: point.y, z: point.z, range: 1.6, timeoutMs: 20000 })
          if (r.ok) walked += 1
          else skipped.push({ point, why: r.summary })
        } catch (error) {
          skipped.push({ point, why: error?.message || String(error) })
        }
      }
    }
    // 最后一小段交给寻路器（轨迹只到附近）
    if (dist(bot.entity.position, target) > range) {
      try {
        const r = await move(s, { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z), range, timeoutMs: 60000 })
        if (!r.ok) skipped.push({ point: target, why: r.summary })
      } catch (error) {
        skipped.push({ point: target, why: error?.message || String(error) })
      }
    }
    const arrived = dist(bot.entity.position, target) <= range + 1.2
    return { ok: arrived, usedTrail: route.length > 0, walked, skipped, arrived, distance: Number(dist(bot.entity.position, target).toFixed(2)) }
  }
}
