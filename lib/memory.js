/**
 * 本地小地图 + 目标 + 施工进度。
 * 一个 bot 一个文件：$DSH_HOME/mc-player/<host>_<username>.json
 * 写盘失败不影响动作，只是这一轮记不住 —— 所有调用都吞异常并回报到返回值里。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MAX_NOTES = 200
const MAX_BUILDS = 20

export function dataDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'mc-player')
}

export function memoryPath({ host, username }) {
  const safe = (s) => String(s || 'unknown').replace(/[^\w.\-@\u4e00-\u9fa5]/g, '_').slice(0, 60)
  return path.join(dataDir(), `${safe(host)}_${safe(username)}.json`)
}

export function configPath() {
  return path.join(dataDir(), 'config.json')
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const emptyMemory = () => ({
  version: 1,
  places: {},
  death: null,
  goal: null,
  notes: [],
  builds: {},
  updatedAt: null,
})

/**
 * 一份很轻的记忆。每次 set 立刻落盘，进程崩了也不丢。
 */
export class Memory {
  constructor(file) {
    this.file = file
    this.data = { ...emptyMemory(), ...readJson(file, {}) }
    this.data.places ||= {}
    this.data.notes ||= []
    this.data.builds ||= {}
  }

  get(key) {
    return this.data[key] ?? null
  }

  /** 记一个地点：家 / 矿洞 / 上次死的地方 / 随便什么 */
  setPlace(name, place) {
    this.data.places[name] = { ...place, at: Date.now() }
    return this.save()
  }

  getPlace(name) {
    return this.data.places[name] ?? null
  }

  listPlaces() {
    return Object.entries(this.data.places).map(([name, place]) => ({ name, ...place }))
  }

  setGoal(text) {
    this.data.goal = text ? { text, at: Date.now() } : null
    return this.save()
  }

  addNote(text) {
    this.data.notes.push({ text, at: Date.now() })
    if (this.data.notes.length > MAX_NOTES) this.data.notes.splice(0, this.data.notes.length - MAX_NOTES)
    return this.save()
  }

  build(id) {
    return this.data.builds[id] ?? null
  }

  saveBuild(id, value) {
    this.data.builds[id] = { ...value, updatedAt: Date.now() }
    const ids = Object.keys(this.data.builds)
    if (ids.length > MAX_BUILDS) {
      ids.sort((a, b) => (this.data.builds[a].updatedAt || 0) - (this.data.builds[b].updatedAt || 0))
      for (const old of ids.slice(0, ids.length - MAX_BUILDS)) delete this.data.builds[old]
    }
    return this.save()
  }

  summary() {
    return {
      goal: this.data.goal,
      places: this.listPlaces(),
      death: this.data.death,
      notes: this.data.notes.slice(-5),
      builds: Object.entries(this.data.builds).map(([id, b]) => ({
        id,
        name: b.name,
        done: b.done?.length ?? 0,
        planned: b.planned ?? null,
        updatedAt: b.updatedAt,
      })),
    }
  }

  save() {
    this.data.updatedAt = Date.now()
    try {
      writeJson(this.file, this.data)
      return { ok: true, file: this.file }
    } catch (error) {
      return { ok: false, error: String(error?.message || error), file: this.file }
    }
  }
}

export function loadMemory(opts) {
  return new Memory(memoryPath(opts))
}

/** 连接设置单独存一份，模型改过一次，下次重启还记得 */
export function loadConnectionConfig() {
  return readJson(configPath(), null)
}

export function saveConnectionConfig(cfg) {
  writeJson(configPath(), cfg)
  return cfg
}
