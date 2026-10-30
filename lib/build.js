/**
 * 施工：图纸 → 算料 → 逐层放 → 竣工验收。
 *
 * 图纸用几个很土的 op 拼出来，模型不用手算几十个坐标：
 *   { op: 'fill', from: [x,y,z], to: [x,y,z], block: 'oak_planks' }   实心填满
 *   { op: 'box',  from, to, block, hollow: true }                     盒子（默认只有外壳：墙+顶+底）
 *   { op: 'walls', from, to, block }                                  只有四面墙（逐层的边框）
 *   { op: 'air',  from, to }                                          掏空（门窗洞）
 * 坐标都相对 blueprint.origin，所以换个地方盖同一张图纸只要换 origin。
 */

import { countItem, placeBlockAt, walkTo } from './actions.js'
import { verifyState, blockMatches } from './placement.js'
import { dist, key, round, sleep, throwIfAborted, describeError } from './util.js'

const MAX_CELLS = 4096

function toTriplet(v, label) {
  if (!Array.isArray(v) || v.length !== 3 || v.some((n) => !Number.isFinite(Number(n)))) {
    throw new Error(`${label} 要是 [x, y, z] 三个数字`)
  }
  return v.map((n) => Math.floor(Number(n)))
}

export function expandBlueprint(bp) {
  if (!bp || typeof bp !== 'object') throw new Error('图纸是个对象，至少要有 ops')
  const ops = Array.isArray(bp.ops) ? bp.ops : null
  if (!ops || !ops.length) throw new Error('图纸没有 ops')
  const origin = bp.origin ? toTriplet([bp.origin.x, bp.origin.y, bp.origin.z], 'origin') : [0, 0, 0]
  const cells = new Map()

  const put = (x, y, z, block, state) => {
    const pos = [x + origin[0], y + origin[1], z + origin[2]]
    const k = key({ x: pos[0], y: pos[1], z: pos[2] })
    if (block === 'air') cells.delete(k)
    else cells.set(k, { x: pos[0], y: pos[1], z: pos[2], block, state: state ?? null })
    if (cells.size > MAX_CELLS) throw new Error(`图纸太大了（超过 ${MAX_CELLS} 格）`)
  }

  for (const op of ops) {
    const kind = op?.op
    if (kind === 'fill' || kind === 'box' || kind === 'air' || kind === 'walls') {
      const from = toTriplet(op.from, 'from')
      const to = toTriplet(op.to, 'to')
      const block = kind === 'air' ? 'air' : String(op.block || '').trim()
      if (kind !== 'air' && !block) throw new Error(`${kind} 缺 block`)
      const min = [Math.min(from[0], to[0]), Math.min(from[1], to[1]), Math.min(from[2], to[2])]
      const max = [Math.max(from[0], to[0]), Math.max(from[1], to[1]), Math.max(from[2], to[2])]
      const hollow = kind === 'box' && op.hollow !== false
      for (let y = min[1]; y <= max[1]; y += 1) {
        for (let z = min[2]; z <= max[2]; z += 1) {
          for (let x = min[0]; x <= max[0]; x += 1) {
            const onEdge = x === min[0] || x === max[0] || z === min[2] || z === max[2]
            if (kind === 'walls' && !onEdge) continue
            const onShell = onEdge || y === min[1] || y === max[1]
            if (hollow && !onShell) continue
            put(x, y, z, block, op.state)
          }
        }
      }
    } else if (kind === 'wall') {
      const from = toTriplet(op.from, 'from')
      const to = toTriplet(op.to, 'to')
      const block = String(op.block || '').trim()
      const height = Math.max(1, Math.floor(Number(op.height) || 1))
      if (!block) throw new Error('wall 缺 block')
      const sameX = from[0] === to[0]
      const sameZ = from[2] === to[2]
      if (!sameX && !sameZ) throw new Error('wall 的 from/to 必须在一条直线上（x 或 z 相同）')
      const steps = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[2] - from[2]))
      const dx = Math.sign(to[0] - from[0])
      const dz = Math.sign(to[2] - from[2])
      for (let i = 0; i <= steps; i += 1) {
        for (let h = 0; h < height; h += 1) {
          put(from[0] + dx * i, from[1] + h, from[2] + dz * i, block, op.state)
        }
      }
    } else {
      throw new Error(`不认识的 op：${kind}（支持 fill / box / walls / wall / air）`)
    }
  }

  if (!cells.size) throw new Error('图纸展开之后是空的')
  return { cells, origin }
}

