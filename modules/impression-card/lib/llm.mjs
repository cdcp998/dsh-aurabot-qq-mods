// 印象卡片的 LLM 提示词层：拼冷启动 / 刷新 / 轻量微调 / 简介精简的提示词，
// 解析模型返回的 JSON，并把新的评分与增量写回档案。
//
// 这里只有纯函数：不发请求、不碰文件、不依赖 Aurabot 的 api。调用方拿到 prompt 后
// 自己走 api.ask({ system, text, maxTokens })。提示词沿用参考插件的口径，但 Aurabot
// 只有一份完整人格文本，所以用 {persona} 取代了原来的「人格设定 / 表达风格」两行。

import {
  DEFAULT_SCALE_MAX,
  DEFAULT_SCALE_MIN,
  DEFAULT_SCORE,
  DEFAULT_TOTAL_LABEL,
  defaultDimensions,
  dimensionDoc,
  fillTemplate,
  formatNum,
} from './dimensions.mjs'

const DEFAULT_NICKNAME = '大肥鱼'
const DEFAULT_PERSONA = '（暂无额外的人格设定）'
const DEFAULT_SIZE_LIMIT = 256
const DEFAULT_NOTE_POLICY = '【笔记策略】可以返回微调后的完整笔记，或省略以保留。'

// 简介太长时请模型压缩；成功后仍会再做一次硬截断兜底。
const DEFAULT_COMPACT_PROMPT_TEMPLATE = `你是印象卡片模块，是名为「{nickname}」的人工智能生命体的一部分。
{persona}

下面这段你对群友「{name}」的印象简介太长了：当前 {used}，必须精简到 {limit_label} 以内。
请你以{nickname}的身份、用你的口吻重写这段简介，保留最核心的人物特征与你的态度，让它更精炼有趣。
只输出精简后的简介正文本身，不要输出任何解释、前言或额外说明。

当前简介：
{description}`

// 冷启动与全面刷新共用一套模板：刷新时由调用方塞入 refresh_guidance / existing_block。
const DEFAULT_COLD_START_PROMPT_TEMPLATE = `你是印象卡片模块，是名为「{nickname}」的人工智能生命体的一部分。
{persona}

你要为群友「{name}」{task_intro}一份「好感度档案」。这是一个欢乐向的设定，请完全以你的视角、按你的喜好与脾气来打分，可以主观、可以毒舌、可以偏心，不必客观中立。

评分维度（每项参考 {scale_min}–{scale_max}，{default_score} 为中间值；分数越高表示你越认可该项；加分=奖励、扣分=不满。各维度均为正向表述，允许极端越界）：
{dimensions_doc}

另外单独给一个「{total_label}」整体评分（同样以 {scale_min}–{scale_max} 为参考，可越界）。它是你对 ta 的整体感受，是一个独立的评分，**不是**上面各维度的总和或平均，请单独判断。

关于这个人你已知的信息：
{person_identities}
- 长期记忆（请综合参考，不必逐条照搬）：
{memory_block}
- 最近的聊天记录：
  - 请求中quote后面跟的是消息id，指用户对之前的同一id消息进行了引用。
  - 在聊天记录中，不同的人正在互动，（{nickname}也是一位参与的用户），请注意辨别不同用户的身份。
{recent_chat}
{refresh_guidance}{existing_block}
请只输出一个 JSON 对象（不要输出任何额外文字、解释或代码块标记），格式如下：
{"total": 数字, "scores": {{scores_keys_doc}}, "description": "用你的口吻写的人物简介，{size_limit}字以内"}`

const DEFAULT_REFRESH_GUIDANCE = `【刷新评估】这是一次全面重算，不是微调旧分。请优先依据「印象记忆」与「最近聊天记录」重新判断你对 ta 的真实感受；下方旧档案仅供参考，各项分数与简介都可以明显上升或下降，不要惯性膨胀，也不要死守先入为主的旧印象。`

