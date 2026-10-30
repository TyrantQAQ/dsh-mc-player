/**
 * 工具面：大脑能看到、能按的东西。
 *
 * 约定（写清楚给模型看，也给自己看）：
 *   - 每个动作的返回值里都有 verified。没有 verified:true 就是没干成，别自己骗自己。
 *   - events 只在 mc_status 里给，一次给完就清空，别的工具只报"攒了几条"。
 *   - 工具失败不抛异常，返回 ok:false + evidence.error + hint。
 */

import * as actions from './actions.js'
import { build, verifyBlueprint } from './build.js'
import { createPlan } from './goals.js'
import { enchantAt, anvilUse, tradeWith } from './stations.js'
import { farm } from './farming.js'
import { fishAt } from './fishing.js'
import { brew } from './brewing.js'
import { tame } from './taming.js'
import { fight } from './combat.js'
import { creativeGive, sequence, doorPass } from './actions.js'
import { scanNearby } from './machine.js'
import { DEFAULT_REFLEX } from './reflex.js'
import { describeError } from './util.js'

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    verified: { description: 'true 才算真做成；false 是做了但回读不对；null 是没法验证' },
    summary: { type: 'string' },
    evidence: { type: 'object', additionalProperties: true },
    hint: { type: 'string' },
  },
  required: ['ok', 'verified', 'summary'],
}

function text(t) {
  return [{ type: 'text', text: t }]
}

/**
 * 工具返回值必须是"纯 JSON"：不能带 undefined / NaN / 类实例 / 循环引用。
 * mineflayer 的对象（Vec3、实体）很容易漏进来，所以在出口统一过一遍。
 */
function toJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null))
  } catch (error) {
    return {
      ok: false,
      verified: false,
      summary: `返回值没法序列化成 JSON：${describeError(error)}`,
      evidence: { error: describeError(error) },
    }
  }
}

function format(value) {
  if (!value || typeof value !== 'object') return String(value)
  const head = `[${value.ok === false ? '失败' : value.verified === true ? '已验证' : value.verified === null ? '没法验证' : '未验证'}] ${value.summary ?? ''}`
  const lines = [head]
  if (value.evidence && Object.keys(value.evidence).length) {
    let body = JSON.stringify(value.evidence, null, 2)
    if (body.length > 6000) body = `${body.slice(0, 6000)}\n…（截断）`
    lines.push(`证据：\n${body}`)
  }
  if (value.hint) lines.push(`→ ${value.hint}`)
  return lines.join('\n')
}

const render = (_args, value) => text(format(value))

function defineFactory(session, ctx) {
  return function define(name, description, parameters, execute, extra = {}) {
    return {
    name,
    description,
    parameters,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(args, exec) {
      if (exec?.agent?.id) session.dshSessionId = exec.agent.id
      else if (ctx?.get) {
        try {
          const agents = ctx.get('agents')
          const cur = agents?.currentInitiator?.()
          if (cur?.id) session.dshSessionId = cur.id
        } catch {
          /* ignore */
        }
      }
      const previous = session.currentExecSignal
      session.currentExecSignal = exec?.signal ?? null
      try {
        return toJsonSafe(await execute(args ?? {}, exec))
      } catch (error) {
        return {
          ok: false,
          verified: false,
          summary: `${name} 出错：${describeError(error)}`,
          evidence: { error: describeError(error) },
          hint: '这是插件自己的异常，不是游戏里的失败。看 mc_status 确认 bot 还在不在。',
        }
      } finally {
        session.currentExecSignal = previous
      }
    },
      presentCall: extra.presentCall ?? (() => ({ card: 'generic', title: name, kind: 'execute' })),
    }
  }
}

