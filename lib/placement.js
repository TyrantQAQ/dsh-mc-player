/**
 * 放置规则：让"放一个方块"变成可计算的事，而不是碰运气。
 *
 * 三条共识（都是 1.16.5 实测出来的，规则到今天没变过）：
 *   1. 参考方块不必是整块。服务器只做一件事：从眼睛射线过去，看你点中了哪块、哪个面，
 *      再把方块放到那个面的外侧格。所以半砖、台阶、栅栏、铜格栅都能当垫面，
 *      只要点击点落在它真实的碰撞面里（不是方块中心）。
 *   2. 朝向有四种来源：跟着你视线（楼梯、观察者）、背对你（箱子、熔炉、活塞、发射器）、
 *      点哪个面就朝哪（原木的轴、火把/梯子/拉杆/按钮贴哪面墙）、点在哪一半（半砖、台阶上下）。
 *   3. 转头是异步的：bot.look(force:true) 只是把目标角度排队，包要到下一个 tick 才发出去。
 *      所以"转头 → 等两 tick → 放"必须连在一起，否则服务器拿旧视角做射线，会判你够不着。
 */

export const FACING_VEC = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  west: [-1, 0, 0],
  east: [1, 0, 0],
}

export const OPPOSITE = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' }

const VEC_TO_FACING = new Map()
for (const [name, v] of Object.entries(FACING_VEC)) VEC_TO_FACING.set(v.join(','), name)

export const UP = [0, 1, 0]
export const DOWN = [0, -1, 0]

export function facingName(vec) {
  return VEC_TO_FACING.get(`${Math.sign(vec[0])},${Math.sign(vec[1])},${Math.sign(vec[2])}`) ?? null
}

/** 从水平朝向反推 yaw（mineflayer 内部约定：lookAt 用 atan2(-dx,-dz)） */
export function yawForFacing(facing) {
  const v = FACING_VEC[facing]
  if (!v) return null
  return Math.atan2(-v[0], -v[2])
}

export function facingFromYaw(yaw) {
  const dx = -Math.sin(yaw)
  const dz = -Math.cos(yaw)
  // 取最近的正方向
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? 'east' : 'west'
  return dz > 0 ? 'south' : 'north'
}

// ---------------------------------------------------------------------------
// 方块家族：一个方块允许哪些状态、怎么放出来
// ---------------------------------------------------------------------------

const INTERACTIVE = /(chest|barrel|furnace|smoker|blast_furnace|crafting_table|anvil|enchanting_table|brewing_stand|hopper|dispenser|dropper|note_block|jukebox|lectern|cartography_table|loom|smithing_table|grindstone|stonecutter|bell|_door$|_trapdoor$|_button$|lever|repeater|comparator|daylight_detector|_bed$|beacon|conduit|respawn_anchor)/

export function isInteractiveBlock(block) {
  return Boolean(block) && INTERACTIVE.test(block.name)
}

/** 点击点在方块内、落在哪个面上（局部 0..1） */
function faceBoxes(block, face) {
  const shapes = Array.isArray(block.shapes) ? block.shapes : []
  if (!shapes.length) return []
  const axis = face[0] !== 0 ? 0 : face[1] !== 0 ? 1 : 2
  const wantMax = face[axis] > 0
  // 半砖、栅栏、墙这些的"面"不在 0/1 上：取所有盒子里最外侧的那一档
  let extreme = null
  for (const box of shapes) {
    const v = wantMax ? box[axis + 3] : box[axis]
    if (extreme === null || (wantMax ? v > extreme : v < extreme)) extreme = v
  }
  const out = []
  for (const box of shapes) {
    const v = wantMax ? box[axis + 3] : box[axis]
    if (Math.abs(v - extreme) < 1e-6) {
      const area = (box[3] - box[0]) * (box[4] - box[1]) * (box[5] - box[2])
      out.push({ box, area })
    }
  }
  out.sort((a, b) => b.area - a.area)
  return out.map((o) => o.box)
}

function centerOfFace(box, face) {
  const p = [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2]
  const axis = face[0] !== 0 ? 0 : face[1] !== 0 ? 1 : 2
  // 贴在盒子真实的外侧面上（往里收一点点，免得射线打空）
  p[axis] = face[axis] > 0 ? box[axis + 3] - 0.004 : box[axis] + 0.004
  return p
}

