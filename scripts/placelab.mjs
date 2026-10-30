import mineflayer from 'mineflayer'
import { Vec3 } from 'vec3'
import pathfinder from 'mineflayer-pathfinder'
import { placeBlockAt } from '../lib/actions.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bot = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: '小鲸鱼', auth: 'offline', version: '1.16.5', hideErrors: true })
bot.on('error', (e) => console.log('bot error', e.message))
bot.loadPlugin(pathfinder.pathfinder)
const session = { libs: { pf: pathfinder }, memory: { getPlace: () => null }, runAction: async (_n, _d, fn) => fn(new AbortController().signal), pushEvent: () => {} }
const cmd = async (c, wait = 140) => { bot.chat(c); await sleep(wait) }
const blockAt = (p) => bot.blockAt(new Vec3(p[0], p[1], p[2]))

let pass = 0, fail = 0
const results = []

async function reset(extra = []) {
  await cmd('/fill -20 4 -20 20 16 20 air', 200)
  await cmd('/fill -20 4 -20 20 4 20 stone', 200)
  for (const [x, y, z, block] of extra) await cmd(`/setblock ${x} ${y} ${z} ${block}`)
  await sleep(80)
}

async function test(label, item, target, state, { stand, extra = [] } = {}) {
  await reset(extra)
  await cmd('/tp 0 5 3', 350)
  if (stand) await cmd(`/tp ${stand[0]} ${stand[1]} ${stand[2]}`, 350)
  await cmd(`/give @s ${item} 1`)
  const itemObj = bot.inventory.items().find((i) => i.name === item)
  if (!itemObj) { fail++; results.push({ label, error: 'no item' }); return }
  await bot.equip(itemObj, 'hand').catch(() => {})
  let res, err = null
  try {
    res = await placeBlockAt(session, bot, { position: { x: target[0], y: target[1], z: target[2] }, blockName: item, state })
  } catch (e) { err = e.message; if (process.env.STACK) console.log(e.stack) }
  const b = blockAt(target)
  const ok = res?.verified === true && !err
  if (ok) pass++; else fail++
  results.push({ label, ok, err, placed: b?.name, props: b?.getProperties?.(), want: state, expected: res?.expectedState, stateOk: res?.stateOk, ref: res?.ref, family: res?.family })
  await sleep(120)
}

bot.once('spawn', async () => {
  await sleep(1000)
  await cmd('/gamemode creative')
  await cmd('/tp 0 5 0')
  const T = [0, 5, 0]
  await test('stairs east bottom', 'oak_stairs', T, { facing: 'east', half: 'bottom' })
  await test('stairs north top (隔壁墙)', 'oak_stairs', T, { facing: 'north', half: 'top' }, { extra: [[0, 5, -1, 'stone']] })
  await test('stairs west top (隔壁墙)', 'oak_stairs', T, { facing: 'west', half: 'top' }, { extra: [[-1, 5, 0, 'stone']] })
  await test('slab top (隔壁墙)', 'oak_slab', T, { type: 'top' }, { extra: [[1, 5, 0, 'stone']] })
  await test('slab top (上方有方块)', 'oak_slab', T, { type: 'top' }, { extra: [[0, 6, 0, 'stone']] })
  await test('slab bottom', 'oak_slab', T, { type: 'bottom' })
  await test('log axis x', 'oak_log', T, { axis: 'x' }, { extra: [[1, 5, 0, 'stone']] })
  await test('log axis y', 'oak_log', T, { axis: 'y' })
  await test('log axis z', 'oak_log', T, { axis: 'z' }, { extra: [[0, 5, 1, 'stone']] })
  await test('chest facing north', 'chest', T, { facing: 'north' })
  await test('chest facing east', 'chest', T, { facing: 'east' })
  await test('piston facing north', 'piston', T, { facing: 'north' })
  await test('observer facing west', 'observer', T, { facing: 'west' })
  await test('hopper facing down', 'hopper', T, { facing: 'down' })
  await test('hopper 朝东连箱子', 'hopper', T, { facing: 'east' }, { extra: [[1, 5, 0, 'chest']] })
  await test('hopper 朝北连漏斗', 'hopper', T, { facing: 'north' }, { extra: [[0, 5, -1, 'hopper']] })
  await test('torch 朝西（墙在东边）', 'torch', T, { facing: 'west' }, { extra: [[1, 5, 0, 'stone']] })
  await test('ladder 朝北（墙在南边）', 'ladder', T, { facing: 'north' }, { extra: [[0, 5, 1, 'stone']] })
  await test('lever 朝东（墙在西边）', 'lever', T, { facing: 'east' }, { extra: [[-1, 5, 0, 'oak_planks']] })
  await test('torch 站地上（不给朝向）', 'torch', T, null)
  await test('stone on top of slab', 'stone', [0, 6, 0], null, { extra: [[0, 5, 0, 'oak_slab']] })
  await test('stone beside slab (partial ref)', 'stone', T, null, { extra: [[1, 5, 0, 'oak_slab']] })
  await test('planks against fence', 'oak_planks', T, null, { extra: [[0, 5, -1, 'oak_fence']] })

  for (const r of results) console.log(JSON.stringify(r))
  console.log(`\n${pass} pass, ${fail} fail`)
  bot.quit(); setTimeout(() => process.exit(fail ? 1 : 0), 300)
})
