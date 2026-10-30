/**
 * 游戏内聊天：耳朵和嘴，不做理解。
 *
 * 主人说话 → 原样转给大脑（DSH 会话），由模型决定"跟不跟、先做手上的还是先做这个"；
 * 模型的回话走 mc_chat say。插件不猜意图，只保证话能到、能回。
 *
 * 叫醒大脑的办法：sessionController.prompt（往当前会话塞一条用户消息），
 * 它会让模型开始一轮；会话号从任意一次工具调用里拿到。
 */

export const DEFAULT_CHAT = {
  enabled: true,
}

export class ChatLink {
  constructor({ session, config = {}, log = () => {}, wake = null }) {
    this.session = session
    this.cfg = { ...DEFAULT_CHAT, ...(config || {}) }
    this.log = log
    this.wake = wake
    this.timer = null
    this.lastSeenAt = 0
    this.seenKeys = new Set()
    this.messages = []
    this.unread = 0
    this.pending = []
    this.lastReply = null
    this.lastWake = null
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => this.#poll(), 500)
    if (this.timer.unref) this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  say(text) {
    const s = this.session
    const line = String(text ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 250)
    if (!line) return { ok: false, verified: false, summary: '没话说' }
    try {
      s.bot.chat(line)
      this.lastReply = { text: line, at: Date.now() }
      return { ok: true, verified: true, summary: `说了：${line}`, evidence: { text: line } }
    } catch (error) {
      return { ok: false, verified: false, summary: `说不出来：${error?.message || error}`, evidence: {} }
    }
  }

  read(limit = 20) {
    const unread = this.messages.filter((m) => !m.seen)
    for (const m of unread) m.seen = true
    this.unread = 0
    return { messages: unread.slice(-limit), pending: this.pending.slice(-20) }
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      unread: this.unread,
      pending: this.pending.length,
      lastReply: this.lastReply,
      lastWake: this.lastWake,
      sessionId: this.session.dshSessionId ?? null,
      recent: this.messages.slice(-5),
    }
  }

  #poll() {
    const s = this.session
    if (!s.isOnline) return
    for (const m of s.chat ?? []) {
      if (!m || m.at <= this.lastSeenAt) continue
      if (m.from === s.bot?.username) continue
      const key = `${m.at}|${m.from}|${m.message}`
      if (this.seenKeys.has(key)) continue
      this.lastSeenAt = Math.max(this.lastSeenAt, m.at)
      this.seenKeys.add(key)
      this.#onChat(m.from, m.message, m.at)
    }
  }

  #onChat(username, message, at) {
    const text = String(message ?? '').trim()
    if (!text) return
    const entry = { from: username, text, at: at ?? Date.now(), seen: false, handled: null }
    this.messages.push(entry)
    if (this.messages.length > 200) this.messages.splice(0, this.messages.length - 200)
    this.unread += 1
    this.session.pushEvent?.('info', `聊天：${username}：${text}`)
    this.#forward(entry).catch((e) => this.log('[chat] 转给大脑失败', e?.message || e))
  }

  async #forward(entry) {
    const line = `【游戏内聊天】${entry.from}：${entry.text}（想回话就用 mc_chat say）`
    let ok = false
    if (this.wake) {
      try {
        ok = await this.wake(line)
      } catch (e) {
        ok = false
        this.lastWake = { ok, error: e?.message || String(e), at: Date.now() }
      }
    }
    entry.handled = ok ? 'forwarded' : 'pending'
    this.lastWake = { ok, at: Date.now() }
    if (!ok) this.pending.push({ from: entry.from, text: entry.text, at: Date.now() })
  }
}
