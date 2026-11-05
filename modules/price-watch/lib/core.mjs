// 价格监控的纯逻辑：价格解析、商品指纹、好价判定、匹配打分。
//
// 好价判定沿用 什么值得买 好价监控（extensions/smzdm-monitor）的筛选口径，
// 但只保留两条：超级好价、早期好价。那边还有均衡热度、高讨论、早期强信号、升温好价，
// 这里都不参与判定。
//
// 这里不碰网络、不碰磁盘、不碰 api，全部是纯函数，方便直接单测。

/**
 * 从什么值得买的 article_price 文本里取当前售价。
 * 「68.52元（需买2件，共137.04元）」是单价；「3590元（淘金币可抵25元起）」是抵扣前的价格。
 * 返还额、满减门槛、赠品面值、原价都不是售价，要跳过。
 */
export function parsePrice (text) {
  const raw = String(text === undefined || text === null ? '' : text).replace(/,/g, '')
  const values = []
  const re = /(\d+(?:\.\d+)?)\s*元/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const before = raw.slice(Math.max(0, m.index - 16), m.index)
    // 返还额、满减门槛、赠品面值、原价、抵扣额：都不是当前售价
    if (/(?:返(?:还)?|退(?:还)?|赠|送|赔|满|减|立减|省|原价|价值|面值|券面额|可抵|抵扣|抵)\s*$/.test(before)) continue
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) values.push(n)
    // 只取第一个出现的「元」金额作为主价格；后面括号里的通常是用券 / 凑单备注
    break
  }
  if (!values.length) return null
  return Math.round(values[0] * 100) / 100
}

/** 只看数字金额（给面板显示用）：19.9元（需用券）→ 19.9 */
export function formatPrice (value) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return (Math.round(n * 100) / 100).toString()
}

/**
 * 商品指纹：把同一件商品在不同爆料里的标题归一成同一个 key。
 * 这里只做轻量归一：去括号里的用券 / 满减说明、去促销前缀、去标点、压空白。
 * 归一不到足够长度就返回空串（不参与历史价比较），避免把一堆短标题混成一件商品。
 */
export function productKey (title, minLength = 6) {
  let text = String(title || '').toLowerCase()
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/[[](?:[^\]]*(?:券|优惠|返|plus|会员|满减|到手|需买|凑单|可抵|补贴))[^\]]*[]]/g, '')
  text = text.replace(/[（(](?:[^）)]*(?:券|优惠|返|plus|会员|满减|到手|需买|凑单|可抵|补贴))[^）)]*[）)]/g, '')
  const promo = ['移动端', 'plus会员', '88vip', '值友专享', '今日必买', '拼多多百亿补贴', '百亿补贴', '淘金币可用', '历史低价', '历史新低', '新低价', '新低', '限地区', '限时', '临期品', '凑单品', '需用券', '券后', '下单立减', '满减', '可用券', '可用', '官方旗舰店', '旗舰店']
  for (const word of promo) text = text.split(word).join('')
  text = text.replace(/\d+(?:\.\d+)?\s*元/g, '')
  text = text.replace(/[（(](?:\d+色|多色|多款)可选[）)]/g, '')
  text = text.replace(/[^\w\u4e00-\u9fff]+/g, '')
  if (text.length < minLength) return ''
  return text.slice(0, 80)
}

/** 值票支持率：值 / (值 + 不值)，没人投票返回 null。 */
export function scoreRate (worthy, unworthy) {
  const w = Math.max(0, Number(worthy) || 0)
  const u = Math.max(0, Number(unworthy) || 0)
  if (w + u <= 0) return null
  return w / (w + u)
}

/** 综合热度分：评论 * 3 + 收藏 * 2 + 值票。和 smzdm-monitor 的公式一致。 */
export function heatScore ({ comments = 0, collection = 0, worthy = 0 } = {}) {
  return Math.max(0, Number(comments) || 0) * 3 + Math.max(0, Number(collection) || 0) * 2 + Math.max(0, Number(worthy) || 0)
}

