#!/usr/bin/env node
/**
 * 自检：不需要服务器、不需要 mineflayer。
 *
 * 主要是给"小脑"上测试——设计文档里说得很清楚：
 * "反射层要能被测试：写一个假 bot，喂它'苦力怕在 4 格'，看它退不退。"
 *
 * 跑法：node scripts/selftest.mjs
 */

import { EventEmitter } from 'node:events'
import { decide, DEFAULT_REFLEX, senseWorld, ReflexLayer } from '../lib/reflex.js'
import { expandBlueprint, plannedMaterials } from '../lib/build.js'
import { clickPointFor, verifyState, blockMatches, familyFor } from '../lib/placement.js'
import { normalizeOxygen } from '../lib/util.js'
import { decideIdleLook, needsSleep } from '../lib/rhythm.js'
import { shouldThink } from '../lib/idle.js'
import { planTrailRoute } from '../lib/mapmemory.js'
import { createPlan, applyStepResult, currentStep, planSummary, revivePlan, stepLabel } from '../lib/goals.js'

let passed = 0
let failed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

// ---------------------------------------------------------------------------
// 假 bot：只实现感知/反射真正用到的那几个接口
// ---------------------------------------------------------------------------

class FakeVec {
  constructor(x, y, z) {
    this.x = x
    this.y = y
    this.z = z
  }

  offset(x, y, z) {
    return new FakeVec(this.x + x, this.y + y, this.z + z)
  }

  floored() {
    return new FakeVec(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))
  }
}

class FakeBot extends EventEmitter {
  constructor({ position = [0, 64, 0], health = 20, food = 20, oxygen = 20, blocks = {}, entities = {}, items = [], foods = { bread: { foodPoints: 5 } } } = {}) {
    super()
    this.entity = { position: new FakeVec(...position), yaw: 0, pitch: 0, velocity: new FakeVec(0, 0, 0) }
    this.health = health
    this.food = food
    this.oxygenLevel = oxygen
    this.isSleeping = false
    this.entities = entities
    this.registry = { foodsByName: foods }
    this.inventory = {
      items: () => items.map((it, i) => ({ slot: 36 + i, count: 1, ...it })),
      slots: [],
    }
    this.blocks = blocks
    this.controls = {}
    this.calls = []
  }

  blockAt(pos) {
    const k = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    if (this.blocks[k]) return { name: this.blocks[k], boundingBox: this.blocks[k] === 'air' || this.blocks[k] === 'water' ? 'empty' : 'block', position: pos }
    return { name: 'air', boundingBox: 'empty', position: pos }
  }

  setControlState(key, value) {
    this.controls[key] = value
    this.calls.push({ key, value, at: Date.now() })
  }

  look() {
    return Promise.resolve()
  }

  equip() {
    return Promise.resolve()
  }

  consume() {
    return Promise.resolve()
  }

  activateItem() {}

  deactivateItem() {}

  blockAtCursor() {
    return null
  }
}

const air = (bot) => bot.blockAt({ x: 0, y: 65, z: 0 })

// ---------------------------------------------------------------------------
// 1. 纯判断
// ---------------------------------------------------------------------------

section('1. decide()：命中就出手')

const baseWorld = (extra = {}) => ({
  alive: true,
  health: 20,
  food: 20,
  oxygen: 20,
  position: { x: 0, y: 64, z: 0 },
  yaw: 0,
  inLiquid: null,
  suffocating: false,
  creeper: null,
  hostiles: [],
  hostileCount: 0,
  hasFood: true,
  bestFood: { slot: 36, name: 'bread', count: 3, points: 5 },
  ...extra,
})

check('没事的时候什么都不做', decide(baseWorld(), DEFAULT_REFLEX, new Map(), 1000) === null)

const creeper = { id: 7, name: 'creeper', distance: 3.2, position: { x: 3, y: 64, z: 0 } }
const d1 = decide(baseWorld({ creeper }), DEFAULT_REFLEX, new Map(), 1000)
check('苦力怕 3.2 格 → 后退', d1?.id === 'creeper' && d1.kind === 'backoff')
check('后退要打断当前动作', d1?.interrupt === true)