// 轻量微调只收相对变化，避免模型把整张卡重写一遍。
const DEFAULT_LIGHT_REFRESH_PROMPT_TEMPLATE = `你是印象卡片模块，是名为「{nickname}」的人工智能生命体的一部分。
{persona}

这是一次**小幅微调**，不是全面重算。请根据「最近聊天」对群友「{name}」的已有档案做增量调整。
不要给出全新绝对分数；只输出相对变化。没有变化的维度请省略。可以主观、可以毒舌，但优先小步调整。

评分参考区间 {scale_min}–{scale_max}，中间值 {default_score}；实际可越界。各维度均为正向表述。
「{total_label}」是独立的整体评分，不是各维度之和。
{dimensions_doc}

当前档案（这是基准，请在此上加减）：
{current_scores_block}
当前印象笔记：
{current_note}
{note_policy}
关于这个人：
{person_identities}
最近的聊天记录（当前会话、较短窗口）：
  - quote 后是消息 id。请辨别不同用户；{nickname} 也是参与者。
{recent_chat}

请只输出一个 JSON 对象（不要额外文字或代码块标记）：
{"deltas": {"total": 数字, "维度key": 数字}, "description": "可选；省略或空字符串表示保留原笔记。若要改笔记，请在原文基础上微调，不要另起炉灶。{size_limit}字以内"}
deltas 里只放需要改的 key（含 total）。`

// 主动提醒 / 加减分播报用的系统通知模板。
const DEFAULT_NOTIFY_TEMPLATE = `━━━━━━━━━━━━━━
　【系统通知】数值变动
　对象：{name}
　{dimension}　{delta}
　缘由：{reason}
━━━━━━━━━━━━━━`

export const DEFAULT_PROMPTS = {
  coldStart: DEFAULT_COLD_START_PROMPT_TEMPLATE,
  refreshGuidance: DEFAULT_REFRESH_GUIDANCE,
  lightRefresh: DEFAULT_LIGHT_REFRESH_PROMPT_TEMPLATE,
  compact: DEFAULT_COMPACT_PROMPT_TEMPLATE,
  notify: DEFAULT_NOTIFY_TEMPLATE,
}

/** 任意值转字符串；null / undefined 变空串，且吞掉 toString 的异常。 */
function toText (value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return String(value)
  } catch {
    return ''
  }
}

/** 普通对象（排除 null、数组）。 */
function isRecord (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 取一段非空文本，空则用兜底。 */
function firstText (value, fallback) {
  const text = toText(value).trim()
  return text || fallback
}

/** 多行块：保留缩进与换行，只在整块为空时用兜底。 */
function blockOr (value, fallback) {
  const text = toText(value)
  return text.trim() ? text : fallback
}

/** 多行块并保证结尾换行，方便嵌进模板的 {xxx}{yyy} 相邻占位符。 */
function blockWithBreak (value) {
  const text = toText(value).replace(/\s+$/, '')
  return text ? text + '\n' : ''
}

/** 把上限数字洗成展示文本；脏数据用默认字符上限。 */
function sizeLimitText (value) {
  const n = Number(value)
  if (Number.isFinite(n)) return formatNum(Math.max(0, Math.floor(n)))
  return firstText(value, String(DEFAULT_SIZE_LIMIT))
}

/** 模板为空 / 非字符串时回落到内置模板。 */
function templateOf (value, fallback) {
  const text = toText(value)
  return text.trim() ? text : fallback
}

/** 维度表统一洗一遍，避免脏配置在拼 prompt 时炸掉。 */
function normalizedDimensions (value) {
  if (!Array.isArray(value)) return defaultDimensions()
  const list = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const key = toText(item.key).trim()
    if (!key) continue
    list.push({
      key,
      label: toText(item.label).trim() || key,
      description: toText(item.description).trim(),
    })
  }
  return list
}

/** 给模型看的维度 key 清单，嵌在 JSON 示例的 scores 里。 */
function scoresKeysDoc (dimensions) {
  return dimensions.map((d) => '"' + d.key + '": 数字').join(', ')
}

/** 上限统一成非负整数；无效值返回 null（表示不限制）。 */
function normalizeLimit (limit) {
  const n = Number(limit)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.floor(n))
}

