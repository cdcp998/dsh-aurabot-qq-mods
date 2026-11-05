// 价格监控面板：总开关 + 监控列表 + 添加 / 查价 + 设置草稿。
// 这段代码是函数体，由 Aurabot 面板在受限作用域里执行，最后要 return 一个 React 组件。
// React / h / ui / call / settings / draftSettings / setSettings / save / toast 全部来自参数，不能 import。
// 接口：GET /state；POST /check { id? }、/add { query }、/remove { id }、/search { query }。

const { useState, useEffect, useCallback } = React

const DEFAULTS = {
  enabled: true,
  // active 和 enabled 同步；标签页上的开/关小圆点读的是 active
  active: true,
  intervalMinutes: 60,
  alertDropPercent: 5,
  alertDropAmount: 5,
  alertOnQuality: true,
  maxWatches: 20,
  queryPages: 2,
  // 查价时最多列几条（默认 3），群里不至于一屏几十条
  queryTopN: 3,
  guestQuery: true,
  guestWatch: false,
  alertCooldownMinutes: 180,
  watchTtlDays: 90,
}

const EMPTY_WATCH_TEXT = '还没有监控的商品。点上面的「添加监控」，填商品名就能开始。'
const EMPTY_SEARCH_TEXT = '没找到匹配的商品，换个关键词再试试。'

