/**
 * 小工具。不依赖 mineflayer，方便在没有服务器的环境里单测。
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 纯对象坐标，避免让 Vec3 漏到返回值里 */
export function v3(x, y, z) {
  return { x: Number(x), y: Number(y), z: Number(z) }
}

export function toV3(p) {
  if (!p) return null
  if (Array.isArray(p)) return v3(p[0], p[1], p[2])
  return v3(p.x, p.y, p.z)
}

/**
 * mineflayer / prismarine-world 的 blockAt 只认 Vec3（内部会调 pos.floored()），
 * 所以坐标在进 bot 之前必须变成真 Vec3。拿实体位置的构造函数来造，避免多引一个包。
 */
export function vecAt(bot, x, y, z) {
  const V = bot?.entity?.position?.constructor
  const fx = Math.floor(Number(x))
  const fy = Math.floor(Number(y))
  const fz = Math.floor(Number(z))
  return typeof V === 'function' ? new V(fx, fy, fz) : { x: fx, y: fy, z: fz }
}

export function asVec(bot, p) {
  if (Array.isArray(p)) return vecAt(bot, p[0], p[1], p[2])
  return vecAt(bot, p.x, p.y, p.z)
}

/** 不做取整的 Vec3（转头、看某个点用这个——blockAt 才需要取整） */
export function pointAt(bot, x, y, z) {
  const V = bot?.entity?.position?.constructor
  const fx = Number(x)
  const fy = Number(y)
  const fz = Number(z)
  return typeof V === 'function' ? new V(fx, fy, fz) : { x: fx, y: fy, z: fz }
}

export function key(p) {
  return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
}

export function dist(a, b) {
  if (!a || !b) return Infinity
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

export function dist2d(a, b) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

export function round(n, digits = 2) {
  if (!Number.isFinite(n)) return n
  const f = 10 ** digits
  return Math.round(n * f) / f
}

/** 把角度归一到 (-PI, PI] */
export function wrapAngle(a) {
  let x = a
  while (x <= -Math.PI) x += Math.PI * 2
  while (x > Math.PI) x -= Math.PI * 2
  return x
}

/** 相对朝向：正前/左前/左/左后/后/右后/右/右前。负角在右手边（mineflayer 约定） */
export function bearingLabel(botYaw, from, to) {
  if (!from || !to) return '未知'
  const targetYaw = Math.atan2(-(to.x - from.x), -(to.z - from.z))
  const diff = wrapAngle(targetYaw - (botYaw ?? 0))
  const deg = (diff * 180) / Math.PI
  if (Math.abs(deg) <= 30) return '正前方'
  if (Math.abs(deg) >= 150) return '正后方'
  if (deg > 0) return deg < 90 ? '左前方' : '左后方'
  return deg > -90 ? '右前方' : '右后方'
}

/** 水平方向（N/E/S/W），给"家在哪个方向"这种话用 */
export function compass(botYaw, from, to) {
  const targetYaw = Math.atan2(-(to.x - from.x), -(to.z - from.z))
  const names = ['北', '西北', '西', '西南', '南', '东南', '东', '东北']
  const idx = Math.round((((targetYaw * 180) / Math.PI + 360) % 360) / 45) % 8
  return names[idx]
}

export class AbortError extends Error {
  constructor(message = '动作被中断') {
    super(message)
    this.name = 'AbortError'
    this.code = 'ABORTED'
  }
}

export class TimeoutError extends Error {
  constructor(message = '动作超时') {
    super(message)
    this.name = 'TimeoutError'
    this.code = 'TIMEOUT'
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw new AbortError(signal.reason ? String(signal.reason) : undefined)
}

/**
 * 让任意 promise 支持 abort / 超时。中断时先调 onAbort（用来停 pathfinder、停 dig），
 * 再抛出 AbortError —— 这样"小脑"能立刻打断正在挖的矿。
 */
export function abortable(promise, { signal, timeoutMs, onAbort, timeoutMessage } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onSignal)
      fn(value)
    }
    const onSignal = () => {
      try {
        onAbort?.()
      } catch {
        /* 中断处理本身失败不该再抛 */
      }
      finish(reject, new AbortError(signal?.reason ? String(signal.reason) : undefined))
    }
    if (signal?.aborted) {
      onSignal()
      return
    }
    signal?.addEventListener?.('abort', onSignal, { once: true })
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          onAbort?.()
        } catch {
          /* ignore */
        }
        finish(reject, new TimeoutError(timeoutMessage))
      }, timeoutMs)
    }
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

/** 轮询等待条件成立；用于给 mineflayer 的异步状态一个确定的观察窗口 */
export async function waitFor(check, { timeoutMs = 5000, intervalMs = 100, signal } = {}) {
  const started = Date.now()
  for (;;) {
    throwIfAborted(signal)
    let value
    try {
      value = await check()
    } catch {
      value = false
    }
    if (value) return value
    if (Date.now() - started > timeoutMs) return null
    await sleep(intervalMs)
  }
}

/**
 * 转身这类动作靠服务器回执才 resolve，网络一卡就永远等下去。
 * 这种"做不成也无所谓"的等待用它：最多等 ms，错了也不炸。
 */
export function softWait(promise, ms = 1200) {
  const guarded = Promise.resolve(promise).then(
    () => true,
    () => false,
  )
  return Promise.race([guarded, sleep(ms).then(() => false)])
}

/**
 * 氧气归一化。mineflayer 的 oxygenLevel 是 air_supply / 15：
 * 1.16 满氧是 20；26.2 的 air_supply 单位变大，满氧会读到 300。
 * 反射层的阈值按 0~20 写，所以超过 20 的值按 15 倍缩放回来，再夹到 0~20。
 */
export function normalizeOxygen(raw) {
  const v = Number(raw)
  if (!Number.isFinite(v)) return 20
  const scaled = v > 20 ? v / 15 : v
  return Math.max(0, Math.min(20, Math.round(scaled)))
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/** 把错误转成一句能进工具返回值的话（绝不把整个堆栈甩给模型） */
export function describeError(error) {
  if (!error) return '未知错误'
  const code = error.code || error.name
  const msg = String(error.message || error)
  return code && !msg.includes(code) ? `${code}: ${msg}` : msg
}
