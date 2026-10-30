/**
 * dsh-mc-player — 设置页（Client 半边）。
 *
 * 注册 settings.section「MC 玩家」：连接、会话绑定、反射/节奏/聊天/闲置、目标/挂机、地图，
 * 以及在线状态和连接/断开按钮。数据走宿主插件的 HTTP API（/dsh-mc-player/api）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mc-player',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const API = '/dsh-mc-player/api'

    const CSS = [
      '.mcp-panel{display:flex;flex-direction:column;gap:18px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary);max-width:760px}',
      '.mcp-sec{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}',
      '.mcp-sec h3{margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
      '.mcp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px}',
      '.mcp-field{display:flex;flex-direction:column;gap:4px}',
      '.mcp-field label{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.mcp-field input[type=text],.mcp-field input[type=number],.mcp-field select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none}',
      '.mcp-field input:focus,.mcp-field select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.mcp-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      '.mcp-panel button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}',
      '.mcp-panel button:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.mcp-panel button:disabled{opacity:.5;cursor:default}',
      '.mcp-panel .primary{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.mcp-switch{position:relative;width:34px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer;display:inline-block;transition:background .15s}',
      '.mcp-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .15s}',
      '.mcp-switch.on{background:var(--dsw-alias-brand-primary)}',
      '.mcp-switch.on::after{transform:translateX(16px)}',
      '.mcp-inline{display:flex;align-items:center;gap:8px}',
      '.mcp-note{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.mcp-err{color:#e5484d;font-size:12px}',
      '.mcp-ok{color:#2f9e44;font-size:12px}',
      '.mcp-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.mcp-dot{width:8px;height:8px;border-radius:50%;background:#e5484d}',
      '.mcp-dot.on{background:#2f9e44}',
    ].join('\n')

    function Field(props) {
      return h('div', { className: 'mcp-field' },
        h('label', null, props.label),
        props.children,
        props.hint ? h('div', { className: 'mcp-note' }, props.hint) : null)
    }

    function Num(props) {
      return h('input', {
        type: 'number',
        value: props.value ?? '',
        min: props.min, max: props.max, step: props.step ?? 1,
        onChange: (e) => props.onChange(Number(e.target.value)),
      })
    }

    function Switch(props) {
      return h('span', {
        className: 'mcp-switch' + (props.on ? ' on' : ''),
        role: 'switch', 'aria-checked': props.on,
        tabIndex: 0,
        onClick: () => props.onChange(!props.on),
        onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onChange(!props.on) } },
      })
    }

    function McPanel() {
      const [settings, setSettings] = useState(null)
      const [sessions, setSessions] = useState([])
      const [status, setStatus] = useState(null)
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const [a, b, c] = await Promise.all([
            fetch(API + '/settings').then((r) => r.json()),
            fetch(API + '/sessions').then((r) => r.json()),
            fetch(API + '/status').then((r) => r.json()),
          ])
          setSettings(a.settings)
          setSessions(b.items || [])
          setStatus(c)
        } catch (e) {
          setMsg({ kind: 'err', text: '读设置失败：' + (e?.message || e) })
        }
      }, [])
      useEffect(() => { load() }, [load])

      const setPath = (path, value) => {
        setSettings((prev) => {
          const next = JSON.parse(JSON.stringify(prev))
          let node = next
          for (let i = 0; i < path.length - 1; i += 1) node = node[path[i]]
          node[path[path.length - 1]] = value
          return next
        })
      }

      const save = async () => {
        setBusy(true)
        try {
          const r = await fetch(API + '/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })
          const d = await r.json()
          if (!r.ok) throw new Error(d.error || r.status)
          setSettings(d.settings)
          setMsg({ kind: 'ok', text: '已保存（连接相关的改动用「连接」按钮生效）' })
        } catch (e) {
          setMsg({ kind: 'err', text: '保存失败：' + (e?.message || e) })
        } finally { setBusy(false) }
      }

      const doPost = async (path, body) => {
        setBusy(true)
        try {
          const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
          const d = await r.json()
          if (d?.error) throw new Error(d.error)
          setMsg({ kind: d?.ok ? 'ok' : 'err', text: d?.ok ? '连接成功' : ('没连上：' + (d?.error || '未知原因')) })
          await load()
        } catch (e) {
          setMsg({ kind: 'err', text: '操作失败：' + (e?.message || e) })
        } finally { setBusy(false) }
      }

      if (!settings) return h('div', { className: 'mcp-panel' }, h('style', null, CSS), '读取中…')

      const conn = settings.connection || {}
      const sess = sessions.slice(0, 50)
      return h('div', { className: 'mcp-panel' },
        h('style', null, CSS),
        msg ? h('div', { className: msg.kind === 'err' ? 'mcp-err' : 'mcp-ok' }, msg.text) : null,

        h('div', { className: 'mcp-sec' },
          h('h3', null, '连接'),
          h('div', { className: 'mcp-grid' },
            h(Field, { label: '服务器地址' }, h('input', { type: 'text', value: conn.host ?? '', onChange: (e) => setPath(['connection', 'host'], e.target.value) })),
            h(Field, { label: '端口' }, h(Num, { value: conn.port, min: 1, max: 65535, onChange: (v) => setPath(['connection', 'port'], v) })),
            h(Field, { label: '用户名' }, h('input', { type: 'text', value: conn.username ?? '', onChange: (e) => setPath(['connection', 'username'], e.target.value) })),
            h(Field, { label: '版本' }, h('input', { type: 'text', value: conn.version ?? '', onChange: (e) => setPath(['connection', 'version'], e.target.value) })),
            h(Field, { label: '登录方式' },
              h('select', { value: conn.auth ?? 'offline', onChange: (e) => setPath(['connection', 'auth'], e.target.value) },
                h('option', { value: 'offline' }, '离线（offline）'),
                h('option', { value: 'microsoft' }, '微软（microsoft）'))),
          ),
          h('div', { className: 'mcp-row' },
            h('button', { className: 'primary', disabled: busy, onClick: () => doPost('/connect', settings.connection) }, '连接'),
            h('button', { disabled: busy, onClick: () => doPost('/disconnect') }, '断开'),
            h('span', { className: 'mcp-pill' },
              h('span', { className: 'mcp-dot' + (status?.online ? ' on' : '') }),
              status?.online ? ('在线：' + (status?.connection?.host || '') + ':' + (status?.connection?.port || '')) : '离线'),
          ),
        ),

        h('div', { className: 'mcp-sec' },
          h('h3', null, '会话绑定'),
          h('div', { className: 'mcp-grid' },
            h(Field, { label: '用哪个 DSH 会话玩游戏', hint: '游戏聊天、闲置思考会把消息转给这个会话；留空则用第一次调用工具时的会话。' },
              h('select', {
                value: settings.boundSessionId ?? '',
                onChange: (e) => setPath(['boundSessionId'], e.target.value || null),
              },
                h('option', { value: '' }, '自动（当前会话）'),
                sess.map((s) => h('option', { key: s.id, value: s.id },
                  (s.title || '未命名会话') + (s.running ? ' · 运行中' : '') + ' · ' + new Date(s.updatedAt || 0).toLocaleString()))),
            ),
          ),
          h('div', { className: 'mcp-row' },
            h('button', { onClick: load }, '刷新会话'),
            h('span', { className: 'mcp-note' }, '共 ' + sessions.length + ' 个会话'),
          ),
        ),

        h('div', { className: 'mcp-sec' },
          h('h3', null, '反射（保命）'),
          h('div', { className: 'mcp-grid' },
            h(Field, { label: '启用反射' }, h(Switch, { on: settings.reflex?.enabled !== false, onChange: (v) => setPath(['reflex', 'enabled'], v) })),
            h(Field, { label: '低血进食阈值' }, h(Num, { value: settings.reflex?.lowHealth, min: 1, max: 20, onChange: (v) => setPath(['reflex', 'lowHealth'], v) })),
            h(Field, { label: '被围判定只数' }, h(Num, { value: settings.reflex?.surroundCount, min: 1, max: 10, onChange: (v) => setPath(['reflex', 'surroundCount'], v) })),
            h(Field, { label: '苦力怕警戒距离' }, h(Num, { value: settings.reflex?.creeperRange, min: 1, max: 10, onChange: (v) => setPath(['reflex', 'creeperRange'], v) })),
          ),
        ),

        h('div', { className: 'mcp-sec' },
          h('h3', null, '节奏与闲置'),
          h('div', { className: 'mcp-grid' },
            h(Field, { label: '节奏（张望/睡觉）' }, h(Switch, { on: settings.rhythm?.enabled !== false, onChange: (v) => setPath(['rhythm', 'enabled'], v) })),
            h(Field, { label: '多久没活才张望（毫秒）' }, h(Num, { value: settings.rhythm?.idleLookAfterMs, min: 1000, step: 1000, onChange: (v) => setPath(['rhythm', 'idleLookAfterMs'], v) })),
            h(Field, { label: '几天没睡后睡觉' }, h(Num, { value: settings.rhythm?.sleepAfterDays, min: 1, max: 10, onChange: (v) => setPath(['rhythm', 'sleepAfterDays'], v) })),
            h(Field, { label: '闲置思考' }, h(Switch, { on: settings.idle?.enabled !== false, onChange: (v) => setPath(['idle', 'enabled'], v) })),
            h(Field, { label: '闲置多少秒叫醒大脑' }, h(Num, { value: settings.idle?.afterSeconds, min: 5, max: 600, onChange: (v) => setPath(['idle', 'afterSeconds'], v) })),
            h(Field, { label: '两次叫醒的冷却（秒）' }, h(Num, { value: settings.idle?.cooldownSeconds, min: 10, max: 3600, onChange: (v) => setPath(['idle', 'cooldownSeconds'], v) })),
            h(Field, { label: '聊天转发' }, h(Switch, { on: settings.chat?.enabled !== false, onChange: (v) => setPath(['chat', 'enabled'], v) })),
          ),
        ),

        h('div', { className: 'mcp-sec' },
          h('h3', null, '目标与挂机'),
          h('div', { className: 'mcp-grid' },
            h(Field, { label: '自主目标执行器' }, h(Switch, { on: settings.autopilot?.enabled !== false, onChange: (v) => setPath(['autopilot', 'enabled'], v) })),
            h(Field, { label: '执行间隔（毫秒）' }, h(Num, { value: settings.autopilot?.intervalMs, min: 500, step: 100, onChange: (v) => setPath(['autopilot', 'intervalMs'], v) })),
            h(Field, { label: '低于多少血不干活' }, h(Num, { value: settings.autopilot?.minHealth, min: 1, max: 20, onChange: (v) => setPath(['autopilot', 'minHealth'], v) })),
            h(Field, { label: '一步最多重试几次' }, h(Num, { value: settings.autopilot?.maxAttempts, min: 1, max: 10, onChange: (v) => setPath(['autopilot', 'maxAttempts'], v) })),
            h(Field, { label: '挂机最长分钟' }, h(Num, { value: settings.machine?.maxMinutes, min: 1, max: 240, onChange: (v) => setPath(['machine', 'maxMinutes'], v) })),
            h(Field, { label: '地图记忆' }, h(Switch, { on: settings.map?.enabled !== false, onChange: (v) => setPath(['map', 'enabled'], v) })),
          ),
        ),

        h('div', { className: 'mcp-row' },
          h('button', { className: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存设置'),
          h('span', { className: 'mcp-note' }, '设置存在 ~/.dsh/mc-player/settings.json，重启还在。'),
        ),
        h('div', { className: 'mcp-note' },
          '状态：' + (status?.online ? '在线' : '离线') +
          ' · 当前会话 ' + (status?.currentSessionId ? status.currentSessionId.slice(0, 14) + '…' : '未捕获') +
          ' · 绑定 ' + (status?.boundSessionId ? status.boundSessionId.slice(0, 14) + '…' : '自动') +
          ' · 目标 ' + (status?.plan?.status || '无')),
      )
    }

    exports.inject = ['slots']
    exports.apply = function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'mc-player', order: 30, label: 'MC 玩家' },
        () => h(McPanel),
      ))
    }
    return module.exports
  },
})
