// 印象卡片的 SVG 卡面：940x500 纯 SVG 字符串，由 render.mjs 用 sharp 栅格化。
// 版式对齐 MaiBot 参考插件：标题栏、好感度量表条、雷达图 + 图例、印象笔记、页脚。
// 三套主题只通过这里的配色与背景装饰区分，不引用任何外部字体或图片。

import {
  formatNum,
  escapeXml,
  wrapDisplayText,
  selectRadarDimensions,
  radarSectorClass,
  formatScaleRange,
  DEFAULT_SCALE_MIN,
  DEFAULT_SCALE_MAX,
  DEFAULT_RADAR_TOP_N,
  DEFAULT_SCORE,
  DEFAULT_TOTAL_LABEL,
} from './dimensions.mjs'

export const CARD_WIDTH = 940
export const CARD_HEIGHT = 500

const FONT_STACK = "'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', 'Segoe UI', sans-serif"

// 三套主题：键必须和设置面板里的 select 值保持一致。
export const CARD_THEMES = {
  parchment: {
    id: 'parchment',
    label: '羊皮纸',
    description: '暖色纸面、细线与角饰',
    swatch: '#e7cf9f',
    decor: 'paper',
    radius: 22,
    borderWidth: 4,
    avatarShape: 'circle',
    bgFrom: '#f6ead0',
    bgMid: '#eddbb5',
    bgTo: '#dcbf8b',
    glow: '#fffaf0',
    glowOpacity: 0.85,
    glow2: '#d8b478',
    glow2Opacity: 0.55,
    border: '#8a5a2b',
    innerBorder: 'rgba(138,90,43,0.35)',
    rule: 'rgba(138,90,43,0.45)',
    ruleDash: '',
    ruleWidth: 1,
    dividerDash: '7 7',
    dividerWidth: 2,
    ink: '#4a3416',
    subInk: '#8a6134',
    titleInk: '#7a4a1e',
    accent: '#b5651d',
    accentStrong: '#6a3a10',
    muted: '#9a7244',
    panelFill: 'rgba(255,251,240,0.52)',
    panelStroke: 'rgba(138,90,43,0.32)',
    descFill: 'rgba(255,251,239,0.72)',
    descStroke: 'rgba(138,90,43,0.38)',
    descRadius: 14,
    legendFill: 'rgba(255,251,239,0.62)',
    legendStroke: 'rgba(138,90,43,0.30)',
    grid: 'rgba(138,90,43,0.30)',
    axis: 'rgba(138,90,43,0.28)',
    chartStroke: '#b5651d',
    vertex: '#8a4a18',
    sectorPos: 'rgba(192,120,52,0.34)',
    sectorNeg: 'rgba(181,58,43,0.42)',
    sectorOver: 'rgba(217,151,32,0.44)',
    track: 'rgba(120,80,30,0.18)',
    fill: '#c8861f',
    over: '#d9480f',
    neg: '#a4161a',
    knobFill: '#6a3a10',
    knobStroke: '#fff4df',
    avatarRing: '#8a5a2b',
    avatarFill: '#b07a3c',
    avatarInk: '#fff8ec',
  },
  holo: {
    id: 'holo',
    label: '全息科技',
    description: '冷色渐变、网格线与边角标记',
    swatch: '#0b1226',
    decor: 'grid',
    radius: 20,
    borderWidth: 2,
    avatarShape: 'rounded',
    bgFrom: '#0b1226',
    bgMid: '#111a38',
    bgTo: '#0a1730',
    glow: '#00c8ff',
    glowOpacity: 0.28,
    glow2: '#b43cff',
    glow2Opacity: 0.30,
    border: 'rgba(80,220,255,0.55)',
    innerBorder: 'rgba(90,220,255,0.22)',
    rule: 'rgba(90,220,255,0.30)',
    ruleDash: '2 7',
    ruleWidth: 1,
    dividerDash: '',
    dividerWidth: 1,
    ink: '#d7f6ff',
    subInk: '#9fdcff',
    titleInk: '#74e9ff',
    accent: '#5ad7ff',
    accentStrong: '#74e9ff',
    muted: '#7fb8d8',
    panelFill: 'rgba(20,40,75,0.50)',
    panelStroke: 'rgba(90,220,255,0.28)',
    descFill: 'rgba(20,40,75,0.55)',
    descStroke: 'rgba(90,220,255,0.30)',
    descRadius: 12,
    legendFill: 'rgba(20,40,75,0.60)',
    legendStroke: 'rgba(90,220,255,0.30)',
    grid: 'rgba(90,220,255,0.22)',
    axis: 'rgba(90,220,255,0.20)',
    chartStroke: '#5ad7ff',
    vertex: '#aef0ff',
    sectorPos: 'rgba(90,220,255,0.30)',
    sectorNeg: 'rgba(255,90,138,0.38)',
    sectorOver: 'rgba(180,107,255,0.38)',
    track: 'rgba(90,220,255,0.16)',
    fill: '#5ad7ff',
    over: '#ffb020',
    neg: '#ff5a8a',
    knobFill: '#eaffff',
    knobStroke: '#5ad7ff',
    avatarRing: 'rgba(90,220,255,0.80)',
    avatarFill: '#24466f',
    avatarInk: '#d7f6ff',
  },
  cute: {
    id: 'cute',
    label: '可爱贴纸',
    description: '粉色圆角、虚线贴纸与波点',
    swatch: '#ffe9f3',
    decor: 'sticker',
    radius: 28,
    borderWidth: 5,
    avatarShape: 'circle',
    bgFrom: '#ffe9f3',
    bgMid: '#ffe0ee',
    bgTo: '#fff0d9',
    glow: '#ffffff',
    glowOpacity: 0.75,
    glow2: '#ffc7de',
    glow2Opacity: 0.70,
    border: '#ffb3d1',
    innerBorder: 'rgba(255,170,210,0.60)',
    rule: 'rgba(255,150,195,0.60)',
    ruleDash: '3 7',
    ruleWidth: 2,
    dividerDash: '3 7',
    dividerWidth: 3,
    ink: '#6b4a5a',
    subInk: '#b06082',
    titleInk: '#e8568b',
    accent: '#ff6fa5',
    accentStrong: '#e8568b',
    muted: '#b98ba0',
    panelFill: 'rgba(255,255,255,0.55)',
    panelStroke: 'rgba(255,170,210,0.60)',
    descFill: 'rgba(255,255,255,0.68)',
    descStroke: 'rgba(255,170,210,0.65)',
    descRadius: 18,
    legendFill: 'rgba(255,255,255,0.72)',
    legendStroke: 'rgba(255,170,210,0.60)',
    grid: 'rgba(255,150,195,0.35)',
    axis: 'rgba(255,150,195,0.30)',
    chartStroke: '#ff7fb0',
    vertex: '#e8568b',
    sectorPos: 'rgba(255,150,195,0.40)',
    sectorNeg: 'rgba(154,134,255,0.45)',
    sectorOver: 'rgba(255,207,90,0.42)',
    track: 'rgba(255,150,195,0.30)',
    fill: '#ff7fb0',
    over: '#f59e0b',
    neg: '#d92b4b',
    knobFill: '#e8568b',
    knobStroke: '#ffffff',
    avatarRing: '#ffb3d1',
    avatarFill: '#ff8fb8',
    avatarInk: '#ffffff',
  },
}

