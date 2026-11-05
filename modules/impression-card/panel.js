// 印象卡片的自定义面板：人物列表 + 选中详情 + 卡片预览 + 刷新 / 加减分 / 删除。
// 这段代码是函数体，由 Aurabot 面板在受限作用域里执行，最后要 return 一个 React 组件。
// React / h / ui / call / settings / draftSettings / setSettings / save / toast 全部来自参数，不能 import。
// 接口（都用 call(路径, 请求体?) 调）：/state /card.png /render /refresh /adjust /delete /send。

const { useState, useEffect, useMemo, useCallback } = React

const CARD_BASE = '/aurabot/api/ext/impression-card'
const CARD_URL = CARD_BASE + '/card.png'
const EMPTY_LIST_TEXT = '还没有任何档案。去 QQ 里发 /卡片 就会开始记。'
const NO_MATCH_TEXT = '没有匹配的档案'

function toNum (value) {
  if (value === '' || value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function fmt1 (value) {
  const n = toNum(value)
  return n === null ? '—' : n.toFixed(1)
}

function fmtDelta (value) {
  const n = toNum(value)
  if (n === null) return '—'
  return (n > 0 ? '+' : '') + n.toFixed(1)
}

function fmtTime (ts) {
  const n = toNum(ts)
  if (n === null || n <= 0) return '尚未更新'
  const d = new Date(n)
  const pad = (x) => String(x).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

// 量程只影响显示，分数可以越界：越界时进度条贴边，数字仍显示真实值。
function barPercent (value, min, max) {
  const v = toNum(value)
  const lo = toNum(min)
  const hi = toNum(max)
  if (v === null) return 0
  if (lo === null || hi === null || !(hi > lo)) return 50
  return Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100))
}

// 语义色用面板主题变量，不写死配色。
function barTone (percent) {
  if (percent >= 70) return 'var(--ab-ok)'
  if (percent >= 45) return 'var(--ab-sea)'
  if (percent >= 25) return 'var(--ab-warn)'
  return 'var(--ab-err)'
}

function dimLabelOf (cfg, key) {
  const k = String(key || '')
  if (!k) return '—'
  if (k === 'total') return (cfg && cfg.totalLabel) || '好感度'
  const dims = cfg && Array.isArray(cfg.dimensions) ? cfg.dimensions : []
  const hit = dims.find((dim) => dim && dim.key === k)
  return hit ? hit.label || k : k
}

function valueOfDim (person, cfg, key) {
  if (!person) return null
  if (key === 'total') return toNum(person.total)
  const dims = Array.isArray(person.dims) ? person.dims : []
  const hit = dims.find((dim) => dim && dim.key === key)
  return hit ? toNum(hit.value) : null
}

return function Panel (props) {
  const given = props || {}
  const notify = typeof given.toast === 'function' ? given.toast : typeof toast === 'function' ? toast : function () {}
  const request = typeof call === 'function' ? call : function () { return Promise.resolve({ ok: false, message: '接口不可用' }) }

  const [state, setState] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [imgError, setImgError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [adjustError, setAdjustError] = useState('')
  const [askingDelete, setAskingDelete] = useState(false)
  const [helpText, setHelpText] = useState('')
  const [helpError, setHelpError] = useState('')
  const [helpLoading, setHelpLoading] = useState(false)
  const [showAllDims, setShowAllDims] = useState(false)
  const [adjustDim, setAdjustDim] = useState('total')
  const [adjustValue, setAdjustValue] = useState('1')
  const [adjustMode, setAdjustMode] = useState('add')
  const [adjustReason, setAdjustReason] = useState('')
  const [rev, setRev] = useState(function () { return Date.now() })

  const load = useCallback(async function () {
    setLoading(true)
    setLoadError('')
    try {
      const next = await request('/state')
      if (!next || next.ok === false) {
        const msg = (next && next.message) || '接口没有返回有效的档案数据。'
        setLoadError('读取档案失败：' + msg)
        notify(msg)
        return
      }
      setState(next)
      // 每次列表刷新都换一张卡的缓存戳，避免还显示旧图
      setPreview(null)
      setRev(Date.now())
      const list = Array.isArray(next.persons) ? next.persons : []
      setSelectedId(function (prev) {
        if (prev && list.some(function (person) { return person.id === prev })) return prev
        return list.length ? list[0].id : ''
      })
    } catch (error) {
      const msg = '读取档案失败：' + ((error && error.message) || String(error))
      setLoadError(msg)
      notify(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(function () { load() }, [load])

  const persons = useMemo(function () {
    return state && Array.isArray(state.persons) ? state.persons : []
  }, [state])
  const cfg = useMemo(function () { return (state && state.settings) || {} }, [state])
  const filtered = useMemo(function () {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return persons
    return persons.filter(function (person) {
      const name = String(person.name || '').toLowerCase()
      const uid = String(person.userId || '').toLowerCase()
      return name.indexOf(q) >= 0 || uid.indexOf(q) >= 0
    })
  }, [persons, query])
  const selected = useMemo(function () {
    return persons.find(function (person) { return person.id === selectedId }) || null
  }, [persons, selectedId])
  const dims = useMemo(function () {
    const list = selected && Array.isArray(selected.dims) ? selected.dims.slice() : []
    return list.sort(function (a, b) { return (toNum(b.value) || 0) - (toNum(a.value) || 0) })
  }, [selected])
  const radarTop = useMemo(function () {
    const raw = Math.round(toNum(cfg.radarTopN) || 0)
    if (raw > 0) return raw
    return dims.length || 1
  }, [cfg, dims])
  const dimOptions = useMemo(function () {
    const list = [{ value: 'total', label: cfg.totalLabel || '好感度' }]
    const source = Array.isArray(cfg.dimensions) ? cfg.dimensions : []
    for (const dim of source) {
      if (dim && dim.key && dim.key !== 'total') list.push({ value: dim.key, label: dim.label || dim.key })
    }
    return list
  }, [cfg])

  const sharpReady = state ? state.sharpReady !== false : false
  const stats = (state && state.stats) || {}
  const statPersons = toNum(stats.persons) === null ? persons.length : toNum(stats.persons)
  const statAvg = toNum(stats.avgTotal) === null ? '—' : toNum(stats.avgTotal).toFixed(1)
  const statDescribed = toNum(stats.described) === null
    ? persons.filter(function (person) { return person.described }).length
    : toNum(stats.described)
  const activeDim = dimOptions.some(function (opt) { return opt.value === adjustDim }) ? adjustDim : 'total'
  const shownDims = showAllDims ? dims : dims.slice(0, radarTop)
  const cardSrc = selected
    ? (preview && preview.id === selected.id
        ? preview.url
        : CARD_URL + '?person=' + encodeURIComponent(selected.id) + '&radar=' + radarTop + '&t=' + rev)
    : ''

  const selectPerson = function (id) {
    setSelectedId(id)
    setPreview(null)
    setImgError('')
    setPreviewError('')
    setAdjustError('')
    setAskingDelete(false)
    setShowAllDims(false)
    setAdjustDim('total')
    setAdjustValue('1')
    setAdjustMode('add')
    setAdjustReason('')
  }

  const renderCard = async function () {
    if (!selected || busy) return
    setBusy('render')
    setPreviewError('')
    setImgError('')
    try {
      const result = await request('/render', { personId: selected.id, radarTopN: radarTop })
      if (!result || result.ok !== true) {
        const reason = (result && result.message) || '接口没有说明原因。'
        setPreviewError('重新渲染失败：' + reason)
        notify(reason)
        return
      }
      setPreview({ id: selected.id, url: result.url || CARD_URL + '?person=' + encodeURIComponent(selected.id) + '&radar=' + radarTop + '&t=' + Date.now() })
      notify('卡片已重新渲染')
    } catch (error) {
      const msg = '重新渲染失败：' + ((error && error.message) || String(error))
      setPreviewError(msg)
      notify(msg)
    } finally {
      setBusy('')
    }
  }

  const refreshImpression = async function () {
    if (!selected || busy) return
    setBusy('refresh')
    setPreviewError('')
    setImgError('')
    try {
      const result = await request('/refresh', { personId: selected.id })
      if (!result || result.ok !== true) {
        const reason = (result && result.message) || '接口没有说明原因。'
        setPreviewError('刷新印象失败：' + reason)
        notify(reason)
        return
      }
      notify(result.message || '已刷新印象')
      await load()
    } catch (error) {
      const msg = '刷新印象失败：' + ((error && error.message) || String(error))
      setPreviewError(msg)
      notify(msg)
    } finally {
      setBusy('')
    }
  }

  const applyAdjust = async function () {
    if (!selected || busy) return
    const raw = String(adjustValue === undefined || adjustValue === null ? '' : adjustValue).trim()
    if (!raw) {
      setAdjustError('先填一个数字。')
      notify('先填一个数字')
      return
    }
    const value = toNum(raw)
    if (value === null) {
      setAdjustError('数值不是数字。')
      notify('数值不是数字')
      return
    }
    setBusy('adjust')
    setAdjustError('')
    try {
      const result = await request('/adjust', {
        personId: selected.id,
        dimension: activeDim,
        value: value,
        mode: adjustMode,
        reason: String(adjustReason || '').trim(),
      })
      if (!result || result.ok !== true) {
        const reason = (result && result.message) || '接口没有说明原因。'
        setAdjustError('调整失败：' + reason)
        notify(reason)
        return
      }
      notify(result.message || '已更新')
      setAdjustReason('')
      await load()
    } catch (error) {
      const msg = '调整失败：' + ((error && error.message) || String(error))
      setAdjustError(msg)
      notify(msg)
    } finally {
      setBusy('')
    }
  }

  const deletePerson = async function () {
    if (!selected || busy) return
    setBusy('delete')
    setPreviewError('')
    try {
      const result = await request('/delete', { personId: selected.id })
      if (!result || result.ok !== true) {
        const reason = (result && result.message) || '接口没有说明原因。'
        setPreviewError('删除失败：' + reason)
        notify(reason)
        return
      }
      notify(result.message || '已删除')
      setAskingDelete(false)
      await load()
    } catch (error) {
      const msg = '删除失败：' + ((error && error.message) || String(error))
      setPreviewError(msg)
      notify(msg)
    } finally {
      setBusy('')
    }
  }

  const sendCard = async function () {
    if (!selected || busy) return
    setBusy('send')
    setPreviewError('')
    try {
      const result = await request('/send', { personId: selected.id, radarTopN: radarTop })
      const message = (result && result.message) || ''
      if (!result || result.ok !== true) {
        const reason = message || '发送失败。'
        setPreviewError('发送失败：' + reason)
        notify(reason)
        return
      }
      notify(message || '已发到最近的聊天')
    } catch (error) {
      const msg = '发送失败：' + ((error && error.message) || String(error))
      setPreviewError(msg)
      notify(msg)
    } finally {
      setBusy('')
    }
  }

  const loadHelp = async function () {
    if (helpLoading) return
    setHelpLoading(true)
    setHelpError('')
    try {
      const result = await request('/help')
      if (!result || result.ok !== true) {
        setHelpError('读命令说明失败：' + ((result && result.message) || '接口没有说明原因。'))
        return
      }
      setHelpText(String(result.text || ''))
    } catch (error) {
      setHelpError('读命令说明失败：' + ((error && error.message) || String(error)))
    } finally {
      setHelpLoading(false)
    }
  }

  if (!state) {
    return h('div', { className: 'ab-grid' },
      h(ui.Card, { title: '印象档案' },
        loadError
          ? h('div', { className: 'ab-grid' },
            h('div', { className: 'ab-note err' }, loadError),
            h('div', { className: 'ab-flex' }, h(ui.Btn, { small: true, onClick: load }, '重试')))
          : h(ui.Empty, { icon: '⏳', text: '正在读取档案…' })))
  }

  const statItem = function (label, value) {
    return h('div', { key: label, style: { minWidth: 96 } },
      h('div', { className: 'ab-small ab-muted' }, label),
      h('div', { style: { fontSize: 22, fontWeight: 650, lineHeight: 1.35, fontVariantNumeric: 'tabular-nums' } }, value))
  }

  const settingsLine = '设置项在这个页面下方（「人设」页里的自动表单）。这里是只读预览：主题「' + (cfg.themeLabel || cfg.theme || '默认') +
    '」· 雷达 ' + radarTop + ' 项 · 量程 ' + fmt1(cfg.scaleMin) + ' ～ ' + fmt1(cfg.scaleMax)

  const topCard = h(ui.Card, {
    title: '印象档案',
    desc: '群友在 QQ 里发 /卡片 就会开始记一个人。刷新、加减分、删除都在右边。',
    right: h(ui.Btn, { small: true, onClick: load, disabled: loading }, loading ? '刷新中…' : '刷新列表'),
  },
  h('div', { className: 'ab-grid' },
    h('div', { className: 'ab-flex', style: { gap: 28, alignItems: 'flex-end' } },
      statItem('档案数', String(statPersons)),
      statItem('平均好感度', statAvg),
      statItem('有笔记', String(statDescribed))),
    h('div', { className: 'ab-small ab-muted' }, settingsLine),
    state.enabled === false ? h('div', { className: 'ab-note warn' }, '总开关关着：QQ 命令、工具和接口都停了，这里只能看已有档案。') : null,
    loadError ? h('div', { className: 'ab-note err' }, loadError) : null))

  const listCard = h(ui.Card, {
    title: '人物（' + persons.length + (toNum(state.personsTotal) > persons.length ? ' / 共 ' + toNum(state.personsTotal) : '') + '）',
    desc: query ? '匹配 ' + filtered.length + ' 人' : null,
  },
  h('div', { className: 'ab-grid', style: { gap: 8 } },
    h('input', {
      className: 'ab-input',
      style: { width: '100%' },
      type: 'search',
      'aria-label': '搜索档案',
      placeholder: '搜索名字或 QQ 号',
      value: query,
      onChange: function (event) { setQuery(event.target.value) },
    }),
    persons.length === 0
      ? h(ui.Empty, { icon: '📇', text: EMPTY_LIST_TEXT })
      : filtered.length === 0
        ? h(ui.Empty, { icon: '🔍', text: NO_MATCH_TEXT })
        : h('div', { className: 'ab-plist', style: { maxHeight: 460, overflow: 'auto' } },
          filtered.map(function (person) {
            return h('button', {
              key: person.id,
              type: 'button',
              className: 'ab-pitem' + (person.id === selectedId ? ' on' : ''),
              title: (person.name || person.userId) + '（QQ ' + person.userId + '）',
              onClick: function () { selectPerson(person.id) },
            },
            h('div', { className: 'nm' }, person.name || person.userId || '（无名）'),
            h('div', { className: 'tg' }, (cfg.totalLabel || '好感度') + ' ' + fmt1(person.total) + ' · ' + fmtTime(person.updatedAt)))
          }))))

  const dimRows = shownDims.map(function (dim) {
    const percent = barPercent(dim.value, cfg.scaleMin, cfg.scaleMax)
    return h('div', { key: dim.key, className: 'ab-flex', style: { gap: 10, flexWrap: 'nowrap' } },
      h('span', {
        className: 'ab-small',
        title: dim.label || dim.key,
        style: { flex: '0 0 72px', width: 72, color: 'var(--ab-sub)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      }, dim.label || dim.key),
      h('span', { style: { flex: 1, display: 'block', height: 8, borderRadius: 999, overflow: 'hidden', background: 'var(--ab-card-2)' } },
        h('span', { style: { display: 'block', height: '100%', borderRadius: 999, width: percent + '%', background: barTone(percent) } })),
      h('span', {
        className: 'ab-small',
        style: { flex: '0 0 44px', width: 44, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--ab-text)' },
      }, fmt1(dim.value)))
  })

  const dimsBlock = dims.length
    ? h('div', { className: 'ab-grid', style: { gap: 8 } },
      h('div', { className: 'ab-flex', style: { justifyContent: 'space-between' } },
        h('div', { className: 'ab-small ab-muted' }, '维度（' + shownDims.length + ' / ' + dims.length + '，按分数排序）'),
        dims.length > radarTop
          ? h(ui.Btn, { small: true, kind: 'ghost', onClick: function () { setShowAllDims(function (value) { return !value }) } }, showAllDims ? '只看雷达维度' : '显示全部 ' + dims.length + ' 项')
          : null),
      h('div', { className: 'ab-grid', style: { gap: 6 } }, dimRows))
    : h('div', { className: 'ab-small ab-muted' }, '这个人还没有维度分数。')

  const noteLine = !selected
    ? ''
    : selected.described
      ? '已写 ' + (toNum(selected.noteChars) || 0) + ' 字；正文印在卡片右侧，预览图里能看到。'
      : '还没有笔记。点「刷新印象」让她结合记忆和最近的聊天写一句。'

  const actionsBlock = h('div', { className: 'ab-grid', style: { gap: 8 } },
    h('div', { className: 'ab-flex' },
      h(ui.Btn, { small: true, onClick: renderCard, disabled: !!busy || !sharpReady }, busy === 'render' ? '渲染中…' : '重新渲染卡片'),
      h(ui.Btn, { kind: 'primary', small: true, onClick: refreshImpression, disabled: !!busy },
        busy === 'refresh' ? h('span', null, h('i', { className: 'ab-spin' }), ' 刷新中…') : '刷新印象'),
      h(ui.Btn, { small: true, kind: 'ghost', onClick: sendCard, disabled: !!busy || !sharpReady }, busy === 'send' ? '发送中…' : '发到最近聊天')),
    h('div', { className: 'ab-small ab-muted' }, '刷新印象会调用一次模型（几秒到几十秒，会消耗额度）；加减分不会。'),
    askingDelete
      ? h('div', { className: 'ab-note warn' },
        h('div', null, '删除后这个人的分数和笔记都会没掉，不能撤销。确定删除「' + (selected.name || selected.userId) + '」？'),
        h('div', { className: 'ab-flex', style: { marginTop: 8 } },
          h(ui.Btn, { small: true, kind: 'danger', onClick: deletePerson, disabled: !!busy }, busy === 'delete' ? '删除中…' : '确认删除'),
          h(ui.Btn, { small: true, kind: 'ghost', onClick: function () { setAskingDelete(false) }, disabled: !!busy }, '取消')))
      : h('div', { className: 'ab-flex' },
        h(ui.Btn, { small: true, kind: 'danger', onClick: function () { setAskingDelete(true) }, disabled: !!busy }, '删除档案')))

  const detailCard = selected
    ? h(ui.Card, {
      title: (selected.name || selected.userId) + ' 的档案',
      desc: 'QQ ' + (selected.userId || '未知') + ' · 最近更新 ' + fmtTime(selected.updatedAt),
    },
    h('div', { className: 'ab-grid' },
      h('div', { className: 'ab-flex', style: { gap: 28, alignItems: 'flex-end' } },
        statItem(cfg.totalLabel || '好感度', fmt1(selected.total)),
        statItem('笔记字数', String(toNum(selected.noteChars) || 0))),
      sharpReady
        ? (imgError
          ? h('div', { className: 'ab-note err' }, imgError)
          : h('img', {
            key: cardSrc,
            src: cardSrc,
            alt: (selected.name || '这个人') + ' 的印象卡',
            loading: 'lazy',
            style: { display: 'block', width: '100%', maxWidth: 680, borderRadius: 10, border: '1px solid var(--ab-line)' },
            onError: function () {
              setImgError('卡片图没加载出来：渲染接口可能没就绪（sharp 未安装或渲染报错）。点「重新渲染卡片」看具体原因。')
            },
          }))
        : h('div', { className: 'ab-note warn' },
          h('div', null, state.sharpMessage || '这台机器上没有可用的 sharp，卡片图渲染不出来；QQ 里发 /卡片 会自动改成文字版。'),
          h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '印象卡片只用 DSH 自带的 sharp，不在运行时装依赖；DSH 版本较老或精简安装时只能发文字卡。')),
      previewError ? h('div', { className: 'ab-note err' }, previewError) : null,
      dimsBlock,
      h('div', null,
        h('div', { className: 'ab-small ab-muted' }, '印象笔记'),
        h('div', { className: 'ab-small' }, noteLine)),
      actionsBlock))
    : h(ui.Card, { title: '档案详情' },
      h(ui.Empty, { icon: '👈', text: persons.length === 0 ? '还没有任何档案。' : '从左边选一个人查看档案。' }))

  const adjustCard = selected
    ? h(ui.Card, { title: '手动调整', desc: '直接给这个人加减分，或把某一项设成指定数值；会写进下面的变动记录。' },
      h('div', null,
        h(ui.Row, { label: '维度', hint: 'total 是整体好感度' },
          h(ui.Select, { value: activeDim, options: dimOptions, onChange: function (value) { setAdjustDim(value) }, width: 170 }),
          h(ui.Select, {
            value: adjustMode,
            options: [{ value: 'add', label: '加 / 减' }, { value: 'set', label: '设为' }],
            onChange: function (value) { setAdjustMode(value) },
            width: 110,
          })),
        h(ui.Row, { label: '数值', hint: adjustMode === 'add' ? '相对当前值，负数就是减' : '直接设成这个数' },
          h('input', {
            className: 'ab-input sm',
            type: 'number',
            step: '0.5',
            value: adjustValue,
            placeholder: adjustMode === 'add' ? '1 或 -2' : '7.5',
            onChange: function (event) { setAdjustValue(event.target.value) },
          }),
          h('span', { className: 'ab-small ab-muted' }, '当前「' + dimLabelOf(cfg, activeDim) + '」 ' + fmt1(valueOfDim(selected, cfg, activeDim)))),
        h(ui.Row, { label: '原因', hint: '可选，会出现在变动记录里' },
          h('input', {
            className: 'ab-input wide',
            value: adjustReason,
            maxLength: 120,
            placeholder: '比如：帮了个大忙',
            onChange: function (event) { setAdjustReason(event.target.value) },
          })),
        h('div', { className: 'ab-flex', style: { marginTop: 4 } },
          h(ui.Btn, {
            kind: 'primary',
            small: true,
            onClick: applyAdjust,
            disabled: !!busy || String(adjustValue === undefined || adjustValue === null ? '' : adjustValue).trim() === '' || toNum(adjustValue) === null,
          }, busy === 'adjust' ? '写入中…' : adjustMode === 'set' ? '设定数值' : '加减分'),
          adjustError ? h('span', { className: 'ab-small', style: { color: 'var(--ab-err)' } }, adjustError) : null)))
    : null

  const recentList = Array.isArray(state.recent) ? state.recent.slice(0, 10) : []
  const recentCard = h(ui.Card, { title: '最近变动', desc: '最新 10 条数值变动，新的在上面。' },
    h('div', { className: 'ab-grid' },
      recentList.length === 0
        ? h(ui.Empty, { icon: '🧾', text: '还没有变动记录。加减分或刷新印象后会记在这里。' })
        : h('div', { className: 'ab-list' },
          recentList.map(function (item, index) {
            return h('div', { key: String(index), className: 'ab-li' },
              h('div', { className: 'meta' }, fmtTime(item.at)),
              h('div', { className: 'body' },
                h('b', null, item.name || '某人'),
                ' · ' + dimLabelOf(cfg, item.dimension) + ' ' + fmtDelta(item.delta) + ' → ' + fmt1(item.value),
                item.reason ? h('div', { className: 'ab-small ab-muted' }, item.reason) : null))
          })),
      h('details', { onToggle: function (event) { if (event && event.target && event.target.open && !helpText && !helpLoading) loadHelp() } },
        h('summary', { className: 'ab-small ab-muted', style: { cursor: 'pointer' } }, '在 QQ 里能用的命令'),
        h('div', { style: { marginTop: 8 } },
          helpError ? h('div', { className: 'ab-note err' }, helpError) : null,
          helpText || state.help
            ? h('div', { className: 'ab-note ab-small', style: { whiteSpace: 'pre-wrap' } }, String(helpText || state.help))
            : helpLoading
              ? h('div', { className: 'ab-small ab-muted' }, '正在读命令说明…')
              : h(ui.Btn, { small: true, kind: 'ghost', onClick: loadHelp }, '读命令说明')))))

  return h('div', { className: 'ab-grid' },
    topCard,
    h('div', { className: 'ab-persona' },
      listCard,
      h('div', { className: 'ab-grid' }, detailCard, adjustCard)),
    recentCard)
}
