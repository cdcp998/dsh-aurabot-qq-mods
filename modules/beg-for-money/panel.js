// 讨饭面板：今日 / 累计数字、收款码状态、待确认记账（可直接确认 / 不记）、最近账本。
// 这段代码是函数体，由 Aurabot 面板在受限作用域里执行，最后要 return 一个 React 组件。
// React / h / ui / call / settings / draftSettings / setSettings / save / toast 全部来自参数，不能 import。
// 接口：/state（GET）、/approve（POST { id, approve }）、/beg（GET）。

const { useState, useEffect, useCallback } = React

function numOf (value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function money (value, unit) {
  const n = numOf(value)
  if (n === null) return '—'
  return n.toFixed(2) + (unit || '元')
}

function clock (ts) {
  const n = numOf(ts)
  if (n === null || n <= 0) return ''
  const d = new Date(n)
  const pad = function (x) { return String(x).padStart(2, '0') }
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

return function Panel (props) {
  const given = props || {}
  const notify = typeof given.toast === 'function' ? given.toast : function () {}
  const request = typeof call === 'function' ? call : function () { return Promise.resolve({ ok: false, message: '接口不可用' }) }

  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(async function () {
    setLoading(true)
    setError('')
    try {
      const next = await request('/state')
      if (!next || next.ok === false) {
        const msg = (next && next.message) || '接口没有返回数据。'
        setError('读取账本失败：' + msg)
        notify(msg)
        return
      }
      setState(next)
    } catch (err) {
      const msg = '读取账本失败：' + ((err && err.message) || String(err))
      setError(msg)
      notify(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(function () { load() }, [load])

  const act = async function (path, body, label) {
    setBusy(label)
    try {
      const r = await request(path, body)
      notify((r && r.message) || (r && r.ok ? '好了' : '没成功'), r && r.ok === false ? 'err' : 'ok')
      await load()
      return r
    } catch (err) {
      notify((err && err.message) || '请求失败', 'err')
      return null
    } finally {
      setBusy('')
    }
  }

  if (loading && !state) return h(ui.Empty, { icon: '⏳', text: '读取账本…' })
  if (!state) return h('div', { className: 'ab-note err' }, error || '读不到账本。')

  // 总开关在标签页标题栏（宿主按 defaults.enabled 自动渲染），面板里不再放一个，免得同一个地方两个开关。
  // 这里只用它的状态给一句说明。
  const enabled = state.enabled !== false

  const unit = state.currency || '元'
  const today = state.today || {}
  const recent = state.recent || {}
  const qr = state.qr || {}
  const approvals = Array.isArray(state.approvals) ? state.approvals : []
  const rows = Array.isArray(state.rows) ? state.rows : []
  const buckets = Array.isArray(recent.buckets) ? recent.buckets : []
  const pendingThanks = Array.isArray(state.pendingThanks) ? state.pendingThanks : []
  const q = String(query || '').trim().toLowerCase()
  const shown = showAll ? rows : rows.slice(0, 30)
  const filtered = q
    ? shown.filter(function (row) {
      const hay = [row.note, row.group, row.payer, row.date, row.source].join(' ').toLowerCase()
      return hay.indexOf(q) >= 0
    })
    : shown

  function metric (label, value, count) {
    return h('div', { key: label },
      h('div', { className: 'ab-small ab-muted' }, label),
      h('b', null, value),
      h('span', { className: 'ab-muted' }, ' · ' + count + ' 笔'))
  }

  // 收款码可以配多张（一行一个路径）。这里列清楚「几张可用、哪张找不到」，
  // 别只报一个总数让主人猜。
  const qrItems = Array.isArray(qr.items) ? qr.items : []
  const qrMissing = Array.isArray(qr.missing) ? qr.missing : []
  let qrText
  if (!qr.configured) qrText = '还没填路径，讨饭命令会直接回失败'
  else if (!qr.available) qrText = qr.message || '收款码图片找不到，发不了。'
  else if (qrItems.length > 1) qrText = '可用 ' + qrItems.length + ' 张，按顺序轮着发'
  else qrText = '可用：' + ((qrItems[0] && qrItems[0].path) || qr.path || '')

  function approvalRow (rec) {
    return h('div', { key: rec.id, className: 'ab-li' },
      h('div', { className: 'meta' }, '#' + rec.id, h('br'), clock(rec.created)),
      h('div', { className: 'body' },
        h('b', null, money(rec.amount, unit)), ' — ', rec.groupName || '未知', ' / ', rec.requester,
        rec.note ? h('div', { className: 'ab-muted ab-small' }, rec.note) : null,
        h('div', { className: 'ab-flex', style: { marginTop: 6 } },
          h(ui.Btn, {
            small: true,
            disabled: Boolean(busy),
            onClick: function () { act('/approve', { id: rec.id, approve: true }, 'ok-' + rec.id) },
          }, busy === 'ok-' + rec.id ? '确认中…' : '确认记账'),
          h(ui.Btn, {
            small: true,
            disabled: Boolean(busy),
            onClick: function () { act('/approve', { id: rec.id, approve: false }, 'no-' + rec.id) },
          }, busy === 'no-' + rec.id ? '处理中…' : '不记'))))
  }

  function ledgerRow (row, i) {
    return h('div', { key: row.date + '-' + row.time + '-' + i, className: 'ab-li' },
      h('div', { className: 'meta' }, row.date, h('br'), row.time),
      h('div', { className: 'body' },
        h('b', null, money(row.amount, unit)),
        h('span', { className: 'ab-muted ab-small' },
          ' · ' + (row.group || '—') + (row.payer ? ' / ' + row.payer : '') + (row.source ? ' · ' + row.source : '')),
        row.note ? h('div', { className: 'ab-muted' }, row.note) : null))
  }

  const children = []

  children.push(h(ui.Card, {
    key: 'head',
    title: '打赏',
    desc: (state.ledgerEnabled ? '账本记在 ' : '记账已关闭；文件在 ') + String(state.ledgerFile || ''),
    right: h(ui.Btn, { small: true, disabled: Boolean(busy), title: '刷新', onClick: load }, busy === 'load' ? '刷新中…' : '↻'),
  }))

  if (!enabled) {
    children.push(h('div', { key: 'off', className: 'ab-note warn' },
      '讨饭关着（标签页标题栏的开关）：命令、她自己的工具、自动道谢都不会动。账本和待确认记录还在，打开就恢复。'))
  }

  if (state.ledgerBroken) {
    children.push(h('div', { key: 'broken', className: 'ab-note err' },
      '账本文件损坏，已停止写入（避免用空账本覆盖历史）。先修好 ledger.json，再在「扩展」页重新加载这个模块。'))
  }

  children.push(h('div', { key: 'metrics', className: 'ab-flex' },
    metric('今天 ' + (today.date || ''), money(today.total, unit), numOf(today.count) || 0),
    metric('最近 ' + (numOf(recent.days) || 0) + ' 天', money(recent.total, unit), numOf(recent.count) || 0),
    metric('累计', money(state.grandTotal, unit), numOf(state.accounts) || 0)))

  children.push(buckets.length
    ? h('div', { key: 'buckets', className: 'ab-note ab-small' }, '有记录的日子：' + buckets.map(function (b) {
      return b.date.slice(5) + ' ' + b.count + ' 笔 ' + money(b.total, unit)
    }).join('、'))
    : h('div', { key: 'buckets', className: 'ab-note ab-small' }, '最近没有打赏记录。'))

  children.push(h(ui.Card, { key: 'switches', title: '收款码与开关', desc: '这些是这一轮实际生效的状态；改设置请在上面表单里改完点「保存设置」。' },
    h(ui.Row, { label: '收款码' }, h('span', { className: qr.available ? 'ab-note' : 'ab-note err' }, qrText)),
    qrItems.length
      ? h('div', { className: 'ab-muted ab-small', style: { marginTop: -4 } }, qrItems.map(function (item, i) {
        return h('div', { key: item.path + i }, (i + 1) + '. ' + item.path)
      }))
      : null,
    qrMissing.length
      ? h('div', { className: 'ab-note err ab-small' }, '找不到：' + qrMissing.join('；'))
      : null,
    h(ui.Row, { label: '记账审批' }, h('span', { className: 'ab-note' },
      state.requireApproval ? '群友触发的记账要管理员私聊 /确认 才落账' : '关着：谁触发都直接落账')),
    h(ui.Row, { label: '管理员' }, h('span', { className: 'ab-note' },
      (Array.isArray(state.admins) && state.admins.length)
        ? state.admins.join('、') + (state.adminOnly ? '（命令仅管理员）' : '')
        : '只有主人')),
    h(ui.Row, { label: '印象卡片联动' }, h('span', { className: state.linkImpressionCard && state.impressionCard ? 'ab-note' : 'ab-muted' },
      !state.linkImpressionCard
        ? '已关闭'
        : (state.impressionCard ? '记账生效后给打赏的人加「慷慨」' : '印象卡片没在跑，记账照常，只是不加分'))),
    h(ui.Row, { label: '道谢窗口' }, h('span', { className: 'ab-muted ab-small' },
      (numOf(state.thanksWindowSeconds) || 0) + ' 秒' +
      (pendingThanks.length ? '；正在等道谢：' + pendingThanks.join('、') : '；当前没有等待道谢的会话'))),
    h('div', { className: 'ab-flex', style: { marginTop: 8 } },
      h(ui.Btn, {
        disabled: Boolean(busy) || !state.enabled,
        onClick: function () { act('/beg', undefined, 'beg') },
      }, busy === 'beg' ? '发送中…' : '往主人私聊试发一张'),
      h(ui.Btn, { disabled: Boolean(busy), onClick: load }, '刷新'))))

  children.push(h(ui.Card, { key: 'approvals', title: '待确认的记账（' + approvals.length + '）', desc: '确认后真正落账、在原群道谢，并在装了印象卡片时加「慷慨」。' },
    approvals.length
      ? h('div', { className: 'ab-list' }, approvals.map(approvalRow))
      : h(ui.Empty, { icon: '📭', text: '没有待确认的记账。群友说「我转了 15」时才会出现。' })))

  const ledgerBody = rows.length
    ? h('div', null,
      h('div', { className: 'ab-flex', style: { marginBottom: 8 } },
        h('input', {
          className: 'ab-input',
          placeholder: '按备注 / 群 / 打赏人 / 日期筛选',
          value: query,
          onChange: function (e) { setQuery(e.target.value) },
        }),
        h(ui.Btn, { small: true, onClick: function () { setShowAll(!showAll) } },
          showAll ? '只看最近 30 笔' : '显示全部（最多 200）')),
      filtered.length
        ? h('div', { className: 'ab-list' }, filtered.map(ledgerRow))
        : h(ui.Empty, { icon: '🔍', text: '没有匹配的记录。' }))
    : h(ui.Empty, { icon: '🧾', text: '账本还是空的。发 /打赏 15 或者对着收款码收到钱后记一笔。' })

  children.push(h(ui.Card, { key: 'ledger', title: '最近的账（' + rows.length + '）', desc: '最多显示最近 200 笔，倒序。' }, ledgerBody))

  return h('div', { className: 'ab-grid' }, children)
}