// 版式常量：全部是 940x500 画布坐标。
const CARD_BOX = { x: 6, y: 6, width: 928, height: 488 }
const AVATAR = { cx: 56, cy: 52, r: 31, x: 25, y: 21, size: 62, rx: 14 }
const HEADER_RULE_Y = 94
const GAUGE = { x0: 44, x1: 896, y: 112, h: 12, labelY: 140, clampMin: 26, clampMax: 914, centerX: 470 }
const SECTION_RULE_Y = 152
const BODY = { top: 158, bottom: 462, left: 24, leftWidth: 500, centerX: 274, dividerX: 536, rightX: 552, rightWidth: 360 }
const DESC = { x: 552, y: 190, width: 360, height: 252, titleY: 179 }
const FOOTER_Y = 480
const LEGEND = { fontSize: 11, chipHeight: 18, rowGap: 3, gap: 6, maxRows: 4, maxWidth: 476, centerX: BODY.centerX }

const WIDE_CHAR_RE = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

/**
 * 认不出的主题 id 回落到羊皮纸；返回主题配置对象。
 * 也兼容直接传设置对象（{ theme: 'holo' }）或主题配置对象（{ id: 'holo' }）。
 */
export function themeOf (id) {
  let key = ''
  if (typeof id === 'string') {
    key = id.trim().toLowerCase()
  } else if (id && typeof id === 'object') {
    if (typeof id.theme === 'string') key = id.theme.trim().toLowerCase()
    else if (typeof id.id === 'string') key = id.id.trim().toLowerCase()
  }
  if (Object.prototype.hasOwnProperty.call(CARD_THEMES, key)) return CARD_THEMES[key]
  return CARD_THEMES.parchment
}

function safeId (value) {
  const text = String(value === undefined || value === null ? '' : value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
  return text || 'card'
}

function resolveTheme (input) {
  if (input && typeof input === 'object') {
    const base = CARD_THEMES[safeId(input.id)] || CARD_THEMES.parchment
    return { ...base, ...input, id: safeId(input.id || base.id) }
  }
  return themeOf(input)
}

function themeIds (theme) {
  const base = 'ic-' + safeId(theme.id)
  return {
    bg: base + '-bg',
    glow: base + '-glow',
    glow2: base + '-glow2',
    grid: base + '-grid',
    card: base + '-card',
    avatar: base + '-avatar',
    desc: base + '-desc',
  }
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function toFinite (value, fallback) {
  try {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  } catch (error) {
    return fallback
  }
}

function coord (value) {
  if (!Number.isFinite(value)) return '0'
  return String(Math.round(value * 10) / 10)
}

function safeText (value) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function safeMultiline (value) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\r\n?/g, '\n').trim()
}

function displayUnits (text) {
  let units = 0
  for (const ch of String(text)) units += WIDE_CHAR_RE.test(ch) ? 1 : 0.55
  return units
}

function clipText (text, maxUnits) {
  const src = safeText(text)
  if (!src) return ''
  if (displayUnits(src) <= maxUnits) return src
  let used = 0
  let out = ''
  for (const ch of src) {
    const w = WIDE_CHAR_RE.test(ch) ? 1 : 0.55
    if (used + w > maxUnits - 0.8) break
    out += ch
    used += w
  }
  return (out || src.slice(0, 1)) + '…'
}

function normalizeScale (scaleMin, scaleMax) {
  let min = toFinite(scaleMin, DEFAULT_SCALE_MIN)
  let max = toFinite(scaleMax, DEFAULT_SCALE_MAX)
  if (max <= min) {
    if (max === min) {
      max = min + 10
    } else {
      const swap = min
      min = max
      max = swap
    }
  }
  if (!Number.isFinite(max - min) || max - min <= 0) {
    return { scaleMin: DEFAULT_SCALE_MIN, scaleMax: DEFAULT_SCALE_MAX }
  }
  return { scaleMin: min, scaleMax: max }
}

