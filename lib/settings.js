/**
 * 运行时可改的设置：存成 JSON，设置页读写；插件启动时并进 config。
 *
 * 优先级：settings.json（用户在设置页保存的） > cordis.patch.yml 的 config > 内置默认。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEFAULT_SETTINGS = {
  connection: { host: '127.0.0.1', port: 25565, username: 'xiaojingyu', version: '26.2', auth: 'offline' },
  boundSessionId: null,
  reflex: { enabled: true, lowHealth: 6, surroundCount: 3, creeperRange: 4 },
  rhythm: { enabled: true, idleLookAfterMs: 12000, sleepAfterDays: 2 },
  chat: { enabled: true },
  idle: { enabled: true, afterSeconds: 10, cooldownSeconds: 120 },
  autopilot: { enabled: true, intervalMs: 2500, minHealth: 8, maxAttempts: 3 },
  machine: { maxMinutes: 30 },
  map: { enabled: true },
}

export function settingsDir() {
  const base = process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'mc-player') : path.join(os.homedir(), '.dsh', 'mc-player')
  return base
}

export function settingsPath() {
  return path.join(settingsDir(), 'settings.json')
}

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

export function mergeSettings(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = mergeSettings(base[k], v)
    else out[k] = v
  }
  return out
}

export function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
    return mergeSettings(DEFAULT_SETTINGS, raw || {})
  } catch {
    return mergeSettings(DEFAULT_SETTINGS, {})
  }
}

export function saveSettings(settings) {
  const dir = settingsDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  return settingsPath()
}
