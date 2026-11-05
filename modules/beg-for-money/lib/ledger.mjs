// 账本：范围解析、按天聚合、命令 / 工具文案，以及带原子写盘的账本文件。
//
// 这一层只碰文件系统和纯函数，不 import Aurabot 的 api，测试可以直接造临时目录跑。
//
// 账本是纯手工维护的唯一副本，所以写盘必须原子：先写同目录临时文件，再 rename 换上去。
// 解析失败时也绝不能当成「空账本」继续跑 —— 下一次记账就会用「空列表 + 这一笔」
// 把整个文件覆盖掉，历史全没。坏文件改名留档，并置位禁止写入，等用户自己处理。

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CURRENCY_FALLBACK = '元'
/** 一条备注最多留这么长；再长在私聊和日志里也读不完。 */
export const NOTE_LIMIT = 40
/** 列表最多显示这么多条，剩下的用「另有 N 笔」带过。 */
export const ROW_LIMIT = 10
/** 时间窗口上限：`/收款 9999` 这种写法不该真的扫一万年。 */
const MAX_SPAN_DAYS = 3650

const pad2 = (n) => String(n).padStart(2, '0')

/** 本地日期 → YYYY-MM-DD。别用 toISOString：那是 UTC，东八区晚上会差一天。 */
export function isoDay (d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
}

/** YYYY-MM-DD 平移 n 天（n 可负）。按本地正午算，避开夏令时 / 时区边界。 */
export function addDaysISO (iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return String(iso || '')
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0)
  d.setDate(d.getDate() + Number(n || 0))
  return isoDay(d)
}

/** 金额容错：手工改坏的一行按 0 算，别让整个统计崩掉。 */
export function amountOf (row) {
  const n = Number(row && row.amount)
  return Number.isFinite(n) ? n : 0
}

export function round2 (n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

export function formatMoney (value, unit = CURRENCY_FALLBACK) {
  return round2(value).toFixed(2) + (unit || CURRENCY_FALLBACK)
}

/**
 * 把各种范围写法归一成 { kind, value }。
 * kind 为 bad 表示看不懂；default 表示「今天 + 最近 N 天」。
 */
export function parseScope (raw, todayISO = isoDay()) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!text) return { kind: 'default' }
  const low = text.toLowerCase()
  if (['全部', '总', '总计', '累计', 'all', 'total'].includes(low)) return { kind: 'all' }
  if (['今天', '今日', 'today'].includes(low)) return { kind: 'day', value: todayISO }
  if (['昨天', '昨日', 'yesterday'].includes(low)) return { kind: 'day', value: addDaysISO(todayISO, -1) }
  if (/^\d+$/.test(text)) return { kind: 'days', value: Math.min(MAX_SPAN_DAYS, Math.max(1, Number(text) || 1)) }
  // 补零：`1-5` 也要能认，不然只认 `01-05` 这种写法
  const key = /^\d{1,2}-\d{1,2}$/.test(text)
    ? todayISO.slice(0, 4) + '-' + pad2(Number(text.split('-')[0])) + '-' + pad2(Number(text.split('-')[1]))
    : text
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return { kind: 'day', value: key }
  return { kind: 'bad', value: text }
}

/** 按天聚合最近 span 天，账本只扫一遍，顺序仍是今天在前。 */
export function bucketByDay (records, todayISO, span) {
  const days = Math.max(0, Math.floor(Number(span) || 0))
  if (!days) return []
  const wanted = new Set()
  for (let i = 0; i < days; i++) wanted.add(addDaysISO(todayISO, -i))
  const agg = new Map()
  for (const row of records || []) {
    const key = String((row && row.date) || '')
    if (!wanted.has(key)) continue
    const slot = agg.get(key) || { count: 0, total: 0 }
    slot.count += 1
    slot.total += amountOf(row)
    agg.set(key, slot)
  }
  const out = []
  for (let i = 0; i < days; i++) {
    const key = addDaysISO(todayISO, -i)
    const slot = agg.get(key)
    if (!slot) continue
    out.push({ date: key, count: slot.count, total: round2(slot.total) })
  }
  return out
}

/**
 * 把范围解析成一份可渲染的视图。返回 null 表示这个范围看不懂。
 * 命令和工具共用这一份，避免两边认的写法对不上。
 */