export function plannedMaterials(cells) {
  const counts = {}
  for (const cell of cells.values()) counts[cell.block] = (counts[cell.block] || 0) + 1
  return counts
}

function blueprintId(bp) {
  const text = JSON.stringify({ origin: bp.origin ?? null, ops: bp.ops })
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return `b${hash.toString(36)}`
}

function scans(bot, cells) {
  const mismatch = []
  let matched = 0
  let missing = 0
  for (const cell of cells.values()) {
    let name = 'unknown'
    let actual = null
    let stateOk = true
    let cellMatchedByAlias = false
    try {
      const block = bot.blockAt(new (bot.entity.position.constructor)(cell.x, cell.y, cell.z), false)
      name = block?.name ?? 'unknown'
      actual = block?.getProperties?.() ?? null
      stateOk = verifyState(block, cell.state)
      cellMatchedByAlias = blockMatches(block, cell.block)
    } catch {
      name = 'unknown'
    }
    if ((cellMatchedByAlias || (cell.block === 'air' && name === 'air')) && stateOk) matched += 1
    else {
      missing += 1
      if (mismatch.length < 40) {
        mismatch.push({
          pos: { x: cell.x, y: cell.y, z: cell.z },
          want: cell.block,
          got: name,
          wantState: cell.state ?? undefined,
          gotState: stateOk ? undefined : actual,
        })
      }
    }
  }
  return { matched, missing, total: cells.size, mismatch }
}

/** 只验收不施工 */
export function verifyBlueprint(session, bp) {
  const bot = session.requireBot()
  const id = blueprintId(bp)
  try {
    const { cells } = expandBlueprint(bp)
    const result = scans(bot, cells)
    const percent = result.total ? Math.round((result.matched / result.total) * 1000) / 10 : 0
    return {
      ok: result.missing === 0,
      verified: result.missing === 0,
      summary: `验收：${result.matched}/${result.total} 格对上了（${percent}%），差 ${result.missing} 格`,
      evidence: { blueprint: bp.name ?? id, id, ...result },
      hint: result.missing ? `第一处不对在 ${JSON.stringify(result.mismatch[0])}` : undefined,
    }
  } catch (error) {
    return { ok: false, verified: false, summary: `验收失败：${describeError(error)}`, evidence: { error: describeError(error) } }
  }
}