/** 给定参考方块、要点的面、想用的局部点，算出实际点击点（方块局部坐标 0..1） */
export function clickPointFor(block, face, preferred) {
  if (preferred) {
    const p = [preferred[0], preferred[1], preferred[2]]
    const axis = face[0] !== 0 ? 0 : face[1] !== 0 ? 1 : 2
    // 用真实最外侧平面的坐标，别写死 0/1（半砖的顶面在 0.5）
    const boxes = faceBoxes(block, face)
    if (boxes.length) {
      const box = boxes[0]
      p[axis] = face[axis] > 0 ? box[axis + 3] - 0.004 : box[axis] + 0.004
    }
    return p
  }
  const boxes = faceBoxes(block, face)
  if (!boxes.length) return null
  return centerOfFace(boxes[0], face)
}

// 家族定义：normalize 决定默认状态，candidates 给出"怎么放"的候选（按优先级）
const FAMILIES = [
  {
    id: 'stairs',
    match: (n) => /_stairs$/.test(n),
    props: ['facing', 'half'],
    normalize(state, bot) {
      return {
        facing: validFacing(state?.facing) ?? facingFromYaw(bot?.entity?.yaw ?? 0),
        half: state?.half === 'top' ? 'top' : 'bottom',
      }
    },
    candidates(desired) {
      const f = FACING_VEC[desired.facing]
      // 楼梯朝向 = 你视线方向；所以站在 -f 那边看过来
      const look = [f[0], f[2]]
      const stand = [-look[0], -look[1]]
      if (desired.half === 'top') {
        return [
          // 点上面那块的底面 → 上半（得站得比它低才看得见）
          { refOffset: UP, face: DOWN, look, stand, deltaY: 0.25 },
          // 点视线前方那块的近面 → 上半（这块必须在目标外侧，否则被它自己挡住）
          { refOffset: f, face: [-f[0], 0, -f[2]], look, stand: [-look[0] * 2, -look[1] * 2], deltaY: 0.75 },
        ]
      }
      return [
        // 点脚下地板顶面 → 下半
        { refOffset: DOWN, face: UP, look, stand, deltaY: null },
        { refOffset: f, face: [-f[0], 0, -f[2]], look, stand: [-look[0] * 2, -look[1] * 2], deltaY: 0.25 },
      ]
    },
    verify(props, desired) {
      return props.facing === desired.facing && (props.half === desired.half || props.half === undefined)
    },
  },
  {
    id: 'slab',
    match: (n) => /_slab$/.test(n),
    props: ['type'],
    normalize(state) {
      return { type: state?.type === 'top' ? 'top' : 'bottom' }
    },
    candidates(desired) {
      const sides = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
      if (desired.type === 'top') {
        // 点上面那块的底面，或者点隔壁块侧面的上半格
        const out = [{ refOffset: UP, face: DOWN, deltaY: 0.25 }]
        for (const f of sides) out.push({ refOffset: f, face: [-f[0], 0, -f[2]], stand: f, deltaY: 0.75 })
        return out
      }
      const out = [{ refOffset: DOWN, face: UP, deltaY: null }]
      for (const f of sides) out.push({ refOffset: f, face: [-f[0], 0, -f[2]], stand: f, deltaY: 0.25 })
      return out
    },
    verify(props, desired) {
      return (props.type ?? 'bottom') === desired.type
    },
  },
  {
    id: 'log',
    match: (n) => /(_log|_wood|_stem|_hyphae)$/.test(n),
    props: ['axis'],
    normalize(state) {
      return { axis: ['x', 'y', 'z'].includes(state?.axis) ? state.axis : 'y' }
    },
    candidates(desired) {
      if (desired.axis === 'y') return [{ refOffset: DOWN, face: UP, deltaY: null }, { refOffset: UP, face: DOWN, deltaY: 0.25 }]
      const axis = desired.axis
      const f = axis === 'x' ? [1, 0, 0] : [0, 0, 1]
      return [
        { refOffset: f, face: [-f[0], 0, -f[2]], deltaY: 0.5 },
        { refOffset: [-f[0], 0, -f[2]], face: f, deltaY: 0.5 },
      ]
    },
    verify(props, desired) {
      return props.axis === desired.axis
    },
  },
  {
    id: 'chest',
    match: (n) => /^(chest|trapped_chest|barrel|furnace|blast_furnace|smoker|ender_chest)$/.test(n),
    props: ['facing'],
    normalize(state, bot) {
      // 正面朝你：要 facing=F 就得背对 F 看过去
      return { facing: validFacing(state?.facing) ?? OPPOSITE[facingFromYaw(bot?.entity?.yaw ?? 0)] }
    },
    candidates(desired) {
      const f = FACING_VEC[desired.facing]
      // 站在 target + F 那边，回头看 target
      return [
        { refOffset: DOWN, face: UP, look: [-f[0], -f[2]], stand: [f[0], f[2]], deltaY: null },
        { refOffset: f, face: [-f[0], 0, -f[2]], look: [-f[0], -f[2]], stand: [f[0] * 2, f[2] * 2], deltaY: 0.5 },
      ]
    },
    verify(props, desired) {
      return props.facing === desired.facing
    },
  },
  {
    id: 'piston',
    match: (n) => /^(piston|sticky_piston|dispenser|dropper)$/.test(n),
    props: ['facing'],
    normalize(state, bot) {
      return { facing: validFacing(state?.facing) ?? OPPOSITE[facingFromYaw(bot?.entity?.yaw ?? 0)] }
    },
    candidates(desired) {
      const f = FACING_VEC[desired.facing]
      return [
        { refOffset: DOWN, face: UP, look: [-f[0], -f[2]], stand: [f[0], f[2]], deltaY: null },
        { refOffset: f, face: [-f[0], 0, -f[2]], look: [-f[0], -f[2]], stand: [f[0] * 2, f[2] * 2], deltaY: 0.5 },
      ]
    },
    verify(props, desired) {
      return props.facing === desired.facing
    },
  },
  {
    id: 'observer',
    match: (n) => /^observer$/.test(n),
    props: ['facing'],
    normalize(state, bot) {
      // 观察者正面朝向你视线方向
      return { facing: validFacing(state?.facing) ?? facingFromYaw(bot?.entity?.yaw ?? 0) }
    },
    candidates(desired) {
      const f = FACING_VEC[desired.facing]
      return [
        { refOffset: DOWN, face: UP, look: f, stand: [-f[0], -f[2]], deltaY: null },
        { refOffset: f, face: [-f[0], 0, -f[2]], look: f, stand: [-f[0] * 2, -f[2] * 2], deltaY: 0.5 },
      ]
    },
    verify(props, desired) {
      return props.facing === desired.facing
    },
  },
  {
    id: 'hopper',
    match: (n) => /^hopper$/.test(n),
    props: ['facing'],
    normalize(state) {
      return { facing: validFacing(state?.facing) ?? 'down' }
    },
    candidates(desired) {
      if (desired.facing === 'down') return [{ refOffset: DOWN, face: UP, deltaY: null }]
      const f = FACING_VEC[desired.facing]
      return [
        { refOffset: f, face: [-f[0], 0, -f[2]], deltaY: 0.5 },
        { refOffset: DOWN, face: UP, deltaY: null },
      ]
    },
    verify(props, desired) {
      return props.facing === desired.facing
    },
  },
  {
    id: 'wall-attach',
    match: (n) => /^(torch|ladder|lever|soul_torch|redstone_torch|.*_button)$/.test(n),
    props: ['facing', 'face'],
    normalize(state, bot) {
      // 贴墙时 facing = 离开墙面的方向；不给 state 就默认站地上（手电筒类）
      const dir = validFacing(state?.facing)
      if (dir) return { facing: dir, wall: dir }
      return { facing: null, wall: null }
    },
    candidates(desired) {
      const out = []
      if (!desired.wall) {
        out.push({ refOffset: DOWN, face: UP, deltaY: null, onlyIf: (name) => /^(torch|soul_torch|redstone_torch)$/.test(name) })
      }
      const f = desired.facing ? FACING_VEC[desired.facing] : null
      if (f) {
        // 火把朝 F 伸出去 → 墙在 target - F；点墙朝 target 的那面（+F）；人站在 F 侧往里看
        out.push({ refOffset: [-f[0], 0, -f[2]], face: f, look: [-f[0], -f[2]], stand: [f[0] * 2, f[2] * 2], deltaY: 0.5 })
      }
      return out
    },
    verify(props, desired) {
      if (!desired.wall) return true
      return props.facing === desired.facing
    },
  },
]

