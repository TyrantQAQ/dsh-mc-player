/**
 * dsh-mc-player
 *
 * 小脑 + 大脑的 Minecraft 玩家插件。
 * 这个文件只做三件事：建会话、挂工具、收拾干净。
 */

import { Session } from './session.js'
import { Autopilot, DEFAULT_AUTOPILOT } from './autopilot.js'
import { Rhythm, DEFAULT_RHYTHM } from './rhythm.js'
import { MapMemory, DEFAULT_MAP } from './mapmemory.js'
import { MachineWatcher, DEFAULT_MACHINE } from './machine.js'
import { ChatLink, DEFAULT_CHAT } from './chat.js'
import { IdleThinker, DEFAULT_IDLE } from './idle.js'
import { registerTools } from './tools.js'
import { DEFAULT_REFLEX } from './reflex.js'
import { describeError } from './util.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import { loadSettings, saveSettings, mergeSettings, settingsPath, DEFAULT_SETTINGS } from './settings.js'

export const name = 'mc-player'
export const inject = ['tools', 'webServer']

const PREFIX = '[mc-player]'

function ensure262Data(log) {
  try {
    const req = createRequire(import.meta.url)
    const data = req('minecraft-data')('26.2')
    if (data?.blocksByName?.stone) return true
  } catch {
    /* 数据没装 */
  }
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const setup = path.join(root, 'vendor', '26.2', 'setup.cjs')
    const r = spawnSync(process.execPath, [setup, root], { cwd: root, encoding: 'utf8', timeout: 180000 })
    const line = String(r.stdout || '').trim().split('\n').slice(-1)[0]
    log('26.2 数据缺失，已自动补装：', line || `exit ${r.status}`)
    return r.status === 0
  } catch (error) {
    log('自动补装 26.2 数据失败：', describeError(error))
    return false
  }
}