const PATHS = [
  {
    key: 'super',
    label: '超级好价',
    // 值票、评论、收藏都充分，社区已经把它投成了成熟好价
    test: ({ comments, worthy, collection, score, meetsRate }) =>
      comments >= 20 && worthy >= 20 && collection >= 10 && score >= 120 && meetsRate(0.90),
  },
  {
    key: 'early',
    label: '早期好价',
    // 信号刚起来：值票和评论够看，收藏也在涨，但还没到超级好价
    test: ({ comments, worthy, collection, engagement, score, meetsRate }) =>
      worthy >= 4 && comments >= 6 && collection >= 4 && engagement >= 16 && score >= 35 && meetsRate(0.95),
  },
]

/**
 * 这个商品算不算好价。返回 { quality: 'super'|'early'|'', label }。
 * 基础门槛：至少 2 个值票或 2 条评论，售罄 / 过期直接不算。
 *
 * 「值票支持率」有一个受控的小样本例外：值票 ≥ 6、不值 ≤ 1 时按 85% 算，
 * 免得「6 值 : 1 不值」被 95% 门槛一票否决。这是 smzdm-monitor 原样的规则。
 */
export function qualityOf (item = {}) {
  const comments = Math.max(0, Number(item.comments) || 0)
  const collection = Math.max(0, Number(item.collection) || 0)
  const worthy = Math.max(0, Number(item.worthy) || 0)
  const unworthy = Math.max(0, Number(item.unworthy) || 0)
  const soldOut = Boolean(item.soldOut)
  const ended = Boolean(item.ended)
  const base = { comments, collection, worthy, unworthy }
  const engagement = comments + collection + worthy
  const score = heatScore(base)
  const rate = scoreRate(worthy, unworthy)
  const none = { quality: '', label: '', score, rate }
  if (soldOut || ended) return none
  if (worthy < 2 && comments < 2) return none
  // 值票为 0 时没有支持率可言，按 0 处理
  const actual = rate === null ? 0 : rate
  // 全局下限：票数够多还低于 85% 的直接不算好价
  if (worthy + unworthy >= 3 && actual < 0.85) return none
  // 小样本例外：值 ≥6、不值 ≤1 时，允许 85% 继续参加路径判断
  const meetsRate = (required) =>
    actual >= required || (worthy >= 6 && unworthy <= 1 && actual >= 0.85)
  const probe = { ...base, engagement, score, rate: actual, meetsRate }
  for (const path of PATHS) {
    if (path.test(probe)) return { quality: path.key, label: path.label, score, rate }
  }
  return none
}

