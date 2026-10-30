/**
 * 一个 bot 的完整生命：连接、重连、事件攒着、状态快照、动作中断。
 *
 * 这里是"小脑"和"大脑"之间的那层膜：
 *   大脑通过工具调用看 snapshot() 和拿 drainEvents()；
 *   小脑通过 abortCurrent() 打断正在跑的动作。
 *
 * 规矩：这个文件里任何异步路径都不许把异常漏出去。漏出去就等于把 DSH 带走。
 */

import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { ReflexLayer, DEFAULT_REFLEX, senseWorld } from './reflex.js'
import { loadMemory, loadConnectionConfig, saveConnectionConfig } from './memory.js'
import { dist, bearingLabel, round, describeError, sleep, abortable, vecAt, normalizeOxygen } from './util.js'

export const DEFAULT_CONNECTION = {
  host: '127.0.0.1',
  port: 25565,
  username: 'xiaojingyu',
  auth: 'offline',
  version: '',
  autoConnect: false,
  reconnect: true,
  maxReconnect: 6,
}

const MAX_EVENTS = 200
const MAX_SOUNDS = 60
const MAX_CHAT = 40

const NOTABLE_SOUND = /explos|creeper|zombie|skeleton|enderman|witch|growl|hurt|death|arrow|bow|swing|break|place|door|chest|lever|button|fizz|burn|lava|splash|swim|thunder|lightning|totem|bell|anvil|enchant|potion|drink|eat|burp|levelup|beacon|portal|raid|wither|dragon|warden|sculk|pickup|xp/i

function windowLabel(window) {
  if (!window) return null
  const slots = Array.isArray(window.slots) ? window.slots.length : null
  let title = null
  try {
    title = typeof window.title === 'string' ? window.title.replace(/^"|"$/g, '') : null
  } catch {
    title = null
  }
  return { type: window.type ?? null, slots, title, isOpen: true }
}

export class Session extends EventEmitter {
  constructor({ config = {}, log = console.log } = {}) {
    super()
    this.setMaxListeners(50)
    this.log = log
    this.baseConfig = { ...DEFAULT_CONNECTION, ...(loadConnectionConfig() || {}), ...(config.connection || {}) }
    this.reflexConfig = { ...DEFAULT_REFLEX, ...(config.reflex || {}) }
    this.bot = null
    this.libs = null
    this.state = 'offline' // offline | connecting | online | reconnecting | error
    this.lastError = null
    this.reconnectAttempts = 0
    this.reconnectTimer = null
    this.manualClose = false
    this.connectPromise = null
    this.events = []
    this.sounds = []
    this.chat = []
    this.ui = { window: null }
    this.action = null
    this.lastHealth = null
    this.lastFood = null
    this.spawnedAt = null
    this.memory = loadMemory({ host: this.baseConfig.host, username: this.baseConfig.username })
    this.reflex = new ReflexLayer({
      getConfig: () => this.reflexConfig,
      onInterrupt: (decision) => this.abortCurrent(decision.reason),
      onEvent: (event) => this.pushEvent(event.level || 'info', event.text, { source: 'reflex' }),
      log: (...a) => this.log('[reflex]', ...a),
    })
  }

  get config() {
    return this.baseConfig
  }

  get isOnline() {
    return this.state === 'online' && Boolean(this.bot?.entity)
  }

  /** 给工具用的入口：没连就先连 */
  async ensureOnline() {
    if (this.isOnline) return this.bot
    if (this.state === 'connecting' || this.state === 'reconnecting') {
      await this.connectPromise?.catch(() => {})
      if (this.isOnline) return this.bot
    }
    return this.connect()
  }

  requireBot() {
    if (!this.bot || !this.isOnline) {
      throw new Error('还没连上服务器。先调 mc_connect（或 mc_status 确认状态）。')
    }
    return this.bot
  }