export function registerTools(ctx, { session, log, config, autopilot }) {
  const define = defineFactory(session, ctx)
  const disposers = []
  const add = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }






  add(
    define(
      'mc_fight',
      `打怪：挑威胁最大的先打（苦力怕不近战），自动换背包里最好的剑/斧，血低先吃，打不过就退。

radius 默认 12；retreatBelow 默认 8（血低于这个就退）；eatBelow 默认 15（低于这个先吃）；timeoutMs 默认 90 秒。
打完会捡战利品，回读死了几只、血的变化、剩几只。`,
      {
        type: 'object',
        properties: {
          radius: { type: 'number', description: '搜索半径，默认 12' },
          retreatBelow: { type: 'number', description: '血低于多少就退，默认 8' },
          eatBelow: { type: 'number', description: '血低于多少先吃，默认 15' },
          timeoutMs: { type: 'number', description: '最多打多久，默认 90000' },
        },
        additionalProperties: false,
      },
      async (args) => {
        return fight(session, args)
      },
    ),
  )

  add(
    define(
      'mc_brew',
      `酿造台：把水瓶、材料、烈焰粉放进去，等它酿好，把药水拿出来。

slot 是酿造台的格子：0 材料、1/2/3 瓶子、4 燃料，插件会自己放。
ingredient 给材料（nether_wart / sugar / glowstone_dust / redstone / gunpowder …）。
酿好会回读药水的 potion 类型；没酿出来会说，不会假装成功。`,
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          ingredient: { type: 'string', description: '放什么材料，比如 nether_wart' },
          timeoutMs: { type: 'number', description: '最多等多久（默认 45 秒）' },
        },
        required: ['ingredient'],
        additionalProperties: false,
      },
      async (args) => {
        return brew(session, args)
      },
    ),
  )

  add(
    define(
      'mc_tame',
      `驯养：狼（骨头）、猫（生鱼）、鹦鹉（种子）。

不给 entityId 就找 8 格内最近的；不给 item 就按种类用默认的。
喂到服务端放爱心为止；没成会说喂了几次，不会假装驯服。`,
      {
        type: 'object',
        properties: {
          entityId: { type: 'number', description: '要喂的实体 id；不填找最近的' },
          item: { type: 'string', description: '喂什么；不填按种类默认（狼=bone，猫=cod，鹦鹉=wheat_seeds）' },
        },
        additionalProperties: false,
      },
      async (args) => {
        return tame(session, args)
      },
    ),
  )

  add(
    define(
      'mc_farm',
      `种地：锄地、下种、收成熟的。

action:
- till：给 x/y/z（那一格得是泥土/草方块），拿锄头锄成耕地。
- plant：给 x/y/z（耕地）和 crop（wheat / carrots / potatoes / beetroots），把种子种下去。
- harvest：在 radius（默认 8）内找成熟的作物，收掉，默认顺手补种（replant:false 可以关）。

收完回读背包；附近没有成熟作物会直说。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['till', 'plant', 'harvest'] },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          crop: { type: 'string', description: 'wheat / carrots / potatoes / beetroots' },
          radius: { type: 'number', description: 'harvest 的搜索半径，默认 8' },
          replant: { type: 'boolean', description: '收完要不要补种，默认 true' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      async (args) => {
        return farm(session, args)
      },
    ),
  )

  add(
    define(
      'mc_fish',
      `钓鱼：拿竿、对着 16 格内的水甩钩、等上钩、收杆。

count 默认 1 次；maxMs 是每次等鱼上钩的超时（默认 60 秒）。
钓完回读背包变化。需要鱼竿，附近要有水。`,
      {
        type: 'object',
        properties: {
          count: { type: 'number', description: '钓几次，默认 1' },
          maxMs: { type: 'number', description: '每次等上钩的超时，默认 60000' },
        },
        additionalProperties: false,
      },
      async (args) => {
        return fishAt(session, args)
      },
    ),
  )

  add(
    define(
      'mc_enchant',
      `附魔台：把物品和青金石放进附魔台，挑一个选项附魔。

给 x/y/z（附魔台在哪）或者不给自己找 16 格内最近的。item 不给就用当前手上的。
choice 是 0/1/2 里的第几个选项；不给就挑"等级够、青金石够"里最高的那个。
选项等级和消耗会一起返回；等级/青金石不够会直接说，不会白放。`,
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          item: { type: 'string', description: '要附魔的物品名；不给就用手上拿的' },
          choice: { type: 'number', description: '第几个选项（0/1/2），不给就选能用的最高级' },
        },
        additionalProperties: false,
      },
      async (args) => {
        return enchantAt(session, args)
      },
    ),
  )

  add(
    define(
      'mc_anvil',
      `铁砧：改名 / 合并 / 修理。

item 放进第一格，item2 可选放进第二格（合并/修两件同样的东西），name 是可选的改名。
产出会先读出来再拿走；经验不够或者这两件不能合会直说。`,
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          item: { type: 'string', description: '第一格放什么' },
          item2: { type: 'string', description: '第二格放什么（可选）' },
          name: { type: 'string', description: '改名成什么（可选，最多 35 字）' },
        },
        required: ['item'],
        additionalProperties: false,
      },
      async (args) => {
        return anvilUse(session, args)
      },
    ),
  )

  add(
    define(
      'mc_trade',
      `村民交易：打开村民，列出他能换什么，或者按编号换一次。

先 listOnly:true 看交易列表（每项编号、要什么、给什么、还剩几次），再用 tradeIndex + count 换。
村民要在 3 格内。`,
      {
        type: 'object',
        properties: {
          entityId: { type: 'number', description: '村民实体 id；不填就用 8 格内最近的' },
          listOnly: { type: 'boolean', description: '只看交易列表，不换' },
          tradeIndex: { type: 'number', description: '第几个交易（默认 0）' },
          count: { type: 'number', description: '换几次（默认 1）' },
        },
        additionalProperties: false,
      },
      async (args) => {
        return tradeWith(session, args)
      },
    ),
  )


  add(
    define(
      'mc_creative',
      `创造模式：从创造物品栏里"拿"物品到背包（等价于玩家打开创造物品栏拖一个出来）。

只在创造模式可用；生存模式会拒绝。给 item（比如 stone）、count（默认 1）、slot（默认 36，第一个快捷栏格）。
拿完会回读背包确认。`,
      {
        type: 'object',
        properties: {
          item: { type: 'string', description: '物品名，比如 stone / oak_planks' },
          count: { type: 'number', description: '数量，默认 1' },
          slot: { type: 'number', description: '放到哪个背包槽，默认 36（第一个快捷栏）' },
        },
        required: ['item'],
        additionalProperties: false,
      },
      async (args) => {
        return creativeGive(session, args)
      },
    ),
  )

  add(
    define(
      'mc_stop',
      '停下当前动作：中止正在执行的寻路/挖/放/开门，并清掉寻路目标。卡在门里、走到一半不想走了、或者上一个动作还没结束时用它。',
      { type: 'object', properties: {}, additionalProperties: false },
      async () => {
        const had = session.abortAction('mc_stop')
        return { ok: true, verified: true, summary: had ? '把当前动作停了' : '本来就没在做事', evidence: { hadAction: had } }
      },
    ),
  )

  add(
    define(
      'mc_door',
      `过一扇门：自动判断这一侧是什么在控制它——有按钮就按按钮，有压力板就站上去直接冲过去，木门没控制器就手开；拉杆不认（它不控制门）。然后立刻穿到门那侧。

**只要要穿门就用这个**，比 mc_use + mc_move 稳得多。给 door 或 button 坐标都行，都不给就找脚下的门；through 是门那侧的落脚点，不给就按你的方向自动算。`,
      {
        type: 'object',
        properties: {
          button: {
            type: 'object',
            description: '按钮坐标 {x,y,z}',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
            additionalProperties: false,
          },
          door: {
            type: 'object',
            description: '门坐标（可选，不给就在按钮附近找）',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
            additionalProperties: false,
          },
          through: {
            type: 'object',
            description: '门那侧的目标点（可选）',
            properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
            required: ['x', 'y', 'z'],
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      async (args) => doorPass(session, args),
    ),
  )

  add(
    define(
      'mc_seq',
      `一口气做几个动作，中间不回大脑：按按钮→进门、放方块→挖、走→用这类时间敏感的连招。

每个步骤是 {action, ...参数}，action 支持：
- use   {x,y,z} 右键方块（按钮/拉杆/门/床…）或 {entityId}
- move  {x,y,z} 或 {place:"home"} 寻路
- mine  {block:"iron_ore", count:1} 或 {x,y,z}
- place {x,y,z, block:"stone"}
- wait  {ms:300} 原地等
- chat  {text:"..."} 游戏内说一句

默认第一个失败就停；continueOnError:true 可以继续往下做。全部做完才返回，每步都带结果。`,
      {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            description: '要依次执行的动作',
            items: { type: 'object', additionalProperties: true },
          },
          continueOnError: { type: 'boolean', description: '失败了也继续（默认 false）' },
        },
        required: ['steps'],
        additionalProperties: false,
      },
      async (args) => sequence(session, args),
    ),
  )

  add(
    define(
      'mc_chat',
      `游戏内聊天：读主人说了什么、回一句话、看待办。

action:
- read（默认）：把没读过的聊天读出来（读完标记已读），顺带列待办。
- say：在游戏聊天框里说一句话（text）。
- pending：只看还没处理的待办。
- clear：把待办清掉（做完/不想做的时候）。

聊天里主人可以直接说"跟着我/过来/停下/回家/睡觉/这个是刷石机"，这些插件会自己办并回话；
"造个房子/造台机器"这种要规划的会记成待办，等模型用 mc_chat read 读走再拆步骤。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'say', 'pending', 'clear', 'wake'] },
          text: { type: 'string', description: 'say 的内容' },
          limit: { type: 'number', description: 'read 最多几条，默认 20' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const action = String(args.action || 'read').toLowerCase()
        const chat = session.chatLink
        if (!chat) return { ok: false, verified: false, summary: '聊天模块没装上', evidence: {} }
        if (action === 'say') {
          if (!args.text) return { ok: false, verified: false, summary: '要说什么？给 text', evidence: {} }
          return chat.say(args.text)
        }
        if (action === 'wake') {
          if (!chat.wake) return { ok: false, verified: false, summary: '没有绑定叫醒大脑的通道', evidence: {} }
          try {
            const ok = await chat.wake(String(args.text || '（测试消息）'))
            return { ok: Boolean(ok), verified: Boolean(ok), summary: ok ? '叫醒成功' : '叫醒返回 false', evidence: { ok } }
          } catch (error) {
            return { ok: false, verified: false, summary: `叫醒失败：${error?.message || error}`, evidence: { error: String(error?.message || error) } }
          }
        }
        if (action === 'clear') {
          const n = chat.pending.length
          chat.pending.splice(0, chat.pending.length)
          return { ok: true, verified: true, summary: `清掉了 ${n} 条待办`, evidence: {} }
        }
        if (action === 'pending') {
          return { ok: true, verified: true, summary: chat.pending.length ? `待办 ${chat.pending.length} 条` : '没有待办', evidence: { pending: chat.pending.slice(-20) } }
        }
        const r = chat.read(Number(args.limit) || 20)
        return {
          ok: true,
          verified: true,
          summary: r.messages.length ? `读到 ${r.messages.length} 条聊天` : '没有新消息',
          evidence: r,
        }
      },
    ),
  )

  add(
    define(
      'mc_mark',
      `站到机器旁边，告诉它"这是什么"：把它脚下/看向的位置记成一台有名字的机器。

先走到机器边（看着出料口或机器主体），再 mc_mark {name:"刷石机", kind:"cobble_gen"}：
- 它会把"看着的那一格"记成出料口（mine 模式的目标），把"站的位置"记成 standAt；
- 顺手扫一圈附近的方块（漏斗、红石、水、岩浆……），存成 nearBy 描述，下次好认；
- kind 是 cobble_gen 就默认 mine，iron_farm/afk 就默认 stand。

之后 mc_afk {action:"start", place:"刷石机"} 就能用它。
它不认识建筑，只是把"这里有什么、坐标在哪"记下来。`,
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: '机器叫什么，比如 刷石机' },
          kind: { type: 'string', description: '类型：cobble_gen / iron_farm / afk / 仓库…' },
          note: { type: 'string', description: '备注' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async (args) => {
        const bot = session.bot
        if (!bot?.entity) return { ok: false, verified: false, summary: '没上线，先连上再记', evidence: {} }
        let looked = null
        try {
          looked = bot.blockAtCursor(5)
        } catch {
          looked = null
        }
        const pos = bot.entity.position
        const target = looked ? { x: looked.position.x, y: looked.position.y, z: looked.position.z } : null
        const standAt = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) }
        const kind = args.kind ? String(args.kind) : null
        const mode = kind === 'cobble_gen' ? 'mine' : kind === 'iron_farm' || kind === 'afk' ? 'stand' : target ? 'mine' : 'stand'
        const anchor = mode === 'mine' && target ? target : standAt
        const nearby = scanNearby(bot, 8)
        const place = {
          x: anchor.x,
          y: anchor.y,
          z: anchor.z,
          dimension: bot.game?.dimension ?? null,
          kind,
          mode,
          target: target ?? null,
          standAt,
          nearby,
          note: args.note ? String(args.note) : null,
        }
        const saved = session.memory.setPlace(args.name, place)
        return {
          ok: Boolean(session.memory.getPlace(args.name)),
          verified: Boolean(session.memory.getPlace(args.name)),
          summary: `记住了「${args.name}」：${kind ?? mode}，${mode === 'mine' ? '出料口' : '站位'}在 ${anchor.x} ${anchor.y} ${anchor.z}${nearby.length ? `；附近有 ${nearby.slice(0, 4).map((n) => `${n.name}×${n.count}`).join('、')}` : ''}`,
          evidence: { place: session.memory.getPlace(args.name), file: saved.file },
        }
      },
    ),
  )

  add(
    define(
      'mc_afk',
      `挂机：守着一个"机器"的点，反复做同一件事。

action:
- start：开始挂机。给 place（记忆里的地点，kind 是 cobble_gen 就默认挖、iron_farm/afk 就默认站着）或 x/y/z。
  mode=mine：那格一出现实心方块就挖掉（刷石机出料口）；mode=stand：站在点上，偶尔捡脚边的东西（铁傀儡农场/刷怪塔）。
- stop：停下，报这次挖了多少。
- status：看还在不在挂、挖了多少、还剩多久。

它不看"建筑长什么样"，只认你告诉它的那个坐标；位置得先用 mc_memory setPlace 记下来，或者在 start 里直接给。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'stop', 'status'] },
          place: { type: 'string', description: '记忆里的地点名' },
          mode: { type: 'string', enum: ['mine', 'stand'], description: '默认按地点的 kind 推' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          maxMinutes: { type: 'number', description: '最多挂多久，默认 30 分钟' },
          drop: { type: 'boolean', description: '挖出来的东西直接丢（可选）' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const action = String(args.action || 'status').toLowerCase()
        const m = session.machine
        if (!m) return { ok: false, verified: false, summary: '挂机模块没装上', evidence: {} }
        if (action === 'stop') {
          const was = m.stop()
          return { ok: true, verified: true, summary: was ? `停了，这次挖了 ${was.mined} 个` : '本来就没在挂', evidence: { was } }
        }
        if (action === 'status') {
          return { ok: true, verified: true, summary: m.running ? `在挂（${m.status().mode}），已挖 ${m.status().mined}` : '没在挂', evidence: { status: m.status() } }
        }
        let place = null
        if (args.place) {
          place = session.memory.getPlace(args.place)
          if (!place) return { ok: false, verified: false, summary: `记忆里没有「${args.place}」`, evidence: { places: session.memory.listPlaces() } }
        }
        const kindMode = place?.kind === 'cobble_gen' ? 'mine' : place?.kind === 'iron_farm' || place?.kind === 'afk' ? 'stand' : null
        const mode = args.mode || place?.mode || kindMode || 'mine'
        const fallback = place ? { x: place.x, y: place.y, z: place.z } : null
        const target = place
          ? mode === 'stand'
            ? place.standAt ?? fallback
            : place.target ?? fallback
          : args.x !== undefined
            ? { x: args.x, y: args.y, z: args.z }
            : null
        if (!target || [target.x, target.y, target.z].some((v) => !Number.isFinite(Number(v)))) {
          return { ok: false, verified: false, summary: '给 place 或 x/y/z', evidence: {} }
        }
        const st = m.start({ target, mode, place: args.place ?? null, maxMinutes: args.maxMinutes, drop: args.drop === true })
        return { ok: true, verified: true, summary: `开始挂了：${mode} @ ${target.x} ${target.y} ${target.z}`, evidence: { status: st } }
      },
    ),
  )

  add(
    define(
      'mc_map',
      `地图记忆：看走过的路，或者沿着走过的路去某个点。

action:
- trail（默认）：最近走过哪些点（面包屑），共多少。
- route：沿着轨迹走到 x/y/z 或 place（记忆里的地点）；轨迹到不了就交给寻路器。
- clear：把走过的轨迹清掉（不影响记忆里的地点）。

"按走过的路回去"比让寻路器从零试更稳，尤其是隔了很远、或者地形复杂的时候。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['trail', 'route', 'clear'] },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          place: { type: 'string', description: '记忆里的地点名（比如 home）' },
          range: { type: 'number', description: '离多近算到，默认 1.5' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const action = String(args.action || 'trail').toLowerCase()
        const map = session.map
        if (!map) return { ok: false, verified: false, summary: '地图记忆没装上', evidence: {} }
        if (action === 'wake') {
          if (!chat.wake) return { ok: false, verified: false, summary: '没有绑定叫醒大脑的通道', evidence: {} }
          try {
            const ok = await chat.wake(String(args.text || '（测试消息）'))
            return { ok: Boolean(ok), verified: Boolean(ok), summary: ok ? '叫醒成功' : '叫醒返回 false', evidence: { ok } }
          } catch (error) {
            return { ok: false, verified: false, summary: `叫醒失败：${error?.message || error}`, evidence: { error: String(error?.message || error) } }
          }
        }
        if (action === 'clear') {
          map.clear()
          return { ok: true, verified: true, summary: '轨迹清掉了', evidence: {} }
        }
        if (action === 'route') {
          let target = null
          if (args.place) {
            const place = session.memory.getPlace(args.place)
            if (!place) return { ok: false, verified: false, summary: `记忆里没有 ${args.place}`, evidence: { places: session.memory.listPlaces() } }
            target = { x: place.x, y: place.y, z: place.z }
          } else if (args.x !== undefined && args.y !== undefined && args.z !== undefined) {
            target = { x: Number(args.x), y: Number(args.y), z: Number(args.z) }
          }
          if (!target) return { ok: false, verified: false, summary: '要去哪？给 x/y/z 或 place', evidence: {} }
          const r = await map.walkTo(target, { range: Number(args.range) || 1.5 })
          return {
            ok: r.ok,
            verified: r.arrived,
            summary: r.ok
              ? `沿着走过的路到了（${r.walked} 个点，${r.usedTrail ? '用了轨迹' : '直接寻路'}），离目标 ${r.distance} 格`
              : `没到：离目标还有 ${r.distance} 格${r.skipped?.length ? `，卡在 ${r.skipped.length} 个点` : ''}`,
            evidence: { target, ...r },
          }
        }
        return {
          ok: true,
          verified: true,
          summary: `走过 ${map.trail.length} 个点`,
          evidence: { summary: map.summary(), recent: map.recent(10), places: session.memory.listPlaces() },
        }
      },
    ),
  )

  add(
    define(
      'mc_goal',
      `自主目标：定下一个"打算"，拆成几步，没人在旁边的时候自己一步步做。

action:
- set：给定 text 和 steps，开始一个计划（会替换掉旧的）。
- get（默认）：看当前计划、做到哪一步、最近的日志、执行器状态。
- pause：暂停（会打断正在做的那一步）。
- resume：继续（把卡住的那一步重置重试）。
- clear：丢掉当前计划。

每一步 kind 支持：
- gather  {block:"stone", count:20, maxDistance:48}      挖够 N 个（掉落物进背包才算）
- craft   {item:"wooden_pickaxe", count:1}
- build   {blueprint:{...}}                               按图纸施工 + 验收
- goto    {x,y,z} 或 {place:"home"}
- place   {x,y,z,block:"torch",state:{...}}
- sleep   {}                                              晚上睡觉（白天自动跳过）
- enchant {item:"diamond_sword"}                          附魔台附魔（等级/青金石不够会说）
- anvil   {item:"diamond_sword", name:"小鱼"}             铁砧改名 / 合并 / 修理
- trade   {tradeIndex:0, count:1}                         跟最近的村民换东西
- farm    {action:"harvest", radius:8}                    收成熟作物（till/plant 也可以）
- fish    {count:1}                                       钓几条鱼
- brew    {ingredient:"nether_wart"}                      酿造台酿一瓶
- tame    {item:"bone"}                                   驯养附近的狼/猫/鹦鹉
- fight   {radius:12}                                    清掉附近的怪
- manual  {text:"接下来要人决定的事"}                      执行到这里会暂停并报事件

执行规则：只有"手上有活、血够、没被围、没开界面"时才动手；一次一步；失败重试，连续失败就到 maxAttempts 停下等大脑；死了会自动暂停。进度存在本机，重启接着做。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['set', 'get', 'pause', 'resume', 'clear'] },
          text: { type: 'string', description: '这个目标的一句话（set 用）' },
          steps: {
            type: 'array',
            description: '步骤列表（set 用），每个 {kind, ...}',
            items: { type: 'object', additionalProperties: true },
          },
          note: { type: 'string', description: '备注（set 或 pause 用）' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const action = String(args.action || 'get').toLowerCase()
        const ap = autopilot
        if (!ap) return { ok: false, verified: false, summary: '自主目标执行器没装上', evidence: {} }
        if (action === 'set') {
          try {
            const plan = createPlan({ text: args.text, steps: args.steps, note: args.note })
            ap.setPlan(plan)
            session.pushEvent('info', `定了目标：${plan.text}（${plan.steps.length} 步）`)
            return {
              ok: true,
              verified: true,
              summary: `目标定好了：${plan.text}，${plan.steps.length} 步。没别的事的时候我会自己做。`,
              evidence: { plan: ap.summary(), steps: plan.steps.map((s) => ({ kind: s.kind, spec: s.spec })) },
            }
          } catch (error) {
            return { ok: false, verified: false, summary: `计划没定成：${describeError(error)}`, evidence: {} }
          }
        }
        if (action === 'pause') {
          ap.pause(args.note || '手动暂停')
          return { ok: true, verified: true, summary: '目标暂停了', evidence: { plan: ap.summary(), autopilot: ap.status() } }
        }
        if (action === 'resume') {
          ap.resume()
          return { ok: true, verified: true, summary: '目标继续跑了', evidence: { plan: ap.summary(), autopilot: ap.status() } }
        }
        if (action === 'wake') {
          if (!chat.wake) return { ok: false, verified: false, summary: '没有绑定叫醒大脑的通道', evidence: {} }
          try {
            const ok = await chat.wake(String(args.text || '（测试消息）'))
            return { ok: Boolean(ok), verified: Boolean(ok), summary: ok ? '叫醒成功' : '叫醒返回 false', evidence: { ok } }
          } catch (error) {
            return { ok: false, verified: false, summary: `叫醒失败：${error?.message || error}`, evidence: { error: String(error?.message || error) } }
          }
        }
        if (action === 'clear') {
          ap.clear()
          return { ok: true, verified: true, summary: '目标清掉了，不做了', evidence: {} }
        }
        return {
          ok: true,
          verified: true,
          summary: ap.plan ? `目标：${ap.plan.text}（${ap.summary()?.done ?? 0}/${ap.plan.steps.length} 步）` : '现在没有目标',
          evidence: { plan: ap.summary(), autopilot: ap.status(), goalText: session.memory.get('goal') },
        }
      },
    ),
  )

  add(
    define(
      'mc_status',
      `看自己现在什么样：位置、血、饥饿、氧气、状态效果、手上和背包、界面开没开、脚下是什么、附近有什么生物/玩家/掉落物、刚听到的声音、记忆里的家和矿洞，以及上一次 mc_status 之后攒下的所有事件（打击、掉血、反射触发、连接变化）。

开场先调它。动作之间也调它——但别每走一步都调，人类不会那么干。
drainEvents:false 可以先看一眼不把事件清掉。`,
      {
        type: 'object',
        properties: {
          drainEvents: { type: 'boolean', description: '默认 true：把攒着的事件交出来并清空' },
          sounds: { type: 'number', description: '带几条最近的声音，默认 8' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const snapshot = session.snapshot({ drain: args.drainEvents !== false, soundCount: Math.min(Math.max(Number(args.sounds) || 8, 0), 20) })
        return {
          ok: true,
          verified: true,
          summary: snapshot.online
            ? `${snapshot.username} 活着：血 ${snapshot.self.health}，饱食度 ${snapshot.self.food}，在 ${snapshot.self.position.x} ${snapshot.self.position.y} ${snapshot.self.position.z}；附近有 ${snapshot.nearby.hostiles.length} 只怪、${snapshot.nearby.items.length} 个掉落物；这次带回 ${snapshot.events.length} 条消息`
            : `没上线（${snapshot.state}）${snapshot.lastError ? `：${snapshot.lastError}` : ''}`,
          evidence: snapshot,
          hint: snapshot.hint,
        }
      },
    ),
  )

  add(
    define(
      'mc_connect',
      `上线 / 换服务器 / 下线。

action:
- connect（默认）：连服务器。没给地址就用配置里的（默认 127.0.0.1:25565，离线账号）。
- disconnect：主动下线，之后不会自动重连。
- status：只看连接状态，不连。

连上之后会重新拉一遍完整状态。掉线会自动重连（最多 maxReconnect 次）。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['connect', 'disconnect', 'status'], description: '默认 connect' },
          host: { type: 'string', description: '服务器地址' },
          port: { type: 'number', description: '端口，默认 25565' },
          username: { type: 'string', description: '用户名（离线模式随便起，但只能用字母/数字/下划线，中文名会被 26.2 拒；别跟真玩家重名）' },
          version: { type: 'string', description: '协议版本，比如 1.21.1；不填就让 mineflayer 自己认' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const action = args.action || 'connect'
        if (action === 'status') {
          return {
            ok: true,
            verified: true,
            summary: `状态：${session.state}${session.isOnline ? '（在线）' : ''}${session.lastError ? `，上次错误：${session.lastError}` : ''}`,
            evidence: {
              state: session.state,
              online: session.isOnline,
              username: session.bot?.username ?? null,
              host: session.config.host,
              port: session.config.port,
              reconnectAttempts: session.reconnectAttempts,
              lastError: session.lastError,
            },
          }
        }
        if (action === 'disconnect') {
          const result = await session.disconnect()
          return { ok: true, verified: true, summary: '下线了', evidence: result }
        }
        const overrides = {}
        for (const k of ['host', 'port', 'username', 'version']) if (args[k] !== undefined && args[k] !== '') overrides[k] = args[k]
        try {
          const result = await session.connect(overrides)
          return {
            ok: true,
            verified: true,
            summary: `连上了：${result.username} @ ${result.host}:${result.port}（${result.version ?? '版本未知'}）`,
            evidence: result,
            hint: '下一步 mc_status 看一眼自己在哪、周围有什么。',
          }
        } catch (error) {
          return {
            ok: false,
            verified: false,
            summary: `连不上：${describeError(error)}`,
            evidence: { ...overrides, state: session.state, lastError: session.lastError },
            hint: '确认服务器开着、地址端口对、版本对得上。离线账号只能进离线模式的服务器，用户名只能是字母/数字/下划线。',
          }
        }
      },
    ),
  )

  add(
    define(
      'mc_move',
      `走路。可寻路绕过障碍、跳一格、垫柱子。

**要穿门时优先用 mc_door**（它会按按钮并把“开门+通过”连成一条）；mc_move 不会开闭着的门，关着的门只会让它绕路或报没路。

坐标三选一：
- x / y / z：去这个位置（自动寻路，结束回读距离）
- place：去记忆里的地点（"home" / "mine" / "death" / 自己起的名字）
- player 或 entityId：跟着它走 durationMs 毫秒（默认 8 秒）

sprint 默认 true。走不到会告诉你停在哪、差多少格。想边挖边挪或者精确落脚，用 mc_control。`,
      {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          place: { type: 'string', description: '记忆里的地点名' },
          player: { type: 'string', description: '要跟着的玩家名' },
          entityId: { type: 'number', description: '要跟着的实体 id' },
          range: { type: 'number', description: '离目标多近算到，默认 1.5' },
          sprint: { type: 'boolean', description: '默认 true' },
          durationMs: { type: 'number', description: '跟人时跟多久，默认 8000' },
          timeoutMs: { type: 'number', description: '寻路超时，默认 120000' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.move(session, args)
      },
    ),
  )

  add(
    define(
      'mc_control',
      `直接按键盘：像人手一样按住某个键一小会儿。

keys 从 forward / back / left / right / jump / sneak / sprint 里选。可以同时按（比如 ["forward","sprint","jump"]）。
look 可以给 {yaw, pitch} 或 {at:{x,y,z}}，转头再走。
durationMs 默认 500，最长 20 秒。

**会有小概率手滑**（转身偏一点、按久一点），返回值里 slipped:true 就是这次手滑了——真人就是这样，别慌，看清位置再补一步。`,
      {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: '要按住的键' },
          durationMs: { type: 'number', description: '按多久，默认 500' },
          look: {
            type: 'object',
            properties: {
              yaw: { type: 'number' },
              pitch: { type: 'number' },
              at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false },
            },
            additionalProperties: false,
          },
          mistakeChance: { type: 'number', description: '0~0.5，默认 0.08' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.control(session, args)
      },
    ),
  )

  add(
    define(
      'mc_mine',
      `挖方块。两种用法：
- block + count：在附近找这种方块，挖够 count 块（自己会走过去、换工具、捡掉落物）
- x / y / z：挖指定那一格（先走过去，再挖）

自动换**最省时间的工具**：按游戏公式把背包里每件工具都算一遍（木/石/铁/钻/下界合金的档位、效率附魔、水下/悬空惩罚都算进去），取最快的那把；没有工具就用空手。所以"有石斧用石斧、有钻斧用钻斧、有附魔钻斧用附魔钻斧"是自动的。挖不动（缺工具）、够不着、工具不对都会说清楚。挖完会回读：那格是不是空气、背包里多了几个。
掉落物默认顺手捡（pickup:false 可以不捡）。`,
      {
        type: 'object',
        properties: {
          block: { type: 'string', description: '方块名，比如 stone / oak_log / iron_ore' },
          count: { type: 'number', description: '挖几块，默认 1' },
          maxDistance: { type: 'number', description: '找方块的半径，默认 32' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          pickup: { type: 'boolean', description: '默认 true' },
          timeoutMs: { type: 'number', description: '默认 180000' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.mine(session, args)
      },
    ),
  )

  add(
    define(
      'mc_place',
      `放方块。两种用法：
- x / y / z + block：把 block 放到那一格。参考面可以是任何有碰撞的方块（半砖、台阶、栅栏、墙、铜格栅都行），会按方块类型算好站在哪、点哪个面。
- tower:n + block：垫柱子，往上垫 n 格（自己会跳起来放）

state 用来指定朝向/上下半，比如 {'facing':'east','half':'top'} 的楼梯、{'axis':'x'} 的原木、{'facing':'north'} 的箱子或活塞。

两个容易搞反的：
- 侦测器（observer）的 facing 是**眼睛（观察面）**朝哪，红石脉冲从**反面**出。要它把信号往东打，就 facing:"west"。
- 漏斗的 facing 是**管子伸向**的方向，也就是它把东西灌进去的容器。想让它连到东边的箱子，就 facing:"east"，放的时候会对着那个容器贴（遇到箱子会自动潜行，不会打开它）。

规则表覆盖：楼梯、半砖、原木、箱子/桶/熔炉类、活塞/发射器/投掷器、侦测器、漏斗、火把/梯子/拉杆/按钮。不给 state 就按当前朝向来。

放完回读方块名和状态；站不到该站的地方会说清楚缺什么。够不着会先走过去。`,
      {
        type: 'object',
        properties: {
          block: { type: 'string', description: '放什么方块' },
          state: {
            type: 'object',
            description: '要的方块状态。楼梯: {facing:"east",half:"top"}；半砖: {type:"top"}；原木: {axis:"x"}；箱子/熔炉/活塞/发射器: {facing:"north"}（正面朝哪）；侦测器: {facing:"north"}（眼睛看的方向，红石从反面出）；漏斗: {facing:"east"}（管子伸向哪个容器）；火把/梯子/拉杆/按钮: {facing:"west"}（贴墙时朝向=离开墙面的方向）',
            properties: {
              facing: { type: 'string', enum: ['north', 'south', 'east', 'west'] },
              half: { type: 'string', enum: ['top', 'bottom'] },
              type: { type: 'string', enum: ['top', 'bottom'] },
              axis: { type: 'string', enum: ['x', 'y', 'z'] },
            },
            additionalProperties: true,
          },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          tower: { type: 'number', description: '往上垫几格' },
          sneak: { type: 'boolean', description: '潜行着放（不会触发方块的右键功能）' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.place(session, args)
      },
    ),
  )

  add(
    define(
      'mc_use',
      `用手：右键方块、对生物用东西、吃东西、睡觉、打人、关界面。

action:
- block（默认）：右键 x/y/z 那格（门、按钮、拉杆、工作台、床、唱片机……）
- entity：对 entityId 用（喂食、剪羊毛、挤奶、繁殖、交易前先 entity 再 container）
- item：用当前/指定物品（拉弓要 holdMs 按住；水桶、雪球、末影珍珠都算）
- eat：吃东西，可指定 food
- sleep：找附近的床躺下
- wake：起床
- attack：打 entityId 或 nearest:true，最多 hits 下；血低于 retreatBelow 会自己收手
- close：关掉当前界面（开着界面是走不了路的）

界面开没开、状态变没变都会回读。吃东西/攻击的验证最硬，右键类动作只能看方块状态或窗口。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['block', 'entity', 'item', 'eat', 'sleep', 'wake', 'attack', 'close'] },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          entityId: { type: 'number' },
          nearest: { type: 'boolean', description: '打最近的怪/玩家' },
          item: { type: 'string', description: '用/吃/喂什么' },
          food: { type: 'string', description: '吃的指定食物' },
          holdMs: { type: 'number', description: '按住多久（拉弓），默认 400' },
          offhand: { type: 'boolean', description: '用副手' },
          hits: { type: 'number', description: '攻击几下，默认 1' },
          retreatBelow: { type: 'number', description: '自己血低于这个数就收手，默认 8' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.use(session, args)
      },
    ),
  )

  add(
    define(
      'mc_inventory',
      `背包：看、换、丢、切快捷栏。

action:
- list（默认）：列背包
- equip：把 item 换到 destination（hand / offhand / head / torso / legs / feet）
- drop：扔掉 item 若干个
- quickbar：切到第 slot 格（0~8）

挖石头前记得先在手边有镐——不放心就先 list 看一眼。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'equip', 'drop', 'quickbar'] },
          item: { type: 'string' },
          count: { type: 'number' },
          destination: { type: 'string', description: 'hand / offhand / head / torso / legs / feet' },
          slot: { type: 'number', description: '快捷栏 0~8' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.inventory(session, args)
      },
    ),
  )

  add(
    define(
      'mc_craft',
      `合成。给物品名和数量。需要工作台的配方会自己找 32 格内的工作台并走过去。
合成完回读背包里这种物品的数量变化。材料不够会直接说合不了。`,
      {
        type: 'object',
        properties: {
          item: { type: 'string', description: '要合成什么，比如 oak_planks / stick / crafting_table / iron_pickaxe' },
          count: { type: 'number', description: '合几次，默认 1' },
        },
        required: ['item'],
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.craft(session, args)
      },
    ),
  )

  add(
    define(
      'mc_container',
      `箱子 / 桶 / 潜影盒 / 熔炉。

action:
- open：打开看一眼里面有什么（看完自动关）
- withdraw：从 x/y/z 那个容器里拿 item x count
- deposit：往里面放 item x count
- smelt：用熔炉烧 item x count（可给 fuel，默认 coal）
- close：关界面

拿/放会回读背包数量变化。熔炉会等到出够数再拿走，烧不出来会说清楚。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'withdraw', 'deposit', 'smelt', 'close'] },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          item: { type: 'string' },
          count: { type: 'number' },
          fuel: { type: 'string' },
          timeoutMs: { type: 'number', description: '熔炉最多等多久，默认 120000' },
        },
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.container(session, args)
      },
    ),
  )

  add(
    define(
      'mc_build',
      `按图纸盖房子。三步一体的工具：

1. 算料：图纸展开成坐标表，按背包算出缺多少材料；不够就不开工（除非 force:true）。
2. 施工：从下往上一格一格放，够不着会走过去，进度存在本机，下次接着盖。
3. 验收：整栋扫一遍跟图纸逐格比，报对上几格、差哪几格。

蓝图格式：
{
  "name": "5x5 小屋",
  "origin": {"x": 100, "y": 64, "z": 200},
  "ops": [
    {"op":"fill","from":[0,0,0],"to":[4,0,4],"block":"oak_planks"},   // 地板
    {"op":"fill","from":[0,1,0],"to":[0,1,0],"block":"oak_stairs","state":{"facing":"east","half":"bottom"}},
    {"op":"walls","from":[0,1,0],"to":[4,2,4],"block":"oak_planks"},  // 四面墙，两层高
    {"op":"fill","from":[0,3,0],"to":[4,3,4],"block":"oak_planks"},   // 屋顶
    {"op":"air","from":[2,1,0],"to":[2,2,0]}                          // 门洞
    // ops 里可以带 state：{"op":"fill",...,"block":"oak_stairs","state":{"facing":"east","half":"bottom"}}
  ]
}
坐标是相对 origin 的。verifyOnly:true 只验收不施工。`,
      {
        type: 'object',
        properties: {
          blueprint: {
            type: 'object',
            description: '图纸：{name, origin:{x,y,z}, ops:[...]}',
            properties: {
              name: { type: 'string' },
              origin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, additionalProperties: false },
              ops: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
            required: ['ops'],
            additionalProperties: false,
          },
          verifyOnly: { type: 'boolean', description: '只验收' },
          force: { type: 'boolean', description: '材料不够也硬盖' },
          maxBlocks: { type: 'number', description: '这一轮最多放几格' },
        },
        required: ['blueprint'],
        additionalProperties: false,
      },
      async (args, exec) => {
        if (args.verifyOnly) return verifyBlueprint(session, args.blueprint)
        return build(session, args)
      },
    ),
  )

  add(
    define(
      'mc_memory',
      `记性：家、矿洞、死亡点、今天的打算、随手笔记。

action:
- get（默认）：看记了什么
- setPlace：记一个地点（name + x/y/z，可带 note）
- setGoal：记"今天想干什么"（text）；传空字符串清掉
- note：记一句笔记

死亡点会自动记（名字固定是 death）。这些存在本机文件里，重启还在。`,
      {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'setPlace', 'setGoal', 'note'] },
          name: { type: 'string', description: '地点名，比如 home / mine / 矿洞口' },
          kind: { type: 'string', description: '可选：这个点是什么（cobble_gen / iron_farm / afk / 仓库…）' },
          x: { type: 'number' },
          y: { type: 'number' },
          z: { type: 'number' },
          text: { type: 'string' },
          note: { type: 'string', description: '地点的备注' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const action = args.action || 'get'
        const bot = session.bot
        if (action === 'setPlace') {
          if (!args.name) return { ok: false, verified: false, summary: '地点得有个名字', evidence: {} }
          const pos = bot?.entity?.position ?? args
          if (!Number.isFinite(Number(args.x ?? pos.x))) {
            return { ok: false, verified: false, summary: '现在没上线，记地点得把 x/y/z 一起给我', evidence: {} }
          }
          const saved = session.memory.setPlace(args.name, {
            x: args.x ?? Math.round(pos.x),
            y: args.y ?? Math.round(pos.y),
            z: args.z ?? Math.round(pos.z),
            dimension: bot?.game?.dimension ?? null,
            note: args.note ?? null,
          })
          return {
            ok: saved.ok,
            verified: Boolean(session.memory.getPlace(args.name)),
            summary: `记住了「${args.name}」在 ${Math.round(args.x ?? pos.x)} ${Math.round(args.y ?? pos.y)} ${Math.round(args.z ?? pos.z)}`,
            evidence: { place: session.memory.getPlace(args.name), file: saved.file },
          }
        }
        if (action === 'setGoal') {
          session.memory.setGoal(String(args.text || ''))
          return { ok: true, verified: Boolean(session.memory.get('goal')), summary: args.text ? `今天的打算：${args.text}` : '目标清掉了', evidence: session.memory.summary() }
        }
        if (action === 'note') {
          if (!args.text) return { ok: false, verified: false, summary: '笔记是空的', evidence: {} }
          session.memory.addNote(args.text)
          return { ok: true, verified: true, summary: `记了一句：${args.text}`, evidence: session.memory.summary() }
        }
        return { ok: true, verified: true, summary: '看看记性', evidence: session.memory.summary() }
      },
    ),
  )

  add(
    define(
      'mc_command',
      `发一条服务器指令（/tp /give /time /weather /gamemode ……）。

生存服里这些多半没权限，用了就是作弊。只在明确知道该用的时候用——比如开创造修东西、单人服里传回家。
指令没有回执，verified 是 null，只能从 mc_status 看世界有没有变。`,
      {
        type: 'object',
        properties: { command: { type: 'string', description: '比如 "time set day" 或 "/tp 100 64 200"' } },
        required: ['command'],
        additionalProperties: false,
      },
      async (args, exec) => {
        return actions.command(session, args)
      },
    ),
  )

  add(
    define(
      'mc_reflex',
      `看/调保命反射。反射每 50ms 自己检查一次：掉岩浆、头卡方块、氧气快没、苦力怕贴脸、血少、被围。命中就打断当前动作先保命，不等大脑。

不给参数就是看当前阈值和最近触发记录。
可以改：enabled、lowHealth、lowOxygen、creeperRange、surroundCount。
别随手关——关了它是会死人的。`,
      {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          lowHealth: { type: 'number' },
          lowOxygen: { type: 'number' },
          creeperRange: { type: 'number' },
          surroundCount: { type: 'number' },
        },
        additionalProperties: false,
      },
      async (args) => {
        const changes = {}
        for (const k of ['enabled', 'lowHealth', 'lowOxygen', 'creeperRange', 'surroundCount']) {
          if (args[k] !== undefined) changes[k] = args[k]
        }
        if (Object.keys(changes).length) Object.assign(session.reflexConfig, changes)
        return {
          ok: true,
          verified: true,
          summary: Object.keys(changes).length ? `反射设置改了：${JSON.stringify(changes)}` : '看看反射',
          evidence: {
            settings: { ...DEFAULT_REFLEX, ...session.reflexConfig },
            lastWorld: session.reflex.lastWorld
              ? {
                  health: session.reflex.lastWorld.health,
                  oxygen: session.reflex.lastWorld.oxygen,
                  inLiquid: session.reflex.lastWorld.inLiquid,
                  suffocating: session.reflex.lastWorld.suffocating,
                  creeper: session.reflex.lastWorld.creeper?.distance ?? null,
                  hostiles: session.reflex.lastWorld.hostileCount,
                }
              : null,
            recent: session.reflex.history(),
          },
        }
      },
    ),
  )

  const unregister = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        log('工具注销失败', describeError(error))
      }
    }
  }
  ctx.effect(() => unregister)
  return unregister
}