export function summarizeLedger (records, scope, { todayISO = isoDay(), currency = CURRENCY_FALLBACK, recentDays = 7 } = {}) {
  const parsed = parseScope(scope, todayISO)
  if (parsed.kind === 'bad') return null
  const list = Array.isArray(records) ? records : []
  const grand = round2(list.reduce((sum, row) => sum + amountOf(row), 0))
  const view = {
    kind: parsed.kind,
    unit: currency || CURRENCY_FALLBACK,
    label: '',
    total: 0,
    count: 0,
    rows: [],
    extra: 0,
    buckets: [],
    grand,
    grandCount: list.length,
    first: '',
  }

  if (parsed.kind === 'all') {
    const days = list.map((row) => String((row && row.date) || '')).filter(Boolean).sort()
    view.label = '累计'
    view.total = grand
    view.count = list.length
    view.first = days[0] || ''
    return view
  }

  if (parsed.kind === 'day') {
    const rows = list.filter((row) => String((row && row.date) || '') === parsed.value)
    view.label = parsed.value
    view.total = round2(rows.reduce((sum, row) => sum + amountOf(row), 0))
    view.count = rows.length
    view.rows = rows.slice(-ROW_LIMIT)
    view.extra = Math.max(0, rows.length - ROW_LIMIT)
    return view
  }

  const span = parsed.kind === 'days' ? parsed.value : Math.max(1, Math.floor(Number(recentDays) || 7))
  const buckets = bucketByDay(list, todayISO, span)
  const spanCount = buckets.reduce((n, b) => n + b.count, 0)
  const spanTotal = round2(buckets.reduce((n, b) => n + b.total, 0))

  if (parsed.kind === 'days') {
    view.label = '最近 ' + span + ' 天'
    view.total = spanTotal
    view.count = spanCount
    view.buckets = buckets
    return view
  }

  const todayRows = list.filter((row) => String((row && row.date) || '') === todayISO)
  view.label = '今天'
  view.total = round2(todayRows.reduce((sum, row) => sum + amountOf(row), 0))
  view.count = todayRows.length
  view.buckets = buckets
  view.spanLabel = '最近 ' + span + ' 天'
  view.spanTotal = spanTotal
  view.spanCount = spanCount
  return view
}

function rowLine (row, unit) {
  const note = (row && row.note) ? ' ' + String(row.note) : ''
  return '  ' + String((row && row.time) || '--:--:--') + ' ' + formatMoney(amountOf(row), unit) + note
}

/** 命令用的详细版：带明细行。 */
export function formatLedgerLines (view) {
  if (!view) return '看不懂这个范围，用 `/收款 2026-10-27`、`/收款 7` 或者 `/收款 全部`。'
  const unit = view.unit
  if (view.grandCount === 0) return '账本还是空的。'
  if (view.kind === 'all') {
    return '累计 ' + formatMoney(view.total, unit) + '，共 ' + view.count + ' 笔，最早 ' + (view.first || '—') + '。'
  }
  if (view.kind === 'day' && view.count === 0) return view.label + ' 没有记录。'
  if (view.kind === 'default' && view.count === 0 && view.buckets.length === 0) {
    return '今天没有记录，账本累计 ' + formatMoney(view.grand, unit) + '。'
  }

  const lines = [view.label + ' ' + view.count + ' 笔，共 ' + formatMoney(view.total, unit)]
  for (const row of view.rows) lines.push(rowLine(row, unit))
  if (view.extra) lines.push('  ……另有 ' + view.extra + ' 笔')

  if (view.kind === 'default') {
    if (view.buckets.length) {
      lines.push(view.spanLabel + ' ' + view.spanCount + ' 笔，共 ' + formatMoney(view.spanTotal, unit))
      for (const b of view.buckets) lines.push('  ' + b.date + ' ' + b.count + ' 笔 ' + formatMoney(b.total, unit))
    }
    lines.push('累计 ' + formatMoney(view.grand, unit) + '（' + view.grandCount + ' 笔）')
  } else if (view.kind === 'days') {
    for (const b of view.buckets) lines.push('  ' + b.date + ' ' + b.count + ' 笔 ' + formatMoney(b.total, unit))
  }
  return lines.join('\n')
}