function validFacing(name) {
  return name && FACING_VEC[name] ? name : null
}

export function familyFor(name) {
  return FAMILIES.find((f) => f.match(name)) ?? null
}

export function supportedFamilies() {
  return FAMILIES.map((f) => ({ id: f.id, props: f.props }))
}

// ---------------------------------------------------------------------------
// 计划：站在哪、点哪块哪个面、点面上哪个点
// ---------------------------------------------------------------------------

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]

function blockAt(bot, pos) {
  const V = bot.entity?.position?.constructor
  return bot.blockAt(new V(pos[0], pos[1], pos[2]), false)
}

function solidShapes(block) {
  return Boolean(block) && Array.isArray(block.shapes) && block.shapes.length > 0
}

function canStandAt(bot, cell) {
  const ground = blockAt(bot, [cell[0], cell[1] - 1, cell[2]])
  const feet = blockAt(bot, cell)
  const head = blockAt(bot, [cell[0], cell[1] + 1, cell[2]])
  return solidShapes(ground) && !solidShapes(feet) && !solidShapes(head)
}

function eyeOf(bot) {
  const p = bot.entity.position
  return [p.x, p.y + (bot.entity.eyeHeight ?? 1.62), p.z]
}

function vecLen(a) {
  return Math.sqrt(a[0] ** 2 + a[1] ** 2 + a[2] ** 2)
}

