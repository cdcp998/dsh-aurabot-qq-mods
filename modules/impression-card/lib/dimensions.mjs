// 印象卡片的维度定义、雷达维度挑选，以及全模块共用的小工具。
// 这里只放纯函数，不碰网络、文件和 Aurabot 的 api —— 测试可以直接跑。

export const DEFAULT_SCORE = 5
export const DEFAULT_SCALE_MIN = 0
export const DEFAULT_SCALE_MAX = 10
export const DEFAULT_TOTAL_LABEL = '好感度'
export const DEFAULT_RADAR_TOP_N = 5

// 旧版本改过名的维度：旧 key 自动映射到新 key，不丢数据（与参考插件一致）。
export const LEGACY_DIMENSION_ALIASES = { trouble: 'peace', threat: 'safety' }

// 出厂维度：22 项，对齐大阿尔卡纳数量。全部是正向表述（越高越好），可以任意增删改。
export const DEFAULT_DIMENSIONS = [
  { key: 'familiarity', label: '熟悉', description: '认识多久、了解多深' },
  { key: 'trust', label: '信赖', description: '对她的信任程度' },
  { key: 'joy', label: '欢乐', description: '带来的快乐与整活贡献' },
  { key: 'peace', label: '省心', description: '乖巧省心、少添乱' },
  { key: 'clinginess', label: '贴贴', description: '亲密与粘人程度' },
  { key: 'abstract', label: '抽象', description: '发言抽象整活、不可名状但乐子足' },
  { key: 'quality', label: '含金量', description: '发言的质量与信息含量' },
  { key: 'wavelength', label: '合拍', description: '和她聊得来、脑电波契合' },
  { key: 'safety', label: '安心', description: '相处让人放心、不觉得有威胁' },
  { key: 'generosity', label: '慷慨', description: '投喂、发红包、请客的大方程度' },
  { key: 'intelligence', label: '智力', description: '脑子转得快不快' },
  { key: 'charm', label: '魅力', description: '讨不讨人喜欢' },
  { key: 'vitality', label: '活跃', description: '在群里的活跃度与参与感' },
  { key: 'luck', label: '幸运', description: '欧不欧、运气好不好' },
  { key: 'chaos', label: '混沌', description: '带来的混沌感与活力、不可预测的乐子' },
  { key: 'chuuni', label: '中二', description: '中二戏精浓度（高也可能是萌点）' },
  { key: 'fate', label: '缘分', description: '和她的羁绊与宿命契合' },
  { key: 'intuition', label: '直觉', description: '读空气、猜中她心思' },
  { key: 'rebellion', label: '不羁', description: '自由不羁、有主见不按套路出牌' },
  { key: 'mystery', label: '神秘', description: '人设留有悬念、让人想继续了解' },
  { key: 'devotion', label: '虔诚', description: '对她或本群的忠诚与向心力' },
  { key: 'hope', label: '希望', description: '带来的期待感与正向可能' },
]

/** 数字好看一点：整数不带小数，否则保留一位。 */
export function formatNum (value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  const rounded = Math.round(n * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** 带符号的增量：+2 / -1.5 / +0。 */
export function formatDelta (value) {
  const n = Number(value) || 0
  return (n >= 0 ? '+' : '') + formatNum(n)
}

export function formatScaleRange (scaleMin, scaleMax) {
  return formatNum(scaleMin) + '–' + formatNum(scaleMax)
}

/** 给模型看的分值口径说明（和参考插件一致）。 */
export function scoreGuidanceText (opts) {
  const o = opts || {}
  const defaultScore = o.defaultScore === undefined ? DEFAULT_SCORE : o.defaultScore
  const scaleMin = o.scaleMin === undefined ? DEFAULT_SCALE_MIN : o.scaleMin
  const scaleMax = o.scaleMax === undefined ? DEFAULT_SCALE_MAX : o.scaleMax
  return '各维度与好感度本身的默认中间值都是 ' + formatNum(defaultScore) +
    '；虽无硬性上下限，但一般会在 ' + formatScaleRange(scaleMin, scaleMax) +
    ' 之间浮动，少数情况可故意越界以达成夸张效果。所有子项均为「越高越好」的正向表述：加分表示认可，扣分表示不满。' +
    '好感度是一个独立的整体评分，并非各维度之和或平均。'
}

const KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/

/** 把任意文本压成合法 key。 */
export function normalizeKey (raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase()
  if (KEY_RE.test(text)) return text
  const ascii = text.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  if (ascii && KEY_RE.test(ascii)) return ascii
  // 纯中文等无法转写的标签：用稳定短哈希，保证同一标签每次 key 都一样。
  let hash = 0
  for (const ch of String(raw)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
  return 'dim-' + hash.toString(36).slice(0, 6)
}

export function defaultDimensions () {
  return DEFAULT_DIMENSIONS.map((d) => ({ ...d }))
}

/**
 * 解析面板里填的维度配置。一行一个维度，支持三种写法：
 *   key = 标签 | 描述   （推荐）
 *   key | 标签 | 描述
 *   标签                （自动生成 key，描述留空）
 * 空字符串 = 用内置 22 项；# 开头的一行是注释。
 */
export function parseDimensionConfig (raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!text) return defaultDimensions()
  const out = []
  const seen = new Set()
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue
    const eq = trimmed.indexOf('=')
    let key = ''
    let label = ''
    let description = ''
    if (eq > 0) {
      key = trimmed.slice(0, eq).trim()
      const rest = trimmed.slice(eq + 1)
      const bar = rest.indexOf('|')
      if (bar >= 0) { label = rest.slice(0, bar).trim(); description = rest.slice(bar + 1).trim() } else label = rest.trim()
    } else {
      const parts = trimmed.split('|')
      if (parts.length >= 2) { key = parts[0].trim(); label = parts[1].trim(); description = parts.slice(2).join('|').trim() } else label = trimmed
    }
    label = label || key
    if (!label) continue
    key = normalizeKey(key || label)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ key, label: label.slice(0, 12), description: description.slice(0, 120) })
  }
  return out.length ? out : defaultDimensions()
}

