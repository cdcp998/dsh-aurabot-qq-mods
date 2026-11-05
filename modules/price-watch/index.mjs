// 价格监控（Aurabot 用户扩展）
//
// 盯住一件商品的价格：命令和面板共用同一套底层，状态落在 api.dataDir() 的 state.json。
//
// 只做四件事：
//   1. 超级好价 —— 值票、评论、收藏都够的成熟好价；
//   2. 早期好价 —— 信号刚起来、还没被投满的；
//   3. 降价提醒 —— 比插件上次看到的价格明显便宜；
//   4. 历史价格最低 —— 比插件记录过的最低价还低。
//
// 数据来自什么值得买的公开列表接口（不需要登录），它本身聚合了京东 / 天猫 /
// 拼多多 / 抖音商城等平台的爆料，所以一条查询就能横向比较几个平台。
//
// 为什么叫「历史价格最低」而不是「全网史低」：插件只能看到自己见过的价格，
// 记录从第一次监控开始，之前的行情不知道。文案里不夸大这一点。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { parsePrice, formatPrice, productKey, qualityOf, pickCandidates, evaluateAlert } from './lib/core.mjs'

const VERSION = '1.0.0'
const LIST_API = 'https://api.smzdm.com/v1/list'
const PAGE_SIZE = 50
const MAX_PAGES = 5
const FETCH_TIMEOUT = 12000
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