function normalize3(a) {
  const l = vecLen(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

/** 从某双眼睛看过去，射线第一个打中的是不是这块参考方块 */
function rayHitsRef(bot, eye, point, refPos) {
  const dir = normalize3([point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]])
  const range = vecLen([point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]]) + 1.5
  try {
    const hit = bot.world.raycast(new (bot.entity.position.constructor)(eye[0], eye[1], eye[2]), new (bot.entity.position.constructor)(dir[0], dir[1], dir[2]), range)
    if (!hit) return false
    return hit.position.x === refPos[0] && hit.position.y === refPos[1] && hit.position.z === refPos[2]
  } catch {
    return false
  }
}

/** 站姿候选：先试当前站位，再试几何上要求的站位 */
function standOptions(bot, target, candidate) {
  const out = []
  const p = bot.entity.position
  out.push([Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)])
  if (candidate.stand) {
    const [sx, sz] = candidate.stand
    // 站在目标外侧 1~3 格，同一层；再试上下各一层，地形不一定平
    for (const k of [2, 1, 3]) {
      for (const dy of [0, 1, -1]) {
        out.push([target[0] + sx * k, target[1] + dy, target[2] + sz * k])
      }
    }
  }
  // 兜底：四邻
  for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    for (const dy of [0, 1]) out.push([target[0] + d[0], target[1] + dy, target[2] + d[1]])
  }
  // 去重
  const seen = new Set()
  return out.filter((c) => {
    const k = c.join(',')
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function lookMatches(candidate, eye, point) {
  if (!candidate.look) return true
  const dx = point[0] - eye[0]
  const dz = point[2] - eye[2]
  const len = Math.hypot(dx, dz) || 1
  // look 统一按 [x, z] 两元素用，传三元素也兼容
  const lx = candidate.look[0]
  const lz = candidate.look.length >= 3 ? candidate.look[2] : candidate.look[1]
  const llen = Math.hypot(lx, lz) || 1
  const dot = (dx / len) * (lx / llen) + (dz / len) * (lz / llen)
  return dot >= 0.86 // 约 30 度
}

/**
 * 规划一次放置。成功返回 { plan, desired, family }，失败返回 { error, detail }。
 * plan: { stand, clickPoint, refPos, face, delta, expected, sneak }
 */
export function planPlacement({ bot, target, name, state }) {
  const family = familyFor(name)
  const desired = family ? family.normalize(state, bot) : null
  const candidates = family ? family.candidates(desired) : [{ refOffset: DOWN, face: UP, deltaY: null }]

  const tried = []
  for (const candidate of candidates) {
    if (candidate.onlyIf && !candidate.onlyIf(name)) continue
    const refPos = add(target, candidate.refOffset)
    const refBlock = blockAt(bot, refPos)
    if (!solidShapes(refBlock)) {
      tried.push(`参考格 ${refPos.join(',')} 是空的`)
      continue
    }
    const preferred = candidate.deltaY === null || candidate.deltaY === undefined
      ? null
      : [0.5, candidate.deltaY, 0.5]
    const local = clickPointFor(refBlock, candidate.face, preferred)
    if (!local) {
      tried.push(`${refBlock.name} 这个面点不到`)
      continue
    }
    const point = [refPos[0] + local[0], refPos[1] + local[1], refPos[2] + local[2]]

    for (const stand of standOptions(bot, target, candidate)) {
      if (!canStandAt(bot, stand)) {
        if (process.env.MC_DEBUG_PLACE) console.log('[plan] 站不住', stand, 'cand', candidate.refOffset)
        continue
      }
      const eye = [stand[0] + 0.5, stand[1] + (bot.entity.eyeHeight ?? 1.62), stand[2] + 0.5]
      if (vecLen([point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]]) > 4.4) {
        if (process.env.MC_DEBUG_PLACE) console.log('[plan] 太远', stand, point.map((n) => n.toFixed(2)), 'cand', candidate.refOffset)
        continue
      }
      if (!lookMatches(candidate, eye, point)) {
        if (process.env.MC_DEBUG_PLACE) console.log('[plan] 角度不对', stand, 'cand', candidate.refOffset, 'look', candidate.look)
        continue
      }
      if (!rayHitsRef(bot, eye, point, refPos)) {
        if (process.env.MC_DEBUG_PLACE) {
          const dir = normalize3([point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]])
          const hit = bot.world.raycast(new (bot.entity.position.constructor)(eye[0], eye[1], eye[2]), new (bot.entity.position.constructor)(dir[0], dir[1], dir[2]), vecLen([point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]]) + 1.5)
          console.log('[plan] 被挡/打空', stand, 'cand', candidate.refOffset, 'ref', refPos, 'hit', hit ? [hit.name, hit.position.x, hit.position.y, hit.position.z] : null, 'point', point.map((n) => n.toFixed(2)))
        }
        continue
      }
      return {
        family: family?.id ?? 'block',
        desired,
        plan: {
          stand,
          clickPoint: point,
          local,
          refPos,
          refName: refBlock.name,
          face: candidate.face,
          delta: local,
          expected: desired,
          sneak: isInteractiveBlock(refBlock) || (family?.id === 'wall-attach' && isInteractiveBlock(refBlock)),
        },
      }
    }
  }

  return {
    error: family
      ? `没法按 ${family.id} 的规则放：${tried[0] ?? '周围没有能当垫面的方块'}`
      : '周围没有能当垫面的方块',
    detail: tried.slice(0, 4),
  }
}