const farCreeper = { ...creeper, distance: 6 }
check('苦力怕 6 格 → 不动', decide(baseWorld({ creeper: farCreeper }), DEFAULT_REFLEX, new Map(), 1000) === null)

check('血 4 有吃的 → 吃', decide(baseWorld({ health: 4 }), DEFAULT_REFLEX, new Map(), 1000)?.id === 'low_health')
check('血 4 没吃的 → 不动（交给大脑）', decide(baseWorld({ health: 4, hasFood: false }), DEFAULT_REFLEX, new Map(), 1000) === null)
check('血 4 但冷却没到 → 不重复喊', decide(baseWorld({ health: 4 }), DEFAULT_REFLEX, new Map([['low_health', 900]]), 1000) === null)

check('掉进岩浆 → 上浮', decide(baseWorld({ inLiquid: 'lava' }), DEFAULT_REFLEX, new Map(), 1000)?.id === 'lava')
check('氧气 6 在水里 → 上浮', decide(baseWorld({ oxygen: 6, inLiquid: 'water' }), DEFAULT_REFLEX, new Map(), 1000)?.id === 'drown')
check('氧气 6 但在陆地上 → 不管', decide(baseWorld({ oxygen: 6 }), DEFAULT_REFLEX, new Map(), 1000) === null)
check('头卡方块 → 挣开', decide(baseWorld({ suffocating: true }), DEFAULT_REFLEX, new Map(), 1000)?.id === 'suffocate')

const three = [
  { id: 1, name: 'zombie', distance: 2 },
  { id: 2, name: 'skeleton', distance: 4 },
  { id: 3, name: 'spider', distance: 5 },
]
const dSurround = decide(baseWorld({ hostiles: three, hostileCount: 3 }), DEFAULT_REFLEX, new Map(), 1000)
check('被三只围住 → 停手', dSurround?.id === 'surrounded' && dSurround.kind === 'hold')

const hurt = [{ id: 9, name: 'slime', distance: 2.2, bearing: '右前方', position: { x: 2, y: 64, z: 0 } }]
const dHurt = decide(baseWorld({ underAttack: true, health: 10, hostiles: hurt, hostileCount: 1 }), DEFAULT_REFLEX, new Map(), 1000)
check('空手被一只怪追着打 → 后退 + 报事件', dHurt?.id === 'under_attack' && dHurt.kind === 'retreat')
check('血还多的时候挨打不管（交给大脑）', decide(baseWorld({ underAttack: true, health: 18, hostiles: hurt, hostileCount: 1 }), DEFAULT_REFLEX, new Map(), 1000) === null)

const both = decide(baseWorld({ creeper, health: 4 }), DEFAULT_REFLEX, new Map(), 1000)
check('苦力怕 + 低血 → 先退（优先级）', both?.id === 'creeper')

check('关掉开关就完全不管', decide(baseWorld({ health: 2, creeper }), { ...DEFAULT_REFLEX, enabled: false }, new Map(), 1000) === null)
check('没上线 / 死了 → 不动', decide(baseWorld({ alive: false }), DEFAULT_REFLEX, new Map(), 1000) === null)

// ---------------------------------------------------------------------------
// 2. 假 bot 走一遍：真退吗？
// ---------------------------------------------------------------------------

section('2. ReflexLayer + 假 bot：真的按下了后退键吗')

