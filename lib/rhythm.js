/**
 * 节奏：不是机器，会停下来看看、会发呆、干久了会累。
 *
 * 只在"完全没事"的时候动：没在跑动作、没开界面、没打架、计划没在推进。
 * 有活的时候它一声不吭，绝不打扰。
 *
 * 睡觉：不按"干活时长"休息；按游戏天数算——连续两天两夜没睡，第三天入夜必须睡，
 * 否则第 3 天之后幻翼就来了。
 */

import { sleep, waitFor } from './util.js'
import { sleep_ } from './actions.js'

export const DEFAULT_RHYTHM = {
  enabled: true,
  tickMs: 3000,
  idleLookAfterMs: 12000,
  lookChance: 0.35,
  sleepAfterDays: 2,
  bedSearchRadius: 24,
}

/**
 * 该不该睡了：连续两天两夜没睡，第三天入夜。
 * daysSinceSleep 是"上次睡之后见过几次日出"：2 次日出 = 过了两个白天，接下来这晚就是第三晚。
 * timeOfDay：13000~23000 是夜里。
 */
export function needsSleep({ daysSinceSleep, timeOfDay, afterDays = 2 }) {
  if (!Number.isFinite(daysSinceSleep) || !Number.isFinite(timeOfDay)) return false
  return daysSinceSleep >= afterDays && timeOfDay >= 13000 && timeOfDay <= 23000
}

/**
 * 纯判断：现在该不该张望。返回 { yaw, pitch } 或 null。
 * 参数都是普通数值，方便单测。
 */
export function decideIdleLook({ idleMs, lastLookAt, now, tickMs, lookChance, currentYaw, rng = Math.random }) {
  if (idleMs < tickMs * 2) return null
  if (now - (lastLookAt ?? 0) < 4000) return null
  if (rng() > lookChance) return null
  const yaw = currentYaw + (rng() * 2 - 1) * 1.4
  const pitch = (rng() * 2 - 1) * 0.35
  return { yaw, pitch }
}

export class Rhythm {
  constructor({ session, config = {}, log = () => {} }) {
    this.session = session
    this.cfg = { ...DEFAULT_RHYTHM, ...(config || {}) }
    this.log = log
    this.timer = null
    this.idleSince = Date.now()
    this.lastLookAt = 0
    this.lastLook = null
    // 从这次上线开始算"见过几个日出"；睡一觉清零
    this.daysSinceSleep = 0
    this.lastTimeOfDay = null
    this.lastSleepDay = null
    this.sleeping = false
    this.lastSleepAt = 0
  }

  start() {
    if (this.timer || !this.cfg.enabled) return
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log('[rhythm] tick 失败', e?.message || e))
    }, Math.max(500, this.cfg.tickMs))
    if (this.timer.unref) this.timer.unref()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      daysSinceSleep: this.daysSinceSleep,
      lastSleepDay: this.lastSleepDay,
      sleeping: this.sleeping,
      needSleep: this.#shouldSleep()?.needed ?? false,
      idleMs: Date.now() - this.idleSince,
      lastLookAt: this.lastLookAt || null,
      lastLook: this.lastLook,
    }
  }

  /** 自己数日出，不依赖 bot.time.day（26.2 上 /time set 之后 day 会乱） */
  #trackDawn(timeOfDay) {
    const prev = this.lastTimeOfDay
    this.lastTimeOfDay = timeOfDay
    // 正常是 24000 回绕；/time set 会直接跳回去。掉一万 tick 以上就算翻过一天。
    if (prev !== null && timeOfDay < prev - 10000) this.daysSinceSleep += 1
  }

  #shouldSleep() {
    const t = this.session.bot?.time
    if (!t) return { needed: false }
    return {
      needed: needsSleep({ daysSinceSleep: this.daysSinceSleep, timeOfDay: t.timeOfDay, afterDays: this.cfg.sleepAfterDays }),
      timeOfDay: t.timeOfDay,
    }
  }

  async #goSleep() {
    const s = this.session
    if (this.sleeping) return
    this.sleeping = true
    const wasActive = s.autopilotPlan?.()?.status === 'active'
    try {
      if (wasActive) s.autopilot?.pause('到点睡觉了')
      const r = await sleep_(s, {})
      if (r?.ok) {
        this.daysSinceSleep = 0
        this.lastSleepDay = s.bot?.time?.day ?? null
        this.lastSleepAt = Date.now()
        s.pushEvent('info', '睡了一觉（再熬就要出幻翼了）')
      } else {
        s.pushEvent('warn', `该睡了，但没睡成：${r?.summary ?? '不知道原因'}`)
      }
      // 躺下之后等天亮/醒过来
      const woke = await waitFor(() => !s.bot?.isSleeping, { timeoutMs: 8 * 60 * 1000, intervalMs: 2000 })
      if (!woke) s.bot?.wake?.()
    } catch (error) {
      s.pushEvent('warn', `该睡了，但睡不了：${error?.message || error}`)
    } finally {
      this.sleeping = false
      if (wasActive) s.autopilot?.resume()
    }
  }

  async tick() {
    const s = this.session
    if (!s.isOnline) return
    const busy = Boolean(s.action) || Boolean(s.bot?.currentWindow) || Boolean(s.fighting) || Boolean(s.bot?.__fighting)
    const t = s.bot?.time
    if (t) this.#trackDawn(t.timeOfDay)
    const sleepGate = this.#shouldSleep()
    if (sleepGate.needed && !busy) {
      await this.#goSleep()
      return
    }
    if (busy) {
      this.idleSince = Date.now()
      return
    }
    const plan = s.autopilotPlan?.()
    if (plan && plan.status === 'active') {
      this.idleSince = Date.now()
      return
    }

    const idleMs = Date.now() - this.idleSince
    const look = decideIdleLook({
      idleMs,
      lastLookAt: this.lastLookAt,
      now: Date.now(),
      tickMs: this.cfg.tickMs,
      lookChance: this.cfg.lookChance,
      currentYaw: s.bot?.entity?.yaw ?? 0,
    })
    if (!look) return
    try {
      await s.bot.look(look.yaw, look.pitch, false)
      this.lastLookAt = Date.now()
      this.lastLook = { at: this.lastLookAt, yaw: Number(look.yaw.toFixed(2)), pitch: Number(look.pitch.toFixed(2)) }
    } catch {
      /* ignore */
    }
  }
}
