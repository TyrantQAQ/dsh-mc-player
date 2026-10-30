/**
 * 闲置思考：没人指挥、也没在挂机的时候，第十秒叫醒大脑，让它自己决定要干嘛。
 *
 * 只负责"叫醒"，不替你决定。例子（待着/探索/造东西/去找主人）只是例子，
 * 具体做什么由模型判断；模型也可以选择什么都不做。
 *
 * 不在这些时候叫：手上有活、有目标在跑、在挂机（主人要求的）、在打架。
 */

export const DEFAULT_IDLE = {
  enabled: true,
  afterSeconds: 10,
  cooldownSeconds: 120,
}

/** 纯判断，方便单测 */
export function shouldThink({ online, busy, idleMs, fired, now, lastWakeAt, afterSeconds, cooldownMs }) {
  if (!online || busy) return false
  if (fired) return false
  if (idleMs < afterSeconds * 1000) return false
  if (now - (lastWakeAt ?? 0) < cooldownMs) return false
  return true
}

export class IdleThinker {
  constructor({ session, config = {}, log = () => {}, wake = null }) {
    this.session = session
    this.cfg = { ...DEFAULT_IDLE, ...(config || {}) }
    this.log = log
    this.wake = wake
    this.timer = null
    this.idleSince = Date.now()
    this.fired = false
    this.lastWakeAt = 0
    this.lastError = null
  }

  start() {
    if (this.timer || !this.cfg.enabled) return
    this.timer = setInterval(() => this.tick(), 1000)
    if (this.timer.unref) this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status() {
    const busy = this.#busy()
    return {
      enabled: this.cfg.enabled,
      idleSeconds: Math.round((Date.now() - this.idleSince) / 1000),
      busy,
      fired: this.fired,
      lastWakeAt: this.lastWakeAt || null,
      nextThinkInSeconds: busy || this.fired ? null : Math.max(0, Math.round((this.cfg.afterSeconds * 1000 - (Date.now() - this.idleSince)) / 1000)),
      lastError: this.lastError,
    }
  }

  #busy() {
    const s = this.session
    return Boolean(s.action) || Boolean(s.machine?.running) || Boolean(s.fighting) || Boolean(s.bot?.__fighting) || s.autopilotPlan?.()?.status === 'active'
  }

  tick() {
    const s = this.session
    const now = Date.now()
    if (!s.isOnline) {
      this.idleSince = now
      this.fired = false
      return
    }
    if (this.#busy()) {
      this.idleSince = now
      this.fired = false
      return
    }
    const idleMs = now - this.idleSince
    if (!shouldThink({
      online: true,
      busy: false,
      idleMs,
      fired: this.fired,
      now,
      lastWakeAt: this.lastWakeAt,
      afterSeconds: this.cfg.afterSeconds,
      cooldownMs: this.cfg.cooldownSeconds * 1000,
    })) return

    this.fired = true
    this.lastWakeAt = now
    const line = `【自主思考】你现在闲着（${Math.round(idleMs / 1000)} 秒没在做事）。想做什么？继续待着、探索、造点什么、去找主人都行，也可以什么都不做，由你判断；想说话就用 mc_chat say。`
    if (!this.wake) {
      this.lastError = '没有绑定叫醒通道'
      return
    }
    Promise.resolve(this.wake(line)).catch((error) => {
      this.lastError = error?.message || String(error)
      this.log('[idle] 叫醒失败', this.lastError)
    })
  }
}