const run = async () => {
  const events = []
  const interrupts = []
  const bot = new FakeBot({
    position: [0, 64, 0],
    blocks: { '0,63,0': 'stone', '0,64,0': 'air', '0,65,0': 'air' },
    entities: { 7: { id: 7, name: 'creeper', kind: 'Hostile mobs', position: new FakeVec(3, 64, 0) } },
    items: [{ name: 'bread' }],
  })

  const layer = new ReflexLayer({
    getConfig: () => DEFAULT_REFLEX,
    onEvent: (e) => events.push(e),
    onInterrupt: (d) => interrupts.push(d.id),
    log: () => {},
  })

  const world = senseWorld(bot, DEFAULT_REFLEX)
  check('感知到苦力怕在 3 格', Math.abs(world.creeper.distance - 3) < 0.01, `distance=${world.creeper?.distance}`)
  check('感知到自己站在石头上', world.underBlock === 'stone', world.underBlock)

  layer.attach(bot)
  bot.emit('physicsTick')
  await new Promise((r) => setTimeout(r, 150))
  check('反射层按下了 back', bot.calls.some((c) => c.key === 'back' && c.value === true))
  check('反射层报告了事件', events.length === 1 && events[0].level === 'danger')
  check('反射层要求中断当前动作', interrupts.includes('creeper'))

  await new Promise((r) => setTimeout(r, 900))
  check('退完之后所有键都松开了', Object.values(bot.controls).every((v) => v === false), JSON.stringify(bot.controls))

  const before = bot.calls.length
  bot.emit('physicsTick')
  await new Promise((r) => setTimeout(r, 60))
  check('冷却期内不会反复触发', bot.calls.length === before || bot.calls.slice(before).every((c) => c.value === false))

  layer.detach()
  const afterDetach = bot.calls.length
  bot.emit('physicsTick')
  await new Promise((r) => setTimeout(r, 60))
  check('detach 之后不再 tick', bot.calls.length === afterDetach)

  // 假 bot 吃掉这一条为了消除"未使用"告警
  air(bot)

  // -------------------------------------------------------------------------
  // 3. 图纸
  // -------------------------------------------------------------------------
  section('3. 图纸：展开 / 算料')

  const hut = {
    name: '5x5x3 小屋',
    origin: { x: 100, y: 64, z: 200 },
    ops: [
      { op: 'fill', from: [0, 0, 0], to: [4, 0, 4], block: 'oak_planks' },
      { op: 'walls', from: [0, 1, 0], to: [4, 2, 4], block: 'oak_planks' },
      { op: 'fill', from: [0, 3, 0], to: [4, 3, 4], block: 'oak_planks' },
      { op: 'air', from: [2, 1, 0], to: [2, 2, 0] },
    ],
  }
  const { cells } = expandBlueprint(hut)
  const floor = 25
  const walls = (5 * 5 - 3 * 3) * 2 // 两层外圈
  const roof = 25
  check('地板 25 格', [...cells.values()].filter((c) => c.y === 64).length === floor)
  check(`墙 ${walls} 格（掏门洞后 ${walls - 2}）`, [...cells.values()].filter((c) => c.y === 65 || c.y === 66).length === walls - 2, String([...cells.values()].filter((c) => c.y === 65 || c.y === 66).length))
  check('屋顶 25 格', [...cells.values()].filter((c) => c.y === 67).length === roof)
  check('门洞被掏空了', ![...cells.values()].some((c) => c.x === 102 && c.z === 200 && (c.y === 65 || c.y === 66)))
  check('坐标跟着 origin 走', cells.has('100,64,200') && !cells.has('0,64,0'))

  const mats = plannedMaterials(cells)
  check('算料：木板的量 = 地板+墙+顶-门洞', mats.oak_planks === floor + (walls - 2) + roof, JSON.stringify(mats))

  const tower = { origin: { x: 0, y: 70, z: 0 }, ops: [{ op: 'wall', from: [0, 0, 0], to: [3, 0, 0], block: 'stone', height: 2 }] }
  const wallCells = expandBlueprint(tower)
  check('wall × 2 高 = 8 格', wallCells.cells.size === 8, String(wallCells.cells.size))

  let bad = null
  try {
    expandBlueprint({ ops: [{ op: 'nope' }] })
  } catch (error) {
    bad = error.message
  }
  check('不认识的 op 会报错', String(bad).includes('nope'), bad)

  section('4. 放置：点击点落在真实面上，状态比对认别名')

  const bottomSlab = { name: 'oak_slab', shapes: [[0, 0, 0, 1, 0.5, 1]] }
  const topPoint = clickPointFor(bottomSlab, [0, 1, 0], null)
  check('下半砖的顶面在 y≈0.5，不是 1.0', Math.abs(topPoint[1] - 0.496) < 0.01, String(topPoint?.[1]))

  const fence = { name: 'oak_fence', shapes: [[0.375, 0, 0.375, 0.625, 1.5, 0.625]] }
  const fenceTop = clickPointFor(fence, [0, 1, 0], null)
  check('栅栏顶面点在柱子上（x≈0.5）', Math.abs(fenceTop[0] - 0.5) < 0.01 && fenceTop[1] > 1.4, JSON.stringify(fenceTop))

  const sidePoint = clickPointFor(bottomSlab, [1, 0, 0], [0.5, 0.75, 0.5])
  check('侧面点击用真实 x 边界', Math.abs(sidePoint[0] - 0.996) < 0.01, JSON.stringify(sidePoint))

  check('楼梯家族认得出', familyFor('oak_stairs')?.id === 'stairs')
  check('箱子家族认得出', familyFor('chest')?.id === 'chest')
  check('火把贴墙后变成 wall_torch 也算对', blockMatches({ name: 'wall_torch' }, 'torch'))
  check('名字不对就不算', blockMatches({ name: 'stone' }, 'torch') === false)

  const fakeBlock = { name: 'oak_stairs', getProperties: () => ({ facing: 'east', half: 'top', shape: 'straight' }) }
  check('状态对得上', verifyState(fakeBlock, { facing: 'east', half: 'top' }))
  check('状态对不上', verifyState(fakeBlock, { facing: 'east', half: 'bottom' }) === false)
  check('wall 不是真属性，跳过', verifyState(fakeBlock, { facing: 'east', wall: 'east' }))

  section('5. 自主目标：拆步、记账、卡住就停')
  {
    const plan = createPlan({
      text: '挖 10 块石头',
      steps: [
        { kind: 'gather', block: 'stone', count: 10 },
        { kind: 'craft', item: 'stone_pickaxe', count: 1 },
        { kind: 'goto', place: 'home' },
      ],
    })
    check('建计划：3 步', plan.steps.length === 3 && plan.status === 'active')
    check('第一步是挖石头', currentStep(plan)?.kind === 'gather' && planSummary(plan).current.index === 1)
    check('标签是人话', stepLabel(plan.steps[0]).includes('stone'), stepLabel(plan.steps[0]))

    const step = plan.steps[0]
    let r = applyStepResult(plan, step, { ok: true, verified: true, summary: '挖了 4', progressDelta: 4 })
    check('挖 4 块：进度 4/10、未完', step.progress === 4 && step.status === 'pending' && !r.stepDone)
    r = applyStepResult(plan, step, { ok: true, verified: true, summary: '又挖 6', progressDelta: 6 })
    check('再挖 6：这一步完成', r.stepDone && step.status === 'done' && step.progress === 10)

    // 部分成功（verified false 但有进展）不该按失败算
    const partial = createPlan({ text: '部分', steps: [{ kind: 'gather', block: 'dirt', count: 10 }] })
    const ps = partial.steps[0]
    const pr = applyStepResult(partial, ps, { ok: true, verified: false, summary: '只挖到 3', progressDelta: 3 })
    check('部分成功也算推进（不重试）', ps.status === 'pending' && ps.attempts === 0 && ps.progress === 3, JSON.stringify({ status: ps.status, attempts: ps.attempts, progress: ps.progress }))

    // 失败三次 → 卡住
    const craft = plan.steps[1]
    applyStepResult(plan, craft, { ok: false, summary: '材料不够' })
    applyStepResult(plan, craft, { ok: false, summary: '材料不够' })
    const last = applyStepResult(plan, craft, { ok: false, summary: '材料不够' })
    check('连续失败 3 次 → 计划 blocked', last.blocked && plan.status === 'blocked' && craft.status === 'failed')
    check('日志记了原因', plan.log.some((l) => l.note?.includes('材料不够')))

    // 恢复：失败步骤重置
    for (const s of plan.steps) if (s.status === 'failed') { s.status = 'pending'; s.attempts = 0 }
    plan.status = 'active'
    check('恢复后能接着做', currentStep(plan)?.kind === 'craft')

    const revived = revivePlan(JSON.parse(JSON.stringify(plan)))
    check('计划能存能读', revived?.steps.length === 3 && revived.status === 'active')

    let bad = null
    try { createPlan({ text: 'x', steps: [{ kind: 'nonsense' }] }) } catch (e) { bad = e.message }
    check('不认识的步骤会报错', String(bad).includes('nonsense'), bad)
  }

  section('6. 节奏：没事的时候才会张望，第三天晚上必须睡')
  {
    const base = { idleMs: 20000, lastLookAt: 0, now: 100000, tickMs: 3000, lookChance: 1, currentYaw: 0, rng: () => 0 }
    check('闲着够久、必看：会给一个视角', Boolean(decideIdleLook(base)))
    check('刚看过：不看', decideIdleLook({ ...base, lastLookAt: base.now - 1000 }) === null)
    check('没闲够：不看', decideIdleLook({ ...base, idleMs: 1000 }) === null)
    check('概率不中：不看', decideIdleLook({ ...base, lookChance: 0.3, rng: () => 0.9 }) === null)
    const l = decideIdleLook(base)
    check('转头幅度合理', l && Math.abs(l.yaw) <= 1.4 && Math.abs(l.pitch) <= 0.35, JSON.stringify(l))

    check('见过一个日出：夜里还不睡', needsSleep({ daysSinceSleep: 1, timeOfDay: 14000 }) === false)
    check('见过两个日出：第三晚该睡', needsSleep({ daysSinceSleep: 2, timeOfDay: 14000 }) === true)
    check('白天不睡', needsSleep({ daysSinceSleep: 2, timeOfDay: 4000 }) === false)
    check('睡过清零：不睡', needsSleep({ daysSinceSleep: 0, timeOfDay: 14000 }) === false)
    check('连续干两天不休息：白天不睡', needsSleep({ daysSinceSleep: 2, timeOfDay: 8000 }) === false)
  }

  section('7. 地图记忆：按走过的路回去')
  {
    const trail = []
    for (let i = 0; i <= 10; i += 1) trail.push({ x: i * 2, y: 64, z: 0, at: i })
    const forward = planTrailRoute(trail, { x: 0, y: 64, z: 0 }, { x: 20, y: 64, z: 0 })
    check('从家往矿走：给出向前的路', forward.length > 0 && forward[0].x === 2, JSON.stringify(forward.slice(0, 2)))
    const back = planTrailRoute(trail, { x: 20, y: 64, z: 0 }, { x: 0, y: 64, z: 0 })
    check('从矿回家：给出倒着的路', back.length > 0 && back[0].x === 18, JSON.stringify(back.slice(0, 2)))
    check('原地不动：不用路', planTrailRoute(trail, { x: 20, y: 64, z: 0 }, { x: 19, y: 64, z: 0 }).length === 0)
    check('空轨迹：不用路', planTrailRoute([], { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }).length === 0)
  }

  section('8. 闲置思考：第十秒叫醒大脑')
  {
    const base = { online: true, busy: false, idleMs: 10000, fired: false, now: 1_000_000_000_000, lastWakeAt: 0, afterSeconds: 10, cooldownMs: 120000 }
    check('闲 10 秒：叫一次', shouldThink(base) === true)
    check('闲 9 秒：不叫', shouldThink({ ...base, idleMs: 9000 }) === false)
    check('有活/挂机/打架：不叫', shouldThink({ ...base, busy: true }) === false)
    check('已经叫过：不重复', shouldThink({ ...base, fired: true }) === false)
    check('冷却里：不叫', shouldThink({ ...base, lastWakeAt: base.now - 5000 }) === false)
    check('掉线：不叫', shouldThink({ ...base, online: false }) === false)
  }

  section('9. 氧气归一化（26.2 的 300 要折回 20）')
  check('300 → 20（26.2 满氧）', normalizeOxygen(300) === 20, String(normalizeOxygen(300)))
  check('4500 → 20（air_supply 直读）', normalizeOxygen(4500) === 20, String(normalizeOxygen(4500)))
  check('60 → 4（26.2 快没氧）', normalizeOxygen(60) === 4, String(normalizeOxygen(60)))
  check('20 保持 20（1.16 满氧）', normalizeOxygen(20) === 20)
  check('8 保持 8（1.16 缺氧）', normalizeOxygen(8) === 8)
  check('负数夹到 0', normalizeOxygen(-5) === 0)

  // 结果
  console.log('')
  if (failed) {
    console.log(`✗ ${failed} 条没过：`)
    for (const f of failures) console.log(`   - ${f}`)
    process.exitCode = 1
  } else {
    console.log(`✓ 全部 ${passed} 条通过`)
  }
}

run().catch((error) => {
  console.error('自检自己崩了：', error)
  process.exitCode = 1
})