/** 维度表给 prompt 用的一行行说明。 */
export function dimensionDoc (dimensions) {
  return (dimensions || []).map((d) => '- ' + d.key + '（' + d.label + '）：' + (d.description || d.label)).join('\n')
}

/** 按 key 找维度；接受 key、标签或旧别名。找到返回维度，找不到 null。 */
export function findDimension (dimensions, raw) {
  const input = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!input) return null
  const lower = input.toLowerCase()
  const canonical = LEGACY_DIMENSION_ALIASES[input] || LEGACY_DIMENSION_ALIASES[lower] || input
  const target = String(canonical).toLowerCase()
  for (const d of dimensions || []) {
    if (d.key === canonical || d.key.toLowerCase() === target || d.label === input) return d
  }
  return null
}

/**
 * 挑雷达图要显示的维度（与参考插件一致）：
 * 默认取得分最高的 topN 项；若存在负分，则显示最高 topN-1 项 + 最低的 1 项。
 * items: [{ key, label, value }]，返回保持原顺序的子集。
 */
export function selectRadarDimensions (items, topN) {
  const n = Math.max(1, Math.floor(Number(topN) || DEFAULT_RADAR_TOP_N))
  const list = (items || []).filter((it) => it && Number.isFinite(Number(it.value)))
  if (!list.length) return []
  const lowest = list.reduce((min, it) => (Number(it.value) < Number(min.value) ? it : min), list[0])
  const hasNegative = Number(lowest.value) < 0
  const highCount = hasNegative ? Math.max(0, n - 1) : n
  const chosen = new Set()
  const sorted = [...list].sort((a, b) => Number(b.value) - Number(a.value))
  for (const it of sorted) {
    if (hasNegative && it.key === lowest.key) continue
    if (chosen.size >= highCount) break
    chosen.add(it.key)
  }
  if (hasNegative) chosen.add(lowest.key)
  return list.filter((it) => chosen.has(it.key))
}

/** 从「小明 雷达:3」里拆出对象和雷达维度数。认不出就原样返回。 */
export function parseRadarSpec (text) {
  const raw = String(text === undefined || text === null ? '' : text).trim()
  if (!raw) return { target: '', topN: 0 }
  const match = raw.match(/(?:^|\s)(?:雷达|radar|top_n|雷达数|雷达维度)\s*[:：]\s*(\d+)\s*$/)
  if (!match) return { target: raw, topN: 0 }
  return {
    target: (raw.slice(0, match.index) + raw.slice(match.index + match[0].length)).trim(),
    topN: Math.max(0, Math.min(22, Number(match[1]) || 0)),
  }
}

/** 雷达扇区配色：负分 / 越界 / 正常。 */
export function radarSectorClass (v0, v1, opts) {
  const o = opts || {}
  const scaleMin = o.scaleMin === undefined ? DEFAULT_SCALE_MIN : o.scaleMin
  const scaleMax = o.scaleMax === undefined ? DEFAULT_SCALE_MAX : o.scaleMax
  if (Number(v0) < scaleMin || Number(v1) < scaleMin) return 'neg'
  if (Number(v0) > scaleMax || Number(v1) > scaleMax) return 'over'
  return 'pos'
}

/** 粗略按显示宽度折行：中日韩字符算 1，ASCII 算 0.55。 */
export function wrapDisplayText (text, maxUnits, maxLines) {
  const limit = Number(maxUnits) || 20
  const lineCap = Number(maxLines) || 8
  const src = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n')
  const lines = []
  for (const paragraph of src.split('\n')) {
    let line = ''
    let used = 0
    for (const ch of paragraph) {
      const wide = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch)
      const w = wide ? 1 : 0.55
      if (used + w > limit && line) { lines.push(line); line = ''; used = 0 }
      line += ch
      used += w
    }
    lines.push(line)
  }
  const clipped = lines.slice(0, Math.max(1, lineCap))
  if (lines.length > clipped.length && clipped.length) {
    const last = clipped[clipped.length - 1]
    clipped[clipped.length - 1] = last.slice(0, Math.max(0, last.length - 1)) + '…'
  }
  return clipped
}

/** XML/SVG 转义。 */
export function escapeXml (text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 把 {name} 这类占位符换掉；未知占位符原样保留（方便排查）。 */
export function fillTemplate (template, values) {
  const map = values || {}
  return String(template === undefined || template === null ? '' : template)
    .replace(/\{([a-z_]+)\}/g, (whole, key) => (Object.prototype.hasOwnProperty.call(map, key) ? String(map[key] === undefined || map[key] === null ? '' : map[key]) : whole))
}