/** 有限数字（接受数字与数字字符串），否则 null。 */
function finiteNumber (value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** allowedKeys 可能是数组、Set 或「key → 布尔」对象。 */
function allowedKeySet (value) {
  const set = new Set()
  try {
    if (value instanceof Set || Array.isArray(value)) {
      for (const item of value) set.add(toText(item).trim())
    } else if (isRecord(value)) {
      for (const key of Object.keys(value)) {
        if (value[key]) set.add(toText(key).trim())
      }
    }
  } catch {}
  return set
}

/** 从 start 处的 { 往后找配对的 }，跳过字符串里的括号；找不到返回 -1。 */
function objectEnd (source, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 在一段文本里找第一个能解析成对象的 JSON。 */
function firstJsonObject (text) {
  const source = toText(text)
  let start = source.indexOf('{')
  while (start >= 0) {
    const end = objectEnd(source, start)
    if (end > start) {
      try {
        const parsed = JSON.parse(source.slice(start, end + 1))
        if (isRecord(parsed)) return parsed
      } catch {}
    }
    start = source.indexOf('{', start + 1)
  }
  return null
}

/** 按整字符累加，返回不超过 budget 字节的前缀（不会切碎 UTF-8）。 */
function takeWholeCharsWithinBytes (text, budget) {
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = textByteLength(ch)
    if (used + size > budget) break
    out += ch
    used += size
  }
  return out
}

/** 文本占多少 UTF-8 字节。 */
export function textByteLength (text) {
  try {
    return Buffer.byteLength(toText(text), 'utf8')
  } catch {
    return 0
  }
}

/** 是否没超过限制；unit 为 'bytes' 时按 UTF-8 字节，否则按字符（码点）。 */
export function textWithinLimit (text, limit, unit) {
  const cap = normalizeLimit(limit)
  if (cap === null) return true
  const source = toText(text)
  if (unit === 'bytes') return textByteLength(source) <= cap
  return Array.from(source).length <= cap
}

/** 「256 字符」/「81920 字节」。 */
export function limitLabel (limit, unit) {
  const cap = normalizeLimit(limit)
  return (cap === null ? 0 : cap) + (unit === 'bytes' ? ' 字节' : ' 字符')
}

/** 超限就截断并加省略号，保证结果仍在限制内。 */
export function truncateText (text, limit, unit) {
  const source = toText(text)
  const cap = normalizeLimit(limit)
  if (cap === null || textWithinLimit(source, cap, unit)) return source
  try {
    if (unit === 'bytes') {
      if (cap <= 3) return takeWholeCharsWithinBytes(source, cap)
      const kept = takeWholeCharsWithinBytes(source, cap - 3).replace(/\s+$/, '')
      return kept + '…'
    }
    if (cap <= 0) return ''
    return Array.from(source).slice(0, cap - 1).join('') + '…'
  } catch {
    return source
  }
}

/** 和 dimensions.mjs 的 fillTemplate 完全同义，方便调用方从本模块拿齐工具。 */
export function renderTemplate (template, values) {
  return fillTemplate(template, values)
}

/** 从可能带代码块围栏 / 前后闲话的回复里取第一个 JSON 对象；失败 null。 */
export function extractJsonObject (text) {
  try {
    const source = toText(text).trim()
    if (!source) return null
    for (const fence of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
      const found = firstJsonObject(fence[1])
      if (found) return found
    }
    return firstJsonObject(source)
  } catch {
    return null
  }
}

/** 只接受有限数字；数字字符串会转成数字，其余返回兜底。 */
export function coerceFloat (value, fallback) {
  const n = finiteNumber(value)
  return n === null ? fallback : n
}

/** 冷启动 / 全面刷新：把 JSON 结果写进档案（原地修改并返回）。 */
export function applyGeneration (record, parsed, opts) {
  const o = opts || {}
  const dimensions = normalizedDimensions(o.dimensions)
  const defaultScore = coerceFloat(o.defaultScore, DEFAULT_SCORE)
  if (!isRecord(record)) return record
  try {
    if (!isRecord(record.scores)) record.scores = {}
    const source = isRecord(parsed) ? parsed : {}
    const parsedScores = isRecord(source.scores) ? source.scores : {}
    record.total = coerceFloat(source.total, coerceFloat(record.total, defaultScore))
    for (const dim of dimensions) {
      if (Object.prototype.hasOwnProperty.call(parsedScores, dim.key)) {
        record.scores[dim.key] = coerceFloat(parsedScores[dim.key], defaultScore)
      } else {
        record.scores[dim.key] = coerceFloat(record.scores[dim.key], defaultScore)
      }
    }
    const description = firstText(source.description, '')
    if (description) record.description = description
    record.updatedAt = Date.now()
  } catch {}
  return record
}

/** 轻量微调提示词里的当前档案：好感度一行，各维度各一行。 */
export function buildCurrentScores (record, opts) {
  const o = opts || {}
  const dimensions = normalizedDimensions(o.dimensions)
  const totalLabel = firstText(o.totalLabel, DEFAULT_TOTAL_LABEL)
  const defaultScore = coerceFloat(o.defaultScore, DEFAULT_SCORE)
  try {
    const safeRecord = isRecord(record) ? record : {}
    const scores = isRecord(safeRecord.scores) ? safeRecord.scores : {}
    const lines = [totalLabel + ': ' + formatNum(coerceFloat(safeRecord.total, defaultScore))]
    for (const dim of dimensions) {
      lines.push(dim.label + ': ' + formatNum(coerceFloat(scores[dim.key], defaultScore)))
    }
    return lines.join('\n')
  } catch {
    return totalLabel + ': ' + formatNum(defaultScore)
  }
}

/** 冷启动 / 刷新提示词。 */
export function buildColdStartPrompt (input) {
  const o = input || {}
  const dimensions = normalizedDimensions(o.dimensions)
  const nickname = firstText(o.nickname, DEFAULT_NICKNAME)
  const persona = firstText(o.persona, DEFAULT_PERSONA)
  const values = {
    nickname,
    persona,
    name: firstText(o.personName, '（未命名群友）'),
    task_intro: firstText(o.taskIntro, '建立'),
    total_label: firstText(o.totalLabel, DEFAULT_TOTAL_LABEL),
    default_score: formatNum(coerceFloat(o.defaultScore, DEFAULT_SCORE)),
    scale_min: formatNum(coerceFloat(o.scaleMin, DEFAULT_SCALE_MIN)),
    scale_max: formatNum(coerceFloat(o.scaleMax, DEFAULT_SCALE_MAX)),
    dimensions_doc: dimensionDoc(dimensions),
    scores_keys_doc: scoresKeysDoc(dimensions),
    person_identities: blockOr(o.personIdentities, '（暂无更多身份信息）'),
    memory_block: blockOr(o.memoryBlock, '（无）'),
    recent_chat: blockOr(o.recentChat, '（无）'),
    refresh_guidance: blockWithBreak(o.refreshGuidance),
    existing_block: blockWithBreak(o.existingBlock),
    size_limit: sizeLimitText(o.sizeLimit),
    user_nickname: blockOr(o.userNickname, '（未知）'),
    group_cardname: blockOr(o.groupCardname, '（无）'),
  }
  values.memory_points = values.memory_block
  return renderTemplate(templateOf(o.template, DEFAULT_PROMPTS.coldStart), values)
}

/** 轻量微调提示词。 */
export function buildNudgePrompt (input) {
  const o = input || {}
  const dimensions = normalizedDimensions(o.dimensions)
  const nickname = firstText(o.nickname, DEFAULT_NICKNAME)
  const values = {
    nickname,
    persona: firstText(o.persona, DEFAULT_PERSONA),
    name: firstText(o.personName, '（未命名群友）'),
    total_label: firstText(o.totalLabel, DEFAULT_TOTAL_LABEL),
    default_score: formatNum(coerceFloat(o.defaultScore, DEFAULT_SCORE)),
    scale_min: formatNum(coerceFloat(o.scaleMin, DEFAULT_SCALE_MIN)),
    scale_max: formatNum(coerceFloat(o.scaleMax, DEFAULT_SCALE_MAX)),
    dimensions_doc: dimensionDoc(dimensions),
    current_scores_block: blockOr(o.currentScoresBlock, '（暂无）'),
    current_note: blockOr(o.currentNote, '（无）'),
    note_policy: firstText(o.notePolicy, DEFAULT_NOTE_POLICY),
    person_identities: blockOr(o.personIdentities, '（暂无更多身份信息）'),
    recent_chat: blockOr(o.recentChat, '（无）'),
    size_limit: sizeLimitText(o.sizeLimit),
  }
  return renderTemplate(templateOf(o.template, DEFAULT_PROMPTS.lightRefresh), values)
}

/** 简介精简提示词。 */
export function buildCompactPrompt (input) {
  const o = input || {}
  const values = {
    nickname: firstText(o.nickname, DEFAULT_NICKNAME),
    persona: firstText(o.persona, DEFAULT_PERSONA),
    name: firstText(o.personName, '（未命名群友）'),
    used: blockOr(o.used, '（未知）'),
    limit_label: firstText(o.limitLabel, limitLabel(DEFAULT_SIZE_LIMIT, 'chars')),
    description: toText(o.description),
  }
  return renderTemplate(templateOf(o.template, DEFAULT_PROMPTS.compact), values)
}

/** 解析微调结果：只留白名单 key、有限数字，并按 maxAbsDelta 截断。 */
export function parseNudgePayload (parsed, opts) {
  const o = opts || {}
  const allowed = allowedKeySet(o.allowedKeys)
  const maxAbs = coerceFloat(o.maxAbsDelta, 0)
  const empty = { deltas: {}, description: null }
  if (!isRecord(parsed)) return empty
  try {
    const deltas = {}
    if (isRecord(parsed.deltas)) {
      for (const [rawKey, rawValue] of Object.entries(parsed.deltas)) {
        const key = toText(rawKey).trim()
        if (!allowed.has(key)) continue
        let num = finiteNumber(rawValue)
        if (num === null) continue
        if (maxAbs > 0) num = Math.max(-maxAbs, Math.min(maxAbs, num))
        if (num === 0) continue
        deltas[key] = num
      }
    }
    const description = parsed.description === undefined || parsed.description === null
      ? null
      : (toText(parsed.description).trim() || null)
    return { deltas, description }
  } catch {
    return empty
  }
}

/** 把 deltas 写进档案；返回 { record, applied: [{ key, delta }], noteChanged }。 */
export function applyNudge (record, deltas, description, opts) {
  const o = opts || {}
  const defaultScore = coerceFloat(o.defaultScore, DEFAULT_SCORE)
  const ignoreDescription = Boolean(o.ignoreDescription)
  const result = { record, applied: [], noteChanged: false }
  if (!isRecord(record)) return result
  try {
    if (!isRecord(record.scores)) record.scores = {}
    const deltaSource = isRecord(deltas) ? deltas : {}
    for (const [rawKey, rawDelta] of Object.entries(deltaSource)) {
      const key = toText(rawKey).trim()
      if (!key) continue
      const delta = finiteNumber(rawDelta)
      if (delta === null) continue
      if (key === 'total') {
        record.total = coerceFloat(record.total, defaultScore) + delta
      } else {
        record.scores[key] = coerceFloat(record.scores[key], defaultScore) + delta
      }
      result.applied.push({ key, delta })
    }
    const nextDescription = toText(description).trim()
    if (nextDescription && !ignoreDescription && nextDescription !== toText(record.description)) {
      record.description = nextDescription
      result.noteChanged = true
    }
    if (result.applied.length || result.noteChanged) record.updatedAt = Date.now()
  } catch {}
  return result
}

/** 持久化长笔记时，短窗口微调不允许改写笔记正文。 */
export function shouldIgnoreNudgeDescription (input) {
  const o = input || {}
  if (!o.persistentImpression) return false
  const sizeLimit = Number(o.sizeLimit)
  if (!Number.isFinite(sizeLimit)) return false
  try {
    return Array.from(toText(o.description)).length > Math.max(0, Math.floor(sizeLimit))
  } catch {
    return false
  }
}