/** 校验实际方块状态是否满足期望（只比我们关心的属性） */
/** 火把类贴墙会变成另一个方块名，验证时得认 */
const NAME_ALIASES = {
  torch: ['torch', 'wall_torch'],
  soul_torch: ['soul_torch', 'soul_wall_torch'],
  redstone_torch: ['redstone_torch', 'redstone_wall_torch'],
  lantern: ['lantern', 'hanging_lantern'],
}

export function blockMatches(block, name) {
  const actual = block?.name
  if (!actual) return false
  if (actual === name) return true
  return (NAME_ALIASES[name] ?? []).includes(actual)
}

export function verifyState(block, expected) {
  if (!expected || !block) return true
  let props = {}
  try {
    props = block.getProperties?.() ?? {}
  } catch {
    props = {}
  }
  for (const [k, v] of Object.entries(expected)) {
    if (v === null || v === undefined || k === 'wall') continue
    if (String(props[k]) !== String(v)) return false
  }
  return true
}

export function describeState(name, state) {
  if (!state) return ''
  const parts = []
  for (const [k, v] of Object.entries(state)) {
    if (v === null || v === undefined) continue
    if (k === 'wall') continue
    parts.push(`${k}=${v}`)
  }
  return parts.length ? `[${parts.join(',')}]` : ''
}