  async loadLibs() {
    if (this.libs && typeof this.libs.mineflayer?.createBot === 'function') return this.libs
    this.libs = null // 之前失败的缓存（比如 HMR 换过模块）不要留着
    const mineflayer = await import('mineflayer')
    let mf = mineflayer.default ?? mineflayer
    // HMR 有时候给到的是"包了一层的 default"，再兜底用 require 拿一次
    if (typeof mf?.createBot !== 'function' && typeof mf?.default?.createBot === 'function') mf = mf.default
    if (typeof mf?.createBot !== 'function') {
      try {
            const req = createRequire(import.meta.url)
        mf = req('mineflayer')
      } catch {
        /* 保留原样，让下面报清楚的错 */
      }
    }
    let pf = null
    try {
      const mod = await import('mineflayer-pathfinder')
      const ns = mod.default ?? mod
      pf = ns.pathfinder ? ns : ns.default ? ns.default : null
    } catch (error) {
      this.log('[mc] pathfinder 没装上，只能原地动作：', describeError(error))
    }
    this.libs = { mineflayer: mf, pf }
    await this.#warnIfNoData()
    return this.libs
  }

  /** 26.2 的数据是随包 vendor 的，npm install 之后要跑一次 setup:26.2；没有就提前说一声 */
  async #warnIfNoData() {
    if (this.dataWarned) return
    this.dataWarned = true
    try {
      const mod = await import('minecraft-data')
      const mcData = mod.default ?? mod
      const has = typeof mcData === 'function' && Boolean(mcData('26.2'))
      if (!has) {
        this.log('[mc] 没装 26.2 数据（只影响 26.2；1.16~26.1 照常）。要连 26.2 就在插件目录跑 npm run setup:26.2')
      }
    } catch {
      /* 没有 minecraft-data 就算了，连 1.x 也不靠它 */
    }
  }

  /**
   * 连服务器。传 overrides 可以临时改地址/用户名/版本，改完会存盘。
   */
  async connect(overrides = null) {
    if (this.connectPromise && (this.state === 'connecting' || this.state === 'reconnecting')) {
      return this.connectPromise
    }
    if (this.isOnline) {
      return { ok: true, state: this.state, username: this.bot.username, host: this.baseConfig.host, port: this.baseConfig.port }
    }
    if (overrides && typeof overrides === 'object') {
      const next = { ...this.baseConfig }
      for (const [k, value] of Object.entries(overrides)) {
        if (value !== undefined && value !== null && value !== '') next[k] = value
      }
      next.port = Number(next.port) || 25565
      this.baseConfig = next
      try {
        saveConnectionConfig({
          host: next.host,
          port: next.port,
          username: next.username,
          auth: next.auth,
          version: next.version,
        })
      } catch (error) {
        this.log('[mc] 连接设置存不下：', describeError(error))
      }
    }
    this.manualClose = false
    this.connectPromise = this.#doConnect()
    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  async #doConnect() {
    const { mineflayer, pf } = await this.loadLibs()
    this.#teardownBot()
    this.state = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting'
    const cfg = this.baseConfig
    this.memory = loadMemory({ host: cfg.host, username: cfg.username })
    this.pushEvent('info', `正在连 ${cfg.host}:${cfg.port}（${cfg.username}）`)

    const options = {
      host: cfg.host,
      port: Number(cfg.port) || 25565,
      username: cfg.username,
      auth: cfg.auth || 'offline',
      hideErrors: true,
    }
    if (cfg.version) options.version = cfg.version

    let bot
    try {
      if (typeof mineflayer?.createBot !== 'function') {
        throw new Error(`mineflayer 加载异常：type=${typeof mineflayer} keys=${Object.keys(mineflayer || {}).join('|')} url=${import.meta.url} req=${this._requireErr || 'none'}`)
      }
      bot = mineflayer.createBot(options)
    } catch (error) {
      this.state = 'error'
      this.lastError = describeError(error)
      if (/unsupported protocol version/i.test(this.lastError)) {
        const latest = mineflayer.latestSupportedVersion ?? '?'
        const target = cfg.version || '服务器那版'
        throw new Error(
          `连不上：mineflayer 还不认 ${target}（这版最多支持到 ${latest}）。` +
            '新版本发布后 minecraft-data 通常要过几天才补数据；要么把服开成 ' +
            `${latest}，要么等插件依赖更新。`,
        )
      }
      throw new Error(`连不上（${this.lastError}）。检查地址端口，或者服务器根本没开。`)
    }
    this.bot = bot
    this.spawnedAt = null

    bot.on('error', (error) => {
      this.lastError = describeError(error)
      this.log('[mc] 连接错误', this.lastError)
      this.pushEvent('danger', `连接出错：${this.lastError}`)
    })
    bot.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason)
      this.lastError = text
      this.pushEvent('danger', `被服务器踢了：${text}`)
      this.log('[mc] kicked', text)
    })
    bot.on('end', (reason) => {
      this.#onEnd(reason)
    })
    bot.on('spawn', () => this.#onSpawn(bot, pf))
    bot.on('respawn', () => {
      const p = bot.entity?.position
      this.pushEvent('warn', `重生了${p ? `，在 ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}` : ''}`)
    })
    bot.on('death', () => {
      const p = bot.entity?.position
      if (p) {
        const death = { x: p.x, y: p.y, z: p.z, dimension: bot.game?.dimension ?? null, at: Date.now() }
        this.memory.data.death = death
        this.memory.save()
        this.pushEvent('danger', `死了，掉在 ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`)
      } else {
        this.pushEvent('danger', '死了')
      }
      this.abortCurrent('死亡')
      try {
        this.emit('death')
      } catch {
        /* ignore */
      }
    })
    bot.on('health', () => {
      const health = bot.health
      const food = bot.food
      if (this.lastHealth !== null && health < this.lastHealth - 1) {
        this.pushEvent('warn', `掉血了：${Math.round(health)}/${Math.round(this.lastHealth)}`)
      }
      if (this.lastFood !== null && food < this.lastFood - 2) {
        this.pushEvent('warn', `饿了：饱食度 ${Math.round(food)}`)
      }
      this.lastHealth = health
      this.lastFood = food
    })
    bot.on('entityHurt', (entity) => {
      if (entity !== bot.entity) return
      let attacker = null
      try {
        const p = bot.entity?.position
        const nearest = Object.values(bot.entities || {})
          .filter((e) => e !== bot.entity && e.position && (e.name === 'creeper' || e.kind === 'Hostile mobs'))
          .sort((a, b) => dist(p, a.position) - dist(p, b.position))[0]
        if (nearest) attacker = `${nearest.name}（${dist(p, nearest.position).toFixed(1)}格）`
      } catch {
        attacker = null
      }
      this.pushEvent('warn', `我挨打了${attacker ? `，八成是 ${attacker}` : ''}`)
    })
    bot.on('windowOpen', (window) => {
      this.ui.window = windowLabel(window)
      this.pushEvent('info', `打开了界面（${this.ui.window.title || `类型 ${this.ui.window.type ?? '?'}`}），现在走不了路`)
    })
    bot.on('windowClose', () => {
      if (this.ui.window) this.pushEvent('info', '界面关掉了')
      this.ui.window = null
    })
    const onSound = (name, position, volume, pitch) => this.#recordSound(name, position, volume, pitch, bot)
    bot.on('soundEffectHeard', onSound)
    bot.on('hardcodedSoundEffectHeard', (id, position, volume, pitch) => this.#recordSound(`hardcoded:${id}`, position, volume, pitch, bot))
    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      this.#pushChat(username, message)
    })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        this.lastError = '连接超时（30 秒没进世界）'
        this.state = 'error'
        try {
          bot.quit('timeout')
        } catch {
          /* ignore */
        }
        reject(new Error('30 秒内没进世界，服务器可能没开或者版本不对。'))
      }, 30000)
      const onReady = () => {
        cleanup()
        resolve({
          ok: true,
          state: this.state,
          username: this.bot?.username ?? cfg.username,
          host: cfg.host,
          port: cfg.port,
          version: this.bot?.version ?? cfg.version ?? null,
        })
      }
      const onFailed = (error) => {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const onBotError = (error) => onFailed(new Error(describeError(error)))
      const onBotEnd = () => {
        if (!this.isOnline) onFailed(new Error(this.lastError || '服务器把连接关了'))
      }
      const cleanup = () => {
        clearTimeout(timer)
        bot.removeListener('spawn', onReady)
        bot.removeListener('error', onBotError)
        bot.removeListener('end', onBotEnd)
      }
      bot.once('spawn', onReady)
      bot.once('error', onBotError)
      bot.once('end', onBotEnd)
    })
  }

  #onSpawn(bot, pf) {
    if (bot !== this.bot) return
    this.state = 'online'
    this.reconnectAttempts = 0
    this.spawnedAt = Date.now()
    this.lastHealth = bot.health
    this.lastFood = bot.food
    this.ui.window = null
    this.lastError = null
    if (pf?.pathfinder && !bot.pathfinder) {
      try {
        bot.loadPlugin(pf.pathfinder)
        const moves = this.movements()
        if (moves) bot.pathfinder.setMovements(moves)
      } catch (error) {
        this.log('[mc] pathfinder 加载失败：', describeError(error))
      }
    }
    this.reflex.attach(bot)
    this.pushEvent('info', `上线了：${bot.username} @ ${this.baseConfig.host}:${this.baseConfig.port}（${bot.version}）`)
    this.emit('online', bot)
  }

  /** 寻路参数。默认不吃方块、会开门、会搭一格柱——和玩家的走法接近 */
  movements() {
    const pf = this.libs?.pf
    if (!pf?.Movements || !this.bot) return null
    try {
      const moves = new pf.Movements(this.bot)
      const c = this.baseConfig
      moves.canDig = c.canDig === true
      moves.allow1by1towers = c.allowTower !== false
      moves.canOpenDoors = true
      moves.canOpenFenceGates = true
      moves.allowSprinting = true
      moves.allowParkour = true
      moves.maxDropDown = c.maxDropDown ?? 3
      moves.dontMineUnderFallingBlock = true
      return moves
    } catch (error) {
      this.log('[mc] Movements 构造失败：', describeError(error))
      return null
    }
  }

  #onEnd(reason) {
    const wasOnline = this.state === 'online'
    this.reflex.detach()
    this.abortCurrent('连接断了')
    this.state = this.manualClose ? 'offline' : 'reconnecting'
    this.bot = null
    this.ui.window = null
    if (wasOnline || this.manualClose) this.pushEvent('warn', `掉线了${reason ? `（${reason}）` : ''}`)
    if (this.manualClose || !this.baseConfig.reconnect) {
      this.state = 'offline'
      return
    }
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.reconnectTimer) return
    const max = Number(this.baseConfig.maxReconnect ?? 6)
    if (this.reconnectAttempts >= max) {
      this.state = 'error'
      this.lastError = this.lastError || '重连次数用完了'
      this.pushEvent('danger', `重连 ${max} 次都失败，先停下。要我再试就 mc_connect。`)
      return
    }
    const wait = Math.min(30000, 2000 * 2 ** this.reconnectAttempts)
    this.reconnectAttempts += 1
    this.state = 'reconnecting'
    this.pushEvent('warn', `${Math.round(wait / 1000)} 秒后重连（第 ${this.reconnectAttempts} 次）`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectPromise = this.#doConnect()
      this.connectPromise
        .then(() => this.pushEvent('info', '重连成功，状态已重新拉过'))
        .catch((error) => {
          this.lastError = describeError(error)
          this.#scheduleReconnect()
        })
        .finally(() => {
          this.connectPromise = null
        })
    }, wait)
  }

  async disconnect(reason = '手动断开') {
    this.manualClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.abortCurrent(reason)
    this.reflex.detach()
    const bot = this.bot
    this.bot = null
    this.state = 'offline'
    if (bot) {
      try {
        bot.quit(reason)
      } catch {
        /* ignore */
      }
    }
    this.pushEvent('info', '下线了')
    return { ok: true, state: 'offline' }
  }

  #teardownBot() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reflex.detach()
    if (this.bot) {
      const bot = this.bot
      try {
        bot.quit('reconnect')
      } catch {
        /* ignore */
      }
      try {
        // 断开时 mineflayer 还可能抛 socket 错误；留一个哑监听，别让没主的 error 事件把进程带走
        bot.removeAllListeners()
        bot.on('error', () => {})
      } catch {
        /* ignore */
      }
    }
    this.bot = null
  }

  // ---- 事件 / 声音 / 聊天 ----

  pushEvent(level, text, extra = {}) {
    this.events.push({ at: Date.now(), level, text, ...extra })
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.emit('event', { level, text, ...extra })
  }

  drainEvents() {
    const out = this.events
    this.events = []
    return out
  }

  peekEvents() {
    return this.events.slice()
  }

  #recordSound(name, position, volume, pitch, bot) {
    try {
      const pos = bot?.entity?.position
      const sound = {
        at: Date.now(),
        name: String(name),
        volume: volume ?? null,
        pitch: pitch ?? null,
        notable: NOTABLE_SOUND.test(String(name)),
        position: position ? { x: round(position.x, 1), y: round(position.y, 1), z: round(position.z, 1) } : null,
        distance: position && pos ? round(dist(pos, position), 1) : null,
        bearing: position && pos ? bearingLabel(bot.entity.yaw, pos, position) : null,
      }
      this.sounds.push(sound)
      if (this.sounds.length > MAX_SOUNDS) this.sounds.splice(0, this.sounds.length - MAX_SOUNDS)
      if (sound.notable && sound.distance !== null && sound.distance < 24) {
        this.emit('notable-sound', sound)
      }
    } catch {
      /* 声音事件出问题不影响任何动作 */
    }
  }

  #pushChat(username, message) {
    this.chat.push({ at: Date.now(), from: username, message: String(message).slice(0, 200) })
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT)
  }

  recentSounds(limit = 8, onlyNotable = true) {
    const list = onlyNotable ? this.sounds.filter((s) => s.notable) : this.sounds
    return list.slice(-limit)
  }

  // ---- 动作登记：反射层靠中断这里 ----

  beginAction(name, detail = '') {
    if (this.action) {
      const error = new Error(`手上还有活没做完（${this.action.name}），等它结束或者先中断`)
      error.code = 'BUSY'
      throw error
    }
    const controller = new AbortController()
    this.action = { name, detail, since: Date.now(), controller }
    return controller
  }

  endAction() {
    this.action = null
  }

  abortCurrent(reason = '被中断') {
    if (!this.action) return false
    try {
      this.action.controller.abort(reason)
    } catch {
      /* ignore */
    }
    this.pushEvent('warn', `动作被打断：${this.action.name}（${reason}）`)
    return true
  }

  /** 包一层：登记 + 计时 + 一定清理，动作里只管干活 */
  async runAction(name, detail, fn, { timeoutMs, timeoutMessage, onAbort, outerSignal } = {}) {
    const controller = this.beginAction(name, detail)
    const started = Date.now()
    outerSignal ||= this.currentExecSignal
    const onOuterAbort = () => {
      try {
        controller.abort('调用被取消')
      } catch {
        /* ignore */
      }
    }
    outerSignal?.addEventListener?.('abort', onOuterAbort, { once: true })
    try {
      return await abortable(fn(controller.signal), {
        signal: controller.signal,
        timeoutMs,
        timeoutMessage,
        onAbort,
      })
    } finally {
      outerSignal?.removeEventListener?.('abort', onOuterAbort)
      this.endAction()
      this.lastAction = { name, detail, ms: Date.now() - started }
    }
  }

  /** 可中断的等待（给小脑和动作共用） */
  wait(ms, signal) {
    return abortable(sleep(ms), { signal })
  }

  // ---- 快照 ----

  snapshot({ drain = true, soundCount = 8 } = {}) {
    const bot = this.bot
    const cfg = this.baseConfig
    if (!bot || !this.isOnline) {
      const events = drain ? this.drainEvents() : this.peekEvents()
      return {
        online: false,
        state: this.state,
        lastError: this.lastError,
        connection: { host: cfg.host, port: cfg.port, username: cfg.username, version: cfg.version || null },
        reconnectAttempts: this.reconnectAttempts,
        events,
        memory: this.memory.summary(),
        hint: this.state === 'error' ? '连不上，先确认服务器开着，或者 mc_connect 换地址。' : '要上线就调 mc_connect。',
      }
    }

    const entity = bot.entity
    const p = entity.position
    const pos = { x: round(p.x, 2), y: round(p.y, 2), z: round(p.z, 2) }
    let feetBlockName = null
    let blockAtHead = null
    let canStand = null
    let standingOn = null
    let lookingAt = null
    try {
      const fx = Math.floor(p.x)
      const fy = Math.floor(p.y)
      const fz = Math.floor(p.z)
      const feet = bot.blockAt(vecAt(bot, fx, fy, fz), false)
      const below = bot.blockAt(vecAt(bot, fx, fy - 1, fz), false)
      feetBlockName = feet ? { name: feet.name, solid: feet.boundingBox === 'block' } : null
      blockAtHead = bot.blockAt(vecAt(bot, fx, fy + 1, fz), false)?.name ?? null
      canStand = !(feet && feet.boundingBox === 'block')
      standingOn = below ? { name: below.name, solid: below.boundingBox === 'block', liquid: below.name.includes('water') || below.name.includes('lava') } : null
      const cursor = bot.blockAtCursor?.(5)
      if (cursor?.position) {
        lookingAt = { name: cursor.name, position: { x: cursor.position.x, y: cursor.position.y, z: cursor.position.z }, distance: round(dist(p, cursor.position), 1) }
      }
    } catch {
      /* 方块数据缺一块不影响整体 */
    }

    const effects = []
    try {
      for (const effect of Object.values(entity.effects || {})) {
        const known = bot.registry?.effects?.[effect.id] ?? bot.registry?.effectsArray?.find?.((e) => e.id === effect.id)
        effects.push({
          name: known?.name ?? `effect_${effect.id}`,
          amplifier: effect.amplifier ?? 0,
          secondsLeft: Math.round((effect.duration ?? 0) / 20),
        })
      }
    } catch {
      /* ignore */
    }

    const inventory = []
    const armor = []
    try {
      for (const item of bot.inventory.items()) {
        inventory.push({ name: item.name, count: item.count, slot: item.slot })
      }
      for (const [slot, label] of [[5, '头盔'], [6, '胸甲'], [7, '护腿'], [8, '靴子']]) {
        const item = bot.inventory.slots[slot]
        if (item) armor.push({ part: label, name: item.name })
      }
    } catch {
      /* ignore */
    }

    const nearby = this.#nearbyEntities(bot)
    const hotbar = []
    try {
      for (let slot = 36; slot <= 44; slot += 1) {
        const item = bot.inventory.slots[slot]
        hotbar.push(item ? { slot: slot - 36, name: item.name, count: item.count } : null)
      }
    } catch {
      /* ignore */
    }

    const offhand = (() => {
      try {
        return bot.inventory.slots[45] || null
      } catch {
        return null
      }
    })()

    const events = drain ? this.drainEvents() : this.peekEvents()
    const timeOfDay = bot.time?.timeOfDay ?? 0
    const isNight = timeOfDay > 12800 && timeOfDay < 23200

    return {
      online: true,
      state: this.state,
      username: bot.username,
      version: bot.version,
      connection: { host: cfg.host, port: cfg.port },
      ping: bot.player?.ping ?? null,
      self: {
        position: pos,
        yaw: round(entity.yaw ?? 0, 3),
        pitch: round(entity.pitch ?? 0, 3),
        velocity: { x: round(entity.velocity?.x ?? 0, 2), y: round(entity.velocity?.y ?? 0, 2), z: round(entity.velocity?.z ?? 0, 2) },
        onGround: entity.onGround === true,
        health: round(bot.health, 1),
        food: round(bot.food, 1),
        oxygen: round(normalizeOxygen(bot.oxygenLevel ?? 20), 1),
        oxygenRaw: bot.oxygenLevel ?? null,
        experience: { level: bot.experience?.level ?? 0, points: bot.experience?.points ?? 0 },
        effects,
        armor,
        held: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count, slot: bot.heldItem.slot } : null,
        offhand: offhand ? { name: offhand.name, count: offhand.count } : null,
        hotbarSlot: bot.quickBarSlot ?? 0,
        hotbar,
      },
      world: {
        dimension: bot.game?.dimension ?? null,
        mode: bot.game?.gameMode ?? null,
        difficulty: bot.game?.difficulty ?? null,
        day: bot.time?.day ?? null,
        timeOfDay,
        clock: `${String(Math.floor(timeOfDay / 1000)).padStart(2, '0')}:${String(Math.floor(((timeOfDay % 1000) / 1000) * 60)).padStart(2, '0')}`,
        isNight,
        raining: bot.isRaining === true,
        thunder: Boolean(bot.thunderState),
        feetBlock: feetBlockName,
        blockAtHead,
        standingOn,
        canStandHere: canStand,
        lookingAt,
      },
      inventory,
      nearby,
      sounds: this.recentSounds(soundCount),
      chat: this.chat.slice(-6),
      interface: this.ui.window ?? { isOpen: false },
      action: this.action ? { name: this.action.name, detail: this.action.detail, ms: Date.now() - this.action.since } : null,
      lastAction: this.lastAction ?? null,
      reflexes: this.reflex.history(),
      plan: this.planProvider ? this.planProvider() : null,
      rhythm: this.rhythmProvider ? this.rhythmProvider() : null,
      trail: this.trailProvider ? this.trailProvider() : null,
      machine: this.machineProvider ? this.machineProvider() : null,
      chatLink: this.chatProvider ? this.chatProvider() : null,
      autopilot: this.autopilotProvider ? this.autopilotProvider() : null,
      idle: this.idleProvider ? this.idleProvider() : null,
      events,
      memory: this.memory.summary(),
    }
  }

  #nearbyEntities(bot) {
    const p = bot.entity.position
    const out = { hostiles: [], players: [], items: [], animals: [] }
    try {
      for (const e of Object.values(bot.entities || {})) {
        if (e === bot.entity || !e.position || e.isValid === false) continue
        const d = dist(p, e.position)
        if (d > 32) continue
        const entry = {
          id: e.id,
          name: e.name,
          distance: round(d, 1),
          bearing: bearingLabel(bot.entity.yaw, p, e.position),
          position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
        }
        if (e.name === 'item') {
          let dropped = null
          try {
            dropped = e.getDroppedItem?.()?.name ?? null
          } catch {
            dropped = null
          }
          out.items.push({ ...entry, item: dropped, count: e.count ?? null })
        } else if (e.type === 'player') {
          out.players.push(entry)
        } else if (e.kind === 'Hostile mobs') {
          out.hostiles.push(entry)
        } else if (e.kind === 'Passive mobs' || e.kind === 'Animal') {
          out.animals.push(entry)
        }
        if (out.hostiles.length >= 12 && out.items.length >= 12 && out.players.length >= 8) break
      }
    } catch {
      /* ignore */
    }
    out.hostiles.sort((a, b) => a.distance - b.distance)
    out.items.sort((a, b) => a.distance - b.distance)
    out.hostiles = out.hostiles.slice(0, 10)
    out.items = out.items.slice(0, 8)
    out.players = out.players.slice(0, 6)
    out.animals = out.animals.slice(0, 6)
    return out
  }

  /** 给别的地方（施工/动作）用的轻量世界视图 */
  world() {
    if (!this.bot) return null
    return senseWorld(this.bot, this.reflexConfig)
  }
}