function normalizeDimensions (dimensions) {
  const list = Array.isArray(dimensions) ? dimensions : []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const value = toFinite(item.value, null)
    if (value === null) continue
    const key = safeText(item.key) || ('dim-' + (out.length + 1))
    const label = safeText(item.label) || key
    out.push({ key, label, value })
  }
  return out
}

function normalizeAvatarDataUri (value) {
  if (typeof value !== 'string') return ''
  const uri = value.trim()
  return uri.startsWith('data:image/') ? uri : ''
}

function normalizeDescription (value) {
  const text = safeMultiline(value)
  return text || '（这个人还很神秘，暂无印象。）'
}

function computeGauge (total, scaleMin, scaleMax) {
  const span = scaleMax - scaleMin
  const state = total < scaleMin ? 'under' : total > scaleMax ? 'over' : 'in'
  const rawX = GAUGE.x0 + ((total - scaleMin) / span) * (GAUGE.x1 - GAUGE.x0)
  return {
    state,
    knobX: clamp(Number.isFinite(rawX) ? rawX : GAUGE.x0, GAUGE.clampMin, GAUGE.clampMax),
  }
}

function buildDefs (theme) {
  const ids = themeIds(theme)
  const avatarShape = theme.avatarShape === 'rounded'
    ? '<rect x="' + AVATAR.x + '" y="' + AVATAR.y + '" width="' + AVATAR.size + '" height="' + AVATAR.size + '" rx="' + AVATAR.rx + '" />'
    : '<circle cx="' + AVATAR.cx + '" cy="' + AVATAR.cy + '" r="' + AVATAR.r + '" />'
  const gridPattern = theme.decor === 'grid'
    ? '<pattern id="' + ids.grid + '" width="26" height="26" patternUnits="userSpaceOnUse">' +
      '<path d="M 26 0 L 0 0 0 26" fill="none" stroke="' + theme.grid + '" stroke-width="1" />' +
      '</pattern>'
    : ''
  return '<defs>' +
    '<linearGradient id="' + ids.bg + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
    '<stop offset="0%" stop-color="' + theme.bgFrom + '" />' +
    '<stop offset="55%" stop-color="' + theme.bgMid + '" />' +
    '<stop offset="100%" stop-color="' + theme.bgTo + '" />' +
    '</linearGradient>' +
    '<radialGradient id="' + ids.glow + '" cx="50%" cy="50%" r="50%">' +
    '<stop offset="0%" stop-color="' + theme.glow + '" stop-opacity="' + formatNum(theme.glowOpacity) + '" />' +
    '<stop offset="100%" stop-color="' + theme.glow + '" stop-opacity="0" />' +
    '</radialGradient>' +
    '<radialGradient id="' + ids.glow2 + '" cx="50%" cy="50%" r="50%">' +
    '<stop offset="0%" stop-color="' + theme.glow2 + '" stop-opacity="' + formatNum(theme.glow2Opacity) + '" />' +
    '<stop offset="100%" stop-color="' + theme.glow2 + '" stop-opacity="0" />' +
    '</radialGradient>' +
    '<clipPath id="' + ids.card + '"><rect x="' + CARD_BOX.x + '" y="' + CARD_BOX.y + '" width="' + CARD_BOX.width + '" height="' + CARD_BOX.height + '" rx="' + theme.radius + '" /></clipPath>' +
    '<clipPath id="' + ids.avatar + '">' + avatarShape + '</clipPath>' +
    '<clipPath id="' + ids.desc + '"><rect x="' + DESC.x + '" y="' + DESC.y + '" width="' + DESC.width + '" height="' + DESC.height + '" rx="' + theme.descRadius + '" /></clipPath>' +
    gridPattern +
    '</defs>'
}

function buildDecor (theme) {
  const ids = themeIds(theme)
  if (theme.decor === 'grid') {
    return '<circle cx="132" cy="54" r="210" fill="url(#' + ids.glow + ')" />' +
      '<circle cx="856" cy="452" r="250" fill="url(#' + ids.glow2 + ')" />' +
      '<rect x="' + CARD_BOX.x + '" y="' + CARD_BOX.y + '" width="' + CARD_BOX.width + '" height="' + CARD_BOX.height + '" fill="url(#' + ids.grid + ')" />' +
      '<g fill="none" stroke="' + theme.accent + '" stroke-width="1.6" opacity="0.75" stroke-linecap="round">' +
      '<path d="M 26 58 L 26 26 L 58 26" />' +
      '<path d="M 914 58 L 914 26 L 882 26" />' +
      '<path d="M 26 442 L 26 474 L 58 474" />' +
      '<path d="M 914 442 L 914 474 L 882 474" />' +
      '</g>' +
      '<line x1="28" y1="92" x2="912" y2="92" stroke="' + theme.accent + '" stroke-width="1" opacity="0.22" />'
  }
  if (theme.decor === 'sticker') {
    return '<circle cx="66" cy="46" r="86" fill="url(#' + ids.glow + ')" />' +
      '<circle cx="884" cy="460" r="120" fill="url(#' + ids.glow2 + ')" />' +
      '<circle cx="806" cy="62" r="14" fill="#ffffff" opacity="0.55" />' +
      '<circle cx="108" cy="430" r="20" fill="#ffffff" opacity="0.35" />' +
      '<circle cx="860" cy="116" r="6" fill="' + theme.accent + '" opacity="0.35" />' +
      '<circle cx="66" cy="372" r="5" fill="' + theme.accent + '" opacity="0.30" />' +
      '<path d="M 836 38 l 4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4 z" fill="#ffffff" opacity="0.70" />' +
      '<path d="M 90 84 l 3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3 z" fill="#ffffff" opacity="0.50" />'
  }
  // parchment：暖色晕染 + 纸面颗粒 + 四角细线。
  const speckles = []
  for (let i = 0; i < 22; i++) {
    const x = 30 + ((i * 157 + 41) % 878)
    const y = 22 + ((i * 101 + 17) % 452)
    const r = 0.8 + (i % 3) * 0.6
    const opacity = 0.035 + (i % 4) * 0.012
    speckles.push('<circle cx="' + x + '" cy="' + y + '" r="' + formatNum(r) + '" fill="#8a5a2b" opacity="' + formatNum(opacity) + '" />')
  }
  return '<ellipse cx="152" cy="58" rx="330" ry="190" fill="url(#' + ids.glow + ')" />' +
    '<ellipse cx="858" cy="462" rx="280" ry="210" fill="url(#' + ids.glow2 + ')" />' +
    speckles.join('') +
    '<g fill="none" stroke="' + theme.innerBorder + '" stroke-width="1.2" stroke-linecap="round">' +
    '<path d="M 32 66 L 32 32 L 66 32" />' +
    '<path d="M 40 56 L 40 40 L 56 40" />' +
    '<path d="M 908 66 L 908 32 L 874 32" />' +
    '<path d="M 900 56 L 900 40 L 884 40" />' +
    '</g>'
}

