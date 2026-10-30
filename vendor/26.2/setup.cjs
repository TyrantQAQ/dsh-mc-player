#!/usr/bin/env node
/**
 * 26.2 客户端"可重复安装器"（P1-3）
 *
 *   node setup-26.2.cjs [项目目录]            安装/修复（幂等）
 *   node setup-26.2.cjs [项目目录] --check    只检查，缺补丁就返回非 0
 *   node setup-26.2.cjs [项目目录] --json     机器可读
 *   node setup-26.2.cjs [项目目录] --patch-client --patch-data
 *
 * 默认两件事都做：
 *   1) data：把 ../dist/pc/26.2 + 三个 entry 装进 minecraft-data，并重跑 bin/generate_data.js
 *   2) client：给 4 个库补版本登记
 *
 * 补丁全部是"往版本列表里加一个 '26.2'"，没有逻辑改动。匹配不到时**报错**而不是静默跳过。
 * 退出码：0 = 全部就绪；1 = 有缺；2 = 环境不对（没装依赖）。
 */
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const HERE = __dirname
const DIST = process.env.MC_DIST || path.join(HERE, 'dist')
const args = process.argv.slice(2)
const CHECK_ONLY = args.includes('--check')
const JSON_OUT = args.includes('--json')
const target = args.find(a => !a.startsWith('--')) || process.cwd()

const report = []
const log = (...a) => { if (!JSON_OUT) console.log(...a) }
function record (id, status, detail) {
  report.push({ id, status, detail }) // status: ok | patched | missing | error | skip
  if (!JSON_OUT) {
    const tag = { ok: '[=]', patched: '[+]', missing: '[!]', error: '[x]', skip: '[-]' }[status]
    log(`${tag} ${id.padEnd(42)} ${detail}`)
  }
}