/** 工具用的紧凑版：一两句，方便她直接转述。 */
export function formatLedgerBrief (view) {
  if (!view) return '看不懂这个范围。能用今天、昨天、全部、最近几天（如 7）、或者 2026-10-27 这样的日期。'
  const unit = view.unit
  if (view.grandCount === 0) return '账本还是空的，一笔都没记。'
  if (view.kind === 'all') {
    return '账本累计 ' + formatMoney(view.total, unit) + '，共 ' + view.count + ' 笔，最早 ' + (view.first || '—') + '。'
  }
  if (view.count === 0 && view.buckets.length === 0) {
    return view.label + '没有记录，账本累计 ' + formatMoney(view.grand, unit) + '。'
  }
  const parts = [view.label + ' ' + view.count + ' 笔，共 ' + formatMoney(view.total, unit)]
  if (view.buckets.length) {
    const days = view.buckets.slice(0, 5).map((b) => b.date.slice(5) + ' ' + formatMoney(b.total, unit)).join('、')
    parts.push('有记录的日子：' + days)
  }
  if (view.kind === 'default') parts.push('累计 ' + formatMoney(view.grand, unit) + '（' + view.grandCount + ' 笔）')
  return parts.join('；') + '。'
}

/** 一条账本记录。金额已经过调用方校验，这里只做格式化和截断。 */
export function makeEntry (input, now = new Date()) {
  const o = input || {}
  return {
    date: isoDay(now),
    time: pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' + pad2(now.getSeconds()),
    amount: round2(o.amount),
    note: String(o.note || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, NOTE_LIMIT),
    chatId: String(o.chatId || ''),
    groupId: String(o.groupId || ''),
    payer: String(o.payer || ''),
    payerName: String(o.payerName || '').slice(0, 40),
    source: String(o.source || ''),
  }
}

/** 原子写 JSON：先写同目录临时文件，再 rename 换上去。返回是否写成功。 */
export function writeJsonAtomic (file, payload) {
  if (!file) return false
  let tmp = ''
  try {
    mkdirSync(dirname(file), { recursive: true })
    // 临时文件名要唯一：热重载时新旧实例可能短暂并存，共用固定名会互相踩
    tmp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
    writeFileSync(tmp, JSON.stringify(payload, null, 1), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (error) {
    try { if (tmp && existsSync(tmp)) unlinkSync(tmp) } catch (e) {}
    return false
  }
}

/**
 * 账本文件。load() 在插件启动时调一次；record() / remove() 会即时落盘。
 * broken 为 true 时拒绝一切写入，避免用空账本覆盖坏掉的历史。
 */
export function createLedger ({ file, log = console, now = () => new Date() } = {}) {
  let records = []
  let broken = false
  let loaded = false

  function backupCorrupt () {
    try {
      const to = file + '.corrupt-' + Math.floor(Date.now() / 1000)
      renameSync(file, to)
      log.error && log.error('坏账本已备份为 ' + to + '，本次运行不写账本，请修好后再重载模块')
    } catch (error) {
      log.error && log.error('坏账本备份失败，为避免覆盖已停止写入：' + (error && error.message ? error.message : error))
    }
  }

  function load () {
    loaded = true
    records = []
    broken = false
    if (!file || !existsSync(file)) return { count: 0, broken: false }
    try {
      const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
      const data = JSON.parse(text)
      const rows = Array.isArray(data) ? data : (data && Array.isArray(data.records) ? data.records : null)
      if (!rows) throw new Error('账本里没有 records 数组')
      records = rows.filter((row) => row && typeof row === 'object')
      return { count: records.length, broken: false }
    } catch (error) {
      broken = true
      records = []
      log.error && log.error('账本读取失败：' + (error && error.message ? error.message : error))
      backupCorrupt()
      return { count: 0, broken: true }
    }
  }

  function save () {
    if (broken) {
      log.error && log.error('账本文件损坏已禁用写入，这次改动不会落盘')
      return false
    }
    const ok = writeJsonAtomic(file, { version: 1, records })
    if (!ok) log.error && log.error('账本写入失败：' + file)
    return ok
  }

  function record (input) {
    if (!loaded) load()
    const entry = makeEntry(input, now())
    records.push(entry)
    if (!save()) {
      // 没写进磁盘就别留在内存里，否则这一轮统计会多出一笔、重启后又消失
      records.pop()
      return null
    }
    return entry
  }

  function removeEntry (entry) {
    const i = records.indexOf(entry)
    if (i < 0) return false
    records.splice(i, 1)
    return save()
  }

  return {
    load,
    save,
    record,
    removeEntry,
    all: () => records.slice(),
    count: () => records.length,
    get broken () { return broken },
    file,
  }
}