function buildBackground (theme) {
  const ids = themeIds(theme)
  const innerDash = theme.decor === 'sticker' ? ' stroke-dasharray="10 8"' : ''
  return '<rect x="' + CARD_BOX.x + '" y="' + CARD_BOX.y + '" width="' + CARD_BOX.width + '" height="' + CARD_BOX.height + '" rx="' + theme.radius + '" fill="url(#' + ids.bg + ')" />' +
    '<g clip-path="url(#' + ids.card + ')">' + buildDecor(theme) + '</g>' +
    '<rect x="16" y="16" width="908" height="468" rx="' + Math.max(8, theme.radius - 6) + '" fill="none" stroke="' + theme.innerBorder + '" stroke-width="' + (theme.decor === 'sticker' ? 2 : 1) + '"' + innerDash + ' />' +
    '<rect x="' + CARD_BOX.x + '" y="' + CARD_BOX.y + '" width="' + CARD_BOX.width + '" height="' + CARD_BOX.height + '" rx="' + theme.radius + '" fill="none" stroke="' + theme.border + '" stroke-width="' + theme.borderWidth + '" />'
}

function buildRule (theme, y) {
  const dash = theme.ruleDash ? ' stroke-dasharray="' + theme.ruleDash + '"' : ''
  return '<line x1="24" y1="' + y + '" x2="916" y2="' + y + '" stroke="' + theme.rule + '" stroke-width="' + theme.ruleWidth + '" stroke-linecap="round"' + dash + ' />'
}

function buildAvatar (theme, personName, avatarUri) {
  const ids = themeIds(theme)
  const rounded = theme.avatarShape === 'rounded'
  const base = rounded
    ? '<rect x="' + AVATAR.x + '" y="' + AVATAR.y + '" width="' + AVATAR.size + '" height="' + AVATAR.size + '" rx="' + AVATAR.rx + '" fill="' + theme.avatarFill + '" />'
    : '<circle cx="' + AVATAR.cx + '" cy="' + AVATAR.cy + '" r="' + AVATAR.r + '" fill="' + theme.avatarFill + '" />'
  const ring = rounded
    ? '<rect x="' + AVATAR.x + '" y="' + AVATAR.y + '" width="' + AVATAR.size + '" height="' + AVATAR.size + '" rx="' + AVATAR.rx + '" fill="none" stroke="' + theme.avatarRing + '" stroke-width="' + (theme.decor === 'sticker' ? 3 : 2.5) + '" />'
    : '<circle cx="' + AVATAR.cx + '" cy="' + AVATAR.cy + '" r="' + AVATAR.r + '" fill="none" stroke="' + theme.avatarRing + '" stroke-width="' + (theme.decor === 'sticker' ? 3 : 2.5) + '" />'
  if (!avatarUri) {
    const initial = Array.from(safeText(personName))[0] || '?'
    return '<g class="avatar avatar-placeholder">' + base +
      '<text x="' + AVATAR.cx + '" y="' + (rounded ? 62 : 63) + '" text-anchor="middle" font-size="26" font-weight="800" fill="' + theme.avatarInk + '">' + escapeXml(initial) + '</text>' +
      ring + '</g>'
  }
  return '<g class="avatar">' + base +
    '<image class="avatar-image" href="' + escapeXml(avatarUri) + '" x="' + AVATAR.x + '" y="' + AVATAR.y + '" width="' + AVATAR.size + '" height="' + AVATAR.size + '" clip-path="url(#' + ids.avatar + ')" preserveAspectRatio="xMidYMid slice" />' +
    ring + '</g>'
}

