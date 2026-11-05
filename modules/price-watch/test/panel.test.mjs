// 价格监控面板：总开关就在这一页里，而且只有一个。
// 和 Aurabot 面板加载 panel.js 的方式一致：整段函数体丢给 new Function，React 用最小 stub。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')

const STATE = {
  ok: true,
  enabled: true,
  busy: false,
  intervalMinutes: 60,
  lastRun: 0,
  lastResult: '还没检查过',
  watches: [],
  records: {},
  stats: { watches: 0, alerts: 0, checkedAt: 0, checks: 0 },
  window: { startHour: 0, endHour: 0 },
  whitelist: [],
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function load (state = STATE) {
  const values = []
  let index = 0
  const calls = []
  const effects = []
  let mounted = false
  const React = {
    useState: (initial) => {
      const i = index++
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
      return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v }]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
  }
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
  })
  const ui = Object.fromEntries(['Card', 'Row', 'Btn', 'Select', 'Empty', 'Switch'].map((k) => [k, k]))
  const call = async (path) => {
    calls.push(path)
    if (path === '/state') return JSON.parse(JSON.stringify(state))
    return { ok: true, message: '完成' }
  }
  const Panel = new Function('React', 'h', 'ui', 'call', SOURCE)(React, h, ui, call)
  const render = (props) => {
    index = 0
    return Panel({ settings: {}, draftSettings: {}, setSettings: () => {}, save: async () => {}, toast: () => {}, ...props })
  }
  const mount = async (props) => {
    render(props)
    if (!mounted) { mounted = true; for (const fn of effects.splice(0)) fn(); await tick() }
    return render(props)
  }
  return { Panel, render, mount, calls }
}

const walk = (node) => {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(walk)
  return [node, ...walk(node.children), ...walk(node.props && node.props.right)]
}
const text = (node) => {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(text).join('')
  if (!node || typeof node !== 'object') return ''
  const p = node.props || {}
  return [p.title, p.desc, p.text, p.label, p.placeholder].filter((x) => typeof x === 'string').join('') + (node.children || []).map(text).join('')
}
const switches = (tree) => walk(tree).filter((n) => n.type === 'Switch')

test('panel.js 求值后是一个组件函数，首屏能渲染出来', () => {
  const p = load()
  assert.equal(typeof p.Panel, 'function')
  assert.equal(typeof p.render(), 'object')
})

test('总开关就在价格监控卡片右上角，而且整页只有这一个', async () => {
  const p = load()
  const tree = await p.mount()
  const all = switches(tree)
  assert.equal(all.length, 1, '整页只该有一个开关，实际 ' + all.length + ' 个')
  // 它挂在标题为「价格监控」的 Card 的 right 上
  const card = walk(tree).find((n) => n.type === 'Card' && n.props && n.props.title === '价格监控')
  assert.ok(card, '要有「价格监控」卡片')
  assert.equal(card.props.right, all[0], '开关要在卡片右上角')
})

test('没有 enabled 这个键时按开处理（默认开）', async () => {
  const p = load()
  const tree = await p.mount()
  assert.equal(switches(tree)[0].props.on, true)
})

test('草稿里关掉后，开关显示关，页面给出「总开关关着」的提示', async () => {
  const p = load()
  const tree = await p.mount({ settings: {}, draftSettings: { enabled: false } })
  assert.equal(switches(tree)[0].props.on, false)
  assert.match(text(tree), /总开关关着/)
})

test('拨动开关会同时写 enabled 和 active（后者给标签页圆点）', async () => {
  const p = load()
  const patches = []
  const tree = await p.mount({ settings: {}, draftSettings: {}, setSettings: (x) => patches.push(x) })
  switches(tree)[0].props.onChange(false)
  assert.deepEqual(patches, [{ enabled: false }, { active: false }])
})

test('面板引用的接口路径都存在', () => {
  for (const path of ["'/state'", "'/search'", "'/add'", "'/remove'", "'/check'"]) {
    assert.ok(SOURCE.includes(path), '缺少接口路径 ' + path)
  }
})
