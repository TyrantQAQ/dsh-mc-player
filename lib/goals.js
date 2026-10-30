/**
 * 自主目标：一份"打算" + 一串步骤 + 一本账。
 *
 * 设计上刻意不在这里替模型想事：想干什么由大脑（模型）通过 mc_goal 定，
 * 这里负责把它拆成能执行的步骤、记住做到哪了、失败了为什么，然后由 autopilot 一步步做。
 *
 * 一份 plan 长这样：
 * {
 *   id: 'g1k2', text: '挖 20 块石头并把木镐磨一磨',
 *   status: 'active' | 'paused' | 'blocked' | 'done',
 *   steps: [{ id, kind, spec, status, progress, attempts, note }],
 *   log: [{ at, step, ok, note }]
 * }
 */

const KINDS = new Set(['gather', 'craft', 'build', 'goto', 'place', 'sleep', 'enchant', 'anvil', 'trade', 'farm', 'fish', 'brew', 'tame', 'fight', 'manual'])

let seq = 0
function nextId(prefix) {
  seq += 1
  return `${prefix}${Date.now().toString(36).slice(-4)}${seq}`
}

export function normalizeStep(input, index = 0) {
  if (!input || typeof input !== 'object') throw new Error(`第 ${index + 1} 步不是对象`)
  const kind = String(input.kind || input.intent || '').toLowerCase()
  if (!KINDS.has(kind)) throw new Error(`第 ${index + 1} 步的 kind 不认识：${kind}（支持 ${[...KINDS].join(' / ')}）`)
  const spec = {}
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined)

  if (kind === 'gather') {
    if (!input.block) throw new Error(`第 ${index + 1} 步 gather 缺 block`)
    spec.block = String(input.block)
    spec.count = Math.max(1, Math.floor(num(input.count) ?? 1))
    spec.maxDistance = Math.max(2, Math.floor(num(input.maxDistance) ?? 48))
    spec.pickup = input.pickup !== false
  } else if (kind === 'craft') {
    if (!input.item) throw new Error(`第 ${index + 1} 步 craft 缺 item`)
    spec.item = String(input.item)
    spec.count = Math.max(1, Math.floor(num(input.count) ?? 1))
  } else if (kind === 'build') {
    if (!input.blueprint || typeof input.blueprint !== 'object') throw new Error(`第 ${index + 1} 步 build 缺 blueprint`)
    spec.blueprint = input.blueprint
    spec.force = input.force === true
  } else if (kind === 'goto') {
    if (input.place) spec.place = String(input.place)
    else {
      spec.x = num(input.x)
      spec.y = num(input.y)
      spec.z = num(input.z)
      if (spec.x === undefined || spec.y === undefined || spec.z === undefined) {
        throw new Error(`第 ${index + 1} 步 goto 要给 x/y/z 或 place`)
      }
    }
    spec.range = Math.max(0.5, num(input.range) ?? 1.5)
  } else if (kind === 'place') {
    spec.x = num(input.x)
    spec.y = num(input.y)
    spec.z = num(input.z)
    if ([spec.x, spec.y, spec.z].some((v) => v === undefined)) throw new Error(`第 ${index + 1} 步 place 要给 x/y/z`)
    spec.block = String(input.block || '')
    if (!spec.block) throw new Error(`第 ${index + 1} 步 place 缺 block`)
    if (input.state) spec.state = input.state
    if (input.tower) spec.tower = Math.max(1, Math.floor(num(input.tower) ?? 1))
  } else if (kind === 'farm') {
    const action = String(input.action || 'harvest')
    if (!['till', 'plant', 'harvest'].includes(action)) throw new Error(`第 ${index + 1} 步 farm 的 action 不认识：${action}`)
    spec.action = action
    if (action !== 'harvest') {
      for (const k of ['x', 'y', 'z']) {
        spec[k] = num(input[k])
        if (spec[k] === undefined) throw new Error(`第 ${index + 1} 步 farm ${action} 要给 x/y/z`)
      }
    }
    if (action === 'plant') {
      if (!input.crop) throw new Error(`第 ${index + 1} 步 farm plant 缺 crop`)
      spec.crop = String(input.crop)
    }
    if (input.radius !== undefined) spec.radius = num(input.radius)
    if (input.replant === false) spec.replant = false
  } else if (kind === 'brew') {
    if (!input.ingredient) throw new Error(`第 ${index + 1} 步 brew 缺 ingredient`)
    spec.ingredient = String(input.ingredient)
    for (const k of ['x', 'y', 'z']) if (input[k] !== undefined) spec[k] = num(input[k])
    if (input.timeoutMs !== undefined) spec.timeoutMs = num(input.timeoutMs)
  } else if (kind === 'tame') {
    if (input.entityId !== undefined) spec.entityId = num(input.entityId)
    if (input.item) spec.item = String(input.item)
  } else if (kind === 'fight') {
    if (input.radius !== undefined) spec.radius = num(input.radius)
    if (input.retreatBelow !== undefined) spec.retreatBelow = num(input.retreatBelow)
  } else if (kind === 'fish') {
    spec.count = Math.max(1, Math.floor(num(input.count) ?? 1))
    if (input.maxMs !== undefined) spec.maxMs = num(input.maxMs)
  } else if (kind === 'enchant') {
    if (!input.item) throw new Error(`第 ${index + 1} 步 enchant 缺 item`)
    spec.item = String(input.item)
    if (input.choice !== undefined) spec.choice = Math.floor(num(input.choice) ?? 0)
    for (const k of ['x', 'y', 'z']) if (input[k] !== undefined) spec[k] = num(input[k])
  } else if (kind === 'anvil') {
    if (!input.item) throw new Error(`第 ${index + 1} 步 anvil 缺 item`)
    spec.item = String(input.item)
    if (input.item2) spec.item2 = String(input.item2)
    if (input.name) spec.name = String(input.name).slice(0, 35)
    for (const k of ['x', 'y', 'z']) if (input[k] !== undefined) spec[k] = num(input[k])
  } else if (kind === 'trade') {
    if (input.entityId !== undefined) spec.entityId = num(input.entityId)
    spec.tradeIndex = Math.max(0, Math.floor(num(input.tradeIndex) ?? 0))
    spec.count = Math.max(1, Math.floor(num(input.count) ?? 1))
  } else if (kind === 'sleep') {
    spec.note = input.note ? String(input.note) : null
  } else if (kind === 'manual') {
    spec.text = String(input.text || '需要大脑接手').slice(0, 500)
  }

  return {
    id: nextId('s'),
    kind,
    spec,
    status: 'pending',
    progress: 0,
    attempts: 0,
    note: null,
    startedAt: null,
    finishedAt: null,
  }
}

