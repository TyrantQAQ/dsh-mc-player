/**
 * 自主目标的执行器：模型定好计划之后，没人盯着的时候它自己一步步做。
 *
 * 边界（这些是故意的）：
 *   - 只在"手上没活、血够、没被围、没开界面"的时候才动手；
 *   - 一次只做一步，做完记账、失败记原因，连续失败 maxAttempts 次就停下等大脑；
 *   - manual 步骤会主动暂停，等模型接手；
 *   - 死了、掉线、被反射层打断，都会记在计划日志里，不会假装没发生。
 */

import { sleep } from './util.js'
import * as actions from './actions.js'
import { build } from './build.js'
import { enchantAt, anvilUse, tradeWith } from './stations.js'
import { farm } from './farming.js'
import { fishAt } from './fishing.js'
import { brew } from './brewing.js'
import { tame } from './taming.js'
import { fight } from './combat.js'
import { applyStepResult, currentStep, planSummary, revivePlan, stepLabel } from './goals.js'

export const DEFAULT_AUTOPILOT = {
  enabled: true,
  intervalMs: 2500,
  minHealth: 8,
  pauseAtNight: false,
  maxAttempts: 3,
  cooldownMs: 1200,
}

export class Autopilot {
  constructor({ session, config = {}, log = () => {} }) {
    this.session = session
    this.cfg = { ...DEFAULT_AUTOPILOT, ...(config || {}) }
    this.log = log
    this.plan = revivePlan(session.memory?.data?.plan)
    this.timer = null
    this.running = false
    this.lastStepAt = 0
    this.lastTickAt = 0
    this.lastNote = null
    this.stopped = false
    this.#bindDeath()
  }