/** 文本归一成用来比对的词袋：小写、去标点、按空白切。 */
function tokens (text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * 用户输入「switch 2」这种查询和爆料标题的匹配打分。
 * 返回 0~1；全部关键词都命中才算高相关，只命中一部分算候选。
 * 中文按「输入串是否出现在标题里」判断，英文按词边界。
 */
export function matchScore (query, title) {
  const q = String(query || '').trim()
  if (!q) return 0
  const haystack = String(title || '').toLowerCase()
  if (!haystack) return 0
  const hay = tokens(title)
  const haySet = new Set(hay)
  const hayJoined = hay.join('')
  const parts = q.toLowerCase().split(/\s+/).filter(Boolean)
  const cjk = /[\u4e00-\u9fff]/.test(q)
  let hit = 0
  for (const part of parts) {
    if (cjk) {
      // 中文没有词边界：整串在标题里出现就算命中
      if (hayJoined.includes(part)) hit++
      else if (part.length >= 2) {
        // 退一步：按两字片段命中率算，避免「索尼降噪耳机」整串不在标题里就判 0
        let small = 0
        for (let i = 0; i + 2 <= part.length; i++) if (hayJoined.includes(part.slice(i, i + 2))) small++
        const total = Math.max(1, part.length - 1)
        const cover = small / total
        if (cover >= 0.6) hit += cover
      }
    } else if (haySet.has(part) || hayJoined.includes(part)) {
      hit++
    }
  }
  const base = parts.length ? hit / parts.length : 0
  // 完全匹配整串额外加分，让最贴切的那条排在前面
  const exact = hayJoined.includes(q.toLowerCase().replace(/\s+/g, '')) ? 0.15 : 0
  return Math.min(1, base + exact)
}

/**
 * 从搜索结果里挑要监控的那个商品。
 * 返回 { kind: 'one', item } | { kind: 'many', options } | { kind: 'none', options }。
 * 「多个」和「没有」都带候选项，让用户在 QQ 里按编号选，而不是直接失败。
 */
export function pickCandidates (query, items, { threshold = 0.6, suggest = 5 } = {}) {
  const scored = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, score: matchScore(query, item.title) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.item.price || Infinity) - (b.item.price || Infinity))
  const strong = scored.filter((x) => x.score >= threshold)
  const pool = strong.length ? strong : scored
  if (!pool.length) return { kind: 'none', options: [] }
  // 同一件商品（指纹相同）只留最便宜的那一条，别让同款的不同爆料互相顶掉
  const seen = new Set()
  const unique = []
  for (const row of pool) {
    const key = row.item.key || row.item.articleId || row.item.title
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  if (strong.length && unique.length === 1) return { kind: 'one', item: unique[0].item }
  // 强匹配只有一条、其余都是弱候选：仍然算唯一
  if (strong.length && unique.length > 1) {
    return { kind: 'many', options: unique.slice(0, suggest).map((x) => x.item) }
  }
  if (unique.length === 1) return { kind: 'one', item: unique[0].item }
  return { kind: 'none', options: unique.slice(0, suggest).map((x) => x.item) }
}

/**
 * 这次检查要不要提醒。
 * 只有两种情况提醒：价格明显下降，或创下本插件记录的最低价。
 * 返回 { alert: boolean, reasons: string[], drop: number, dropPercent: number }。
 */
export function evaluateAlert (record, currentPrice, opts = {}) {
  const dropPercent = Math.max(0, Number(opts.dropPercent === undefined ? 5 : opts.dropPercent) || 0)
  const dropAmount = Math.max(0, Number(opts.dropAmount === undefined ? 5 : opts.dropAmount) || 0)
  const reasons = []
  const price = Number(currentPrice)
  if (!Number.isFinite(price) || price <= 0) return { alert: false, reasons, drop: 0, dropPercent: null }
  const previous = record && Number(record.price)
  const lowest = record && Number(record.lowest)
  const hasPrevious = Number.isFinite(previous) && previous > 0
  let drop = 0
  let percent = null
  if (hasPrevious && previous > price) {
    drop = Math.round((previous - price) * 100) / 100
    percent = Math.round((drop / previous) * 1000) / 10
    const byAmount = dropAmount > 0 && drop >= dropAmount
    const byPercent = dropPercent > 0 && percent >= dropPercent
    if (byAmount || byPercent) reasons.push('降价')
  }
  // 只有确实记录过最低价、并且这次更低，才算「历史最低」。
  // 没有最低价记录时不当成新低：宁可少报，也不把一次小波动说成历史最低。
  const hasLowest = Number.isFinite(lowest) && lowest > 0
  if (hasLowest && price < lowest) reasons.push('历史最低')
  return { alert: reasons.length > 0, reasons, drop, dropPercent: percent }
}

/** 北京时间当天（用来判断提醒冷却是不是同一天）。 */
export function shanghaiDay (ts) {
  const n = Number(ts)
  if (!Number.isFinite(n)) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(n))
}

export default { parsePrice, formatPrice, productKey, scoreRate, heatScore, qualityOf, matchScore, pickCandidates, evaluateAlert, shanghaiDay }