export function apply(ctx, config = {}) {
  const log = (...args) => console.log(PREFIX, ...args)
  ensure262Data(log)
  // 冒烟测试用假的 ctx，没有 get；真宿主有
  const getService = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  // 设置页保存的运行时设置：优先级高于 patch 里的 config
  const saved = loadSettings()
  const runtime = { settings: saved }
  const pick = (name, defaults) => ({ ...(defaults || {}), ...(config[name] || {}), ...(saved[name] || {}) })
  const conn = { ...(config.connection || {}), ...(saved.connection || {}) }
  let session

  try {
    session = new Session({
      config: {
        connection: conn,
        reflex: { ...DEFAULT_REFLEX, ...(config.reflex || {}), ...(saved.reflex || {}) },
      },
      log,
    })
  } catch (error) {
    log('初始化失败，插件不挂任何工具：', describeError(error))
    return
  }

  // 会话里没给阈值时就按默认来（patch 里只写了连接信息也照常工作）
  session.reflexConfig = { ...DEFAULT_REFLEX, ...(config.reflex || {}), ...(saved.reflex || {}), ...(session.reflexConfig || {}) }
  session.baseConfig = { ...session.baseConfig, ...conn }

  if (Number.isFinite(Number(config.mistakeChance))) {
    session.baseConfig.mistakeChance = Math.min(Math.max(Number(config.mistakeChance), 0), 0.5)
  }

  const autopilot = new Autopilot({
    session,
    config: pick('autopilot', DEFAULT_AUTOPILOT),
    log,
  })
  session.planProvider = () => autopilot.summary()
  session.autopilotProvider = () => autopilot.status()
  session.autopilotPlan = () => autopilot.plan

  const rhythm = new Rhythm({ session, config: pick('rhythm', DEFAULT_RHYTHM), log })
  session.rhythm = rhythm
  session.rhythmProvider = () => rhythm.status()

  const mapMemory = new MapMemory({ session, config: pick('map', DEFAULT_MAP), log })
  session.map = mapMemory
  session.trailProvider = () => mapMemory.summary()

  const machine = new MachineWatcher({ session, config: pick('machine', DEFAULT_MACHINE), log })
  session.machine = machine
  session.machineProvider = () => machine.status()

  // 叫醒大脑：把游戏里的话变成当前会话的一条用户消息
  const wakeBrain = async (text) => {
    const sc = getService('sessionController')
    const agents = getService('agents')
    const sessionId = runtime.settings.boundSessionId ?? session.dshSessionId ?? agents?.currentInitiator?.()?.id ?? agents?.roots?.()?.[0]?.id
    if (!sessionId) session.dshSessionId = sessionId
    if (!sc?.prompt || !sessionId) {
      session.pushEvent?.('warn', `聊天没转给大脑：sc=${typeof sc?.prompt} sid=${sessionId ? 'yes' : 'no'} get=${typeof ctx.get}`)
      return false
    }
    try {
      await sc.prompt(
        {
          requestId: `mc-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
      return true
    } catch (error) {
      log('[chat] 叫醒大脑失败', error?.message || error)
      session.pushEvent?.('warn', `聊天转给大脑失败：${error?.message || error}`)
      return false
    }
  }
  const chat = new ChatLink({ session, config: pick('chat', DEFAULT_CHAT), log, wake: wakeBrain })
  session.chatLink = chat
  session.chatProvider = () => chat.status()
  chat.start()

  const idle = new IdleThinker({ session, config: pick('idle', DEFAULT_IDLE), log, wake: wakeBrain })
  session.idle = idle
  session.idleProvider = () => idle.status()
  idle.start()
  if (autopilot.cfg.enabled) autopilot.start()
  if (rhythm.cfg.enabled) rhythm.start()
  if (mapMemory.cfg.enabled) mapMemory.start()
  ctx.effect(() => () => {
    autopilot.stop()
    rhythm.stop()
    mapMemory.stop()
    machine.stop()
    chat.stop()
    idle.stop()
  })

  // 运行时可改设置的读写 + 设置页用的 HTTP API
  const applyRuntime = () => {
    autopilot.cfg = { ...DEFAULT_AUTOPILOT, ...runtime.settings.autopilot }
    rhythm.cfg = { ...DEFAULT_RHYTHM, ...runtime.settings.rhythm }
    idle.cfg = { ...DEFAULT_IDLE, ...runtime.settings.idle }
    chat.cfg = { ...DEFAULT_CHAT, ...runtime.settings.chat }
    machine.cfg = { ...DEFAULT_MACHINE, ...runtime.settings.machine }
    mapMemory.cfg = { ...DEFAULT_MAP, ...runtime.settings.map }
    session.reflexConfig = { ...DEFAULT_REFLEX, ...runtime.settings.reflex }
    session.baseConfig = { ...session.baseConfig, ...runtime.settings.connection }
    if (autopilot.cfg.enabled) autopilot.start(); else autopilot.stop()
    if (rhythm.cfg.enabled) rhythm.start(); else rhythm.stop()
    if (idle.cfg.enabled) idle.start(); else idle.stop()
    if (mapMemory.cfg.enabled) mapMemory.start(); else mapMemory.stop()
  }
  session.runtime = runtime
  session.applyRuntime = applyRuntime
  const webServer = getService('webServer')
  if (webServer?.register) {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/dsh-mc-player/api',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
        const readBody = () => new Promise((resolve) => { let raw = ''; req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() }); req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } }) })
        try {
          if (url.pathname === '/dsh-mc-player/api/settings' && req.method === 'GET') {
            return send(200, { settings: runtime.settings, defaults: DEFAULT_SETTINGS, path: settingsPath() })
          }
          if (url.pathname === '/dsh-mc-player/api/settings' && req.method === 'PUT') {
            const patch = await readBody()
            runtime.settings = mergeSettings(runtime.settings, patch || {})
            saveSettings(runtime.settings)
            applyRuntime()
            return send(200, { settings: runtime.settings })
          }
          if (url.pathname === '/dsh-mc-player/api/sessions' && req.method === 'GET') {
            const sc = getService('sessionController')
            let items = []
            if (sc?.list) {
              const r = await sc.list({}, new AbortController().signal)
              items = (r?.items ?? []).map((s) => ({ id: s.sessionId, updatedAt: s.updatedAt, running: s.running, blank: s.blank, parentSessionId: s.parentSessionId ?? null, origin: s.origin ?? null, delegationDepth: s.delegationDepth ?? null }))
              // 补上会话标题（标题是单独 fold 出来的投影）
              try {
                const q = getService('sessionQuery')
                if (q?.readTitleSnapshots) {
                  const obs = await q.readTitleSnapshots(items.map((i) => i.id), new AbortController().signal)
                  const titles = {}
                  const headers = {}
                  for (const o of obs ?? []) {
                    if (o?.status !== 'fulfilled') continue
                    if (o.value?.title?.title) titles[o.sessionId] = o.value.title.title
                    if (o.value?.session) headers[o.sessionId] = o.value.session
                  }
                  // 子会话（子代理/委派出来的一层）不进可选列表
                  items = items.filter((i) => {
                    const h = headers[i.id]
                    if (!h) return true
                    return h.origin !== 'subagent' && !(h.delegationDepth > 0)
                  })
                  items = items.map((i) => ({ ...i, title: titles[i.id] ?? null }))
                }
              } catch (error) {
                log('读会话标题失败：', error?.message || error)
              }
            }
            return send(200, { items, boundSessionId: runtime.settings.boundSessionId ?? null })
          }
          if (url.pathname === '/dsh-mc-player/api/status' && req.method === 'GET') {
            return send(200, {
              online: session.isOnline,
              connection: runtime.settings.connection,
              boundSessionId: runtime.settings.boundSessionId ?? null,
              currentSessionId: session.dshSessionId ?? null,
              plan: session.planProvider?.() ?? null,
              idle: session.idleProvider?.() ?? null,
            })
          }
          if (url.pathname === '/dsh-mc-player/api/connect' && req.method === 'POST') {
            const body = await readBody()
            const cfg = { ...runtime.settings.connection, ...(body || {}) }
            runtime.settings.connection = cfg
            saveSettings(runtime.settings)
            try {
              await session.connect(cfg)
              return send(200, { ok: true, online: session.isOnline })
            } catch (error) {
              return send(200, { ok: false, error: error?.message || String(error) })
            }
          }
          if (url.pathname === '/dsh-mc-player/api/disconnect' && req.method === 'POST') {
            await session.disconnect('设置页断开')
            return send(200, { ok: true, online: session.isOnline })
          }
          return send(404, { error: 'not found' })
        } catch (error) {
          return send(500, { error: error?.message || String(error) })
        }
      },
    }))
  }

  registerTools(ctx, { session, log, config, autopilot })

  if (config.autoConnect === true) {
    const timer = setTimeout(() => {
      session.connect().catch((error) => log('自动上线失败：', describeError(error)))
    }, Number(config.autoConnectDelayMs) || 1200)
    ctx.effect(() => () => clearTimeout(timer))
  }

  ctx.effect(() => () => {
    try {
      session.disconnect('插件卸载')
    } catch (error) {
      log('关闭会话失败', describeError(error))
    }
  })

  log('就绪：工具已注册，等 mc_connect 或 config.autoConnect')
}