  #bindDeath() {
    try {
      this.session.on('death', () => {
        if (this.plan && this.plan.status === 'active') {
          this.plan.status = 'paused'
          this.plan.note = '死了，先暂停'
          this.plan.log.push({ at: Date.now(), kind: 'pause', ok: false, note: '死亡自动暂停' })
          this.#persist()
          this.session.pushEvent('danger', '自主目标暂停：死了')
        }
      })
    } catch {
      /* ignore */
    }
  }

  start() {
    if (this.timer || !this.cfg.enabled) return
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log('[autopilot] tick 失败', e?.message || e))
    }, Math.max(500, this.cfg.intervalMs))
    if (this.timer.unref) this.timer.unref()
  }

  stop() {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  setPlan(plan) {
    this.plan = plan
    this.lastNote = null
    this.#persist()
  }

  pause(reason = '手动暂停') {
    if (!this.plan) return
    this.plan.status = 'paused'
    this.plan.note = reason
    this.plan.log.push({ at: Date.now(), kind: 'pause', ok: false, note: reason })
    this.#persist()
    try {
      this.session.abortCurrent('自主目标暂停')
    } catch {
      /* ignore */
    }
  }

  resume() {
    if (!this.plan) return
    for (const step of this.plan.steps) {
      if (step.status === 'failed') {
        step.status = 'pending'
        step.attempts = 0
        step.note = '重试'
      }
    }
    this.plan.status = 'active'
    this.plan.note = null
    this.#persist()
  }

  clear() {
    this.plan = null
    if (this.session.memory?.data) {
      delete this.session.memory.data.plan
      this.session.memory.save()
    }
  }

  status() {
    const step = currentStep(this.plan)
    return {
      enabled: this.cfg.enabled,
      running: Boolean(this.timer),
      planStatus: this.plan?.status ?? null,
      current: step ? stepLabel(step) : null,
      lastTickAt: this.lastTickAt || null,
      lastNote: this.lastNote,
    }
  }

  summary() {
    return planSummary(this.plan)
  }

  #persist() {
    try {
      if (!this.session.memory) return
      if (this.plan) this.session.memory.data.plan = this.plan
      else delete this.session.memory.data.plan
      this.session.memory.save()
    } catch (e) {
      this.log('[autopilot] 存计划失败', e?.message || e)
    }
  }

  /** 现在能不能动手 */
  #canAct() {
    const s = this.session
    if (!s.isOnline) return { ok: false, why: '没上线' }
    if (s.action) return { ok: false, why: '手上有活' }
    if (!this.plan || this.plan.status !== 'active') return { ok: false, why: '计划不在跑' }
    if (Date.now() - this.lastStepAt < this.cfg.cooldownMs) return { ok: false, why: '刚做完一步' }
    const bot = s.bot
    if (bot.currentWindow) return { ok: false, why: '界面开着' }
    if (bot.health < this.cfg.minHealth) return { ok: false, why: `血只有 ${Math.round(bot.health)}` }
    const w = s.reflex?.lastWorld
    if (w && w.hostiles?.length && w.hostiles[0].distance <= 6 && bot.health < 14) {
      return { ok: false, why: '附近有怪、血也不多' }
    }
    if (this.cfg.pauseAtNight && w && (w.timeOfDay > 13000 && w.timeOfDay < 23000)) {
      return { ok: false, why: '天黑了' }
    }
    return { ok: true }
  }

  async tick() {
    this.lastTickAt = Date.now()
    if (this.stopped) return
    const gate = this.#canAct()
    if (!gate.ok) {
      this.lastNote = gate.why
      return
    }
    const step = currentStep(this.plan)
    if (!step) {
      if (this.plan.status === 'active') {
        this.plan.status = 'done'
        this.#persist()
        this.session.pushEvent('info', `目标完成：${this.plan.text}`)
      }
      return
    }

    if (step.kind === 'manual') {
      this.plan.status = 'paused'
      this.plan.note = `等大脑：${step.spec.text}`
      step.status = 'pending'
      this.plan.log.push({ at: Date.now(), kind: 'manual', ok: false, note: step.spec.text })
      this.#persist()
      this.session.pushEvent('warn', `自主目标需要你接手：${step.spec.text}`)
      return
    }

    // 起步前停顿一下：不是机器，做事前会想一下
    await sleep(200 + Math.random() * 800)
    step.status = 'running'
    step.startedAt = Date.now()
    this.#persist()
    let result
    try {
      result = await this.#execute(step)
    } catch (error) {
      result = { ok: false, verified: false, summary: error?.message || String(error) }
    }
    this.lastStepAt = Date.now()
    step.status = 'pending'
    const applied = applyStepResult(this.plan, step, result, { maxAttempts: this.cfg.maxAttempts })
    this.#persist()
    this.lastNote = applied.note

    if (applied.blocked) {
      this.session.pushEvent('warn', applied.note)
    } else if (applied.stepDone) {
      this.session.pushEvent('info', `目标推进：${stepLabel(step)} ✔`)
    }
    if (applied.planDone) {
      this.session.pushEvent('info', `目标完成：${this.plan.text}`)
    }
  }

  async #execute(step) {
    const s = this.session
    const spec = step.spec || {}
    const remaining = Math.max(1, (spec.count ?? 1) - (step.progress ?? 0))
    switch (step.kind) {
      case 'gather': {
        const r = await actions.mine(s, { block: spec.block, count: remaining, maxDistance: spec.maxDistance, pickup: spec.pickup !== false })
        const dug = r.evidence?.dugCount ?? 0
        const delta = r.evidence?.invDelta ?? 0
        return {
          ok: r.ok && dug > 0,
          verified: r.verified,
          summary: r.summary,
          progressDelta: delta > 0 ? delta : dug,
        }
      }
      case 'craft': {
        const r = await actions.craft(s, { item: spec.item, count: remaining })
        const gained = (r.evidence?.after ?? 0) - (r.evidence?.before ?? 0)
        return { ok: r.ok && gained > 0, verified: r.verified, summary: r.summary, progressDelta: Math.max(0, gained) }
      }
      case 'build': {
        const r = await build(s, { blueprint: spec.blueprint, force: spec.force === true })
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'goto': {
        const r = await actions.move(s, spec.place ? { place: spec.place, range: spec.range } : { x: spec.x, y: spec.y, z: spec.z, range: spec.range })
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'place': {
        const r = await actions.place(s, { ...spec })
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'fight': {
        const r = await fight(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'brew': {
        const r = await brew(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'tame': {
        const r = await tame(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'farm': {
        const r = await farm(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'fish': {
        const r = await fishAt(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'enchant': {
        const r = await enchantAt(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'anvil': {
        const r = await anvilUse(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'trade': {
        const r = await tradeWith(s, spec)
        return { ok: r.ok, verified: r.verified, summary: r.summary }
      }
      case 'sleep': {
        try {
          const r = await actions.sleep_(s, {})
          return { ok: r.ok, verified: r.verified, summary: r.summary }
        } catch (error) {
          const msg = error?.message || ''
          if (/白天|没意义/.test(msg)) return { ok: true, verified: true, summary: '白天，不用睡' }
          throw error
        }
      }
      default:
        return { ok: false, summary: `不认识的步骤：${step.kind}` }
    }
  }
}