export async function build(session, args) {
  const bot = session.requireBot()
  const bp = args.blueprint
  let expanded
  try {
    expanded = expandBlueprint(bp)
  } catch (error) {
    return { ok: false, verified: false, summary: `图纸有问题：${describeError(error)}`, evidence: { error: describeError(error) } }
  }
  const { cells } = expanded
  const id = blueprintId(bp)
  const name = String(bp.name || id)
  const materials = plannedMaterials(cells)
  const inventory = Object.fromEntries(Object.keys(materials).map((block) => [block, countItem(bot, block)]))
  const missing = Object.entries(materials)
    .map(([block, need]) => ({ block, need, have: inventory[block] ?? 0 }))
    .filter((m) => m.have < m.need)

  if (args.verifyOnly) {
    const result = scans(bot, cells)
    const percent = Math.round((result.matched / result.total) * 1000) / 10
    return {
      ok: result.missing === 0,
      verified: result.missing === 0,
      summary: `验收 ${name}：${result.matched}/${result.total} 对上（${percent}%）`,
      evidence: { id, name, materials, missing: result.missing, total: result.total, sample: result.mismatch.slice(0, 20) },
    }
  }

  if (missing.length && args.force !== true) {
    return {
      ok: false,
      verified: false,
      summary: `材料不够，先别开工：${missing.slice(0, 6).map((m) => `${m.block} 差 ${m.need - m.have}`).join('、')}`,
      evidence: { id, name, materials, inventory, missing, total: cells.size },
      hint: '先去挖/合成/砍树把材料备齐。确认要硬着来可以传 force:true。',
    }
  }

  const maxBlocks = Math.min(Math.max(Number(args.maxBlocks) || cells.size, 1), cells.size)
  const previous = session.memory.build(id)
  const done = new Set(Array.isArray(previous?.done) ? previous.done : [])
  const failures = []
  let placed = 0
  let skipped = 0

  const order = [...cells.values()].sort((a, b) => {
    if (a.y !== b.y) return a.y - b.y
    return dist(bot.entity.position, a) - dist(bot.entity.position, b)
  })

  try {
    await session.runAction(
      'build',
      `${name}（${cells.size} 格）`,
      async (signal) => {
        for (const cell of order) {
          throwIfAborted(signal)
          if (placed >= maxBlocks) break
          const cellKey = key(cell)
          if (done.has(cellKey)) {
            skipped += 1
            continue
          }
          if (cell.block === 'air') {
            done.add(cellKey)
            continue
          }
          let currentName = 'unknown'
          try {
            currentName = bot.blockAt(new (bot.entity.position.constructor)(cell.x, cell.y, cell.z), false)?.name ?? 'unknown'
          } catch {
            currentName = 'unknown'
          }
          if (currentName === cell.block) {
            done.add(cellKey)
            skipped += 1
            continue
          }
          if (dist(bot.entity.position, cell) > 4.2) {
            try {
              await walkTo(session, bot, cell, { range: 2, timeoutMs: 25000 }, signal)
            } catch (error) {
              if (error.name === 'AbortError') throw error
              failures.push({ pos: { x: cell.x, y: cell.y, z: cell.z }, block: cell.block, reason: `走不过去：${describeError(error)}` })
              if (failures.length >= 30) break
              continue
            }
          }
          let lastError = null
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const result = await placeBlockAt(session, bot, { position: cell, blockName: cell.block, state: cell.state }, signal)
              if (result.verified) {
                done.add(cellKey)
                placed += 1
                lastError = null
                break
              }
              lastError = `那格变成了 ${result.placed}`
            } catch (error) {
              if (error.name === 'AbortError') throw error
              lastError = describeError(error)
              await sleep(120)
            }
          }
          if (lastError) {
            failures.push({ pos: { x: cell.x, y: cell.y, z: cell.z }, block: cell.block, reason: lastError })
            if (failures.length >= 30) break
          }
          if (placed % 8 === 0 && placed > 0) {
            session.memory.saveBuild(id, { name, planned: cells.size, done: [...done] })
          }
        }
        session.memory.saveBuild(id, { name, planned: cells.size, done: [...done] })
        return { placed, skipped, failures }
      },
      { timeoutMs: Math.max(120000, maxBlocks * 6000) },
    )
  } catch (error) {
    session.memory.saveBuild(id, { name, planned: cells.size, done: [...done] })
    return {
      ok: placed > 0,
      verified: false,
      summary: `施工中断：已经放了 ${placed} 格，进度存下来了`,
      evidence: { id, name, placed, skipped, failures: failures.slice(0, 10), error: describeError(error), done: done.size },
      hint: '下次同样的图纸再调 mc_build 会接着盖，不会重来。',
    }
  }

  const final = scans(bot, cells)
  const percent = Math.round((final.matched / final.total) * 1000) / 10
  const complete = final.missing === 0
  return {
    ok: true,
    verified: complete,
    summary: complete
      ? `盖完了，「${name}」${final.total} 格全部对上（100%）`
      : `盖了一轮：新放 ${placed} 格，跳过 ${skipped} 格，验收 ${final.matched}/${final.total}（${percent}%），差 ${final.missing} 格`,
    evidence: {
      id,
      name,
      placed,
      skipped,
      materials,
      inventoryBefore: inventory,
      verification: { matched: final.matched, total: final.total, missing: final.missing, sample: final.mismatch.slice(0, 20) },
      failures: failures.slice(0, 10),
    },
    hint: complete ? undefined : '差的那几格多半是够不着、被占着、或者材料刚好用完。再跑一次 mc_build 会从没盖完的地方接着来。',
  }
}