export function createPlan({ text, steps, note } = {}) {
  const list = Array.isArray(steps) ? steps : []
  if (!list.length) throw new Error('至少给一个步骤，不然没有可做的东西')
  return {
    id: nextId('g'),
    text: String(text || '没写名字的计划').slice(0, 200),
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    steps: list.map((s, i) => normalizeStep(s, i)),
    log: [],
    note: note ? String(note).slice(0, 500) : null,
  }
}

/** 当前该做的那一步：第一个没做完的；全做完返回 null */
export function currentStep(plan) {
  if (!plan || plan.status !== 'active') return null
  return plan.steps.find((s) => s.status === 'pending' || s.status === 'running') ?? null
}

export function stepLabel(step) {
  if (!step) return '（没有步骤）'
  const s = step.spec || {}
  switch (step.kind) {
    case 'gather': return `挖 ${s.count} 块 ${s.block}（已有 ${step.progress}/${s.count}）`
    case 'craft': return `合成 ${s.count} 个 ${s.item}（已有 ${step.progress}/${s.count}）`
    case 'build': return `施工：${s.blueprint?.name ?? '图纸'}`
    case 'goto': return s.place ? `去 ${s.place}` : `去 ${s.x} ${s.y} ${s.z}`
    case 'place': return `在 ${s.x} ${s.y} ${s.z} 放 ${s.block}`
    case 'sleep': return '睡觉（等天亮）'
    case 'farm': return `种地：${s.action}${s.crop ? ` ${s.crop}` : ''}${s.radius ? `（半径 ${s.radius}）` : ''}`
    case 'fish': return `钓鱼 x${s.count ?? 1}`
    case 'fight': return `打附近的怪（半径 ${s.radius ?? 12}）`
    case 'brew': return `酿造：${s.ingredient}`
    case 'tame': return `驯养${s.item ? `（${s.item}）` : ''}`
    case 'enchant': return `附魔 ${s.item}${s.choice !== undefined ? `（选项 ${s.choice}）` : ''}`
    case 'anvil': return `铁砧：${s.item}${s.item2 ? ` + ${s.item2}` : ''}${s.name ? `（改名 ${s.name}）` : ''}`
    case 'trade': return `跟村民交易（第 ${s.tradeIndex ?? 0} 项 x${s.count ?? 1}）`
    case 'manual': return `需要大脑：${s.text}`
    default: return step.kind
  }
}