function buildHeader (theme, opts, gaugeState) {
  const scoreText = formatNum(opts.total)
  const scoreLength = Array.from(scoreText).length
  const scoreSize = scoreLength <= 3 ? 40 : scoreLength === 4 ? 34 : scoreLength === 5 ? 30 : scoreLength === 6 ? 26 : 22
  const scoreColor = gaugeState === 'over' ? theme.over : gaugeState === 'under' ? theme.neg : theme.accentStrong
  const nameY = opts.personLabel ? 49 : 57
  const pieces = ['<g class="titlebar">', buildAvatar(theme, opts.personName, opts.avatarDataUri)]
  pieces.push('<text class="person-name" x="100" y="' + nameY + '" font-size="20" font-weight="700" fill="' + theme.ink + '">' + escapeXml(clipText(opts.personName, 10)) + '</text>')
  if (opts.personLabel) {
    pieces.push('<text class="person-label" x="100" y="68" font-size="11" fill="' + theme.subInk + '">' + escapeXml(clipText(opts.personLabel, 20)) + '</text>')
  }
  pieces.push('<text class="card-title" x="470" y="56" text-anchor="middle" font-size="22" font-weight="800" letter-spacing="1.2" fill="' + theme.titleInk + '">' + escapeXml(clipText(opts.title, 13)) + '</text>')
  pieces.push('<text class="score-label" x="906" y="31" text-anchor="end" font-size="11" letter-spacing="1" fill="' + theme.subInk + '">' + escapeXml(clipText(opts.totalLabel, 10)) + '</text>')
  pieces.push('<text class="score-value" x="906" y="74" text-anchor="end" font-size="' + scoreSize + '" font-weight="800" fill="' + scoreColor + '">' + escapeXml(scoreText) + '</text>')
  pieces.push('</g>')
  return pieces.join('')
}

function buildGauge (theme, opts, gauge) {
  const state = gauge.state
  const knobX = gauge.knobX
  const color = state === 'over' ? theme.over : state === 'under' ? theme.neg : theme.fill
  const parts = ['<g class="gauge" data-gauge-state="' + state + '">']
  parts.push('<rect class="gauge-bar-track" x="' + GAUGE.x0 + '" y="' + GAUGE.y + '" width="' + (GAUGE.x1 - GAUGE.x0) + '" height="' + GAUGE.h + '" rx="' + (GAUGE.h / 2) + '" fill="' + theme.track + '" />')
  if (state === 'in') {
    if (knobX - GAUGE.x0 > 0.5) {
      parts.push('<rect class="gauge-bar-fill" x="' + GAUGE.x0 + '" y="' + GAUGE.y + '" width="' + coord(knobX - GAUGE.x0) + '" height="' + GAUGE.h + '" rx="' + (GAUGE.h / 2) + '" fill="' + theme.fill + '" />')
    }
  } else if (state === 'over') {
    parts.push('<rect class="gauge-bar-fill" x="' + GAUGE.x0 + '" y="' + GAUGE.y + '" width="' + (GAUGE.x1 - GAUGE.x0) + '" height="' + GAUGE.h + '" rx="' + (GAUGE.h / 2) + '" fill="' + theme.fill + '" />')
    parts.push('<rect class="gauge-bar-over" x="' + GAUGE.x1 + '" y="' + GAUGE.y + '" width="' + coord(Math.max(2.5, knobX - GAUGE.x1)) + '" height="' + GAUGE.h + '" rx="' + (GAUGE.h / 2) + '" fill="' + theme.over + '" />')
  } else {
    parts.push('<rect class="gauge-bar-neg" x="' + coord(Math.min(knobX, GAUGE.x0 - 2.5)) + '" y="' + GAUGE.y + '" width="' + coord(Math.max(2.5, GAUGE.x0 - knobX)) + '" height="' + GAUGE.h + '" rx="' + (GAUGE.h / 2) + '" fill="' + theme.neg + '" />')
  }
  parts.push('<circle class="gauge-bar-knob" cx="' + coord(knobX) + '" cy="' + (GAUGE.y + GAUGE.h / 2) + '" r="8" fill="' + color + '" stroke="' + theme.knobStroke + '" stroke-width="2" />')
  parts.push('<text class="gauge-scale" x="' + GAUGE.x0 + '" y="' + GAUGE.labelY + '" text-anchor="start" font-size="10" fill="' + theme.muted + '">' + escapeXml(formatNum(opts.scaleMin)) + '</text>')
  parts.push('<text class="gauge-scale" x="' + GAUGE.x1 + '" y="' + GAUGE.labelY + '" text-anchor="end" font-size="10" fill="' + theme.muted + '">' + escapeXml(formatNum(opts.scaleMax)) + '</text>')
  const statusText = state === 'over' ? '高于参考上限' : state === 'under' ? '低于参考下限' : '参考区间 ' + formatScaleRange(opts.scaleMin, opts.scaleMax)
  const statusColor = state === 'over' ? theme.over : state === 'under' ? theme.neg : theme.muted
  parts.push('<text class="gauge-status gauge-status-' + state + '" x="' + GAUGE.centerX + '" y="' + GAUGE.labelY + '" text-anchor="middle" font-size="10" fill="' + statusColor + '">' + escapeXml(statusText) + '</text>')
  parts.push('</g>')
  return parts.join('')
}