function numOf (value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function yuan (value) {
  const n = numOf(value)
  if (n === null) return ''
  return '¥' + String(Math.round(n * 100) / 100)
}

// 带「需用券」之类的原文优先，没有原文再用数字价。
function priceOf (row) {
  if (!row) return ''
  const text = row.priceText
  if (typeof text === 'string' && text.trim()) return text.trim()
  return yuan(row.price)
}

function toDate (ts) {
  if (ts === null || ts === undefined || ts === '' || ts === 0 || ts === '0') return null
  const n = Number(ts)
  let d
  if (Number.isFinite(n)) d = new Date(n > 1e9 && n < 1e12 ? n * 1000 : n)
  else d = new Date(ts)
  if (!d || isNaN(d.getTime()) || d.getTime() <= 0) return null
  return d
}

function fmtTime (ts) {
  const d = toDate(ts)
  if (!d) return ''
  try {
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch (err) {
    return ''
  }
}

function windowLabel (w) {
  if (!w) return '全天'
  const s = Number(w.startHour)
  const e = Number(w.endHour)
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return '全天'
  return s + ' 点至 ' + e + ' 点'
}

function qualityName (quality, label) {
  if (label) return label
  if (quality === 'super') return '超级好价'
  if (quality === 'early') return '早期好价'
  return ''
}

return function Panel (props) {
  const given = props || {}
  const notify = typeof given.toast === 'function' ? given.toast : function () {}
  const persist = typeof given.save === 'function' ? given.save : null
  const request = typeof call === 'function'
    ? call
    : function () { return Promise.resolve({ ok: false, message: '接口不可用' }) }
  const editable = typeof given.setSettings === 'function'

  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState('')

  const [addOpen, setAddOpen] = useState(false)
  const [addQuery, setAddQuery] = useState('')
  const [addBusy, setAddBusy] = useState('')
  const [addResult, setAddResult] = useState(null)

  const [searchQuery, setSearchQuery] = useState('')
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchResult, setSearchResult] = useState(null)

  const [askingId, setAskingId] = useState('')
  const [showAllWatches, setShowAllWatches] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [localPatch, setLocalPatch] = useState({})

  const configured = Object.assign({}, DEFAULTS, given.settings || {}, given.draftSettings || {})
  const cfg = editable ? configured : Object.assign({}, configured, localPatch)
  const set = function (key, value, commit) {
    if (editable) {
      given.setSettings({ [key]: value })
      return
    }
    setLocalPatch(function (previous) { return Object.assign({}, previous, { [key]: value }) })
    if (commit !== false && persist) {
      Promise.resolve(persist({ [key]: value })).catch(function (err) {
        notify((err && err.message) || '保存失败', 'err')
      })
    }
  }
  const dirty = editable && Object.keys(Object.assign({}, given.settings || {}, given.draftSettings || {})).some(function (key) {
    return JSON.stringify((given.settings || {})[key]) !== JSON.stringify((given.draftSettings || {})[key])
  })
  const dirtyNote = dirty
    ? h('div', { className: 'ab-note warn' }, '设置改过了还没保存：点页面底部的「保存设置」才会生效。')
    : null

  const enabled = cfg.enabled !== false && cfg.active !== false
  const interval = numOf(cfg.intervalMinutes)
  const dropPercent = numOf(cfg.alertDropPercent) || 0
  const dropAmount = numOf(cfg.alertDropAmount) || 0
  const maxWatches = numOf(cfg.maxWatches)
  const locked = Boolean(busy || addBusy || searchBusy || (state && state.busy))

  const load = useCallback(async function () {
    setLoading(true)
    setLoadError('')
    try {
      const next = await request('/state')
      if (!next || next.ok === false) {
        const msg = (next && next.message) || '接口没有返回数据。'
        setLoadError('读取监控状态失败：' + msg)
        notify(msg, 'err')
        return
      }
      setState(next)
    } catch (err) {
      const msg = '读取监控状态失败：' + ((err && err.message) || String(err))
      setLoadError(msg)
      notify(msg, 'err')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(function () { load() }, [load])

  // 后台正在检查（可能是 QQ 里触发的），几秒刷新一次直到结束。
  const serverBusy = Boolean(state && state.busy)
  useEffect(function () {
    if (!serverBusy) return undefined
    const timer = setInterval(function () { load() }, 3000)
    return function () { clearInterval(timer) }
  }, [serverBusy, load])

  const runAction = async function (kind, path, body) {
    if (locked) return null
    setBusy(kind)
    setActionError('')
    try {
      const result = await request(path, body || {})
      if (!result || result.ok === false) {
        const msg = (result && result.message) || '操作没有成功。'
        setActionError(msg)
        notify(msg, 'err')
        return null
      }
      if (result.message) notify(result.message, 'ok')
      return result
    } catch (err) {
      const msg = (err && err.message) || '请求失败。'
      setActionError(msg)
      notify(msg, 'err')
      return null
    } finally {
      setBusy('')
    }
  }

  const checkAll = async function () {
    const result = await runAction('check', '/check', {})
    if (result) await load()
  }

  const checkOne = async function (id) {
    const result = await runAction('check:' + id, '/check', { id: id })
    if (result) await load()
  }

  const removeWatch = async function (id) {
    const result = await runAction('remove', '/remove', { id: id })
    if (result) {
      setAskingId('')
      await load()
    }
  }

  // articleId 只在「点了某个候选」时才有：带上它才能精确锁定那一条爆料，
  // 不然同一件商品的几条爆料会让用户一直看到「选一个」。
  const submitAdd = async function (query, articleId) {
    const text = String(query === undefined || query === null ? addQuery : query).trim()
    if (!text) {
      setAddResult({ ok: false, message: '先填要监控的商品名。' })
      return
    }
    if (addBusy || busy) return
    setAddBusy('add')
    setAddResult(null)
    setActionError('')
    try {
      const payload = { query: text }
      if (articleId) payload.articleId = String(articleId)
      const result = await request('/add', payload)
      if (!result || result.ok === false) {
        const msg = (result && result.message) || '没能添加，换个关键词试试。'
        setAddResult({ ok: false, message: msg })
        notify(msg, 'err')
        return
      }
      if (result.watch) {
        setAddResult({ ok: true, message: result.message || '已加入监控。' })
        setAddQuery('')
        notify(result.message || '已加入监控', 'ok')
        await load()
        return
      }
      const options = Array.isArray(result.options) ? result.options : []
      if (options.length) {
        setAddResult({ ok: true, message: result.message || '匹配到多个商品，点一个加入监控。', options: options })
        return
      }
      setAddResult({ ok: true, message: result.message || '接口没有返回可用的结果。' })
    } catch (err) {
      const msg = (err && err.message) || '请求失败。'
      setAddResult({ ok: false, message: msg })
      notify(msg, 'err')
    } finally {
      setAddBusy('')
    }
  }

  const submitSearch = async function () {
    const text = String(searchQuery || '').trim()
    if (!text) {
      setSearchResult({ ok: false, message: '先填要查的商品名。' })
      return
    }
    if (searchBusy || busy) return
    setSearchBusy(true)
    setSearchResult(null)
    setActionError('')
    try {
      const result = await request('/search', { query: text })
      if (!result || result.ok === false) {
        const msg = (result && result.message) || '查询没有成功。'
        setSearchResult({ ok: false, message: msg })
        notify(msg, 'err')
        return
      }
      setSearchResult({ ok: true, message: result.message || '', groups: Array.isArray(result.groups) ? result.groups : [] })
    } catch (err) {
      const msg = (err && err.message) || '请求失败。'
      setSearchResult({ ok: false, message: msg })
      notify(msg, 'err')
    } finally {
      setSearchBusy(false)
    }
  }

  const watches = state && Array.isArray(state.watches) ? state.watches : []
  const stats = (state && state.stats) || {}
  const shownWatches = showAllWatches ? watches : watches.slice(0, 6)
  const watchCount = numOf(stats.watches) === null ? watches.length : numOf(stats.watches)
  const alertCount = numOf(stats.alerts) === null ? 0 : numOf(stats.alerts)
  const lastRun = fmtTime(state && state.lastRun)
  const rawResult = String((state && state.lastResult) || '').trim()
  const lastResult = rawResult.length > 40 ? rawResult.slice(0, 40) + '…' : rawResult
  const summary = '监控 ' + watchCount + ' 个' +
    ' · 最近检查 ' + (lastRun || '还没检查过') +
    ' · ' + (serverBusy ? '正在检查…' : lastResult || '还没有结果')

  const qualityBadge = function (quality, label) {
    const name = qualityName(quality, label)
    if (!name) return null
    return h('span', { className: quality === 'super' ? 'ab-badge warn' : 'ab-badge' }, name)
  }

  const numField = function (key, opts) {
    const o = opts || {}
    const value = cfg[key]
    const step = o.step || 1
    const min = numOf(o.min)
    const max = numOf(o.max)
    return h('input', {
      className: 'ab-input sm',
      type: 'number',
      min: o.min,
      max: o.max,
      step: step,
      value: value === null || value === undefined ? '' : value,
      placeholder: o.def === undefined ? '' : String(o.def),
      onChange: function (event) {
        const raw = event.target.value
        set(key, raw === '' ? '' : Number(raw), false)
      },
      onBlur: function (event) {
        const raw = event.target.value
        const n = numOf(raw)
        if (n === null) {
          set(key, o.def === undefined ? 0 : o.def)
          return
        }
        let next = Math.round(n / step) * step
        if (min !== null) next = Math.max(min, next)
        if (max !== null) next = Math.min(max, next)
        set(key, Number(next.toFixed(2)))
      },
    })
  }

  const watchRow = function (watch) {
    const meta = []
    if (watch.mall) meta.push(watch.mall)
    meta.push('当前 ' + (priceOf(watch) || '未知'))
    const lowest = numOf(watch.lowest)
    if (lowest !== null && lowest > 0) meta.push('最低 ' + yuan(lowest) + '（插件记录）')
    meta.push('提醒 ' + (numOf(watch.alerts) || 0) + ' 次')
    const checked = fmtTime(watch.lastCheck)
    const title = watch.title || watch.query || '未命名商品'
    return h('div', { key: watch.id, className: 'ab-li' },
      h('div', { className: 'body' },
        h('div', { className: 'ab-flex', style: { gap: 8 } },
          watch.url
            ? h('a', { href: watch.url, target: '_blank', rel: 'noreferrer' }, title)
            : h('b', null, title),
          qualityBadge(watch.quality, watch.qualityLabel)),
        h('div', { className: 'ab-small ab-muted' }, meta.join(' · ')),
        h('div', { className: 'ab-small ab-muted' }, checked ? '最近检查 ' + checked : '还没检查过'),
        askingId === watch.id
          ? h('div', { className: 'ab-flex', style: { marginTop: 6 } },
            h('span', { className: 'ab-small' }, '删除后不再检查这个商品，确定吗？'),
            h(ui.Btn, {
              small: true,
              kind: 'danger',
              disabled: locked,
              onClick: function () { removeWatch(watch.id) },
            }, busy === 'remove' ? '删除中…' : '确认删除'),
            h(ui.Btn, { small: true, kind: 'ghost', onClick: function () { setAskingId('') } }, '取消'))
          : null),
      h('div', { className: 'ab-flex', style: { flexWrap: 'nowrap' } },
        h(ui.Btn, {
          small: true,
          disabled: locked,
          onClick: function () { checkOne(watch.id) },
        }, busy === 'check:' + watch.id ? '检查中…' : '检查'),
        h(ui.Btn, {
          small: true,
          kind: 'ghost',
          disabled: locked || askingId === watch.id,
          onClick: function () { setAskingId(watch.id) },
        }, '删除')))
  }

  const renderGroup = function (group, index) {
    const items = Array.isArray(group.items) ? group.items.slice() : []
    const sorted = items.slice().sort(function (a, b) {
      const pa = numOf(a.price)
      const pb = numOf(b.price)
      if (pa === null && pb === null) return 0
      if (pa === null) return 1
      if (pb === null) return -1
      return pa - pb
    })
    const prices = sorted.map(function (item) { return numOf(item.price) }).filter(function (n) { return n !== null })
    const minPrice = prices.length ? Math.min.apply(null, prices) : null
    return h('div', { key: 'g' + index, className: 'ab-grid', style: { gap: 6 } },
      h('div', { className: 'ab-flex' },
        h('b', null, group.mall || '未标平台'),
        h('span', { className: 'ab-small ab-muted' }, sorted.length + ' 件')),
      h('div', { className: 'ab-list' }, sorted.map(function (item, i) {
        const price = numOf(item.price)
        const isMin = item.isLowest === true || (minPrice !== null && price !== null && price === minPrice)
        const heat = numOf(item.points)
        return h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'body' },
            item.url
              ? h('a', { href: item.url, target: '_blank', rel: 'noreferrer' }, item.title || '未命名商品')
              : h('span', null, item.title || '未命名商品'),
            h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 2 } },
              h('b', null, priceOf(item) || '价格未知'),
              qualityBadge(item.quality, item.qualityLabel),
              isMin ? h('span', { className: 'ab-badge', style: { background: 'var(--ab-ok)' } }, '最低价') : null,
              heat !== null && heat > 0 ? h('span', { className: 'ab-small ab-muted' }, '热度 ' + heat) : null)))
      })))
  }

  const renderSearchResult = function (result) {
    if (!result.ok) {
      return h('div', { className: 'ab-note err', style: { marginTop: 10 } }, result.message || '查询没有成功。')
    }
    const rawGroups = Array.isArray(result.groups) ? result.groups : []
    const groups = rawGroups.filter(function (group) {
      return group && Array.isArray(group.items) && group.items.length > 0
    })
    if (!groups.length) {
      return h('div', { className: 'ab-note', style: { marginTop: 10 } },
        rawGroups.length ? '这次各平台都没有在售结果，过会儿再查。' : (result.message || EMPTY_SEARCH_TEXT))
    }
    return h('div', { className: 'ab-grid', style: { gap: 12, marginTop: 10 } }, groups.map(renderGroup))
  }

  const addBlock = h('div', {
    className: 'ab-grid',
    style: { gap: 8, marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--ab-line)' },
  },
  h('div', { className: 'ab-flex' },
    h('input', {
      className: 'ab-input',
      style: { flex: 1, minWidth: 200 },
      placeholder: '商品名或链接，例如：红米 K80 12+256',
      value: addQuery,
      disabled: Boolean(addBusy),
      onChange: function (event) { setAddQuery(event.target.value) },
      onKeyDown: function (event) { if (event.key === 'Enter') submitAdd() },
    }),
    h(ui.Btn, {
      small: true,
      kind: 'primary',
      disabled: Boolean(addBusy) || locked || !String(addQuery).trim(),
      onClick: function () { submitAdd() },
    }, addBusy ? '添加中…' : '加入监控')),
  addResult && addResult.message
    ? h('div', { className: addResult.ok ? 'ab-note' : 'ab-note err' }, addResult.message)
    : null,
  addResult && addResult.options && addResult.options.length
    ? h('div', { className: 'ab-plist' }, addResult.options.map(function (option, i) {
      return h('button', {
        key: i,
        type: 'button',
        className: 'ab-pitem',
        disabled: Boolean(addBusy),
        title: option.title || '',
        onClick: function () { submitAdd(option.title, option.articleId) },
      },
      h('div', { className: 'nm' }, option.title || '未命名商品'),
      h('div', { className: 'tg' }, (option.mall || '平台未知') + (priceOf(option) ? ' · ' + priceOf(option) : '')))
    }))
    : null)

  const settingsForm = h('div', null,
    !editable
      ? h('p', { className: 'ab-note' }, '当前面板没有草稿接口，改动会直接保存到这一项。')
      : null,
    h(ui.Row, { label: '检查间隔', hint: '多久检查一次；这里改了以后以这里为准' },
      numField('intervalMinutes', { min: 5, max: 1440, step: 5, def: 60 }),
      h('span', { className: 'ab-muted' }, '分钟')),
    h(ui.Row, { label: '降价百分比', hint: '比上次记录低超过这个比例就提醒；0 = 不看比例' },
      numField('alertDropPercent', { min: 0, max: 100, step: 1, def: 5 }),
      h('span', { className: 'ab-muted' }, '%')),
    h(ui.Row, { label: '降价金额', hint: '比上次记录低超过这个金额也提醒；0 = 不看金额' },
      numField('alertDropAmount', { min: 0, max: 100000, step: 1, def: 5 }),
      h('span', { className: 'ab-muted' }, '元')),
    h(ui.Row, { label: '好价也提醒', hint: '命中超级好价 / 早期好价时，就算没降价也提醒' },
      h(ui.Switch, { on: Boolean(cfg.alertOnQuality), onChange: function (value) { set('alertOnQuality', value) } })),
    h(ui.Row, { label: '提醒时 @ 发起人', hint: '群聊里提醒会 @ 添加这条监控的人，方便他收到' },
      h(ui.Switch, { on: cfg.alertMentionOwner !== false, onChange: function (value) { set('alertMentionOwner', value) } })),
    h(ui.Row, { label: '监控时段', hint: '北京时间整点，只在时段内自动检查；开始 = 结束表示全天，开始大于结束表示跨午夜' },
      numField('checkStartHour', { min: 0, max: 23, step: 1, def: 0 }),
      h('span', { className: 'ab-muted' }, '点 至'),
      numField('checkEndHour', { min: 0, max: 23, step: 1, def: 0 }),
      h('span', { className: 'ab-muted' }, '点'),
      state && state.window ? h('span', { className: 'ab-muted ab-small' }, '（当前时段：' + windowLabel(state.window) + '）') : null),
    h(ui.Row, { label: '每轮最多查几个', hint: '控制每轮的请求量和提醒条数，避免一晚上刷出一堆消息' },
      numField('maxChecksPerRun', { min: 1, max: 50, step: 1, def: 5 }),
      h('span', { className: 'ab-muted' }, '个')),
    h(ui.Row, { label: '群聊白名单', hint: '打开时，只有下面列出的群能用这个插件（默认打开）' },
      h(ui.Switch, { on: cfg.groupWhitelist !== false, onChange: function (value) { set('groupWhitelist', value) } })),
    h(ui.Row, { label: '允许的群', hint: '一行一个群号，也可用逗号分隔；改了记得点底部「保存设置」' },
      h('textarea', {
        className: 'ab-textarea',
        rows: 3,
        value: cfg.whitelistGroups || '',
        placeholder: '一行一个群号，例如\n700001\n700002',
        onChange: function (e) { set('whitelistGroups', e.target.value) },
      })),
    h(ui.Row, { label: '最多监控', hint: '超过这个数量就不再接受新的监控' },
      numField('maxWatches', { min: 1, max: 200, step: 1, def: 20 }),
      h('span', { className: 'ab-muted' }, '个')),
    h(ui.Row, { label: '查询页数', hint: '每次拉几页列表，越多越慢也越全' },
      numField('queryPages', { min: 1, max: 10, step: 1, def: 2 }),
      h('span', { className: 'ab-muted' }, '页')),
    h(ui.Row, { label: '查询价格显示条数', hint: '查价时最多列几条最便宜的（默认 3）；群里刷屏就调小' },
      numField('queryTopN', { min: 1, max: 20, step: 1, def: 3 }),
      h('span', { className: 'ab-muted' }, '条')),
    h('details', null,
      h('summary', { className: 'ab-small ab-muted', style: { cursor: 'pointer', marginTop: 4 } }, '更多设置'),
      h('div', { style: { marginTop: 4 } },
        h(ui.Row, { label: '提醒冷却', hint: '同一个商品两次提醒至少隔这么久' },
          numField('alertCooldownMinutes', { min: 5, max: 1440, step: 5, def: 180 }),
          h('span', { className: 'ab-muted' }, '分钟')),
        h(ui.Row, { label: '监控保留天数', hint: '太久没动静的监控自动清理；0 = 不清理' },
          numField('watchTtlDays', { min: 0, max: 3650, step: 1, def: 90 }),
          h('span', { className: 'ab-muted' }, '天')),
        h(ui.Row, { label: '访客查价格', hint: '别人在群里能不能查价格' },
          h(ui.Switch, { on: cfg.guestQuery !== false, onChange: function (value) { set('guestQuery', value) } })),
        h(ui.Row, { label: '访客加监控', hint: '别人在群里能不能加监控' },
          h(ui.Switch, { on: Boolean(cfg.guestWatch), onChange: function (value) { set('guestWatch', value) } })))))

  if (!state && loading) {
    return h(ui.Card, { title: '价格监控' }, h(ui.Empty, { icon: '⏳', text: '正在读取监控状态…' }))
  }

  if (!state) {
    return h(ui.Card, { title: '价格监控' },
      h('div', { className: 'ab-note err' }, loadError || '读取不到监控状态。'),
      h('div', { className: 'ab-flex', style: { marginTop: 8 } },
        h(ui.Btn, { small: true, onClick: function () { load() } }, '重试')))
  }

  const topCard = h(ui.Card, {
    title: '价格监控',
    desc: summary,
    right: h(ui.Switch, {
      on: enabled,
      title: '价格监控总开关；关掉后不再定时检查、也不再提醒，监控列表保留',
      // 两个键一起写：enabled 给逻辑用，active 给标签页圆点用
      onChange: function (value) { set('enabled', value); set('active', value) },
    }),
  },
  h('div', { className: 'ab-flex', style: { marginTop: 2 } },
    h(ui.Btn, {
      small: true,
      kind: 'primary',
      disabled: locked || !enabled,
      onClick: checkAll,
    }, serverBusy || busy === 'check' ? '检查中…' : '立即检查'),
    h(ui.Btn, {
      small: true,
      disabled: locked,
      onClick: function () { setAddOpen(function (previous) { return !previous }) },
    }, addOpen ? '收起添加' : '添加监控')),
  !enabled ? h('div', { className: 'ab-note warn' }, '总开关关着：不会定时检查，也不会有新提醒。') : null,
  loadError ? h('div', { className: 'ab-note err' }, loadError) : null,
  actionError ? h('div', { className: 'ab-note err' }, actionError) : null,
  dirtyNote,
  addOpen ? addBlock : null)

  const listCard = h(ui.Card, {
    title: '监控中（' + watches.length + '）',
    desc: watches.length
      ? '「最低」是插件自己见过的价格，点商品名可以打开原页' + (alertCount > 0 ? '；一共提醒过 ' + alertCount + ' 次。' : '。')
      : null,
  },
  watches.length === 0
    ? h(ui.Empty, { icon: '🛒', text: EMPTY_WATCH_TEXT })
    : h('div', null,
      h('div', { className: 'ab-list' }, shownWatches.map(watchRow)),
      watches.length > 6
        ? h('div', { className: 'ab-flex', style: { marginTop: 8 } },
          h(ui.Btn, {
            small: true,
            kind: 'ghost',
            onClick: function () { setShowAllWatches(function (previous) { return !previous }) },
          }, showAllWatches ? '只看最近 6 个' : '显示全部 ' + watches.length + ' 个'))
        : null))

  const searchCard = h(ui.Card, {
    title: '查询价格',
    desc: '查一下当前在售的价格：先按价格从低到高列出最便宜的几条，再按平台分组（每组最多 ' + (numOf(cfg.queryTopN) || 3) + ' 条）。',
  },
  h('div', { className: 'ab-flex' },
    h('input', {
      className: 'ab-input',
      style: { flex: 1, minWidth: 200 },
      placeholder: '商品名，例如：红米 K80',
      value: searchQuery,
      onChange: function (event) { setSearchQuery(event.target.value) },
      onKeyDown: function (event) { if (event.key === 'Enter') submitSearch() },
    }),
    h(ui.Btn, {
      small: true,
      kind: 'primary',
      disabled: searchBusy || locked || !String(searchQuery).trim(),
      onClick: submitSearch,
    }, searchBusy ? '查询中…' : '查价格')),
  searchResult ? renderSearchResult(searchResult) : null)

  const settingsCard = h(ui.Card, {
    title: '监控设置',
    desc: '每 ' + (interval === null ? 60 : interval) + ' 分钟检查 · 降价 ' + dropPercent + '% 或 ' + dropAmount + ' 元提醒' +
      (cfg.alertOnQuality !== false ? ' · 好价也提醒' : '') +
      ' · 最多 ' + (maxWatches === null ? 20 : maxWatches) + ' 个',
    right: h(ui.Btn, {
      small: true,
      kind: 'ghost',
      onClick: function () { setSettingsOpen(function (previous) { return !previous }) },
    }, settingsOpen ? '收起' : '展开编辑'),
  },
  settingsOpen
    ? settingsForm
    : h('div', { className: 'ab-small ab-muted' }, '点右上角「展开编辑」可以改检查间隔、降价阈值和数量上限。'))

  return h('div', { className: 'ab-grid' },
    topCard,
    listCard,
    searchCard,
    settingsCard)
}