/** 一个监控最长保留多久（天）；0 表示不过期。避免「监控」列表无限攒灰。 */
const unwatchAfter = (settings) => {
  const days = Number(settings.watchTtlDays)
  return Number.isFinite(days) && days > 0 ? days * 86400000 : 0
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function nowMs () {
  return Date.now()
}

/**
 * 用户可能发来一整个链接。什么值得买的文章页能用 og:title 换回商品名，
 * 但这需要多请求一次文章页；京东 / 淘宝那些链接我们不去抓页面。
 */
export function linkKind (raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim()
  const m = text.match(/https?:\/\/[^\s]+/i)
  if (!m) return { isLink: false, url: '', kind: '' }
  const url = m[0]
  let host = ''
  try { host = new URL(url).hostname.toLowerCase() } catch (error) { return { isLink: true, url, kind: 'unknown' } }
  if (/(^|\.)smzdm\.com$/.test(host)) return { isLink: true, url, kind: 'smzdm' }
  if (/jd\.com$|jd\.hk$|3\.cn$/.test(host)) return { isLink: true, url, kind: 'jd' }
  if (/taobao\.com$|tmall\.com$|tmall\.hk$/.test(host)) return { isLink: true, url, kind: 'taobao' }
  if (/yangkeduo\.com$|pinduoduo\.com$/.test(host)) return { isLink: true, url, kind: 'pdd' }
  if (/douyin\.com$|jinritemai\.com$/.test(host)) return { isLink: true, url, kind: 'douyin' }
  return { isLink: true, url, kind: 'unknown' }
}

/** 白名单文本：一行一个或逗号分隔的群号。只认纯数字，别的一律丢掉。 */
export function parseGroupIds (raw) {
  const out = new Set()
  for (const piece of String(raw === undefined || raw === null ? '' : raw).split(/[,，\s]+/)) {
    const id = piece.trim()
    if (/^\d{4,15}$/.test(id)) out.add(id)
  }
  return out
}

/** 北京时间的当前小时（0-23）。监控时段按这个算，不看服务器时区。 */
export function hourInBeijing (ts) {
  const n = Number.isFinite(Number(ts)) ? Number(ts) : Date.now()
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23' }).format(new Date(n)))
}

/**
 * 现在是否在监控时段内。开始与结束相同 = 全天；开始 > 结束 表示跨午夜（22 至 7 点）。
 * 只到整点，不含结束那一小时 —— 「22 至 7」表示 22:00-06:59。
 */
export function withinWindow (hour, start, end) {
  const h = Number(hour)
  const s = Number(start)
  const e = Number(end)
  if (!Number.isFinite(h)) return true
  if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return true
  return s < e ? h >= s && h < e : h >= s || h < e
}

function clock (ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '还没查过'
  const d = new Date(Number(ts))
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function idOf () {
  return randomBytes(5).toString('hex')
}

/** 从列表接口的一行解析成内部结构。不认识的字段一律当缺失，不做猜测。 */
function parseRow (row) {
  if (!row || !row.article_id || !row.article_title) return null
  const channel = String(row.article_channel_type || '').trim()
  // 只认好价相关频道，众测 / 原创文章不是商品
  if (channel && channel !== 'faxian' && channel !== 'youhui') return null
  const title = String(row.article_title).trim().slice(0, 200)
  if (!title) return null
  const tongji = parseTongji(row.tongji_hudong)
  const comments = tongji.comments || Math.max(0, Number(row.article_comment) || 0)
  const collection = tongji.collection || Math.max(0, Number(row.article_collection) || 0)
  const worthy = tongji.worthy || Math.max(0, Number(row.article_worthy) || 0)
  const unworthy = tongji.unworthy || Math.max(0, Number(row.article_unworthy) || 0)
  const priceText = String(row.article_price || '').trim()
  const price = parsePrice(priceText)
  const soldOut = truthy(row.article_is_sold_out)
  const ended = truthy(row.article_is_timeout)
  const url = String(row.article_url || '').trim()
  if (!/^https?:\/\//i.test(url)) return null
  if (soldOut || ended) return null
  const published = Number(row.publish_date_lt)
  const quality = qualityOf({ comments, collection, worthy, unworthy, soldOut, ended })
  return {
    articleId: String(row.article_id),
    title,
    price,
    priceText,
    mall: String(row.article_mall || '').trim() || '未知平台',
    url,
    comments,
    collection,
    worthy,
    unworthy,
    quality: quality.quality,
    qualityLabel: quality.label,
    points: quality.score,
    rate: quality.rate,
    key: productKey(title, 6),
    publishedAt: Number.isFinite(published) && published > 0 ? (published > 1e10 ? published : published * 1000) : 0,
  }
}

function truthy (value) {
  const text = String(value === undefined || value === null ? '' : value).trim().toLowerCase()
  return text !== '' && text !== '0' && text !== 'false' && text !== 'none' && text !== 'null'
}

/** tongji_hudong 形如「评论_5,收藏_3,值_10,不值_2」，比顶层字段更新。 */
function parseTongji (raw) {
  const out = { comments: 0, collection: 0, worthy: 0, unworthy: 0 }
  const text = String(raw || '')
  if (!text) return out
  const mapping = { 评论: 'comments', 收藏: 'collection', 值: 'worthy', 不值: 'unworthy' }
  for (const part of text.split(',')) {
    const cut = part.indexOf('_')
    if (cut < 0) continue
    const key = part.slice(0, cut).trim()
    const value = part.slice(cut + 1).trim()
    if (mapping[key] && /^\d+$/.test(value)) out[mapping[key]] = Number(value)
  }
  return out
}

export default {
  id: 'price-watch',
  name: '价格监控',
  version: VERSION,
  api: 1,
  description: '盯住商品价格：超级好价、早期好价、降价提醒、本插件记录的历史最低价；/监控价格 与 /查询价格 支持多平台比价。',
  panel: 'panel.js',
  // 入口挂在面板「平台」组下面（和空间、B站、抖音、小黑盒排在一起），自己占一页。
  // 注意用 group 而不是 tab：tab 会塞进某个内置页内部。
  group: 'platform',
  // 子标签页上的「开/关」小圆点读的是 flag 指向的那个设置项。这里故意用 active 而不是 enabled：
  // 宿主对 flag === 'enabled'（或 settings 里有 enabled）的模块，会在页面标题栏再画一个总开关、
  // 还会把设置自动表单再列一遍。用 active 就只拿到圆点，不加那个开关。
  // active 和 enabled 由面板一起写、启动时也会对齐，两边永远同一个意思。
  flag: 'active',
  // 注意：defaults / settings 里都**没有** enabled —— 总开关只由 panel.js 的卡片右上角渲染。
  defaults: {
    // 总开关的真实状态（和 enabled 同步；标签页圆点看这个）
    active: true,
    intervalMinutes: 60,
    alertDropPercent: 5,
    alertDropAmount: 5,
    alertOnQuality: true,
    maxWatches: 20,
    queryPages: 2,
    // 查价时最多列几条：群里最怕一屏几十条报价
    queryTopN: 3,
    guestQuery: true,
    guestWatch: false,
    alertCooldownMinutes: 180,
    watchTtlDays: 90,
    // 群聊白名单：默认开启，必须先把群号加进白名单，群里才能用这个插件
    groupWhitelist: true,
    whitelistGroups: '',
    // 提醒时 @ 发起监控的人（群聊里才有意义）
    alertMentionOwner: true,
    // 监控时段（北京时间，支持跨午夜）；开始 = 结束 表示全天
    checkStartHour: 0,
    checkEndHour: 0,
    // 每轮最多检查几个，防止一次打出去一堆提醒
    maxChecksPerRun: 5,
    // 老版本宿主不会把模块定义里的 group 传给面板，改用 defaults 里这个标记兜底
    // （和印象卡片用的是同一个约定）。
    __panelGroup: 'platform',
  },
  // 设置全部由 panel.js 自己渲染（它本来就是这一页的全部内容）。
  // 这里留空，宿主就不会再生成一份自动表单。
  settings: [],

  setup (api, dependencies = {}) {
    const log = api.log
    const file = () => api.dataDir('state.json')
    // 老配置里只有 enabled，标签页圆点看的是 active：启动时对齐一次，别让圆点和真实开关打架。
    try {
      const s0 = api.settings()
      const want = s0.enabled !== false
      if (s0.active !== want) api.saveSettings({ active: want })
    } catch (error) {
      log.warn('对齐价格监控开关状态失败：' + (error && error.message ? error.message : error))
    }
    // 每次现取：failover / 测试替换全局 fetch 时也能跟着走
    const fetchImpl = dependencies.fetch || ((url, init) => fetch(url, init))

    // ---------- 状态 ----------
    let state = { watches: [], records: {}, lastCheck: 0, lastResult: '还没检查过', checks: 0, alerts: 0, day: '', dayChecks: 0, pending: [] }
    try {
      const loaded = JSON.parse(readFileSync(file(), 'utf8'))
      if (loaded && typeof loaded === 'object') state = { ...state, ...loaded }
    } catch (error) {}
    state.watches = Array.isArray(state.watches) ? state.watches.filter((w) => w && typeof w === 'object' && w.id && w.query) : []
    state.records = state.records && typeof state.records === 'object' ? state.records : {}
    state.pending = Array.isArray(state.pending) ? state.pending.filter((p) => p && typeof p === 'object' && p.chatId).slice(-20) : []
    for (const key of ['lastCheck', 'checks', 'alerts', 'dayChecks']) if (!Number.isFinite(Number(state[key])) || Number(state[key]) < 0) state[key] = 0
    for (const watch of state.watches) {
      watch.history = Array.isArray(watch.history) ? watch.history.filter((h) => h && Number.isFinite(Number(h.price))).slice(-60) : []
      if (!Number.isFinite(Number(watch.createdAt)) || !watch.createdAt) watch.createdAt = nowMs()
      if (!Number.isFinite(Number(watch.alerts)) || Number(watch.alerts) < 0) watch.alerts = 0
      if (!Array.isArray(watch.seenQuality)) watch.seenQuality = []
    }

    let disposed = false
    let busy = false
    let timer = null
    const controller = new AbortController()
    api.onDispose(() => {
      disposed = true
      controller.abort()
      if (timer) clearInterval(timer)
    })

    const save = () => {
      if (disposed) return
      try {
        const target = file()
        mkdirSync(dirname(target), { recursive: true })
        const tmp = target + '.tmp'
        writeFileSync(tmp, JSON.stringify(state, null, 2))
        renameSync(tmp, target)
      } catch (error) {
        log.warn('价格监控状态保存失败：' + (error && error.message ? error.message : error))
      }
    }

    /**
     * 这个聊天能不能用价格监控。
     * 私聊一律放行（主人自己的私聊就是管理入口）；
     * 群聊要在白名单里 —— 白名单开关打开时，没配就谁都用不了，这是刻意的：
     * 宁可先在面板里把群加上，也不要一装上就在所有群里刷价格。
     */
    function chatAllowed (chatId, c) {
      const id = String(chatId || '')
      if (!id.startsWith('group:')) return true
      if (!c.groupWhitelist) return true
      return c.whitelist.has(id.slice(6))
    }

    /** 给一句话加 @ 前缀：群聊里 @ 发起人，私聊原样。 */
    function withMention (chatId, userId, text, c) {
      const id = String(chatId || '')
      const uid = String(userId || '')
      if (!c.mentionOwner || !uid || !id.startsWith('group:')) return text
      // <at:QQ号> 会被中枢换成真正的 @ 段，对方能收到提醒
      return '<at:' + uid + '> ' + text
    }

    /** 设置每次都现读：面板改完立即生效，不在 setup 里缓存。 */
    const conf = () => {
      const s = api.settings()
      return {
        // enabled 和 active 是同一个意思：前者给逻辑用，后者给标签页圆点用，
        // 面板会一起写、启动时也会对齐。两个键都没有 = 默认开。
        enabled: s.enabled !== false && s.active !== false,
        intervalMinutes: clamp(s.intervalMinutes, 10, 1440, 60),
        dropPercent: clamp(s.alertDropPercent, 0, 100, 5),
        dropAmount: clamp(s.alertDropAmount, 0, 100000, 5),
        onQuality: s.alertOnQuality !== false,
        maxWatches: clamp(s.maxWatches, 1, 100, 20),
        pages: clamp(s.queryPages, 1, MAX_PAGES, 2),
        queryTopN: clamp(s.queryTopN, 1, 20, 3),
        guestQuery: s.guestQuery !== false,
        guestWatch: s.guestWatch === true,
        cooldown: clamp(s.alertCooldownMinutes, 10, 10080, 180) * 60000,
        ttl: unwatchAfter(s),
        // 白名单默认开：没配置之前群里用不了，避免刚装上就在所有群刷价格
        groupWhitelist: s.groupWhitelist !== false,
        whitelist: parseGroupIds(s.whitelistGroups),
        mentionOwner: s.alertMentionOwner !== false,
        startHour: clamp(s.checkStartHour, 0, 23, 0),
        endHour: clamp(s.checkEndHour, 0, 23, 0),
        maxChecks: clamp(s.maxChecksPerRun, 1, 50, 5),
      }
    }

    // ---------- 网络 ----------
    async function request (query, pages) {
      const out = []
      const seen = new Set()
      const limit = Math.min(MAX_PAGES, Math.max(1, pages))
      let lastError = null
      for (let page = 0; page < limit; page++) {
        const url = LIST_API + '?keyword=' + encodeURIComponent(query) + '&limit=' + PAGE_SIZE + '&offset=' + page * PAGE_SIZE
        try {
          const res = await fetchImpl(url, {
            headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://www.smzdm.com/' },
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
          })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const body = await res.json()
          const rows = body && body.data && Array.isArray(body.data.rows) ? body.data.rows : []
          if (!rows.length) break
          for (const row of rows) {
            const item = parseRow(row)
            if (!item || seen.has(item.articleId)) continue
            seen.add(item.articleId)
            out.push(item)
          }
        } catch (error) {
          lastError = error
          if (controller.signal.aborted || disposed) throw new Error('价格监控已停用')
          break
        }
      }
      if (!out.length && lastError) throw new Error(/HTTP/.test(lastError.message) ? '什么值得买暂时不可用（' + lastError.message + '）' : '查询超时或网络不通')
      return out
    }

    /** 抓一个什么值得买文章页，用 og:title 换回商品名。失败就返回空串，由调用方给提示。 */
    async function smzdmTitle (url) {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(FETCH_TIMEOUT)]),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const html = await res.text()
      const og = (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || [])[1] || ''
      return og
        // 「立白 洗衣液 24斤 55.84元_京东优惠_什么值得买」→ 只留商品名
        .replace(/\s*\d+(?:\.\d+)?\s*元[\s\S]*$/, '')
        .replace(/_什么值得买\s*$/, '')
        .trim()
    }

    /**
     * 把「商品名或链接」统一成能搜的关键词。
     * 返回 { query, link, note }：link 是识别到的链接信息，note 是要先说给用户的一句解释。
     * 京东 / 淘宝 / 拼多多的商品页不抓（各站反爬和动态渲染都不稳定），只提示换成商品名。
     */
    async function resolveQuery (raw) {
      const text = String(raw || '').trim()
      const link = linkKind(text)
      if (!link.isLink) return { query: text, link, note: '' }
      if (link.kind === 'smzdm') {
        try {
          const title = await smzdmTitle(link.url)
          if (title) return { query: title, link, note: '从链接认出了：' + title.slice(0, 40) }
        } catch (error) {
          log.warn('解析什么值得买链接失败：' + (error && error.message ? error.message : error))
        }
        return { query: '', link, note: '这个值得买链接打不开，换成商品名再试一次吧。' }
      }
      const site = link.kind === 'jd' ? '京东' : link.kind === 'taobao' ? '淘宝 / 天猫' : link.kind === 'pdd' ? '拼多多' : link.kind === 'douyin' ? '抖音商城' : '这个网站'
      return { query: '', link, note: site + '的商品页我不去抓（反爬太不稳定），把商品名或关键词发给我就行，比如「' + (link.kind === 'jd' ? '索尼 WH-1000XM5' : '红米 K80') + '」。' }
    }

    /** 同一件商品的多条爆料里挑最便宜、好评最多的那一条代表当前价。 */
    function bestOf (items) {
      return [...items].sort((a, b) => {
        const pa = Number.isFinite(a.price) ? a.price : Infinity
        const pb = Number.isFinite(b.price) ? b.price : Infinity
        if (pa !== pb) return pa - pb
        return (b.points || 0) - (a.points || 0)
      })[0] || null
    }

    function recordOf (key) {
      return key ? state.records[key] || null : null
    }

    /** 用一条观测更新「本插件记录的最低价」。返回是否创了新低。 */
    function observe (key, price, url, title, stamp) {
      if (!key || !Number.isFinite(Number(price)) || Number(price) <= 0) return false
      const cur = recordOf(key)
      const lowest = cur && Number.isFinite(Number(cur.lowest)) ? Number(cur.lowest) : Infinity
      if (!cur) {
        state.records[key] = { lowest: Math.round(Number(price) * 100) / 100, lowestAt: stamp, title: String(title || '').slice(0, 120), url: String(url || ''), observations: 1 }
        return true
      }
      cur.observations = (Number(cur.observations) || 0) + 1
      cur.title = String(title || cur.title || '').slice(0, 120)
      if (url) cur.url = String(url)
      if (Number(price) < lowest) {
        cur.lowest = Math.round(Number(price) * 100) / 100
        cur.lowestAt = stamp
        return true
      }
      return false
    }

    // ---------- 命令渲染 ----------
    const priceText = (n) => (Number.isFinite(Number(n)) ? '¥' + formatPrice(n) : '价格未知')

    function qualityMark (item) {
      if (item.quality === 'super') return '【超级好价】'
      if (item.quality === 'early') return '【早期好价】'
      return ''
    }

    function watchLine (watch, index) {
      const parts = []
      if (index !== undefined) parts.push(index + '. ')
      parts.push(qualityMark(watch))
      parts.push(watch.title.slice(0, 48))
      const bits = [watch.mall || '未知平台', priceText(watch.price)]
      // 记录最低价只有真正低于现价时才值得说；等于现价等于没说
      if (Number.isFinite(Number(watch.lowest)) && Number(watch.lowest) > 0 && Number(watch.lowest) < Number(watch.price) - 0.001) bits.push('记录最低 ' + priceText(watch.lowest))
      parts.push('\n   ' + bits.join(' · '))
      if (watch.alerts) parts.push(' · 已提醒 ' + watch.alerts + ' 次')
      parts.push('\n   ' + watch.url)
      return parts.join('')
    }

    function listText (chatId) {
      const mine = state.watches.filter((w) => !chatId || w.chatId === chatId)
      if (!mine.length) return '现在没有在监控的商品。发 /监控价格 商品名 开始。'
      return '正在监控 ' + mine.length + ' 个商品（/取消监控 编号）：\n' + mine.map((w, i) => watchLine(w, i + 1)).join('\n\n')
    }

    function helpText () {
      return [
        '价格监控帮助用法：',
        '/监控价格 商品名或链接 —— 开始监控（自动识别商品；匹配到多个会给你编号选）',
        '/查询价格 商品名或链接 —— 多平台价格搜索，按平台列最低价和链接',
        '/价格列表 —— 看正在监控的商品',
        '/取消监控 编号 —— 取消一个监控',
        '数据来自什么值得买的公开好价（聚合京东 / 天猫 / 拼多多 / 抖音商城）。',
        '「插件记录最低价」是开始监控之后见到的价格，不是全网史低。',
      ].join('\n')
    }

    // ---------- 加监控 ----------
    async function addWatch (query, chatId, options = {}) {
      const c = conf()
      if (!c.enabled) return { ok: false, message: '价格监控关着，先在面板或 /价格监控帮助 里打开。' }
      if (!chatAllowed(chatId, c)) return { ok: false, message: '这个群还没加进价格监控白名单，先让主人在面板「平台 → 价格监控」里把群号加上。' }
      let q = String(query || '').trim()
      if (!q) return { ok: false, message: '要监控什么？发 /监控价格 商品名或链接，比如 /监控价格 switch 2。' }
      // 允许直接发链接：什么值得买的链接能换回商品名，京东 / 淘宝的会给出提示
      const resolved = await resolveQuery(q)
      if (resolved.note && !resolved.query) return { ok: false, message: resolved.note }
      if (resolved.query && resolved.query !== q) q = resolved.query
      if (q.length > 120) q = q.slice(0, 120)
      if (q.length < 2) return { ok: false, message: '商品名太短了，说具体一点。' }
      const mine = state.watches.filter((w) => w.chatId === chatId)
      if (mine.length >= c.maxWatches) return { ok: false, message: '已经在监控 ' + mine.length + ' 个了，先取消几个（/价格列表 看编号）。' }
      const items = await request(q, c.pages)
      if (!items.length) return { ok: false, message: '没找到和「' + q + '」相关的商品。换个说法试试，比如带上品牌或关键词。' }
      // 用户已经点过某个候选（面板）或回过编号（QQ）：按文章 id 精确锁定。
      // 否则同一件商品的多条爆料会让「选一个」永远选不完。
      const pick = String(options.pick || '').trim()
      if (pick) {
        const exact = items.find((i) => i.articleId === pick || i.url === pick)
        if (exact) return startWatch(exact, q, chatId, options.creatorId)
      }
      const picked = pickCandidates(q, items)
      if (picked.kind === 'many' || picked.kind === 'none') {
        const list = picked.options
        if (!list.length) return { ok: false, message: '没找到和「' + q + '」相关的商品。换个说法试试，比如带上品牌或关键词。' }
        // 让用户在 QQ 里按编号选，而不是直接挑一条塞给他
        state.pending = [...state.pending.filter((p) => !(p.chatId === chatId && p.kind === 'add')), { chatId, kind: 'add', query: q, at: nowMs(), options: list.map((item) => ({ articleId: item.articleId, title: item.title, mall: item.mall, price: item.price, priceText: item.priceText, url: item.url, key: item.key, quality: item.quality, qualityLabel: item.qualityLabel, points: item.points, comments: item.comments, collection: item.collection, worthy: item.worthy, unworthy: item.unworthy })) }].slice(-20)
        save()
        const head = picked.kind === 'many'
          ? '「' + q + '」匹配到好几个，回 /监控价格 编号 选一个：'
          : '没找到完全一致的，这几个看起来最接近，回 /监控价格 编号 选一个：'
        return { ok: true, message: head + '\n' + list.map((item, i) => (i + 1) + '. ' + qualityMark(item) + item.title.slice(0, 42) + '\n   ' + item.mall + ' · ' + priceText(item.price) + '\n   ' + item.url).join('\n'), options: list }
      }
      return startWatch(picked.item, q, chatId, options.creatorId)
    }

    /** creatorId 是发起监控的人，提醒时 @ 他；私聊添加时也有值，只是不 @。 */
    function startWatch (item, query, chatId, creatorId) {
      const c = conf()
      const mine = state.watches.filter((w) => w.chatId === chatId)
      const dup = mine.find((w) => w.key && item.key && w.key === item.key)
      if (dup) return { ok: true, watch: dup, message: '「' + dup.title.slice(0, 40) + '」已经在监控了。\n现在 ' + priceText(dup.price) + (Number.isFinite(Number(dup.lowest)) ? '，插件记录最低 ' + priceText(dup.lowest) : '') + '\n' + dup.url }
      const stamp = nowMs()
      if (item.key) observe(item.key, item.price, item.url, item.title, stamp)
      const record = recordOf(item.key)
      const watch = {
        id: idOf(),
        query: String(query || '').slice(0, 60),
        title: item.title,
        key: item.key,
        articleId: item.articleId,
        mall: item.mall,
        url: item.url,
        price: item.price,
        priceText: item.priceText,
        lowest: record && Number.isFinite(Number(record.lowest)) ? Number(record.lowest) : item.price,
        lowestAt: record && record.lowestAt ? record.lowestAt : stamp,
        quality: item.quality,
        qualityLabel: item.qualityLabel,
        points: item.points,
        comments: item.comments,
        collection: item.collection,
        worthy: item.worthy,
        unworthy: item.unworthy,
        chatId,
        creatorId: String(creatorId || ''),
        createdAt: stamp,
        lastCheck: stamp,
        alerts: 0,
        lastAlert: 0,
        seenQuality: item.quality ? [item.quality] : [],
        history: [{ at: stamp, price: item.price }],
      }
      state.watches = [...state.watches, watch].slice(-200)
      state.pending = state.pending.filter((p) => !(p.chatId === chatId && p.kind === 'add'))
      save()
      const bits = [watch.mall, priceText(watch.price)]
      const lines = ['开始监控：' + qualityMark(watch) + watch.title.slice(0, 60), bits.join(' · '), watch.url]
      if (Number.isFinite(Number(watch.lowest)) && Number(watch.price) > watch.lowest) lines.push('（插件记录最低 ' + priceText(watch.lowest) + '，现在不是低点）')
      return { ok: true, watch, message: lines.join('\n') }
    }

    /** 在已有候选项里按编号选一个。 */
    function choosePending (chatId, choice) {
      const pending = [...state.pending].reverse().find((p) => p.chatId === chatId && p.kind === 'add')
      if (!pending) return null
      const n = Number(String(choice).replace(/^[#\s]+/, ''))
      if (!Number.isInteger(n) || n < 1 || n > pending.options.length) return null
      return pending.options[n - 1]
    }

    // ---------- 查询价格 ----------
    const PLATFORM_ORDER = ['京东', '天猫', '天猫超市', '天猫国际', '拼多多', '抖音商城', '唯品会']
    function platformRank (mall) {
      const i = PLATFORM_ORDER.indexOf(mall)
      if (i >= 0) return i
      if (/京东/.test(mall)) return 0.5
      if (/天猫|淘宝/.test(mall)) return 1.5
      if (/拼多多/.test(mall)) return 4
      if (/抖音/.test(mall)) return 5
      return 20
    }

    function groupByMall (items) {
      const map = new Map()
      for (const item of items) {
        const mall = item.mall || '其他平台'
        if (!map.has(mall)) map.set(mall, [])
        map.get(mall).push(item)
      }
      return [...map.entries()]
        .map(([mall, rows]) => ({
          mall,
          items: rows
            .sort((a, b) => {
              const pa = Number.isFinite(a.price) ? a.price : Infinity
              const pb = Number.isFinite(b.price) ? b.price : Infinity
              if (pa !== pb) return pa - pb
              return (b.points || 0) - (a.points || 0)
            })
            .slice(0, 8),
        }))
        .sort((a, b) => platformRank(a.mall) - platformRank(b.mall))
    }

    /**
     * prior：查之前那一刻的记录快照。只有「以前就见过这件商品」才谈得上「比记录的最低价还低」，
     * 第一次看到就叫它最低价是没有信息量的噪音。
     */
    /**
     * 查价结果只列「最便宜的前 N 条」，而不是把每个平台的报价都铺出来 —— 群里最怕刷屏。
     * N 是设置里的 queryTopN（默认 3），想看更多就调大。
     */
    function searchText (query, items, prior = {}, topN = 3) {
      if (!items.length) return '没找到「' + query + '」的价格。换个说法试试，比如带上品牌或关键词。'
      const limit = Math.max(1, Math.min(20, Number(topN) || 3))
      const ranked = items
        .filter((item) => Number.isFinite(item.price) && item.price > 0)
        .sort((a, b) => a.price - b.price)
      const picked = ranked.slice(0, limit)
      if (!picked.length) return '「' + query + '」有 ' + items.length + ' 条爆料，但都没给出能比较的价格。'
      const lines = ['「' + query + '」最低 ' + picked.length + ' 条' + (items.length > picked.length ? '（共 ' + items.length + ' 条爆料）' : '') + '：']
      picked.forEach((item, i) => {
        const record = prior[item.key]
        const isLow = record && Number(record.observations) > 1 && Number.isFinite(Number(record.lowest)) && Number(item.price) <= Number(record.lowest) + 0.001
        const tags = [qualityMark(item), isLow ? '【插件记录最低】' : ''].filter(Boolean).join('')
        const note = item.priceText && /\d+\s*元/.test(String(item.priceText)) && String(item.priceText).length > 12
          ? '（' + item.priceText.replace(/^\s*[\d.]+\s*元/, '').trim() + '）'
          : ''
        lines.push((i + 1) + '. ' + priceText(item.price) + ' · ' + (item.mall || '未知平台') + ' ' + tags + item.title.slice(0, 38) + note)
        lines.push('   ' + item.url)
      })
      if (items.length > picked.length) lines.push('只列最低 ' + picked.length + ' 条；想多看几条，把面板「查询价格显示条数」调大。')
      return lines.join('\n')
    }

    // ---------- 检查 ----------
    /**
     * 提醒文案。previous 是检查前那份价格快照 —— 不能读 watch.price：
     * 那时候它已经被新价格覆盖了，会把「上次」写成新价。
     */
    function alertLine (watch, result, item, previous) {
      const currentPrice = Number(item ? item.price : watch.price)
      const prevPrice = previous ? Number(previous.price) : NaN
      const prevLowest = previous ? Number(previous.lowest) : Number(watch.lowest)
      const head = [qualityMark(item || watch), watch.title.slice(0, 56)].join('')
      const bits = []
      if (result.drop > 0) bits.push('↓' + priceText(result.drop))
      if (result.dropPercent !== null && result.dropPercent > 0) bits.push('降 ' + result.dropPercent + '%')
      const lines = ['【价格提醒】' + head]
      if (Number.isFinite(currentPrice) && currentPrice > 0) {
        lines.push('现在 ' + priceText(currentPrice) + (bits.length ? '（' + bits.join('，') + '）' : ''))
        if (Number.isFinite(prevPrice) && prevPrice > 0) lines.push('上次 ' + priceText(prevPrice) + ' · ' + (watch.mall || '未知平台'))
      } else {
        lines.push('价格未知')
      }
      if (Number.isFinite(prevLowest) && prevLowest > 0) {
        const isLower = Number.isFinite(currentPrice) && currentPrice < prevLowest
        const shown = isLower ? currentPrice : prevLowest
        lines.push((isLower ? '创下 ' : '插件记录最低 ') + priceText(shown))
      }
      if (watch.comments || watch.worthy || watch.collection) {
        lines.push('值 ' + watch.worthy + ' · 不值 ' + watch.unworthy + ' · 评论 ' + watch.comments + ' · 收藏 ' + watch.collection)
      }
      const reasons = result.reasons.length ? result.reasons : []
      if (reasons.includes('降价')) lines.push('比上次看到的价格便宜了')
      if (reasons.includes('历史最低')) lines.push('比插件记录过的最低价还低')
      if (reasons.length === 1 && reasons[0] === '超级好价') lines.push('社区投票已经把它投成了成熟好价')
      if (reasons.length === 1 && reasons[0] === '早期好价') lines.push('刚冒头的好价，互动还在涨')
      lines.push(item && item.url ? item.url : watch.url)
      return lines.join('\n')
    }

    /** 检查一个监控：重新查这件商品，更新价格，判断要不要提醒。 */
    async function checkOne (watch, c) {
      const items = await request(watch.title, 1)
      if (!items.length) return { ok: false, watch, message: '查不到这件商品了' }
      // 优先认指纹相同的；否则退回标题最像的
      let item = watch.key ? items.find((i) => i.key === watch.key) : null
      if (!item) {
        const picked = pickCandidates(watch.title, items, { threshold: 0.5, suggest: 1 })
        item = picked.kind === 'one' ? picked.item : (picked.options && picked.options[0]) || bestOf(items)
      }
      if (!item) return { ok: false, watch, message: '查不到这件商品了' }
      const stamp = nowMs()
      const before = { price: watch.price, lowest: watch.lowest, quality: watch.quality }
      const result = evaluateAlert({ price: watch.price, lowest: watch.lowest }, item.price, { dropPercent: c.dropPercent, dropAmount: c.dropAmount })
      const isNewLow = observe(watch.key || item.key, item.price, item.url, item.title, stamp)
      const record = recordOf(watch.key || item.key)
      // 好价是新出现的（之前没见过这个等级）才算一次「好价提醒」
      const qualityNew = c.onQuality && item.quality && !(watch.seenQuality || []).includes(item.quality)
      watch.price = item.price
      watch.priceText = item.priceText
      watch.mall = item.mall
      watch.url = item.url
      watch.title = item.title || watch.title
      watch.key = watch.key || item.key
      watch.quality = item.quality
      watch.qualityLabel = item.qualityLabel
      watch.points = item.points
      watch.comments = item.comments
      watch.collection = item.collection
      watch.worthy = item.worthy
      watch.unworthy = item.unworthy
      watch.lowest = record && Number.isFinite(Number(record.lowest)) ? Number(record.lowest) : Math.min(Number(watch.lowest) || Infinity, Number(item.price) || Infinity)
      watch.lowestAt = record && record.lowestAt ? record.lowestAt : stamp
      watch.lastCheck = stamp
      watch.history = [...(watch.history || []), { at: stamp, price: item.price }].slice(-60)
      if (item.quality && !(watch.seenQuality || []).includes(item.quality)) watch.seenQuality = [...(watch.seenQuality || []), item.quality].slice(-4)
      const alert = result.alert || qualityNew
      let message = ''
      if (alert) {
        const reasons = [...result.reasons]
        if (qualityNew && !reasons.length) reasons.push(item.qualityLabel)
        const cooled = watch.lastAlert && stamp - watch.lastAlert < c.cooldown
        if (!cooled) {
          watch.lastAlert = stamp
          watch.alerts = (Number(watch.alerts) || 0) + 1
          state.alerts = (Number(state.alerts) || 0) + 1
          message = alertLine(watch, { ...result, reasons }, item, before)
        }
      }
      return { ok: true, watch, alerted: Boolean(message), message, before, isNewLow }
    }

    /** 检查所有到期的监控，把提醒发到当初添加它的聊天。 */
    async function runChecks ({ only = null, manual = false } = {}) {
      const c = conf()
      if (!c.enabled) return { ok: false, message: '价格监控关着。' }
      if (busy) return { ok: false, message: '正在检查，等一下。' }
      if (disposed) return { ok: false, message: '价格监控已停用。' }
      const stamp = nowMs()
      // 定时任务只在监控时段内跑；手动检查是主人明确要求的，不受时段限制
      if (!manual && !withinWindow(hourInBeijing(stamp), c.startHour, c.endHour)) {
        state.lastResult = '不在监控时段（' + c.startHour + ' 至 ' + c.endHour + ' 点）'
        return { ok: true, checked: 0, alerts: 0, message: state.lastResult, skipped: 'window' }
      }
      expiring(c, stamp)
      // 手动（面板「立即检查」/ 工具）不看间隔，定时任务才按间隔挑到期的
      const due = state.watches
        .filter((w) => {
          if (only) return w.id === only
          if (manual) return true
          return !w.lastCheck || stamp - w.lastCheck >= c.intervalMinutes * 60000 - 5000
        })
        // 每轮最多查这么几个：一次打出去一堆提醒最容易刷屏
        .slice(0, only ? 1 : c.maxChecks)
      if (!due.length) {
        state.lastResult = only ? '没有这个监控' : manual ? '还没有在监控的商品' : '还没到下次检查时间'
        return { ok: true, checked: 0, alerts: 0, message: state.lastResult }
      }
      busy = true
      let alerts = 0
      let checked = 0
      const sent = []
      try {
        for (const watch of due) {
          if (disposed) break
          try {
            const out = await checkOne(watch, c)
            checked++
            if (out.ok) {
              state.lastResult = clock(stamp) + ' 查了 ' + watch.title.slice(0, 20) + '：' + priceText(watch.price)
            } else {
              state.lastResult = clock(stamp) + ' ' + out.message
            }
            if (out.alerted && out.message) {
              if (api.config().dryRun) {
                log.info('试运行：本该发价格提醒 ' + watch.title.slice(0, 20) + '，现在 ' + priceText(watch.price))
              } else if (!chatAllowed(watch.chatId, c)) {
                // 群被移出白名单后不再往那儿发，也不占用「已提醒」计数
                log.info('价格监控：' + watch.chatId + ' 已不在白名单，跳过提醒')
              } else {
                const ok = await api.sendText(watch.chatId, withMention(watch.chatId, watch.creatorId, out.message, c))
                if (ok !== null && ok !== undefined) {
                  alerts++
                  sent.push({ id: watch.id, title: watch.title, message: out.message })
                  log.info('价格提醒已发到 ' + watch.chatId + '：' + watch.title.slice(0, 30) + ' ' + priceText(watch.price))
                } else {
                  log.warn('价格提醒没发出去：' + watch.chatId)
                }
              }
            }
          } catch (error) {
            if (disposed) break
            state.lastResult = clock(stamp) + ' 检查失败：' + (error && error.message ? error.message : error)
            log.warn('价格监控检查失败：' + (error && error.message ? error.message : error))
          }
          save()
        }
        state.lastCheck = stamp
        state.checks = (Number(state.checks) || 0) + 1
        save()
        return { ok: true, checked, alerts, message: state.lastResult, sent }
      } finally {
        busy = false
      }
    }

    /** 清理过期的监控：超过 TTL 没更新就自动取消。 */
    function expiring (c, stamp) {
      if (!c.ttl) return
      const before = state.watches.length
      state.watches = state.watches.filter((w) => stamp - (Number(w.lastCheck) || Number(w.createdAt) || stamp) < c.ttl)
      if (state.watches.length !== before) {
        log.info('价格监控：' + (before - state.watches.length) + ' 个监控超过 ' + Math.round(c.ttl / 86400000) + ' 天没更新，已自动取消')
        save()
      }
    }

    // ---------- QQ 命令 ----------
    const isOwner = (msg) => api.isOwner(msg && msg.userId)

    async function cmdWatch (arg, msg) {
      const c = conf()
      const text = String(arg || '').trim()
      if (!text) return '要监控什么？发 /监控价格 商品名，比如 /监控价格 switch 2。'
      if (!c.enabled) return '价格监控关着。先在面板里打开。'
      if (!chatAllowed(msg.chatId, c)) return '这个群还没加进价格监控白名单，先让主人在面板「平台 → 价格监控」里把群号加上。'
      if (!isOwner(msg) && !c.guestWatch) return '这个只有主人能加。'
      try {
        // 先看看是不是在回答「选哪个」：「/监控价格 2」
        const chosen = /^\d{1,2}$/.test(text) ? choosePending(msg.chatId, text) : null
        if (chosen) {
          const c2 = conf()
          if (!c2.enabled) return '价格监控关着。'
          const mine = state.watches.filter((w) => w.chatId === msg.chatId)
          if (mine.length >= c2.maxWatches) return '已经在监控 ' + mine.length + ' 个了，先取消几个（/价格列表 看编号）。'
          // 按文章 id 精确锁定那次候选，避免同款多条爆料又回到「选一个」
          const exact = await addWatch(chosen.title, msg.chatId, { pick: chosen.articleId || chosen.url, creatorId: msg.userId })
          if (exact.ok) return exact.message
          // 那条爆料已经不在了，就用手上这份候选直接建档
          const out = startWatch({ ...chosen, quality: chosen.quality || '', qualityLabel: chosen.qualityLabel || '', points: chosen.points || 0, comments: chosen.comments || 0, collection: chosen.collection || 0, worthy: chosen.worthy || 0, unworthy: chosen.unworthy || 0, key: chosen.key || productKey(chosen.title, 6) }, chosen.title, msg.chatId, msg.userId)
          return out.message
        }
        const out = await addWatch(text, msg.chatId, { creatorId: msg.userId })
        return out.message || (out.ok ? '好了' : '没成功')
      } catch (error) {
        log.warn('加监控失败：' + (error && error.message ? error.message : error))
        return '查价格出错了：' + (error && error.message ? error.message : '未知错误') + '。稍后再试。'
      }
    }

    async function cmdQuery (arg, msg) {
      const c = conf()
      const text = String(arg || '').trim()
      if (!text) return '要查什么？发 /查询价格 商品名或链接。'
      if (!c.enabled) return '价格监控关着。'
      if (!isOwner(msg) && !c.guestQuery) return '这个只有主人能查。'
      try {
        // 允许直接发链接（什么值得买的能换回商品名，其它平台的会给出提示）
        const resolved = await resolveQuery(text)
        if (resolved.note && !resolved.query) return resolved.note
        const keyword = resolved.query || text
        const items = await request(keyword, c.pages)
        // 先照一张记录快照，再写新观测：这样「比记录最低还低」只对以前见过的商品说
        const prior = JSON.parse(JSON.stringify(state.records || {}))
        const stamp = nowMs()
        for (const item of items) observe(item.key, item.price, item.url, item.title, stamp)
        save()
        const body = searchText(keyword, items, prior, c.queryTopN)
        // 从链接认出来的，先说一句，免得用户以为是凭空搜的
        return resolved.note && resolved.query !== text ? resolved.note + '\n' + body : body
      } catch (error) {
        log.warn('查价格失败：' + (error && error.message ? error.message : error))
        return '查价格出错了：' + (error && error.message ? error.message : '未知错误') + '。稍后再试。'
      }
    }

    function cmdList (arg, msg) {
      return listText(msg.chatId)
    }

    function cmdUnwatch (arg, msg) {
      const text = String(arg || '').trim()
      const mine = state.watches.filter((w) => w.chatId === msg.chatId)
      if (!mine.length) return '现在没有在监控的商品。'
      let target = null
      if (/^\d{1,3}$/.test(text)) {
        target = mine[Number(text) - 1] || null
      } else if (text) {
        target = mine.find((w) => w.id === text) || mine.find((w) => w.title.includes(text)) || null
      }
      if (!target) return '要取消哪个？发 /价格列表 看编号，再发 /取消监控 编号。'
      state.watches = state.watches.filter((w) => w.id !== target.id)
      save()
      return '已取消监控：' + target.title.slice(0, 50)
    }

    api.command({ name: '价格监控帮助', aliases: ['价格帮助', 'price_help', 'price_watch_help'], desc: '价格监控用法', run: () => helpText() })
    api.command({ name: '监控价格', aliases: ['监控', 'price_watch', 'watch_price'], desc: '开始监控一个商品：/监控价格 商品名', run: cmdWatch })
    api.command({ name: '查询价格', aliases: ['查价格', '比价', 'price_query', 'price_compare'], desc: '多平台价格搜索：/查询价格 商品名', run: cmdQuery })
    api.command({ name: '价格列表', aliases: ['监控列表', 'price_list'], desc: '看正在监控的商品', run: cmdList })
    api.command({ name: '取消监控', aliases: ['取消价格', 'price_unwatch'], desc: '取消一个监控：/取消监控 编号', run: cmdUnwatch })

    // 主人的命令由中枢执行；非主人（allowGuest*）这里接管，同时把主人那几条命令吞掉，
    // 免得她再对「/监控价格」本身回一句。
    const OWN_CN = /^[\/／]\s*(?:价格帮助|价格监控帮助|监控价格|查询价格|价格列表|取消监控|监控列表|查价格|比价|监控|取消价格)/
    const OWN_EN = /^[\/／]\s*(?:price_help|price_watch_help|price_watch|price_query|price_compare|price_list|price_unwatch|watch_price)(?![a-z0-9_-])/i
    api.on('message', async (msg) => {
      if (disposed) return false
      const text = String(msg.text || '').trim()
      if (!/^[\/／]/.test(text)) return false
      if (api.isOwner(msg.userId)) return OWN_CN.test(text) || OWN_EN.test(text)
      const c = conf()
      const match = text.match(/^[\/／]\s*(监控价格|查询价格|查价格|比价|监控|价格监控帮助|价格帮助|价格列表|取消监控)([\s\S]*)$/)
      if (!match) return false
      const word = match[1]
      const arg = String(match[2] || '').trim()
      const reply = (t) => api.reply(msg, t)
      if (word === '价格监控帮助' || word === '价格帮助') { await reply(helpText()); return true }
      if (word === '价格列表' || word === '取消监控') { await reply('监控列表只有主人能看。'); return true }
      if (!c.enabled) { await reply('价格监控关着。'); return true }
      if (!chatAllowed(msg.chatId, c)) { await reply('这个群还没加进价格监控白名单，先让主人在面板「平台 → 价格监控」里把群号加上。'); return true }
      if (word === '查询价格' || word === '查价格' || word === '比价') {
        if (!c.guestQuery) { await reply('查价只有主人能用。'); return true }
        await reply(await cmdQuery(arg, msg))
        return true
      }
      if (!c.guestWatch) { await reply('加监控只有主人能做。'); return true }
      await reply(await cmdWatch(arg, msg))
      return true
    })

    // ---------- 给她用的工具（主人私聊 / 群聊都能用，写操作只认主人） ----------
    api.tool(({ chat, sessionId }) => {
      if (disposed || !chat || chat.kind === 'system') return []
      const c = conf()
      if (!c.enabled) return []
      // 白名单外的群连工具都不给，免得她在那儿「帮」群友查价
      if (!chatAllowed(chat.chatId, c)) return []
      const owner = api.core.hub.turnHasOwner(sessionId)
      return [
        api.defineTool({
          name: 'price_query',
          description: '查询一件商品在多个平台的价格，返回按平台分组的最低价和链接。别人问「这个多少钱」「帮我比个价」时用。query 可以是商品名、关键词，也可以直接给什么值得买的链接。',
          properties: { query: { type: 'string', description: '商品名、关键词，或什么值得买的商品链接，比如 switch 2、索尼降噪耳机' } },
          required: ['query'],
          execute: async ({ query }) => {
            const text = String(query || '').trim()
            if (!text) return { ok: false, message: '要查什么商品？' }
            try {
              const resolved = await resolveQuery(text)
              if (resolved.note && !resolved.query) return { ok: false, message: resolved.note }
              const keyword = resolved.query || text
              const items = await request(keyword, conf().pages)
              const body = searchText(keyword, items, {}, conf().queryTopN)
              return { ok: true, message: resolved.query !== text && resolved.note ? resolved.note + '\n' + body : body }
            } catch (error) {
              return { ok: false, message: '查价格失败：' + (error && error.message ? error.message : error) }
            }
          },
        }),
        api.defineTool({
          name: 'price_watch_add',
          description: '开始监控一件商品的价格，价格降了或者创下记录最低时提醒。只有主人能用。query 可以是商品名，也可以直接给什么值得买的链接。',
          properties: { query: { type: 'string', description: '商品名、关键词，或什么值得买的商品链接' } },
          required: ['query'],
          execute: async ({ query }) => {
            if (!owner) return { ok: false, message: '加价格监控要主人开口。' }
            const out = await addWatch(String(query || '').trim(), chat.chatId, { creatorId: chat.userId })
            return { ok: out.ok, message: out.message }
          },
        }),
        api.defineTool({
          name: 'price_watch_list',
          description: '看当前在监控哪些商品、各自的价格和记录最低价。',
          execute: async () => ({ ok: true, message: listText(chat.chatId) }),
        }),
        api.defineTool({
          name: 'price_watch_check',
          description: '马上检查一遍监控中的商品，返回有没有降价或历史最低。',
          execute: async () => {
            const out = await runChecks({ manual: true })
            if (out.ok === false) return { ok: false, message: out.message }
            if (!out.checked) return { ok: true, message: out.message || '现在没有需要更新的商品。' }
            return { ok: true, message: '查了 ' + out.checked + ' 个，' + (out.alerts ? '发了 ' + out.alerts + ' 条提醒。' : '这次没有降价。') }
          },
        }),
      ]
    })
    api.rule(() => '你能查商品价格：别人问某件东西多少钱、哪里便宜时用 price_query；主人让你盯着某件商品降价时用 price_watch_add。价格来自什么值得买的公开爆料，是爆料里的价格，购买条件要看原文链接。你说「记录最低价」时指的是你开始监控之后见到的价格，不要说成全网历史最低。')

    // ---------- 定时检查 ----------
    timer = setInterval(() => {
      runChecks().catch((error) => log.warn('价格监控定时检查出错：' + (error && error.message ? error.message : error)))
    }, 60000)
    timer.unref?.()

    // ---------- 面板接口 ----------
    const watchView = (w) => ({
      id: w.id,
      query: w.query,
      title: w.title,
      key: w.key || '',
      mall: w.mall || '',
      url: w.url || '',
      price: Number.isFinite(Number(w.price)) ? Number(w.price) : null,
      priceText: w.priceText || '',
      lowest: Number.isFinite(Number(w.lowest)) ? Number(w.lowest) : null,
      lowestAt: w.lowestAt || 0,
      quality: w.quality || '',
      qualityLabel: w.qualityLabel || '',
      points: Number(w.points) || 0,
      comments: Number(w.comments) || 0,
      collection: Number(w.collection) || 0,
      worthy: Number(w.worthy) || 0,
      unworthy: Number(w.unworthy) || 0,
      createdAt: w.createdAt || 0,
      lastCheck: w.lastCheck || 0,
      chatId: w.chatId || '',
      creatorId: w.creatorId || '',
      alerts: Number(w.alerts) || 0,
      history: (w.history || []).slice(-30),
    })

    api.route('/state', async () => {
      const c = conf()
      return {
        ok: true,
        enabled: c.enabled,
        busy,
        intervalMinutes: c.intervalMinutes,
        lastRun: state.lastCheck,
        lastResult: state.lastResult,
        groupWhitelist: c.groupWhitelist,
        whitelist: [...c.whitelist],
        mentionOwner: c.mentionOwner,
        window: { startHour: c.startHour, endHour: c.endHour },
        maxChecksPerRun: c.maxChecks,
        queryTopN: c.queryTopN,
        watches: state.watches.map(watchView),
        records: state.records,
        stats: { watches: state.watches.length, alerts: Number(state.alerts) || 0, checkedAt: state.lastCheck, checks: Number(state.checks) || 0 },
      }
    })

    api.route('/search', async (req) => {
      try {
        const body = await api.core.http.body(req)
        const raw = String((body && body.query) || '').trim()
        if (!raw) return { ok: false, message: '要查什么商品？' }
        const c = conf()
        // 面板里粘贴链接也认
        const resolved = await resolveQuery(raw)
        if (resolved.note && !resolved.query) return { ok: false, message: resolved.note }
        const query = resolved.query || raw
        const items = await request(query, c.pages)
        if (!items.length) return { ok: false, message: '没找到「' + query + '」的价格，换个说法试试。' }
        const prior = JSON.parse(JSON.stringify(state.records || {}))
        const stamp = nowMs()
        for (const item of items) observe(item.key, item.price, item.url, item.title, stamp)
        save()
        const text = searchText(query, items, prior, c.queryTopN)
        // 面板里按平台分组也只放前 N 条，和聊天里的口径一致
        const groups = groupByMall(items).map((group) => ({ ...group, items: group.items.slice(0, c.queryTopN), total: group.items.length }))
        return { ok: true, message: resolved.query !== raw && resolved.note ? resolved.note + '\n' + text : text, groups, topN: c.queryTopN }
      } catch (error) {
        return { ok: false, message: '查价失败：' + (error && error.message ? error.message : error) }
      }
    })

    api.route('/add', async (req) => {
      try {
        const body = await api.core.http.body(req)
        const query = String((body && body.query) || '').trim()
        if (!query) return { ok: false, message: '要监控什么商品？' }
        // pick：面板点了某个候选时带上它的 articleId，精确认领，不再让用户重选一次
        const pick = String((body && (body.articleId || body.pick)) || '').trim()
        const out = await addWatch(query, 'private:' + String(api.config().ownerQQ || 'owner'), { pick, creatorId: String(api.config().ownerQQ || '') })
        if (out.options) return { ok: true, message: out.message, options: out.options.map((i) => ({ articleId: i.articleId, title: i.title, mall: i.mall, price: i.price, priceText: i.priceText, url: i.url })) }
        return { ok: out.ok, message: out.message, watch: out.watch ? watchView(out.watch) : undefined }
      } catch (error) {
        return { ok: false, message: '加监控失败：' + (error && error.message ? error.message : error) }
      }
    })

    api.route('/remove', async (req) => {
      try {
        const body = await api.core.http.body(req)
        const id = String((body && body.id) || '').trim()
        const before = state.watches.length
        state.watches = state.watches.filter((w) => w.id !== id)
        if (state.watches.length === before) return { ok: false, message: '没有这个监控。' }
        save()
        return { ok: true, message: '已取消监控。' }
      } catch (error) {
        return { ok: false, message: '取消失败：' + (error && error.message ? error.message : error) }
      }
    })

    api.route('/check', async (req) => {
      let id = ''
      try {
        const body = await api.core.http.body(req)
        id = String((body && body.id) || '').trim()
      } catch (error) {}
      try {
        const out = await runChecks({ only: id || null, manual: true })
        if (out.ok === false) return out
        return { ok: true, message: out.alerts ? '检查完成，发了 ' + out.alerts + ' 条提醒。' : '检查完成，' + out.checked + ' 个商品，没有降价。', checked: out.checked, alerts: out.alerts }
      } catch (error) {
        return { ok: false, message: '检查失败：' + (error && error.message ? error.message : error) }
      }
    })

    return {
      version: VERSION,
      tick: () => runChecks(),
      check: () => runChecks({ manual: true }),
      search: (query) => cmdQuery(query, { chatId: 'system:panel', userId: String(api.config().ownerQQ || ''), kind: 'private' }),
      list: () => state.watches.map(watchView),
      state: () => ({ watches: state.watches.map(watchView), records: state.records, lastCheck: state.lastCheck }),
    }
  },
}