function layoutLegend (dims) {
  if (!dims.length) return { rows: [], height: 0 }
  const items = dims.map((dim) => {
    const label = clipText(dim.label, 8)
    const value = formatNum(dim.value)
    const width = Math.min(160, Math.round(displayUnits(label + ' ' + value) * LEGEND.fontSize + 14))
    return { key: dim.key, label, value, width: Math.max(34, width) }
  })
  let rows = []
  let row = []
  let rowWidth = 0
  for (const item of items) {
    const extra = row.length ? LEGEND.gap : 0
    if (row.length && rowWidth + extra + item.width > LEGEND.maxWidth) {
      rows.push({ items: row, width: rowWidth })
      row = []
      rowWidth = 0
    }
    if (row.length) rowWidth += LEGEND.gap
    row.push(item)
    rowWidth += item.width
  }
  if (row.length) rows.push({ items: row, width: rowWidth })
  if (rows.length > LEGEND.maxRows) {
    const kept = rows.slice(0, LEGEND.maxRows)
    let dropped = 0
    for (const overflowRow of rows.slice(LEGEND.maxRows)) dropped += overflowRow.items.length
    const last = kept[kept.length - 1]
    const extraItem = { key: '', label: '+' + dropped, value: '', width: 36 }
    if (last.width + LEGEND.gap + extraItem.width <= LEGEND.maxWidth) {
      last.items.push(extraItem)
      last.width += LEGEND.gap + extraItem.width
    }
    rows = kept
  }
  const height = rows.length * LEGEND.chipHeight + (rows.length - 1) * LEGEND.rowGap
  return { rows, height }
}

function buildLegendSvg (legend, theme, y) {
  if (!legend.rows.length) return ''
  const parts = ['<g class="dim-legend">']
  let rowY = y
  for (const row of legend.rows) {
    let x = LEGEND.centerX - row.width / 2
    for (const item of row.items) {
      const textX = x + 7
      const baseline = rowY + 12.5
      parts.push('<g class="legend-item"' + (item.key ? ' data-dim="' + escapeXml(item.key) + '"' : '') + '>')
      parts.push('<rect x="' + coord(x) + '" y="' + coord(rowY) + '" width="' + coord(item.width) + '" height="' + LEGEND.chipHeight + '" rx="' + (theme.decor === 'sticker' ? 11 : 9) + '" fill="' + theme.legendFill + '" stroke="' + theme.legendStroke + '" stroke-width="1" />')
      let text = '<text x="' + coord(textX) + '" y="' + coord(baseline) + '" font-size="' + LEGEND.fontSize + '" fill="' + theme.subInk + '"><tspan class="legend-name">' + escapeXml(item.label) + '</tspan>'
      if (item.value) text += '<tspan class="legend-val" dx="4" font-weight="700" fill="' + theme.accentStrong + '">' + escapeXml(item.value) + '</tspan>'
      text += '</text>'
      parts.push(text)
      parts.push('</g>')
      x += item.width + LEGEND.gap
    }
    rowY += LEGEND.chipHeight + LEGEND.rowGap
  }
  parts.push('</g>')
  return parts.join('')
}

function buildRadarEmpty (theme, box, dims) {
  const width = Math.min(360, box.width - 40)
  const height = Math.min(168, Math.max(130, box.height - 24))
  const x = box.x + (box.width - width) / 2
  const y = box.y + (box.height - height) / 2
  const centerX = x + width / 2
  const title = dims.length ? '维度不足 3 项' : '暂无维度数据'
  const hint = dims.length ? '雷达图至少需要 3 个维度' : '先记录几条印象，雷达图才有形状'
  return '<g class="radar-empty">' +
    '<rect x="' + coord(x) + '" y="' + coord(y) + '" width="' + coord(width) + '" height="' + coord(height) + '" rx="18" fill="' + theme.panelFill + '" stroke="' + theme.panelStroke + '" stroke-width="1.5" stroke-dasharray="6 6" />' +
    '<circle cx="' + coord(centerX) + '" cy="' + coord(y + 44) + '" r="22" fill="none" stroke="' + theme.panelStroke + '" stroke-width="1.5" stroke-dasharray="4 4" />' +
    '<text x="' + coord(centerX) + '" y="' + coord(y + 51) + '" text-anchor="middle" font-size="20" font-weight="800" fill="' + theme.accentStrong + '">?</text>' +
    '<text x="' + coord(centerX) + '" y="' + coord(y + 98) + '" text-anchor="middle" font-size="15" font-weight="700" fill="' + theme.ink + '">' + escapeXml(title) + '</text>' +
    '<text x="' + coord(centerX) + '" y="' + coord(y + 120) + '" text-anchor="middle" font-size="11" fill="' + theme.muted + '">' + escapeXml(hint) + '</text>' +
    '</g>'
}

function buildDescription (theme, description) {
  const ids = themeIds(theme)
  const maxUnits = 21
  const lineHeight = 22
  const innerTop = DESC.y + 21
  const innerBottom = DESC.y + DESC.height - 14
  const maxLines = Math.max(2, Math.floor((innerBottom - innerTop) / lineHeight) + 1)
  const lines = wrapDisplayText(description, maxUnits, maxLines)
  const tspans = lines.map((line, index) => {
    const pos = index === 0 ? 'x="' + (DESC.x + 16) + '" y="' + coord(innerTop) + '"' : 'x="' + (DESC.x + 16) + '" dy="' + lineHeight + '"'
    return '<tspan ' + pos + '>' + escapeXml(line) + '</tspan>'
  }).join('')
  const dash = theme.decor === 'sticker' ? ' stroke-dasharray="7 6"' : ''
  return '<g class="impression">' +
    '<rect x="' + DESC.x + '" y="164" width="4" height="18" rx="2" fill="' + theme.accent + '" />' +
    '<text class="impression-title" x="' + (DESC.x + 14) + '" y="' + DESC.titleY + '" font-size="15" font-weight="700" fill="' + theme.titleInk + '">印象笔记</text>' +
    '<rect x="' + DESC.x + '" y="' + DESC.y + '" width="' + DESC.width + '" height="' + DESC.height + '" rx="' + theme.descRadius + '" fill="' + theme.descFill + '" stroke="' + theme.descStroke + '" stroke-width="1.5"' + dash + ' />' +
    '<g clip-path="url(#' + ids.desc + ')"><text class="impression-note" font-size="14.5" fill="' + theme.ink + '">' + tspans + '</text></g>' +
    '</g>'
}