/**
 * 记一笔账。成功时按 evidence 推进度，失败时累计 attempts。
 * 返回 { advanced, stepDone, planDone, blocked, note }
 */
export function applyStepResult(plan, step, result, { maxAttempts = 3 } = {}) {
  const now = Date.now()
  // 显式的 ok 优先：比如"挖到一半、部分成功"时 mine 的 verified 是 false，
  // 但这一步确实有进展，不该按失败重试。
  const ok = result?.ok !== undefined ? result.ok !== false : result?.verified !== false
  let advanced = false
  let stepDone = false
  let blocked = false
  let note = result?.summary || result?.note || ''

  if (ok) {
    if (step.kind === 'gather' || step.kind === 'craft') {
      const gained = Number(result?.progressDelta ?? 0)
      step.progress = Math.min(step.spec.count, step.progress + (gained > 0 ? gained : 1))
      advanced = gained !== 0 || step.kind === 'craft'
      stepDone = step.progress >= step.spec.count
    } else {
      step.progress = 1
      stepDone = true
    }
    if (stepDone) {
      step.status = 'done'
      step.finishedAt = now
    } else {
      step.status = 'pending'
      step.attempts = 0
    }
    step.note = note || null
  } else {
    step.attempts += 1
    step.note = note || '失败'
    if (step.attempts >= maxAttempts) {
      step.status = 'failed'
      step.finishedAt = now
      plan.status = 'blocked'
      blocked = true
      note = `第 ${plan.steps.indexOf(step) + 1} 步卡住了：${step.note}`
      plan.note = note
    } else {
      step.status = 'pending'
    }
  }

  plan.updatedAt = now
  plan.log.push({ at: now, step: step.id, kind: step.kind, ok: ok && !blocked, note: note.slice(0, 300) })
  if (plan.log.length > 80) plan.log.splice(0, plan.log.length - 80)

  const planDone = plan.steps.every((s) => s.status === 'done')
  if (planDone && plan.status === 'active') plan.status = 'done'

  return { advanced, stepDone, planDone, blocked, note }
}

export function planSummary(plan) {
  if (!plan) return null
  const done = plan.steps.filter((s) => s.status === 'done').length
  const step = currentStep(plan)
  return {
    id: plan.id,
    text: plan.text,
    status: plan.status,
    steps: plan.steps.length,
    done,
    current: step ? { index: plan.steps.indexOf(step) + 1, label: stepLabel(step), status: step.status, attempts: step.attempts } : null,
    log: plan.log.slice(-6),
    updatedAt: plan.updatedAt,
  }
}

/** 从旧数据里兜底：字段缺了补上，别让坏数据把 autopilot 卡死 */
export function revivePlan(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return null
  const steps = raw.steps.filter((s) => s && KINDS.has(s.kind)).map((s) => ({
    id: s.id || nextId('s'),
    kind: s.kind,
    spec: s.spec || {},
    status: ['pending', 'running', 'done', 'failed'].includes(s.status) ? s.status : 'pending',
    progress: Number(s.progress) || 0,
    attempts: Number(s.attempts) || 0,
    note: s.note ?? null,
    startedAt: s.startedAt ?? null,
    finishedAt: s.finishedAt ?? null,
  }))
  if (!steps.length) return null
  const status = ['active', 'paused', 'blocked', 'done'].includes(raw.status) ? raw.status : 'paused'
  return {
    id: raw.id || nextId('g'),
    text: String(raw.text || '旧计划'),
    status,
    createdAt: raw.createdAt || Date.now(),
    updatedAt: raw.updatedAt || Date.now(),
    steps,
    log: Array.isArray(raw.log) ? raw.log.slice(-80) : [],
    note: raw.note ?? null,
  }
}
