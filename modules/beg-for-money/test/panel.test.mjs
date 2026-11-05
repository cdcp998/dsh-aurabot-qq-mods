// 讨饭面板（panel.js）的测试。
// 和 Aurabot 面板加载 panel.js 的方式一致：一整段函数体丢给 new Function，
// React 用最小 stub（useState / useEffect / useCallback），不碰 DOM。

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
const plugin = (await import('../index.mjs')).default
const pluginDefaults = plugin.defaults

const STATE = {
  ok: true,
  version: '1.0.0',
  enabled: true,
  ledgerEnabled: true,
  currency: '元',
  ledgerBroken: false,
  ledgerFile: 'C:/data/ledger.json',
  accounts: 3,
  grandTotal: 42.5,
  today: { date: '2026-11-05', count: 2, total: 27.5 },
  recent: { days: 7, count: 3, total: 42.5, buckets: [{ date: '2026-11-05', count: 2, total: 27.5 }, { date: '2026-11-03', count: 1, total: 15 }] },
  qr: { configured: true, path: 'assets/qr.png', available: true, message: '' },
  adminOnly: false,
  admins: ['10000001', '20000002'],
  requireApproval: true,
  thanksWindowSeconds: 600,
  linkImpressionCard: true,
  impressionCard: true,
  pendingThanks: [],
  approvals: [{ id: '1', amount: 15, note: '请你喝奶茶', groupName: '群 700001', requester: '路人甲', created: Date.UTC(2026, 10, 5, 1, 30) }],
  rows: [
    { date: '2026-11-05', time: '09:00:00', amount: 15, note: '请你喝奶茶', group: '群 700001', payer: '路人甲', source: '管理员确认' },
    { date: '2026-11-03', time: '12:00:00', amount: 15, note: '', group: '群 700002', payer: '', source: '命令' },
    { date: '2026-10-01', time: '12:00:00', amount: 12.5, note: '早饭', group: '群 700003', payer: '小明', source: '工具' },
  ],
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function load (overrides) {
  const values = []
  let index = 0
  const calls = []
  const messages = []
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
  const call = async (path, body) => {
    calls.push({ path, body })
    if (overrides && typeof overrides[path] === 'function') return overrides[path](body)
    if (path === '/state') return JSON.parse(JSON.stringify(STATE))
    return { ok: true, message: '完成' }
  }
  const Panel = new Function('React', 'h', 'ui', 'call', SOURCE)(React, h, ui, call)
  const settingsProps = { settings: {}, draftSettings: {}, setSettings: () => {}, toast: (m) => messages.push(m) }
  const render = () => {
    index = 0
    return Panel({ ...settingsProps, save: overrides && overrides.__save ? overrides.__save : async () => {} })
  }
  const mount = async () => {
    render()
    if (!mounted) {
      mounted = true
      for (const fn of effects.splice(0)) fn()
      await tick()
    }
    return render()
  }
  return { Panel, render, mount, calls, messages, props: settingsProps }
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
  const props = node.props || {}
  const head = [props.title, props.desc, props.text, props.label, props.placeholder].filter((x) => typeof x === 'string')
  return head.join('') + (node.children || []).map(text).join('')
}
const find = (tree, pred) => walk(tree).find((n) => pred(n))
const buttons = (tree) => walk(tree).filter((n) => n.type === 'Btn')
const button = (tree, label) => buttons(tree).find((b) => text(b) === label)

test('panel.js 求值后返回一个 React 组件函数', () => {
  const h = load()
  assert.equal(typeof h.Panel, 'function')
  assert.equal(typeof h.render(), 'object')
})

test('首屏还没拿到 state 时显示加载中，不显示空账本', () => {
  const h = load()
  const tree = h.render()
  assert.match(text(tree), /读取账本/)
  assert.doesNotMatch(text(tree), /账本还是空的/)
  assert.equal(button(tree, '显示全部（最多 200）'), undefined)
  assert.deepEqual(h.calls, [], '渲染过程里不该发请求')
})

test('面板里不重复渲染总开关（它在标签页标题栏上）', async () => {
  const h = load()
  const tree = await h.mount()
  assert.equal(find(tree, (n) => n.type === 'Switch'), undefined, '面板里不该再有第二个总开关')
})

test('总开关关着时给出说明，并指向标签页上的开关', async () => {
  const h = load({ '/state': () => ({ ...JSON.parse(JSON.stringify(STATE)), enabled: false }) })
  const tree = await h.mount()
  const body = text(tree)
  assert.match(body, /讨饭关着/)
  assert.match(body, /标签页标题栏的开关/)
  assert.match(body, /账本和待确认记录还在/)
})

test('总开关开着时不显示「关着」的提示', async () => {
  const h = load()
  const tree = await h.mount()
  assert.doesNotMatch(text(tree), /讨饭关着/)
})

test('defaults 里保留 enabled：标签页的开/关状态点和标题栏开关都靠它', () => {
  assert.equal(pluginDefaults.enabled, true)
})

test('面板引用的接口路径都存在', () => {
  for (const path of ["'/state'", "'/approve'", "'/beg'"]) assert.ok(SOURCE.includes(path), '缺少接口路径 ' + path)
})

test('挂载后只拉一次 /state，今日 / 最近 / 累计都在', async () => {
  const h = load()
  const tree = await h.mount()
  assert.deepEqual(h.calls.map((c) => c.path), ['/state'])
  const body = text(tree)
  assert.match(body, /今天/)
  assert.match(body, /27\.50元/)
  assert.match(body, /最近 7 天/)
  assert.match(body, /42\.50元/)
  assert.match(body, /累计/)
  assert.match(body, /有记录的日子/)
  assert.match(body, /11-05 2 笔 27\.50元/)
})

test('待确认列表显示金额、群、发起人，并带确认 / 不记按钮', async () => {
  const h = load()
  const tree = await h.mount()
  const body = text(tree)
  assert.match(body, /#1/)
  assert.match(body, /15\.00元/)
  assert.match(body, /群 700001/)
  assert.match(body, /路人甲/)
  assert.match(body, /请你喝奶茶/)
  assert.ok(button(tree, '确认记账'), '缺少确认按钮')
  assert.ok(button(tree, '不记'), '缺少不记按钮')
})

test('点「确认记账」调 /approve 并刷新状态', async () => {
  const h = load()
  const tree = await h.mount()
  const btn = button(tree, '确认记账')
  btn.props.onClick()
  await tick()
  await tick()
  const approve = h.calls.find((c) => c.path === '/approve')
  assert.deepEqual(approve.body, { id: '1', approve: true })
  assert.ok(h.calls.filter((c) => c.path === '/state').length >= 2, '操作完要重新拉一次状态')
  assert.ok(h.messages.some((m) => /完成/.test(m)))
})

test('点「不记」发 approve:false', async () => {
  const h = load()
  const tree = await h.mount()
  button(tree, '不记').props.onClick()
  await tick()
  await tick()
  const approve = h.calls.find((c) => c.path === '/approve')
  assert.deepEqual(approve.body, { id: '1', approve: false })
})

test('没有待确认时给出空状态，不留确认按钮', async () => {
  const h = load({ '/state': () => ({ ...JSON.parse(JSON.stringify(STATE)), approvals: [] }) })
  const tree = await h.mount()
  assert.match(text(tree), /没有待确认的记账/)
  assert.equal(button(tree, '确认记账'), undefined)
})

test('账本为空时给空状态，不出现 NaN', async () => {
  const h = load({
    '/state': () => ({
      ...JSON.parse(JSON.stringify(STATE)),
      accounts: 0, grandTotal: 0, rows: [], approvals: [],
      today: { date: '2026-11-05', count: 0, total: 0 },
      recent: { days: 7, count: 0, total: 0, buckets: [] },
    }),
  })
  const tree = await h.mount()
  const body = text(tree)
  assert.match(body, /账本还是空的/)
  assert.match(body, /最近没有打赏记录/)
  assert.doesNotMatch(body, /NaN/)
  assert.match(body, /0\.00元/)
})

test('搜索无匹配时给「没有匹配的记录」，而不是空库提示', async () => {
  const h = load()
  const tree = await h.mount()
  const input = find(tree, (n) => n.type === 'input')
  assert.ok(input, '缺少搜索框')
  input.props.onChange({ target: { value: '查无此账' } })
  const next = h.render()
  assert.match(text(next), /没有匹配的记录/)
  assert.doesNotMatch(text(next), /账本还是空的/)
})

test('搜索按备注 / 群 / 打赏人筛', async () => {
  const h = load()
  const tree = await h.mount()
  find(tree, (n) => n.type === 'input').props.onChange({ target: { value: '小明' } })
  const next = h.render()
  const body = text(next)
  assert.match(body, /12\.50元/, '匹配的行要留着')
  assert.match(body, /最近的账（3）/, '总数还是 3 笔（筛选只影响列表）')
  assert.doesNotMatch(body, /群 700002/, '不匹配的账本行要被筛掉')
})

test('账本损坏时顶部给出明确警告', async () => {
  const h = load({ '/state': () => ({ ...JSON.parse(JSON.stringify(STATE)), ledgerBroken: true }) })
  const tree = await h.mount()
  assert.match(text(tree), /账本文件损坏/)
  assert.match(text(tree), /ledger\.json/)
})

test('收款码不可用时说清楚原因', async () => {
  const h = load({
    '/state': () => ({ ...JSON.parse(JSON.stringify(STATE)), qr: { configured: true, path: 'assets/qr.png', available: false, message: '收款码图片找不到，发不了。' } }),
  })
  const tree = await h.mount()
  assert.match(text(tree), /收款码图片找不到/)
})

test('收款码没填时提示去填路径', async () => {
  const h = load({
    '/state': () => ({ ...JSON.parse(JSON.stringify(STATE)), qr: { configured: false, path: '', available: false, message: '' } }),
  })
  const tree = await h.mount()
  assert.match(text(tree), /还没填路径/)
})

test('印象卡片没在跑时只是提示，不是报错', async () => {
  const h = load({ '/state': () => ({ ...JSON.parse(JSON.stringify(STATE)), impressionCard: false, approvals: [], rows: [] }) })
  const tree = await h.mount()
  assert.match(text(tree), /印象卡片没在跑/)
  assert.doesNotMatch(text(tree), /账本文件损坏/)
})

test('总开关关掉时「试发收款码」按钮不可点', async () => {
  const h = load({ '/state': () => ({ ...JSON.parse(JSON.stringify(STATE)), enabled: false }) })
  const tree = await h.mount()
  const btn = button(tree, '往主人私聊试发一张')
  assert.ok(btn, '缺少试发按钮')
  assert.equal(btn.props.disabled, true)
})

test('接口报错时显示错误并提示，不白屏', async () => {
  const h = load({ '/state': () => ({ ok: false, message: '模块没在跑' }) })
  const tree = await h.mount()
  assert.match(text(tree), /读取账本失败：模块没在跑/)
  assert.ok(h.messages.length > 0)
})