function buildBody (theme, opts) {
  const legend = layoutLegend(opts.legendDims)
  const radarHeight = Math.max(170, BODY.bottom - BODY.top - legend.height - (legend.height ? 10 : 0))
  let radar
  if (opts.selected.length >= 3) {
    const raw = buildRadarSvg(opts.selected, { theme, scaleMin: opts.scaleMin, scaleMax: opts.scaleMax, size: 400 })
    radar = raw
      ? raw.replace('<svg ', '<svg x="' + BODY.left + '" y="' + BODY.top + '" width="' + BODY.leftWidth + '" height="' + coord(radarHeight) + '" ')
      : buildRadarEmpty(theme, { x: BODY.left, y: BODY.top, width: BODY.leftWidth, height: radarHeight }, opts.dims)
  } else {
    radar = buildRadarEmpty(theme, { x: BODY.left, y: BODY.top, width: BODY.leftWidth, height: radarHeight }, opts.dims)
  }
  const legendY = BODY.top + radarHeight + (legend.height ? 10 : 0)
  const legendSvg = buildLegendSvg(legend, theme, legendY)
  const dividerDash = theme.dividerDash ? ' stroke-dasharray="' + theme.dividerDash + '"' : ''
  const divider = '<line class="body-divider" x1="' + BODY.dividerX + '" y1="164" x2="' + BODY.dividerX + '" y2="448" stroke="' + theme.innerBorder + '" stroke-width="' + theme.dividerWidth + '" stroke-linecap="round"' + dividerDash + ' />'
  return '<g class="card-body">' + divider + radar + legendSvg + buildDescription(theme, opts.description) + '</g>'
}

function buildFooter (theme, updatedText, footer) {
  if (!updatedText && !footer) return ''
  const left = clipText(updatedText, 38)
  const right = clipText(footer, 46)
  let content = ''
  if (left) content += '<text x="30" y="' + FOOTER_Y + '" font-size="10.5" fill="' + theme.muted + '">' + escapeXml(left) + '</text>'
  if (right) content += '<text x="910" y="' + FOOTER_Y + '" text-anchor="end" font-size="10.5" fill="' + theme.muted + '">' + escapeXml(right) + '</text>'
  return '<g class="card-footer">' + content + '</g>'
}

/**
 * 生成完整的 940x500 印象卡片 SVG。
 * 文本全部转义；数值全部经过有限性检查，几何坐标在合理范围内。
 */
export function buildCardSvg (options) {
  const opts = options && typeof options === 'object' ? options : {}
  const theme = resolveTheme(opts.theme)
  const scale = normalizeScale(opts.scaleMin, opts.scaleMax)
  const dims = normalizeDimensions(opts.dimensions)
  const total = opts.total === undefined || opts.total === null || opts.total === '' ? DEFAULT_SCORE : toFinite(opts.total, DEFAULT_SCORE)
  const title = safeText(opts.title) || '印象卡片'
  const personName = safeText(opts.personName) || '未知'
  const personLabel = safeText(opts.personLabel)
  const totalLabel = safeText(opts.totalLabel) || DEFAULT_TOTAL_LABEL
  const description = normalizeDescription(opts.description)
  const avatarDataUri = normalizeAvatarDataUri(opts.avatarDataUri)
  const updatedText = safeText(opts.updatedText)
  const footer = safeText(opts.footer)
  const radarTopN = Math.max(1, Math.min(22, Math.floor(toFinite(opts.radarTopN, DEFAULT_RADAR_TOP_N))))
  const selected = selectRadarDimensions(dims, radarTopN)
  const legendDims = selected.length ? selected : dims
  const gauge = computeGauge(total, scale.scaleMin, scale.scaleMax)
  const headerOpts = { total, totalLabel, title, personName, personLabel, avatarDataUri }
  const gaugeOpts = { scaleMin: scale.scaleMin, scaleMax: scale.scaleMax }
  const bodyOpts = { selected, legendDims, dims, scaleMin: scale.scaleMin, scaleMax: scale.scaleMax, description }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + CARD_WIDTH + '" height="' + CARD_HEIGHT + '" viewBox="0 0 ' + CARD_WIDTH + ' ' + CARD_HEIGHT + '" font-family="' + FONT_STACK + '" role="img" aria-label="' + escapeXml(title + ' · ' + personName) + '" shape-rendering="geometricPrecision">' +
    '<title>' + escapeXml(title + ' · ' + personName) + '</title>' +
    '<desc>' + escapeXml(description) + '</desc>' +
    buildDefs(theme) +
    buildBackground(theme) +
    buildHeader(theme, headerOpts, gauge.state) +
    buildRule(theme, HEADER_RULE_Y) +
    buildGauge(theme, gaugeOpts, gauge) +
    buildRule(theme, SECTION_RULE_Y) +
    buildBody(theme, bodyOpts) +
    buildFooter(theme, updatedText, footer) +
    '</svg>'
}

/**
 * 生成雷达图 SVG（独立字符串，不依赖外部样式）。
 * 数值线性映射半径：scaleMin 在圆心，scaleMax 在外环；
 * 低于 scaleMin 的负分穿圆心，超过 scaleMax 的顶点顶出外环但收紧在 1.45 倍半径内。
 * 维度少于 3 项时返回空串，由调用方显示退化提示。
 */