function findPkg (start, name) {
  let dir = path.resolve(start)
  for (let i = 0; i < 10; i++) {
    const cand = path.join(dir, 'node_modules', name)
    if (fs.existsSync(cand)) return cand
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return null
}

// ---------------- 1. 数据 ----------------
function installData () {
  const mcDataPkg = findPkg(target, 'minecraft-data')
  if (!mcDataPkg) return record('data.minecraft-data', 'error', '没找到 node_modules/minecraft-data（先 npm i mineflayer）')
  const dataRoot = fs.existsSync(path.join(mcDataPkg, 'minecraft-data')) ? path.join(mcDataPkg, 'minecraft-data') : mcDataPkg
  const src = path.join(DIST, 'pc', '26.2')
  const dst = path.join(dataRoot, 'data', 'pc', '26.2')
  if (!fs.existsSync(src)) return record('data.dist', 'error', `找不到 ${src}`)

  const upToDate = fs.existsSync(path.join(dst, 'blocks.json')) &&
    (() => { try { return JSON.parse(fs.readFileSync(path.join(dst, 'version.json'), 'utf8')).version === 776 } catch { return false } })()
  if (!upToDate) {
    if (CHECK_ONLY) { record('data.pc-26.2', 'missing', 'data/pc/26.2 没装'); return finishData(dataRoot, mcDataPkg) }
    fs.rmSync(dst, { recursive: true, force: true })
    fs.cpSync(src, dst, { recursive: true })
    record('data.pc-26.2', 'patched', `拷入 ${fs.readdirSync(dst).length} 个文件`)
  } else record('data.pc-26.2', 'ok', 'data/pc/26.2 已就绪')
  return finishData(dataRoot, mcDataPkg)
}

function finishData (dataRoot, mcDataPkg) {
  const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
  const entry = readJson(path.join(DIST, 'dataPaths.26.2.json'))
  const protoVer = readJson(path.join(DIST, 'protocolVersions.26.2.json'))

  const dpPath = path.join(dataRoot, 'data', 'dataPaths.json')
  const dp = readJson(dpPath)
  const hasDp = dp.pc && dp.pc['26.2']
  if (!hasDp) {
    if (CHECK_ONLY) record('data.dataPaths', 'missing', 'dataPaths.json 里没有 pc["26.2"]')
    else { dp.pc = dp.pc || {}; dp.pc['26.2'] = entry; fs.writeFileSync(dpPath, JSON.stringify(dp, null, 2)); record('data.dataPaths', 'patched', 'pc["26.2"] 已写入') }
  } else record('data.dataPaths', 'ok', 'dataPaths.json 已有 pc["26.2"]')

  const pvPath = path.join(dataRoot, 'data', 'pc', 'common', 'protocolVersions.json')
  const pv = readJson(pvPath)
  const hasPv = pv.some(v => v.version === 776)
  if (!hasPv) {
    if (CHECK_ONLY) record('data.protocolVersions', 'missing', 'protocolVersions.json 里没有 776')
    else { pv.unshift(protoVer); fs.writeFileSync(pvPath, JSON.stringify(pv, null, 2)); record('data.protocolVersions', 'patched', '{version:776, minecraftVersion:"26.2"} 已写入') }
  } else record('data.protocolVersions', 'ok', 'protocolVersions.json 已有 776')

  const vsPath = path.join(dataRoot, 'data', 'pc', 'common', 'versions.json')
  const vs = readJson(vsPath)
  if (!vs.includes('26.2') && !CHECK_ONLY) { vs.push('26.2'); fs.writeFileSync(vsPath, JSON.stringify(vs, null, 2)); record('data.versions', 'patched', 'versions.json += "26.2"') }
  else record('data.versions', vs.includes('26.2') ? 'ok' : 'missing', vs.includes('26.2') ? 'versions.json 已有 26.2' : 'versions.json 缺 26.2')

  // data.js 是否包含 26.2
  const dataJs = path.join(mcDataPkg, 'data.js')
  const gen = path.join(mcDataPkg, 'bin', 'generate_data.js')
  const hasDataJs = fs.existsSync(dataJs) && fs.readFileSync(dataJs, 'utf8').includes("'26.2'")
  if (!hasDataJs) {
    if (CHECK_ONLY) record('data.data.js', 'missing', 'data.js 里没有 26.2（需要重跑 bin/generate_data.js）')
    else if (fs.existsSync(gen)) {
      try { execFileSync(process.execPath, [gen], { stdio: 'pipe' }); record('data.data.js', 'patched', '已重跑 bin/generate_data.js') } catch (e) { record('data.data.js', 'error', 'generate_data.js 失败: ' + e.message) }
    } else record('data.data.js', 'error', '没有 bin/generate_data.js')
  } else record('data.data.js', 'ok', 'data.js 已含 26.2')
}

// ---------------- 2. 客户端四处登记 ----------------
function patchVersionList (file, listName, label) {
  // 兼容 `supportedVersions: [...]` / `testedVersions = [...]`，中间允许多少空白都行
  const re = new RegExp(`(${listName}\\s*[=:]\\s*\\[)([\\s\\S]*?)(\\])`)
  if (!fs.existsSync(file)) return record(label, 'skip', '没有这个文件（这个库版本可能不同）')
  const src = fs.readFileSync(file, 'utf8')
  const m = src.match(re)
  if (!m) return record(label, 'error', `没匹配到 ${listName} 数组 —— 这个文件的版本可能不对，需要人工看`)
  if (m[2].includes("'26.2'") || m[2].includes('"26.2"')) return record(label, 'ok', '已经登记过 26.2')
  const body = m[2].replace(/\s*$/, '')
  const patched = src.replace(re, `$1${body}, '26.2'$3`)
  if (CHECK_ONLY) return record(label, 'missing', `${listName} 里没有 26.2`)
  fs.writeFileSync(file, patched)
  record(label, 'patched', `${listName} += '26.2'`)
}

function patchChunk () {
  const pkg = findPkg(target, 'prismarine-chunk')
  if (!pkg) return record('client.prismarine-chunk', 'skip', '没装 prismarine-chunk')
  const file = path.join(pkg, 'src', 'index.js')
  const label = 'client.prismarine-chunk'
  if (!fs.existsSync(file)) return record(label, 'skip', '没有 src/index.js')
  let s = fs.readFileSync(file, 'utf8')
  if (/26\.2\s*:/.test(s)) return record(label, 'ok', 'chunkImplementations 已有 26.2')
  const m = s.match(/(\n\s*)(2[6]:?\s*1\s*:\s*require\('\.\/pc\/1\.18\/chunk'\)|'?26\.1'?\s*:\s*require\('\.\/pc\/1\.18\/chunk'\))/)
  const m2 = m || s.match(/(\n\s*)(1\.21\s*:\s*require\('\.\/pc\/1\.18\/chunk'\))/)
  if (!m2) return record(label, 'error', 'chunkImplementations 里找不到 26.1 / 1.21 那一行 —— 版本可能不对，需要人工看')
  if (CHECK_ONLY) return record(label, 'missing', 'chunkImplementations 里没有 26.2')
  s = s.replace(m2[0], `${m2[0]},${m2[1]}26.2: require('./pc/1.18/chunk')`)
  fs.writeFileSync(file, s)
  record(label, 'patched', "chunkImplementations += 26.2 → ./pc/1.18/chunk")
}

function patchPhysicsFeatures () {
  const pkg = findPkg(target, 'prismarine-physics')
  if (!pkg) return record('client.prismarine-physics', 'skip', '没装 prismarine-physics')
  const file = path.join(pkg, 'lib', 'features.json')
  const label = 'client.prismarine-physics'
  if (!fs.existsSync(file)) return record(label, 'skip', '没有 lib/features.json')
  const j = JSON.parse(fs.readFileSync(file, 'utf8'))
  let need = 0
  for (const f of j) {
    if (!Array.isArray(f.versions)) continue
    if ((f.versions.includes('26.1') || f.versions.includes('1.21')) && !f.versions.includes('26.2')) need++
  }
  if (!need) return record(label, 'ok', 'features.json 已经涵盖 26.2')
  if (CHECK_ONLY) return record(label, 'missing', `有 ${need} 条特性没包含 26.2`)
  for (const f of j) {
    if (Array.isArray(f.versions) && (f.versions.includes('26.1') || f.versions.includes('1.21')) && !f.versions.includes('26.2')) f.versions.push('26.2')
  }
  fs.writeFileSync(file, JSON.stringify(j, null, 2))
  record(label, 'patched', `${need} 条特性 += 26.2`)
}

function patchClient () {
  const mcp = findPkg(target, 'minecraft-protocol')
  if (mcp) {
    for (const rel of ['src/version.js', 'lib/version.js']) {
      const f = path.join(mcp, rel)
      if (!fs.existsSync(f)) { record(`client.minecraft-protocol/${rel}`, 'skip', '没有这个文件'); continue }
      patchVersionList(f, rel.startsWith('src') ? 'supportedVersions' : 'supportedVersions', `client.minecraft-protocol/${rel}`)
    }
  } else record('client.minecraft-protocol', 'error', '没找到 node_modules/minecraft-protocol')
  const mf = findPkg(target, 'mineflayer')
  if (mf) patchVersionList(path.join(mf, 'lib', 'version.js'), 'testedVersions', 'client.mineflayer/lib/version.js')
  else record('client.mineflayer', 'error', '没找到 node_modules/mineflayer')
  patchChunk()
  patchPhysicsFeatures()
}

// ---------------- 3. 安装自检（不连服务器） ----------------
function selfCheck () {
  const req = require('module').createRequire(path.join(path.resolve(target), '__setup__.js'))
  const out = {}
  try {
    const mc = req('minecraft-data')('26.2')
    out.data = !!(mc && mc.version && mc.version.version === 776)
    record('selfcheck.data-load', out.data ? 'ok' : 'error',
      out.data ? `require('minecraft-data')('26.2') → ${mc.blocksArray.length} 方块 / ${mc.itemsArray.length} 物品` : '加载出来不是 776')
  } catch (e) { out.data = false; record('selfcheck.data-load', 'error', '加载 26.2 数据失败: ' + e.message) }

  try {
    const mcp = req('minecraft-protocol')
    const list = (require(path.join(findPkg(target, 'minecraft-protocol'), 'src/version.js')) || {}).supportedVersions || mcp.supportedVersions || []
    out.minecraftProtocol = list.includes('26.2')
    record('selfcheck.minecraft-protocol', out.minecraftProtocol ? 'ok' : 'missing', `supportedVersions 含 26.2 = ${out.minecraftProtocol}`)
  } catch (e) { out.minecraftProtocol = false; record('selfcheck.minecraft-protocol', 'error', e.message) }

  try {
    const pv = require(path.join(findPkg(target, 'mineflayer'), 'lib/version.js'))
    out.mineflayer = pv.latestSupportedVersion === '26.2' || pv.testedVersions.includes('26.2')
    record('selfcheck.mineflayer', out.mineflayer ? 'ok' : 'missing', `latestSupportedVersion = ${pv.latestSupportedVersion}`)
  } catch (e) { out.mineflayer = false; record('selfcheck.mineflayer', 'error', e.message) }

  try {
    const C = req('prismarine-chunk')('26.2')
    const chunk = typeof C === 'function' ? new C() : C
    out.prismarineChunk = !!chunk && (typeof chunk.getBlockStateId === 'function' || typeof chunk.setBlock === 'function')
    record('selfcheck.prismarine-chunk', out.prismarineChunk ? 'ok' : 'error',
      out.prismarineChunk ? `prismarine-chunk 能按 26.2 建出区块实例（不用连服）：getBlockStateId(${chunk?.getBlockStateId?.(0, 0, 0)})` : '建出来不像个 chunk')
  } catch (e) { out.prismarineChunk = false; record('selfcheck.prismarine-chunk', 'error', 'prismarine-chunk("26.2") 抛错: ' + e.message) }

  try {
    const feats = JSON.parse(fs.readFileSync(path.join(findPkg(target, 'prismarine-physics'), 'lib', 'features.json'), 'utf8'))
    const grav = feats.find(f => f.name === 'proportionalLiquidGravity')
    out.prismarinePhysics = !!grav && grav.versions.includes('26.2')
    record('selfcheck.prismarine-physics', out.prismarinePhysics ? 'ok' : 'missing',
      out.prismarinePhysics ? 'proportionalLiquidGravity 含 26.2（不然会抛 No liquid gravity settings）' : '液体重力特性没登记 26.2')
  } catch (e) { out.prismarinePhysics = false; record('selfcheck.prismarine-physics', 'error', e.message) }

  return out
}

// ---------------- main ----------------
log(`# setup-26.2  target=${path.resolve(target)}  mode=${CHECK_ONLY ? 'check' : 'apply'}`)
if (!findPkg(target, 'mineflayer')) {
  log('[x] 这个目录往上找不到 node_modules/mineflayer —— 先 `npm i mineflayer`')
  process.exit(2)
}
installData()
patchClient()
const sc = selfCheck()

const bad = report.filter(r => r.status === 'error' || r.status === 'missing')
const out = {
  at: new Date().toISOString(),
  target: path.resolve(target),
  checkOnly: CHECK_ONLY,
  ok: bad.length === 0,
  items: report,
  selfCheck: sc
}
if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
else {
  log('\n' + '-'.repeat(64))
  log(`${out.ok ? 'PASS' : 'FAIL'}  ${report.filter(r => r.status === 'ok').length} ok / ${report.filter(r => r.status === 'patched').length} 新打 / ${bad.length} 缺`)
  if (bad.length) for (const b of bad) log(`  ${b.id}: ${b.detail}`)
}
process.exit(out.ok ? 0 : 1)
