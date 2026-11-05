// 印象档案的本地存储（JSON 文件，原子写入）。
//
// 一份档案 = 一个人的好感度 + 各维度分 + 印象笔记 + 已知称呼。
// 跨私聊/群聊共用：同一个人在哪都查到同一张卡。文件放在模块的数据目录里，
// 插件升级、模块重载都不会清掉。
//
// 这里只有同步的纯函数和文件读写，不依赖 Aurabot 的 api，测试可以直接造临时文件跑。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const STORE_VERSION = 1
export const MAX_RECORDS = 2000
export const MAX_ALIASES = 12
export const MAX_DESCRIPTION_CHARS = 200000

/** QQ 号 → 稳定的 person id。 */
export function personIdOf (platform, userId) {
  const p = String(platform || 'qq').trim() || 'qq'
  return p + ':' + String(userId === undefined || userId === null ? '' : userId).trim()
}

function finite (value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 新建一条档案（还没存）。 */
export function createRecord (opts) {
  const o = opts || {}
  const now = Date.now()
  const platform = String(o.platform || 'qq')
  const userId = String(o.userId || '')
  return {
    id: o.personId || personIdOf(platform, userId),
    platform,
    userId,
    displayName: String(o.displayName || userId || '某人').slice(0, 40),
    userNickname: String(o.userNickname || o.displayName || '').slice(0, 40),
    groupCard: String(o.groupCard || '').slice(0, 40),
    aliases: Array.isArray(o.aliases) ? o.aliases.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim().slice(0, 40)).slice(0, MAX_ALIASES) : [],
    total: finite(o.total, 5),
    scores: o.scores && typeof o.scores === 'object' ? { ...o.scores } : {},
    description: String(o.description || '').slice(0, MAX_DESCRIPTION_CHARS),
    createdAt: finite(o.createdAt, now),
    updatedAt: finite(o.updatedAt, now),
  }
}

/** 读回来的数据都洗一遍：缺字段补上，脏数据丢掉，不让面板和卡面炸。 */
export function normalizeRecord (raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = String(raw.id || '').trim()
  if (!id) return null
  const record = createRecord({ ...raw, personId: id })
  const scores = {}
  if (raw.scores && typeof raw.scores === 'object') {
    for (const [key, value] of Object.entries(raw.scores)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key)) continue
      const n = Number(value)
      if (Number.isFinite(n)) scores[key] = n
    }
  }
  record.scores = scores
  return record
}

function emptyState () {
  return { version: STORE_VERSION, records: {}, meta: { proactive: {}, events: [] } }
}

function normalizeState (raw) {
  const state = emptyState()
  if (!raw || typeof raw !== 'object') return state
  const records = raw.records && typeof raw.records === 'object' ? raw.records : {}
  for (const [id, value] of Object.entries(records)) {
    const record = normalizeRecord({ ...(value && typeof value === 'object' ? value : {}), id })
    if (record) state.records[record.id] = record
    if (Object.keys(state.records).length >= MAX_RECORDS) break
  }
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {}
  const proactive = meta.proactive && typeof meta.proactive === 'object' ? meta.proactive : {}
  for (const [chatId, at] of Object.entries(proactive)) {
    const n = Number(at)
    if (typeof chatId === 'string' && chatId && Number.isFinite(n)) state.meta.proactive[chatId] = n
  }
  state.meta.events = Array.isArray(meta.events)
    ? meta.events.filter((e) => e && typeof e === 'object').slice(0, 100).map((e) => ({
      at: finite(e.at, 0),
      personId: String(e.personId || ''),
      name: String(e.name || ''),
      dimension: String(e.dimension || ''),
      delta: finite(e.delta, 0),
      value: finite(e.value, 0),
      reason: String(e.reason || '').slice(0, 120),
    }))
    : []
  return state
}

/**
 * createStore({ file, log })
 * 文件不存在就当作空库；坏文件先备份成 .broken 再重来，不让模块起不来。
 */
export function createStore (opts) {
  const o = opts || {}
  const file = String(o.file || '')
  const log = o.log || null
  let state = emptyState()
  if (file) {
    try {
      if (existsSync(file)) state = normalizeState(JSON.parse(readFileSync(file, 'utf8')))
    } catch (error) {
      try { renameSync(file, file + '.broken') } catch (renameError) {}
      log?.warn?.('印象档案文件损坏，已另存为 .broken 并重新开始。')
    }
  }

  let timer = null
  function saveNow () {
    if (timer) { clearTimeout(timer); timer = null }
    if (!file) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(state), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      log?.warn?.('保存印象档案失败：' + (error && error.message ? error.message : error))
    }
  }
  // 连续改动合并成一次落盘，避免一次连发好几条工具调用时反复写文件。
  function schedule () {
    if (timer) return
    timer = setTimeout(() => { timer = null; saveNow() }, 200)
    if (timer.unref) timer.unref()
  }

  function get (personId) {
    return state.records[String(personId)] || null
  }

  function all () {
    return Object.values(state.records).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function upsert (record) {
    if (!record || !record.id) return null
    const next = normalizeRecord(record)
    if (!next) return null
    state.records[next.id] = next
    schedule()
    return next
  }

  function remove (personId) {
    const id = String(personId)
    if (!state.records[id]) return false
    delete state.records[id]
    schedule()
    return true
  }

  function namesOf (record) {
    if (!record) return []
    return [record.displayName, record.userNickname, record.groupCard, ...(record.aliases || [])]
      .map((s) => String(s || '').trim())
      .filter(Boolean)
  }

  /** 按名字找：先精确，再忽略大小写；找不到返回 null。 */
  function findByName (name) {
    const target = String(name === undefined || name === null ? '' : name).trim()
    if (!target) return null
    const lower = target.toLowerCase()
    for (const record of all()) {
      if (namesOf(record).some((n) => n === target)) return record
    }
    for (const record of all()) {
      if (namesOf(record).some((n) => n.toLowerCase() === lower)) return record
    }
    return null
  }

  /** 模糊搜索：名字包含关键字就算命中（面板搜索用）。 */
  function search (query) {
    const q = String(query === undefined || query === null ? '' : query).trim().toLowerCase()
    if (!q) return all()
    return all().filter((record) => namesOf(record).some((n) => n.toLowerCase().includes(q)) || record.userId.includes(q))
  }

  function rememberAlias (record, ...names) {
    if (!record) return record
    const seen = new Set(namesOf(record).map((n) => n.toLowerCase()))
    for (const raw of names) {
      const name = String(raw === undefined || raw === null ? '' : raw).trim().slice(0, 40)
      if (!name || seen.has(name.toLowerCase())) continue
      record.aliases = [...(record.aliases || []), name].slice(-MAX_ALIASES)
      seen.add(name.toLowerCase())
    }
    return record
  }

  function meta () {
    return state.meta
  }

  function pushEvent (event) {
    state.meta.events = [event, ...(state.meta.events || [])].slice(0, 100)
    schedule()
  }

  function stats () {
    const list = all()
    const totals = list.map((r) => Number(r.total)).filter((n) => Number.isFinite(n))
    const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : 0
    return {
      persons: list.length,
      avgTotal: Math.round(avg * 10) / 10,
      described: list.filter((r) => r.description.trim()).length,
      lastUpdatedAt: list.length ? list[0].updatedAt : 0,
    }
  }

  return { file, get, all, upsert, remove, findByName, search, namesOf, rememberAlias, meta, pushEvent, stats, saveNow, state: () => state }
}