export function buildRadarSvg (dimensions, options) {
  const opts = options && typeof options === 'object' ? options : {}
  const items = normalizeDimensions(dimensions)
  if (items.length < 3) return ''
  const theme = resolveTheme(opts.theme)
  const scale = normalizeScale(
    opts.scaleMin === undefined ? DEFAULT_SCALE_MIN : opts.scaleMin,
    opts.scaleMax === undefined ? DEFAULT_SCALE_MAX : opts.scaleMax
  )
  const scaleMin = scale.scaleMin
  const scaleMax = scale.scaleMax
  const span = scaleMax - scaleMin
  if (!Number.isFinite(span) || span <= 0) return ''
  const size = clamp(toFinite(opts.size, 360), 160, 800)
  const n = items.length
  const fontSize = size * 0.045
  const valueFont = size * 0.0375
  const vertexR = Math.max(2.5, size * 0.012)
  const outer = size * 0.39
  const labelR = outer + size * 0.05
  // 标签实际锚点在外圈之外，侧边标签的整段文字还会继续向画布外延伸。
  // 先按最坏情况估算文字宽度，把 viewBox 横向撑开，避免 librsvg 不认 overflow:visible 时裁字。
  const labelTexts = items.map((item) => clipText(item.label, 7) + ' ' + formatNum(item.value))
  const maxLabelWidth = labelTexts.reduce((max, text) => Math.max(max, displayUnits(text) * fontSize), 0)
  const overReach = outer * 1.15
  const edgePad = size * 0.03
  const halfW = Math.max(labelR + maxLabelWidth + edgePad, overReach + edgePad)
  const halfH = Math.max(labelR + size * 0.075, overReach + edgePad)
  const cx = halfW
  const cy = halfH
  const viewW = halfW * 2
  const viewH = halfH * 2
  const angle = (index) => -Math.PI / 2 + (Math.PI * 2 * index) / n
  const point = (value, index) => {
    const ratio = (value - scaleMin) / span
    const tightened = clamp(Number.isFinite(ratio) ? ratio : 0, -0.55, 1.15)
    const r = outer * tightened
    const a = angle(index)
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  }
  const xy = (p) => coord(p.x) + ',' + coord(p.y)
  const parts = ['<svg viewBox="0 0 ' + coord(viewW) + ' ' + coord(viewH) + '" xmlns="http://www.w3.org/2000/svg" overflow="visible" preserveAspectRatio="xMidYMid meet">']
  for (let i = 0; i < n; i++) {
    const v0 = items[i].value
    const v1 = items[(i + 1) % n].value
    const sectorClass = radarSectorClass(v0, v1, { scaleMin, scaleMax })
    const fill = sectorClass === 'neg' ? theme.sectorNeg : sectorClass === 'over' ? theme.sectorOver : theme.sectorPos
    const p0 = point(v0, i)
    const p1 = point(v1, (i + 1) % n)
    parts.push('<polygon class="radar-sector-' + sectorClass + '" points="' + coord(cx) + ',' + coord(cy) + ' ' + xy(p0) + ' ' + xy(p1) + '" fill="' + fill + '" />')
  }
  for (const ratio of [1, 0.5]) {
    const ringPoints = []
    for (let i = 0; i < n; i++) {
      ringPoints.push(xy(point(scaleMin + span * ratio, i)))
    }
    parts.push('<polygon class="grid radar-grid" points="' + ringPoints.join(' ') + '" fill="none" stroke="' + theme.grid + '" stroke-width="1" />')
  }
  for (let i = 0; i < n; i++) {
    const p = point(scaleMax, i)
    parts.push('<line class="axis" x1="' + coord(cx) + '" y1="' + coord(cy) + '" x2="' + coord(p.x) + '" y2="' + coord(p.y) + '" stroke="' + theme.axis + '" stroke-width="1" />')
  }
  const outline = items.map((item, index) => xy(point(item.value, index))).join(' ')
  parts.push('<polygon class="radar-area" points="' + outline + '" fill="' + theme.chartStroke + '" fill-opacity="0.18" stroke="none" />')
  parts.push('<polygon class="radar-stroke" points="' + outline + '" fill="none" stroke="' + theme.chartStroke + '" stroke-width="2" stroke-linejoin="round" />')
  items.forEach((item, index) => {
    const p = point(item.value, index)
    parts.push('<circle class="radar-vertex" data-radar-vertex="true" data-dim="' + escapeXml(item.key) + '" data-index="' + index + '" cx="' + coord(p.x) + '" cy="' + coord(p.y) + '" r="' + coord(vertexR) + '" fill="' + theme.vertex + '" />')
  })
  items.forEach((item, index) => {
    const a = angle(index)
    const cos = Math.cos(a)
    const sin = Math.sin(a)
    const lx = cx + labelR * cos
    const ly = cy + labelR * sin
    const anchor = cos > 0.25 ? 'start' : cos < -0.25 ? 'end' : 'middle'
    const dy = sin < -0.4 ? -fontSize * 0.1 : sin > 0.4 ? fontSize * 0.75 : fontSize * 0.3
    parts.push('<text class="axis-label" x="' + coord(lx) + '" y="' + coord(ly + dy) + '" text-anchor="' + anchor + '" font-size="' + coord(fontSize) + '" font-weight="700" fill="' + theme.ink + '">' + escapeXml(clipText(item.label, 7)) + ' <tspan class="axis-value" fill="' + theme.accentStrong + '" font-size="' + coord(valueFont) + '" font-weight="700">' + escapeXml(formatNum(item.value)) + '</tspan></text>')
  })
  parts.push('</svg>')
  return parts.join('')
}
