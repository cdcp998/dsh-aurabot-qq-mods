// 印象卡片（Aurabot 用户扩展）
//
// 移植自 MaiBot 的 maibot-impression-card-plugin（作者 kes，MIT）：
// 给群友一张欢乐向的好感度 / 印象卡 —— 顶部头像、昵称与好感度，中间横向量表条，
// 下面左边多维雷达、右边人物印象笔记。数值没有上下限：负分会穿过圆心，
// 超过量程会顶出外环。她可以自己给某人加减分、写印象笔记，也可以主动发卡。
//
// 和原插件的差异（都在 README 里写了）：
//   · 卡面用 SVG + DSH 自带 sharp 栅格化，不再依赖 Playwright / Pillow；
//   · 没有 PersonInfo / knowledge.search，长期记忆改从 Aurabot 的记忆模块取；
//   · 群友用 /卡片 由 message 事件接管（Aurabot 的 api.command 只认主人）；
//   · 主动提醒默认关闭，只做「小幅微调」，不会自己往群里说话。
//
// 数据放在 api.dataDir：affinity.json（档案）+ cards/（渲染出来的卡片）。

import { existsSync } from 'node:fs'
import { readFile, readdir, stat, unlink } from 'node:fs/promises'
import {
  DEFAULT_SCORE, DEFAULT_SCALE_MIN, DEFAULT_SCALE_MAX, DEFAULT_TOTAL_LABEL, DEFAULT_RADAR_TOP_N,
  parseDimensionConfig, findDimension, parseRadarSpec, formatNum, formatDelta, scoreGuidanceText,
} from './lib/dimensions.mjs'
import { createStore, createRecord, personIdOf } from './lib/store.mjs'
import { createIdentity } from './lib/identity.mjs'
import { buildCardSvg, themeOf, CARD_THEMES } from './lib/card.mjs'
import { createCardRenderer, fetchQqAvatar } from './lib/render.mjs'
import { sharpStatus } from './lib/sharp-plan.mjs'
import {
  DEFAULT_PROMPTS, buildColdStartPrompt, buildNudgePrompt, buildCompactPrompt,
  extractJsonObject, applyGeneration, buildCurrentScores, parseNudgePayload, applyNudge,
  shouldIgnoreNudgeDescription, textByteLength, truncateText, limitLabel,
  renderTemplate,
} from './lib/llm.mjs'

const VERSION = '1.0.5'

/** Electron 里 process.resourcesPath 一定在；纯 Node 下可能没有。 */
function safeResourcesPath () {
  try {
    return process.resourcesPath || ''
  } catch (error) {
    return ''
  }
}

function clampNumber (value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function splitList (raw) {
  return String(raw === undefined || raw === null ? '' : raw)
    .split(/[,，、\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function dayKey (ts) {
  const d = new Date(ts)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function clockOf (ts) {
  const d = new Date(ts)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

function dateTimeOf (ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '尚未更新'
  return dayKey(Number(ts)) + ' ' + clockOf(Number(ts))
}

function safeBase (ref) {
  return String((ref && ref.userId) || 'person').replace(/[^0-9a-zA-Z_-]/g, '').slice(0, 24) || 'person'
}

export default {
  id: 'impression-card',
  name: '印象卡片',
  version: VERSION,
  api: 1,
  description: '欢乐向的好感度 / 印象卡：多维度打分、雷达卡片、加减分系统通知、主动微调',
  panel: 'panel.js',
  // 设置和面板作为「人设」分组下的子标签页「印象卡片」，和人格、聊天、主动搭话、心情并列；
  // 注意不是 tab: 'persona'（那会塞进「人格」页内部）。
  group: 'self',

  defaults: {
    // 宿主版本较老时 /modules 不返回 group，面板靠这个标记把这一页挂到「人设」组下面。
    __panelGroup: 'self',
    enabled: true,
    botName: '大肥鱼',
    cardTitle: '{bot_name}的印象档案',
    totalLabel: DEFAULT_TOTAL_LABEL,
    defaultScore: DEFAULT_SCORE,
    scaleMin: DEFAULT_SCALE_MIN,
    scaleMax: DEFAULT_SCALE_MAX,
    radarTopN: DEFAULT_RADAR_TOP_N,
    dimensions: '',
    allowQueryOthers: true,
    guestCards: true,
    guestColdStart: false,
    refreshAdminOnly: true,
    adminQQ: '',
    theme: 'parchment',
    cardScale: 2,
    cardFormat: 'png',
    fetchAvatar: true,
    noteSizeLimit: 256,
    persistentNote: true,
    notifyEnabled: true,
    notifyDimensions: 'total',
    notifyTemplate: '',
    lightRefresh: false,
    lightRecentLimit: 48,
    lightMaxAbsDelta: 0,
    proactiveEnabled: false,
    proactiveHours: 6,
    proactivePollSeconds: 300,
    proactiveMaxPerTick: 2,
    recentMessages: 200,
    contextEnabled: true,
  },

  settings: [
    { key: 'enabled', label: '总开关', type: 'switch', hint: '关掉后命令、工具、面板接口和主动提醒都停，已有档案保留' },
    { key: 'botName', label: '她的名字', type: 'text', hint: '卡面标题和系统通知里的称呼；默认「大肥鱼」' },
    { key: 'cardTitle', label: '卡面标题', type: 'text', hint: '支持 {bot_name} 和 {person_name}；留空用「{bot_name}的印象档案」' },
    { key: 'totalLabel', label: '好感度名称', type: 'text', hint: '顶部那个独立整体评分的显示名，默认「好感度」' },
    { key: 'defaultScore', label: '默认中间值', type: 'number', min: -100, max: 100, step: 0.5, hint: '未评分、新增维度、冷启动都从这个值开始' },
    { key: 'scaleMin', label: '量程下限', type: 'number', min: -100, max: 100, step: 0.5, hint: '只影响显示刻度与配色，数值可以越界' },
    { key: 'scaleMax', label: '量程上限', type: 'number', min: -100, max: 100, step: 0.5, hint: '只影响显示刻度与配色，数值可以越界' },
    { key: 'radarTopN', label: '雷达维度数', type: 'number', min: 1, max: 12, step: 1, hint: '最多 12 项（再多标签会挤）；默认显示得分最高的 N 项，有负分时改成最高 N-1 项 + 最低 1 项' },
    { key: 'dimensions', label: '维度配置', type: 'textarea', hint: '一行一个：key = 标签 | 描述。留空用内置 22 项。改 key 等于新维度，改标签不会丢分' },
    { key: 'theme', label: '卡面主题', type: 'select', options: [{ value: 'parchment', label: '羊皮纸' }, { value: 'holo', label: '全息科技' }, { value: 'cute', label: '可爱贴纸' }], hint: '面板里可以直接预览三种主题' },
    { key: 'cardFormat', label: '卡片格式', type: 'select', options: [{ value: 'png', label: 'PNG（清晰）' }, { value: 'jpeg', label: 'JPEG（小一点）' }] },
    { key: 'cardScale', label: '渲染倍率', type: 'select', options: [{ value: '1', label: '1x（940×500）' }, { value: '2', label: '2x（1880×1000）' }, { value: '3', label: '3x（2820×1500）' }] },
    { key: 'fetchAvatar', label: '拉取 QQ 头像', type: 'switch', hint: '关掉就完全离线，卡面用占位头像；只请求固定地址 q1.qlogo.cn，不接收外部链接' },
    { key: 'allowQueryOthers', label: '允许查别人', type: 'switch', hint: '关掉后 /卡片 只能看自己' },
    { key: 'guestCards', label: '群友也能查卡', type: 'switch', hint: '开着时群里/私聊里别人发 /卡片 也能看自己的卡（主人命令不受影响）' },
    { key: 'guestColdStart', label: '群友冷启动', type: 'switch', hint: '关掉时，没有档案的人查卡不会触发模型生成，只看已有档案' },
    { key: 'refreshAdminOnly', label: '刷新仅管理员', type: 'switch', hint: '关掉后任何人都能 /刷新印象（会消耗模型额度）' },
    { key: 'adminQQ', label: '管理员 QQ', type: 'text', hint: '逗号或空格分隔；主人 QQ 自动算管理员' },
    { key: 'noteSizeLimit', label: '卡面笔记字数', type: 'number', min: 20, max: 2000, step: 10, hint: '卡面右侧笔记的显示上限；持久笔记超长时临时用模型精简，不改库' },
    { key: 'persistentNote', label: '持久印象笔记', type: 'switch', hint: '开：库里可以攒长文，卡面临时精简；关：写入时就按卡面上限精简' },
    { key: 'notifyEnabled', label: '系统通知', type: 'switch', hint: '加减分后在当前聊天播报（原始插件的 RPG 风格通知）' },
    { key: 'notifyDimensions', label: '通知哪些维度', type: 'text', hint: '维度 key 用逗号分隔；填 total 只通知好感度，填 * 通知全部，留空不通知' },
    { key: 'notifyTemplate', label: '通知模板', type: 'textarea', hint: '可用 {name}{dimension}{delta}{new_value}{reason}{nickname}；留空用内置模板' },
    { key: 'lightRefresh', label: '查卡时小幅微调', type: 'switch', hint: '开卡前先用较短窗口的最近聊天做一次增量微调（deltas，不发系统通知）' },
    { key: 'lightRecentLimit', label: '微调聊天条数', type: 'number', min: 8, max: 200, step: 4 },
    { key: 'lightMaxAbsDelta', label: '单次微调上限', type: 'number', min: 0, max: 50, step: 0.5, hint: '0 表示不限；限制单次 deltas 的绝对值，防止分数乱跳' },
    { key: 'recentMessages', label: '冷启动聊天条数', type: 'number', min: 20, max: 500, step: 10, hint: '冷启动 / 刷新时从聊天流水里取多少条' },
    { key: 'proactiveEnabled', label: '主动微调', type: 'switch', hint: '默认关。开着时每隔几小时对最近活跃、且已有档案的人做一次后台微调，不会自己发言' },
    { key: 'proactiveHours', label: '主动微调间隔（小时）', type: 'number', min: 1, max: 168, step: 1 },
    { key: 'proactivePollSeconds', label: '扫描间隔（秒）', type: 'number', min: 60, max: 3600, step: 60 },
    { key: 'proactiveMaxPerTick', label: '每轮最多几个聊天', type: 'number', min: 1, max: 10, step: 1 },
    { key: 'contextEnabled', label: '把印象塞进上下文', type: 'switch', hint: '每轮聊天前，如果对当前说话人有档案，就把分数和笔记摘要塞给她（她说话会更连戏）' },
  ],

  // dependencies 只给测试用（注入假的渲染器）；正常加载时 Aurabot 不会传。
  setup (api, dependencies = {}) {
    const log = api.log
    const store = createStore({ file: api.dataDir('affinity.json'), log })
    const identity = createIdentity({ api, store, log })
    // moduleDir：扩展自己的文件夹，只从它的 node_modules 里读 sharp，不安装。
    const moduleDir = String(api.dir || '')
    const renderer = dependencies.renderer || createCardRenderer({ dataDir: api.dataDir('cards'), log, moduleDir })
    let disposed = false
    const genLocks = new Map()
    const cooldown = new Map()
    const avatarCache = new Map() // userId → { at, dataUri }
    const noteCache = new Map() // personId + 长度 → 精简后的卡面笔记，避免每次预览都调模型
    let renderCount = 0
    let lastPoll = 0
    const startedAt = Date.now()
    // 当前聊天最后说话的人：activity 事件里记一份，省得每轮都去翻聊天流水。
    const lastSpeakers = new Map()

    api.onDispose(() => {
      disposed = true
      store.saveNow()
    })

    // ---------- 设置 ----------

    function conf () {
      const s = api.settings()
      const dimensions = parseDimensionConfig(s.dimensions)
      let scaleMin = clampNumber(s.scaleMin, -100, 100, DEFAULT_SCALE_MIN)
      let scaleMax = clampNumber(s.scaleMax, -100, 100, DEFAULT_SCALE_MAX)
      if (!(scaleMax > scaleMin)) { scaleMin = DEFAULT_SCALE_MIN; scaleMax = DEFAULT_SCALE_MAX }
      const notify = splitList(s.notifyDimensions).map((x) => x.toLowerCase())
      const admins = new Set([String(api.config().ownerQQ || ''), ...splitList(s.adminQQ)].filter(Boolean))
      const themeId = Object.prototype.hasOwnProperty.call(CARD_THEMES, s.theme) ? s.theme : 'parchment'
      return {
        enabled: s.enabled !== false,
        botName: String(s.botName || '大肥鱼').slice(0, 20),
        cardTitle: String(s.cardTitle || '').trim() || '{bot_name}的印象档案',
        totalLabel: String(s.totalLabel || DEFAULT_TOTAL_LABEL).slice(0, 12),
        defaultScore: clampNumber(s.defaultScore, -100, 100, DEFAULT_SCORE),
        scaleMin,
        scaleMax,
        // 卡面的雷达最多画 12 个标签，再多会挤成一团；设置里也按 12 封顶。
        radarTopN: Math.round(clampNumber(s.radarTopN, 1, Math.max(1, Math.min(12, dimensions.length)), DEFAULT_RADAR_TOP_N)),
        dimensions,
        allowQueryOthers: s.allowQueryOthers !== false,
        guestCards: s.guestCards !== false,
        guestColdStart: s.guestColdStart === true,
        refreshAdminOnly: s.refreshAdminOnly !== false,
        admins,
        theme: themeId,
        cardScale: Math.round(clampNumber(s.cardScale, 1, 3, 2)),
        format: String(s.cardFormat) === 'jpeg' || String(s.cardFormat) === 'jpg' ? 'jpeg' : 'png',
        fetchAvatar: s.fetchAvatar !== false,
        noteSizeLimit: Math.round(clampNumber(s.noteSizeLimit, 20, 2000, 256)),
        persistentNote: s.persistentNote !== false,
        notifyEnabled: s.notifyEnabled !== false,
        notifyAll: notify.some((x) => x === '*' || x === 'all' || x === '全部'),
        notifyDims: new Set(notify),
        notifyTemplate: String(s.notifyTemplate || '').trim() || DEFAULT_PROMPTS.notify,
        lightRefresh: s.lightRefresh === true,
        lightRecentLimit: Math.round(clampNumber(s.lightRecentLimit, 8, 200, 48)),
        lightMaxAbsDelta: clampNumber(s.lightMaxAbsDelta, 0, 50, 0),
        proactiveEnabled: s.proactiveEnabled === true,
        proactiveHours: clampNumber(s.proactiveHours, 1, 168, 6),
        proactivePollSeconds: Math.round(clampNumber(s.proactivePollSeconds, 60, 3600, 300)),
        proactiveMaxPerTick: Math.round(clampNumber(s.proactiveMaxPerTick, 1, 10, 2)),
        recentMessages: Math.round(clampNumber(s.recentMessages, 20, 500, 200)),
        contextEnabled: s.contextEnabled !== false,
      }
    }

    const themeObj = (c) => themeOf(c.theme)

    function isOwner (userId) {
      return String(userId || '') !== '' && String(userId) === String(api.config().ownerQQ || '')
    }

    function isAdmin (userId, c) {
      return isOwner(userId) || (c || conf()).admins.has(String(userId || ''))
    }

    function persona () {
      try {
        const text = api.core.personas.current()
        return String(text || '').slice(0, 8000)
      } catch (error) {
        return ''
      }
    }

    // ---------- 聊天流水 / 记忆 ----------

    // 一天内的聊天流水只解析一次（上下文每轮都要看最后说话的人，别反复读文件）。
    const dayCache = new Map() // day → { at, rows }
    function rowsOfDay (day) {
      const hit = dayCache.get(day)
      if (hit && Date.now() - hit.at < 10000) return hit.rows
      let rows = []
      try { rows = api.core.hub.chatLogOf(day) || [] } catch (error) { rows = [] }
      dayCache.set(day, { at: Date.now(), rows })
      if (dayCache.size > 4) {
        const oldest = [...dayCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, dayCache.size - 4)
        for (const [key] of oldest) dayCache.delete(key)
      }
      return rows
    }

    function chatRows (chatId, days) {
      const rows = []
      const count = Number(days) || 2
      for (let i = count - 1; i >= 0; i--) {
        for (const row of rowsOfDay(dayKey(Date.now() - i * 86400000))) {
          if (row && String(row.chatId) === String(chatId)) rows.push(row)
        }
      }
      return rows
    }

    function recentChatText (chatId, limit) {
      const c = conf()
      const rows = chatRows(chatId, 2).slice(-limit)
      return rows.map((row) => {
        const t = Number(row.t) || Date.now()
        const who = String(row.who || '') === 'bot' ? c.botName : String(row.who || '某人')
        const uid = row.uid ? '(' + row.uid + ')' : ''
        return clockOf(t) + ' ' + who + uid + '：' + String(row.text || '').replace(/\s+/g, ' ').slice(0, 300)
      }).join('\n')
    }

    api.on('activity', (event) => {
      try {
        if (!event || event.kind !== 'in' || !event.chatId || !event.userId) return
        lastSpeakers.set(String(event.chatId), { uid: String(event.userId), who: String(event.nickname || ''), t: Date.now() })
        if (lastSpeakers.size > 500) {
          const now = Date.now()
          for (const [key, value] of lastSpeakers) if (now - value.t > 6 * 3600 * 1000) lastSpeakers.delete(key)
        }
      } catch (error) {}
    })

    function lastSpeakerRow (chatId) {
      const hit = lastSpeakers.get(String(chatId))
      if (hit && Date.now() - hit.t < 3600 * 1000) return { uid: hit.uid, who: hit.who, t: hit.t }
      const rows = chatRows(chatId, 2)
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]
        if (row && row.uid && String(row.who || '') !== 'bot') return row
      }
      return null
    }

    async function memoryBlock (ref) {
      const out = []
      try {
        const memory = api.use('memory')
        if (memory && typeof memory.recall === 'function') {
          // recall 是关键词检索：名字、群名片、最近说过的话各试一次，去重后再交给提示词。
          const queries = [ref.displayName, ref.groupCard, ref.userNickname].filter(Boolean)
          const seen = new Set()
          for (const query of [...new Set(queries)]) {
            const hits = memory.recall(query, { about: ref.userId, limit: 20 }) || []
            for (const hit of hits) {
              const text = hit && ((hit.it && hit.it.text) || hit.text)
              if (!text) continue
              const clean = String(text).replace(/\s+/g, ' ').slice(0, 200)
              if (seen.has(clean)) continue
              seen.add(clean)
              out.push(clean)
            }
          }
        }
        if (memory && typeof memory.profiles === 'function') {
          const profile = (memory.profiles() || []).find((p) => String(p.qq) === String(ref.userId))
          const text = profile && (profile.text || profile.summary || profile.desc || profile.insight || profile.profile)
          if (text) out.unshift(String(text).replace(/\s+/g, ' ').slice(0, 600))
        }
      } catch (error) {
        log.debug('读记忆失败：' + (error && error.message ? error.message : error))
      }
      const record = store.get(ref.personId)
      if (record && record.description) out.push('（你以前写下的印象）' + record.description.slice(0, 800))
      const unique = [...new Set(out.filter(Boolean))].slice(0, 40)
      return unique.length ? unique.map((line) => '- ' + line).join('\n') : '（无）'
    }

    function personIdentities (ref) {
      const stored = store.get(ref.personId)
      return identity.identityBlock(ref, stored)
    }

    function existingBlock (record, c) {
      if (!record) return ''
      const lines = ['你之前对 ta 的档案（仅供参考，不必在旧分附近微调，允许大幅改动）：', '- ' + c.totalLabel + '：' + formatNum(record.total)]
      for (const d of c.dimensions) lines.push('- ' + d.label + '：' + formatNum(scoreOf(record, d.key, c)))
      if (record.description) lines.push('- 旧简介：' + record.description.slice(0, 800))
      return lines.join('\n') + '\n'
    }

    function scoreOf (record, key, c) {
      const value = record && record.scores ? Number(record.scores[key]) : NaN
      return Number.isFinite(value) ? value : c.defaultScore
    }

    // ---------- 档案 ----------

    function withLock (map, key, fn) {
      const prev = map.get(key) || Promise.resolve()
      const next = prev.then(fn, fn)
      const tail = next.catch(() => {})
      map.set(key, tail)
      next.finally(() => { if (map.get(key) === tail) map.delete(key) }).catch(() => {})
      return next
    }

    function newRecordFor (ref, c) {
      const record = createRecord({
        personId: ref.personId, platform: ref.platform, userId: ref.userId,
        displayName: ref.displayName, userNickname: ref.userNickname, groupCard: ref.groupCard,
        total: c.defaultScore,
      })
      for (const d of c.dimensions) record.scores[d.key] = c.defaultScore
      identity.remember(record, ref)
      return record
    }

    async function generateRecord (ref, chatId, existing) {
      const c = conf()
      const parsedExisting = existing || store.get(ref.personId)
      const memory = await memoryBlock(ref)
      const recent = recentChatText(chatId, c.recentMessages) || '（无）'
      const prompt = buildColdStartPrompt({
        persona: persona(),
        nickname: c.botName,
        personName: ref.displayName,
        taskIntro: parsedExisting ? '重新评估并更新' : '建立',
        totalLabel: c.totalLabel,
        defaultScore: c.defaultScore,
        scaleMin: c.scaleMin,
        scaleMax: c.scaleMax,
        dimensions: c.dimensions,
        personIdentities: personIdentities(ref),
        memoryBlock: memory,
        recentChat: recent,
        refreshGuidance: parsedExisting ? DEFAULT_PROMPTS.refreshGuidance : '',
        existingBlock: existingBlock(parsedExisting, c),
        sizeLimit: c.noteSizeLimit,
      })
      let raw = ''
      try {
        raw = await api.ask({ text: prompt, maxTokens: 1400 })
      } catch (error) {
        log.warn('印象生成失败（' + (parsedExisting ? '刷新' : '冷启动') + '）：' + (error && error.message ? error.message : error))
      }
      const parsed = raw ? extractJsonObject(raw) : null
      const record = parsedExisting
        ? { ...parsedExisting, scores: { ...(parsedExisting.scores || {}) } }
        : newRecordFor(ref, c)
      if (parsed) {
        applyGeneration(record, parsed, { dimensions: c.dimensions, defaultScore: c.defaultScore })
      } else {
        for (const d of c.dimensions) {
          if (!Number.isFinite(Number(record.scores[d.key]))) record.scores[d.key] = c.defaultScore
        }
      }
      record.updatedAt = Date.now()
      completeness(record, c)
      identity.remember(record, ref)
      store.upsert(record)
      store.saveNow()
      if (parsed) log.info('已为 ' + ref.displayName + (parsedExisting ? ' 刷新印象' : ' 建立印象档案'))
      return record
    }

    function completeness (record, c) {
      if (!Number.isFinite(Number(record.total))) record.total = c.defaultScore
      if (!record.scores || typeof record.scores !== 'object') record.scores = {}
      for (const d of c.dimensions) {
        if (!Number.isFinite(Number(record.scores[d.key]))) record.scores[d.key] = c.defaultScore
      }
      return record
    }

    async function ensureRecord (ref, chatId) {
      const existing = store.get(ref.personId)
      if (existing) {
        completeness(existing, conf())
        identity.remember(existing, ref)
        return existing
      }
      return withLock(genLocks, ref.personId, async () => {
        const again = store.get(ref.personId)
        if (again) return again
        return generateRecord(ref, chatId, null)
      })
    }

    async function refreshRecord (ref, chatId) {
      return withLock(genLocks, ref.personId, async () => generateRecord(ref, chatId, store.get(ref.personId)))
    }

    function resolveDimension (dimension, c) {
      const raw = String(dimension === undefined || dimension === null ? 'total' : dimension).trim()
      if (!raw || raw.toLowerCase() === 'total' || raw === c.totalLabel || raw === '好感度') {
        return { key: 'total', label: c.totalLabel }
      }
      const found = findDimension(c.dimensions, raw)
      if (found) return { key: found.key, label: found.label }
      return null
    }

    async function adjustScore (ref, dimension, delta, opts) {
      const c = conf()
      const o = opts || {}
      const dim = resolveDimension(dimension, c)
      if (!dim) {
        return { ok: false, message: '未知维度「' + String(dimension) + '」。可用：total、' + c.dimensions.map((d) => d.key + '(' + d.label + ')').join('、') }
      }
      const record = store.get(ref.personId) || newRecordFor(ref, c)
      completeness(record, c)
      identity.remember(record, ref)
      const oldValue = dim.key === 'total' ? record.total : scoreOf(record, dim.key, c)
      let newValue = oldValue
      if (o.mode === 'set') {
        newValue = Number(delta)
        if (!Number.isFinite(newValue)) return { ok: false, message: '要设定的数值不是数字。' }
      } else {
        const step = Number(delta)
        if (!Number.isFinite(step)) return { ok: false, message: '增量不是数字。' }
        newValue = oldValue + step
      }
      if (dim.key === 'total') record.total = newValue
      else record.scores[dim.key] = newValue
      record.updatedAt = Date.now()
      store.upsert(record)
      store.saveNow()
      const applied = newValue - oldValue
      store.pushEvent({ at: Date.now(), personId: ref.personId, name: ref.displayName, dimension: dim.key, delta: applied, value: newValue, reason: String(o.reason || '').slice(0, 120) })
      if (o.notify !== false && o.chatId) {
        await notifyChange(o.chatId, ref, dim, applied, newValue, o.reason, c)
      }
      try {
        api.use('memory')?.addEvent?.({
          text: c.botName + '把对 ' + ref.displayName + ' 的「' + dim.label + '」' + formatDelta(applied) + ' 到 ' + formatNum(newValue) + (o.reason ? '，因为' + String(o.reason).slice(0, 80) : ''),
          tags: ['印象'],
          importance: 0.3,
        })
      } catch (error) {}
      return { ok: true, record, dimension: dim.key, label: dim.label, oldValue, newValue, delta: applied }
    }

    async function notifyChange (chatId, ref, dim, delta, value, reason, c) {
      if (!c.notifyEnabled) return false
      if (!c.notifyAll && !c.notifyDims.has(dim.key)) return false
      const text = renderTemplate(c.notifyTemplate, {
        name: ref.displayName,
        dimension: dim.label,
        delta: formatDelta(delta),
        new_value: formatNum(value),
        reason: String(reason || '').trim() || '（未说明）',
        nickname: c.botName,
      }).trim()
      if (!text) return false
      try {
        await api.sendText(chatId, text)
        return true
      } catch (error) {
        log.debug('系统通知没发出去：' + (error && error.message ? error.message : error))
        return false
      }
    }

    // ---------- 简介 / 精简 ----------

    async function compactText (text, ref, c) {
      let current = String(text || '').trim()
      if (!current) return ''
      const label = limitLabel(c.noteSizeLimit, 'chars')
      for (let attempt = 0; attempt < 2; attempt++) {
        if (current.length <= c.noteSizeLimit) return current
        let out = ''
        try {
          out = await api.ask({
            text: buildCompactPrompt({
              persona: persona(),
              nickname: c.botName,
              personName: ref.displayName,
              used: String(current.length) + ' 字符',
              limitLabel: label,
              description: current,
            }),
            maxTokens: 500,
          })
        } catch (error) {
          log.warn('精简简介失败：' + (error && error.message ? error.message : error))
          break
        }
        const next = String(out || '').replace(/^["「]|["」]$/g, '').trim()
        if (!next) break
        if (next.length < current.length) current = next
        if (current.length <= c.noteSizeLimit) return current
      }
      return truncateText(current, c.noteSizeLimit, 'chars')
    }

    async function descriptionForCard (record, ref, c) {
      const text = String(record.description || '').trim()
      if (!text) return ''
      if (!c.persistentNote) return text.length <= c.noteSizeLimit ? text : truncateText(text, c.noteSizeLimit, 'chars')
      if (text.length <= c.noteSizeLimit) return text
      const key = ref.personId + '|' + c.noteSizeLimit + '|' + text.length + '|' + text.slice(0, 40)
      const hit = noteCache.get(key)
      if (hit) return hit
      const compacted = await compactText(text, ref, c)
      noteCache.set(key, compacted)
      if (noteCache.size > 100) {
        for (const oldKey of [...noteCache.keys()].slice(0, 30)) noteCache.delete(oldKey)
      }
      return compacted
    }

    // ---------- 卡片 ----------

    function cardSummaryText (record, ref, c) {
      const top = c.dimensions
        .map((d) => ({ label: d.label, value: scoreOf(record, d.key, c) }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 5)
        .map((d) => d.label + ' ' + formatNum(d.value))
        .join(' · ')
      const lines = [
        '【' + c.botName + '的印象卡片】' + ref.displayName + (ref.userId ? '（' + ref.userId + '）' : ''),
        c.totalLabel + '：' + formatNum(record.total),
        top || '（还没有维度分）',
      ]
      if (record.description) lines.push('印象：' + (record.description.length > 160 ? record.description.slice(0, 160) + '…' : record.description))
      const dims = c.dimensions.slice(0, 8).map((d) => d.label + ' ' + formatNum(scoreOf(record, d.key, c))).join(' / ')
      if (dims) lines.push(dims)
      return lines.join('\n')
    }

    // 头像缓存：面板预览会反复请求同一张卡，别每次都去 q1.qlogo.cn。
    async function avatarFor (ref, c) {
      if (!c.fetchAvatar || !ref.userId) return ''
      const hit = avatarCache.get(ref.userId)
      if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.dataUri
      let dataUri = ''
      try {
        const buf = await fetchQqAvatar(ref.userId)
        if (buf) dataUri = await renderer.avatarDataUri(buf)
      } catch (error) {
        log.debug('头像处理失败：' + (error && error.message ? error.message : error))
      }
      avatarCache.set(ref.userId, { at: Date.now(), dataUri })
      // 头像是 data URI，几十张就会占几十 MB；只留最近 60 个。
      if (avatarCache.size > 60) {
        const oldest = [...avatarCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 20)
        for (const [key] of oldest) avatarCache.delete(key)
      }
      return dataUri
    }

    // 渲染出来的卡片越攒越多：偶尔删掉最旧的，保留最近 100 张。
    async function pruneCards (dir) {
      try {
        const names = (await readdir(dir)).filter((n) => /\.(png|jpg)$/i.test(n))
        if (names.length <= 100) return
        const stats = []
        for (const name of names) {
          try { stats.push({ name, at: (await stat(dir + '/' + name)).mtimeMs }) } catch (error) {}
        }
        stats.sort((a, b) => a.at - b.at)
        for (const item of stats.slice(0, stats.length - 100)) {
          try { await unlink(dir + '/' + item.name) } catch (error) {}
        }
      } catch (error) {}
    }

    // 面板可能同时点开几个人；并发太多会一起卡住 sharp，排个队（最多两张同时画）。
    let activeRenders = 0
    async function renderCard (record, ref, opts) {
      while (activeRenders >= 2) await new Promise((resolve) => setTimeout(resolve, 60))
      activeRenders++
      try {
        return await renderCardNow(record, ref, opts)
      } finally {
        activeRenders--
      }
    }

    async function renderCardNow (record, ref, opts) {
      const c = conf()
      const o = opts || {}
      completeness(record, c)
      const requestedTopN = Number(o.radarTopN)
      const radarTopN = requestedTopN > 0
        ? Math.round(clampNumber(requestedTopN, 1, Math.max(1, Math.min(12, c.dimensions.length)), c.radarTopN))
        : c.radarTopN
      const dimensions = c.dimensions.map((d) => ({ key: d.key, label: d.label, value: scoreOf(record, d.key, c) }))
      const description = await descriptionForCard(record, ref, c)
      const avatarDataUri = await avatarFor(ref, c)
      const title = c.cardTitle.replace(/\{bot_name\}/g, c.botName).replace(/\{person_name\}/g, ref.displayName)
      const svg = buildCardSvg({
        theme: c.theme,
        title,
        personName: ref.displayName,
        personLabel: ref.userId ? 'QQ ' + ref.userId : '',
        total: record.total,
        totalLabel: c.totalLabel,
        dimensions,
        radarTopN,
        scaleMin: c.scaleMin,
        scaleMax: c.scaleMax,
        description,
        avatarDataUri,
        updatedText: '更新于 ' + dateTimeOf(record.updatedAt),
        footer: c.botName + ' · 印象档案',
      })
      const result = await renderer.renderCard({
        svg,
        fileBase: safeBase(ref) + '-' + Date.now().toString(36),
        format: c.format,
        scale: c.cardScale,
      })
      if (!result.ok) return { ok: false, error: result.error || '渲染失败', svg }
      renderCount++
      if (renderCount % 20 === 0) await pruneCards(api.dataDir('cards'))
      return { ok: true, file: result.file, bytes: result.bytes, svg }
    }

    async function sendCard (chatId, ref, opts) {
      const c = conf()
      const o = opts || {}
      let record = store.get(ref.personId)
      const created = !record
      if (!record) {
        if (o.coldStart === false) {
          return { ok: false, message: '还没有 ' + ref.displayName + ' 的印象档案。' }
        }
        record = await ensureRecord(ref, chatId)
      }
      if (o.refresh && !created) record = await refreshRecord(ref, chatId)
      else if (c.lightRefresh) {
        await nudgeRecord(ref, chatId).catch(() => {})
        record = store.get(ref.personId) || record
      }
      completeness(record, c)
      const out = await renderCard(record, ref, { radarTopN: o.radarTopN })
      if (out.ok) {
        try {
          await api.sendImage(chatId, out.file)
          return { ok: true, file: out.file, record, message: '卡片已发送' }
        } catch (error) {
          log.warn('卡片发送失败：' + (error && error.message ? error.message : error))
          return { ok: false, message: '卡片画好了，但发送失败。', record }
        }
      }
      log.warn('卡片渲染失败，改发文字版：' + out.error)
      await api.sendText(chatId, cardSummaryText(record, ref, c))
      return { ok: true, record, message: '图片渲染不可用，已发文字版卡片。', fallback: true }
    }

    // ---------- 小幅微调 ----------

    async function nudgeRecord (ref, chatId) {
      const c = conf()
      // 和生成 / 刷新共用同一把锁：并发时不会一份笔记盖掉另一份。
      return withLock(genLocks, ref.personId, async () => {
        const existing = store.get(ref.personId)
        if (!existing) return { ok: false, message: '还没有这个人的档案。' }
        completeness(existing, c)
        const recent = recentChatText(chatId, c.lightRecentLimit)
        if (!recent) return { ok: false, message: '最近没有可以看的聊天记录。' }
        const ignore = shouldIgnoreNudgeDescription({
          persistentImpression: c.persistentNote,
          description: existing.description,
          sizeLimit: c.noteSizeLimit,
        })
        const notePolicy = ignore
          ? '【笔记策略】当前笔记长于卡面上限，这是持久印象期刊。禁止返回 description（或返回也会被忽略）。只调整 deltas。'
          : '【笔记策略】可以返回微调后的完整笔记，或省略以保留。'
        const currentNote = ignore
          ? (existing.description ? existing.description.slice(0, c.noteSizeLimit) + '…' : '（无）')
          : (existing.description || '（无）')
        const prompt = buildNudgePrompt({
          persona: persona(),
          nickname: c.botName,
          personName: ref.displayName,
          totalLabel: c.totalLabel,
          scaleMin: c.scaleMin,
          scaleMax: c.scaleMax,
          defaultScore: c.defaultScore,
          dimensions: c.dimensions,
          currentScoresBlock: buildCurrentScores(existing, { dimensions: c.dimensions, totalLabel: c.totalLabel, defaultScore: c.defaultScore }),
          currentNote,
          notePolicy,
          personIdentities: personIdentities(ref),
          recentChat: recent,
          sizeLimit: c.noteSizeLimit,
        })
        let raw = ''
        try {
          raw = await api.ask({ text: prompt, maxTokens: 800 })
        } catch (error) {
          return { ok: false, message: '微调调用模型失败：' + (error && error.message ? error.message : error) }
        }
        const parsed = extractJsonObject(raw)
        if (!parsed) return { ok: false, message: '模型没给出有效 JSON，档案保持不变。' }
        const allowed = new Set(['total', ...c.dimensions.map((d) => d.key)])
        const { deltas, description } = parseNudgePayload(parsed, { allowedKeys: allowed, maxAbsDelta: c.lightMaxAbsDelta })
        const result = applyNudge(existing, deltas, description, { ignoreDescription: ignore, defaultScore: c.defaultScore })
        completeness(result.record, c)
        result.record.updatedAt = Date.now()
        identity.remember(result.record, ref)
        store.upsert(result.record)
        store.saveNow()
        for (const item of result.applied) {
          const label = item.key === 'total' ? c.totalLabel : (findDimension(c.dimensions, item.key) || {}).label || item.key
          store.pushEvent({ at: Date.now(), personId: ref.personId, name: ref.displayName, dimension: item.key, delta: item.delta, value: item.key === 'total' ? result.record.total : scoreOf(result.record, item.key, c), reason: '小幅微调' + (label ? '：' + label : '') })
        }
        return { ok: true, applied: result.applied, noteChanged: result.noteChanged, record: result.record, message: result.applied.length || result.noteChanged ? '已在后台上调了印象' : '这次没什么变化' }
      })
    }

    // ---------- 对象解析 / 命令 ----------

    async function refFromCurrentChat (chat, chatId) {
      if (chat && chat.kind === 'private' && chat.userId) {
        return identity.refFromUser(chat.userId, { platform: 'qq' })
      }
      const row = lastSpeakerRow(chatId)
      if (row && row.uid) return identity.refFromUser(row.uid, { groupId: chat && chat.groupId, nickname: row.who })
      return null
    }

    async function resolveTarget (target, ctx) {
      const text = String(target === undefined || target === null ? '' : target).trim()
      if (!text) {
        const ref = await refFromCurrentChat(ctx.chat, ctx.chatId)
        return ref ? { ref } : { error: '这条消息里看不出在说谁，请传 QQ 号或名字。' }
      }
      return identity.resolve(text, { groupId: ctx.chat && ctx.chat.groupId, platform: 'qq' })
    }

    function contextOf (msg) {
      return { chatId: msg.chatId, chat: { chatId: msg.chatId, kind: msg.kind, userId: msg.userId, groupId: msg.groupId } }
    }

    // 自然语言触发：消息里出现「查询好感度 [名字]」就等同 /卡片（不用打斜杠）。
    // 只认开头这几个词，避免普通聊天里提到「好感度」也发卡；名字后面可以带 雷达:N。
    const CARD_QUERY_RE = /^(?:请|帮我|帮忙|给我|麻烦你?)?\s*(?:查询|查看|查|看看)\s*(?:一下)?\s*好感度\s*(?:[:：,，、]\s*)?([\s\S]*)$/
    const CARD_QUERY_ALT_RE = /^好感度\s*(?:查询|查看|查)\s*(?:[:：,，、]\s*)?([\s\S]*)$/

    /** 从「查询好感度 小明」里取出对象；不是这种话返回 null。 */
    function parseCardQuery (text) {
      let raw = String(text === undefined || text === null ? '' : text).trim()
      // 群里 @她 的时候，消息正文前面会带「@QQ号」；先去掉再认
      while (/^@\S+\s+/.test(raw)) raw = raw.replace(/^@\S+\s+/, '').trim()
      if (!raw) return null
      const match = raw.match(CARD_QUERY_RE) || raw.match(CARD_QUERY_ALT_RE)
      if (!match) return null
      let target = String(match[1] || '').trim()
      target = target.replace(/^[的是叫:：\s]+/, '')
      target = target.replace(/[？?。.!！~～\s]+$/g, '')
      target = target.replace(/(?:呢|吗|啊|呀|吧)$/g, '').trim()
      const spec = parseRadarSpec(target)
      return { target: spec.target, topN: spec.topN }
    }

    function helpText () {
      const c = conf()
      return [
        '【' + c.botName + '的印象卡片】',
        '/卡片 —— 看自己的印象卡',
        '/卡片 小明、/卡片 12345678 —— 看别人（可在设置里关掉）',
        '/卡片 雷达:8 —— 指定雷达图显示几个维度',
        '不想打斜杠也行：直接说「查询好感度」或「查询好感度 小明」。',
        '/刷新印象 [名字] —— 结合记忆和最近聊天重新评估（默认仅管理员）',
        '/印象列表 —— 现有档案一览',
        '/印象卡片帮助 —— 这份说明',
        '',
        '群友也能直接发 /卡片 看自己的卡；数值没有上下限，纯属欢乐向设定。',
      ].join('\n')
    }

    function allowCooldown (msg, scope) {
      const key = scope + '|' + msg.chatId + '|' + msg.userId
      const now = Date.now()
      if (now - (cooldown.get(key) || 0) < 8000) return false
      cooldown.set(key, now)
      if (cooldown.size > 800) {
        for (const [k, at] of cooldown) if (now - at > 120000) cooldown.delete(k)
      }
      return true
    }

    // 群友冷启动的每日额度（按人算），避免有人在群里连点别人的卡把模型额度刷光。
    const guestColdStartDay = { day: '', used: new Map() }
    function allowGuestColdStart (userId) {
      const day = dayKey(Date.now())
      if (guestColdStartDay.day !== day) {
        guestColdStartDay.day = day
        guestColdStartDay.used.clear()
      }
      const uid = String(userId || '')
      const used = guestColdStartDay.used.get(uid) || 0
      if (used >= 6) return false
      guestColdStartDay.used.set(uid, used + 1)
      return true
    }

    /** 引用回复某人后发 /卡片：从被引用的消息里找说话人。 */
    async function quotedRef (msg) {
      if (!msg || !msg.replyId) return null
      try {
        const raw = await api.onebot('get_msg', { message_id: msg.replyId })
        const data = raw && (raw.data || raw)
        if (!data) return null
        const sender = data.sender || {}
        const uid = sender.user_id || data.user_id
        if (!uid) return null
        return identity.refFromUser(String(uid), {
          groupId: msg.groupId,
          nickname: sender.card || sender.nickname || '',
          groupCard: sender.card || '',
        })
      } catch (error) {
        log.debug('读引用的消息失败：' + (error && error.message ? error.message : error))
        return null
      }
    }

    async function commandTarget (arg, msg, { allowOthers }) {
      const spec = parseRadarSpec(arg)
      if (!spec.target && msg && msg.replyId) {
        const quoted = await quotedRef(msg)
        if (quoted) return { ref: quoted, topN: spec.topN }
      }
      if (!spec.target) {
        const ref = await identity.refFromMessage(msg)
        return ref ? { ref, topN: spec.topN } : { error: '拿不到你的身份信息。' }
      }
      if (!allowOthers) return { error: '现在只允许查自己的卡片哦。' }
      const resolved = await resolveTarget(spec.target, contextOf(msg))
      if (!resolved.ref) return { error: resolved.error }
      return { ref: resolved.ref, topN: spec.topN }
    }

    async function ownerCard (arg, msg) {
      const c = conf()
      if (!c.enabled) return '印象卡片已关闭（面板「扩展」里打开总开关）。'
      if (api.config().enabled === false) return 'Aurabot 总开关关着，先打开再发卡。'
      const raw = String(arg || '').trim()
      if (raw === '帮助' || raw === 'help' || raw === '?') return helpText()
      const target = await commandTarget(arg, msg, { allowOthers: c.allowQueryOthers })
      if (target.error) return target.error
      try {
        const out = await sendCard(msg.chatId, target.ref, { radarTopN: target.topN })
        return out.ok ? '' : out.message
      } catch (error) {
        log.warn('发卡失败：' + (error && error.message ? error.message : error))
        return '卡片没画出来：' + (error && error.message ? error.message : '未知错误')
      }
    }

    async function ownerRefresh (arg, msg) {
      const c = conf()
      if (!c.enabled) return '印象卡片已关闭。'
      if (api.config().enabled === false) return 'Aurabot 总开关关着，先打开再刷新。'
      if (c.refreshAdminOnly && !isAdmin(msg.userId, c)) return '刷新印象只允许管理员（设置里可以关掉这个限制）。'
      const target = await commandTarget(arg, msg, { allowOthers: c.allowQueryOthers })
      if (target.error) return target.error
      try {
        const out = await sendCard(msg.chatId, target.ref, { refresh: true, radarTopN: target.topN })
        return out.ok ? '' : out.message
      } catch (error) {
        log.warn('刷新印象失败：' + (error && error.message ? error.message : error))
        return '刷新时出错了：' + (error && error.message ? error.message : '未知错误')
      }
    }

    function listText () {
      const c = conf()
      const list = store.all().slice(0, 24)
      if (!list.length) return '还没有任何印象档案。发一张 /卡片 就会开始记。'
      const lines = ['现有印象档案（共 ' + store.stats().persons + ' 人）']
      for (const record of list) {
        const top = c.dimensions
          .map((d) => ({ label: d.label, value: scoreOf(record, d.key, c) }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 3)
          .map((d) => d.label + ' ' + formatNum(d.value))
          .join('、')
        lines.push('· ' + record.displayName + '：' + c.totalLabel + ' ' + formatNum(record.total) + (top ? '（' + top + '）' : ''))
      }
      return lines.join('\n')
    }

    // 帮助要最先注册：Aurabot 的命令解析对中文命令支持「/命令后面直接跟内容」，
    // 否则 /印象卡片帮助 会先被 /印象卡片 吃掉，变成查一个叫「帮助」的人。
    api.command({ name: '印象卡片帮助', aliases: ['卡片帮助', 'card_help', 'impression_card_help'], desc: '印象卡片用法', run: () => helpText() })
    api.command({ name: '卡片', aliases: ['card', '印象卡片', 'impression_card'], desc: '看自己或别人的印象卡：/卡片 [名字或QQ] [雷达:N]', run: ownerCard })
    api.command({ name: '刷新印象', aliases: ['refresh_impression'], desc: '结合记忆与最近聊天重新评估：/刷新印象 [名字或QQ]', run: ownerRefresh })
    api.command({ name: '印象列表', aliases: ['impression_list'], desc: '看现有印象档案', run: () => listText() })

    // 群友（非主人）用 /卡片：Aurabot 的 api.command 只认主人，所以在这里接管这条消息。
    //
    // 主人的命令已经由 api.command 执行过了。如果命令的 run 返回空串，中枢会继续把这条
    // 消息交给她处理（见 hub 的 onCommand），所以在 message 事件里把主人这几条命令吞掉，
    // 避免她再对「/卡片」本身回一句。
    // 中文命令允许「/卡片小明」这种不带空格的写法；英文命令要求词边界，别把 /cards 之类当成命令。
    const OWN_CN_COMMAND_RE = /^[\/／]\s*(?:印象卡片帮助|卡片帮助|印象卡片|刷新印象|印象列表|卡片)/
    const OWN_EN_COMMAND_RE = /^[\/／]\s*(?:impression_card_help|card_help|impression_list|refresh_impression|impression_card|card)(?![a-z0-9_-])/i

    // 发卡的公共流程：/卡片 和「查询好感度」都走这里。
    // owner=true 时不受 guestCards / guestColdStart 限制（主人永远可以冷启动）。
    async function serveCard (msg, spec, opts) {
      const c = conf()
      const isOwnerUser = Boolean(opts && opts.owner)
      if (!allowCooldown(msg, isOwnerUser ? 'owner-card' : 'guest-card')) {
        await api.reply(msg, '刚看过啦，过几秒再来～')
        return true
      }
      if (spec.target && !c.allowQueryOthers) {
        await api.reply(msg, '现在只能查自己的卡片哦。')
        return true
      }
      let ref = null
      if (spec.target) {
        const resolved = await resolveTarget(spec.target, contextOf(msg))
        ref = resolved.ref
        if (!ref) {
          await api.reply(msg, resolved.error || '找不到这个人。')
          return true
        }
      } else if (msg.replyId) {
        ref = await quotedRef(msg)
        if (!ref) ref = await identity.refFromMessage(msg)
      } else {
        ref = await identity.refFromMessage(msg)
      }
      if (!ref) {
        await api.reply(msg, '拿不到你的身份信息。')
        return true
      }
      const exists = store.get(ref.personId)
      if (!exists && !isOwnerUser && (!c.guestColdStart || !allowGuestColdStart(msg.userId))) {
        await api.reply(msg, c.guestColdStart
          ? '今天已经给好几个人建过卡啦，明天再来吧。'
          : '还没有 ' + ref.displayName + ' 的印象档案，等聊熟了再看吧。')
        return true
      }
      try {
        const out = await sendCard(msg.chatId, ref, { radarTopN: spec.topN })
        if (!out.ok) await api.reply(msg, out.message || '卡片没发出来，稍后再试。')
      } catch (error) {
        log.warn('发卡失败：' + (error && error.message ? error.message : error))
        await api.reply(msg, '卡片没画出来，过会儿再试试。')
      }
      return true
    }

    api.on('message', async (msg) => {
      if (disposed) return false
      const c = conf()
      const text = String(msg.text || '').trim()
      const owner = api.isOwner(msg.userId)

      // 1) 自然语言：查询好感度 [名字]（不需要 /）
      const natural = parseCardQuery(text)
      if (natural) {
        if (!c.enabled) return false
        if (!owner && !c.guestCards) return false
        return serveCard(msg, natural, { owner })
      }

      // 2) 主人发的 /卡片 等命令已经由 api.command 执行过；这里吞掉那几条，别再交给她回
      if (owner) return OWN_CN_COMMAND_RE.test(text) || OWN_EN_COMMAND_RE.test(text)

      // 3) 非主人用 /刷新印象、/印象列表：明确拒绝（或干脆吞掉），别让她把命令当聊天来回
      const adminOnly = text.match(/^[\/／]\s*(刷新印象|refresh_impression|印象列表|impression_list)(?![a-z0-9_-])/i)
      if (adminOnly) {
        if (/刷新印象|refresh_impression/i.test(adminOnly[1])) await api.reply(msg, '刷新印象只能让主人来（会消耗模型额度）。')
        else await api.reply(msg, '档案列表只有主人能看。想看自己的卡发 /卡片 就行。')
        return true
      }
      if (!c.enabled || !c.guestCards) return false
      const help = text.match(/^[\/／](印象卡片帮助|卡片帮助|card_help|impression_card_help)$/i)
      if (help) {
        await api.reply(msg, helpText())
        return true
      }
      const match = text.match(/^[\/／](印象卡片|卡片)([\s\S]*)$/)
        || text.match(/^[\/／](card|impression_card)(?:\s+([\s\S]*))?$/i)
      if (!match) return false
      const spec = parseRadarSpec(match[2])
      if (spec.target === '帮助' || spec.target === 'help' || spec.target === '?') {
        await api.reply(msg, helpText())
        return true
      }
      return serveCard(msg, spec, { owner: false })
    })

    // ---------- 给她用的工具 ----------

    api.tool((where) => {
      const c = conf()
      const chat = where && where.chat
      if (!c.enabled || disposed || !chat || chat.kind === 'system') return []
      const chatId = chat.chatId
      const ctx = { chat, chatId }
      const targetParam = { type: 'string', description: '对象：QQ 号或名字；不传表示当前说话的人' }
      const dimensionParam = { type: 'string', description: 'total（好感度整体评分）或维度 key；不传默认 total' }
      const reasonParam = { type: 'string', description: '变动缘由，会出现在系统通知里' }
      const lookup = async (target) => {
        const resolved = await resolveTarget(target, ctx)
        if (!resolved.ref) return { error: resolved.error || '解析对象失败。' }
        return { ref: resolved.ref }
      }
      const tools = []

      tools.push(api.defineTool({
        name: 'impression_adjust',
        description: '给某人的好感度或某个子项维度加分 / 减分（delta 可为负）。这是欢乐向设定，可凭你自己的主观态度调整。调整后会按配置发【系统通知】，并返回该项的新数值。' + scoreGuidanceText({ defaultScore: c.defaultScore, scaleMin: c.scaleMin, scaleMax: c.scaleMax }),
        properties: { target: targetParam, dimension: dimensionParam, delta: { type: 'number', description: '增量，可正可负' }, reason: reasonParam },
        required: ['delta'],
        execute: async ({ target, dimension, delta, reason }) => {
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          const out = await adjustScore(found.ref, dimension || 'total', delta, { chatId, reason })
          if (!out.ok) return { ok: false, message: out.message }
          return { ok: true, message: '已给 ' + found.ref.displayName + ' 的「' + out.label + '」' + formatDelta(out.delta) + '，当前 ' + formatNum(out.newValue) + '。' }
        },
      }))

      tools.push(api.defineTool({
        name: 'impression_set',
        description: '直接把某人的好感度或某个子项维度设定成指定数值（用于重置 / 校准）。target、dimension 规则同 impression_adjust。',
        properties: { target: targetParam, dimension: dimensionParam, value: { type: 'number', description: '要设定的数值' }, reason: reasonParam },
        required: ['value'],
        execute: async ({ target, dimension, value, reason }) => {
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          const out = await adjustScore(found.ref, dimension || 'total', value, { chatId, reason, mode: 'set' })
          if (!out.ok) return { ok: false, message: out.message }
          return { ok: true, message: '已把 ' + found.ref.displayName + ' 的「' + out.label + '」设定为 ' + formatNum(out.newValue) + '。' }
        },
      }))

      tools.push(api.defineTool({
        name: 'impression_append_note',
        description: '给某人的人物印象笔记追加一段文字（会出现在 ta 的好感度卡右侧）。target 规则同上。',
        properties: { content: { type: 'string', description: '要追加的笔记文字' }, target: targetParam },
        required: ['content'],
        execute: async ({ content, target }) => {
          const text = String(content || '').trim()
          if (!text) return { ok: false, message: '内容为空，没有写入。' }
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          const record = store.get(found.ref.personId) || newRecordFor(found.ref, c)
          completeness(record, c)
          identity.remember(record, found.ref)
          const base = String(record.description || '').trim()
          record.description = (base ? base + '\n' : '') + text
          record.updatedAt = Date.now()
          store.upsert(record)
          store.saveNow()
          return { ok: true, message: '已追加到 ' + found.ref.displayName + ' 的印象笔记，当前 ' + textByteLength(record.description) + ' 字节。' }
        },
      }))

      tools.push(api.defineTool({
        name: 'impression_rewrite_note',
        description: '用新内容【完全覆盖】某人的人物印象笔记。target 规则同上。',
        properties: { content: { type: 'string', description: '新的完整笔记' }, target: targetParam },
        required: ['content'],
        execute: async ({ content, target }) => {
          const text = String(content || '').trim()
          if (!text) return { ok: false, message: '内容为空，原笔记已保留。' }
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          const record = store.get(found.ref.personId) || newRecordFor(found.ref, c)
          completeness(record, c)
          identity.remember(record, found.ref)
          record.description = text
          record.updatedAt = Date.now()
          store.upsert(record)
          store.saveNow()
          return { ok: true, message: '已覆盖 ' + found.ref.displayName + ' 的印象笔记。' }
        },
      }))

      tools.push(api.defineTool({
        name: 'impression_detail',
        description: '以文字形式查看某个人的完整印象档案（好感度、各维度分值、笔记）。target 规则同上。库中没有该人时会先冷启动生成。',
        properties: { target: targetParam },
        execute: async ({ target }) => {
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          const record = await ensureRecord(found.ref, chatId)
          const lines = [
            found.ref.displayName + '（QQ ' + found.ref.userId + '）',
            c.totalLabel + '：' + formatNum(record.total),
            c.dimensions.map((d) => d.label + ' ' + formatNum(scoreOf(record, d.key, c))).join(' · '),
            '印象：' + (record.description || '（这个人还很神秘，暂无印象。）'),
          ]
          return { ok: true, message: lines.join('\n') }
        },
      }))

      tools.push(api.defineTool({
        name: 'impression_nudge',
        description: '用较小的近期聊天记录，对某人已有的印象档案做一次增量微调（deltas）。适合「最近有点变化、但不必全面重算」。调用后立刻返回，模型在后台完成；不要等待，也不要向对方复述。没有档案时不要调用。target 规则同上。',
        properties: { target: targetParam },
        execute: async ({ target }) => {
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          if (!store.get(found.ref.personId)) return { ok: false, message: found.ref.displayName + ' 还没有档案，先发一张卡或刷新印象。' }
          nudgeRecord(found.ref, chatId).catch((error) => log.warn('后台微调失败：' + (error && error.message ? error.message : error)))
          return { ok: true, message: '好的，我在后台上调一下对 ' + found.ref.displayName + ' 的印象。' }
        },
      }))

      tools.push(api.defineTool({
        name: 'impression_refresh',
        description: '结合记忆与最近聊天，重新评估某人的各项分值与笔记（全面重算，比 impression_nudge 重）。target 规则同上。',
        properties: { target: targetParam },
        slow: '好，我重新感受一下这个人…',
        execute: async ({ target }) => {
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          const record = await refreshRecord(found.ref, chatId)
          return { ok: true, message: '已刷新对 ' + found.ref.displayName + ' 的印象（' + c.totalLabel + ' ' + formatNum(record.total) + '）。' }
        },
      }))

      tools.push(api.defineTool({
        name: 'impression_send_card',
        description: '向当前聊天主动发一张某人（默认当前说话的人）的印象卡片图片。可先 refresh_first 重新评估，或指定 radar_top_n。',
        properties: {
          target: targetParam,
          refresh_first: { type: 'boolean', description: '发之前先重新评估这个人的印象' },
          radar_top_n: { type: 'integer', description: '雷达图显示几个维度（1-12），不传用设置里的值' },
        },
        execute: async ({ target, refresh_first, radar_top_n }) => {
          const found = await lookup(target)
          if (found.error) return { ok: false, message: found.error }
          const out = await sendCard(chatId, found.ref, { refresh: refresh_first === true, radarTopN: radar_top_n })
          return { ok: out.ok, message: out.message || '' }
        },
      }))

      // 模块在使用中被关掉时，已挂载的工具也要立刻停手（工具清单不会因为设置变化重挂）。
      for (const tool of tools) {
        const original = tool.execute
        tool.execute = async (...args) => {
          if (disposed || !conf().enabled) return { ok: false, message: '印象卡片已关闭。' }
          return original(...args)
        }
      }
      return tools
    })

    api.rule((kind) => {
      const c = conf()
      if (!c.enabled) return ''
      return '你有一套印象卡片：可以用 impression_adjust 给某人的好感度或某个维度加减分，impression_set 直接设为某个值，impression_append_note / impression_rewrite_note 写人物印象笔记，impression_detail 查档案，impression_nudge 做小幅微调，impression_refresh 全面重算，impression_send_card 主动发卡。target 可以传 QQ 号或名字，不传就是当前说话的人；dimension 用 total（独立的好感度）或维度 key。这是欢乐向设定，可以凭你的喜好打分、毒舌，但别对没聊过的人乱刷分。' + scoreGuidanceText({ defaultScore: c.defaultScore, scaleMin: c.scaleMin, scaleMax: c.scaleMax })
    })

    api.context(({ chat }) => {
      try {
        const c = conf()
        if (!c.enabled || !c.contextEnabled || disposed || !chat) return ''
        const uid = chat.kind === 'private' ? chat.userId : (lastSpeakerRow(chat.chatId) || {}).uid
        if (!uid) return ''
        const record = store.get(personIdOf('qq', uid))
        if (!record) return ''
        const top = c.dimensions
          .map((d) => ({ label: d.label, value: scoreOf(record, d.key, c) }))
          .sort((a, b) => b.value - a.value)
          .slice(0, 3)
          .map((d) => d.label + ' ' + formatNum(d.value))
          .join('、')
        return '（你对 ' + (record.displayName || '当前这个人') + ' 的印象：' + c.totalLabel + ' ' + formatNum(record.total) + (top ? '；' + top : '') + (record.description ? '；笔记：' + record.description.slice(0, 120) : '') + '。聊到相关的时候自然用上，别报数字、别念档案。）'
      } catch (error) {
        return ''
      }
    })

    // ---------- 面板接口 ----------

    function chatForPerson (userId) {
      let best = null
      for (let i = 0; i < 2; i++) {
        for (const row of rowsOfDay(dayKey(Date.now() - i * 86400000))) {
          if (String(row.uid) !== String(userId)) continue
          if (!best || Number(row.t) > Number(best.t)) best = row
        }
      }
      if (!best) return null
      const chatId = String(best.chatId || '')
      return { chatId, groupId: chatId.startsWith('group:') ? chatId.slice(6) : '' }
    }

    function personPayload (record) {
      const c = conf()
      return {
        id: record.id,
        userId: record.userId,
        name: record.displayName,
        total: record.total,
        updatedAt: record.updatedAt,
        described: Boolean(String(record.description || '').trim()),
        noteChars: String(record.description || '').length,
        dims: c.dimensions.map((d) => ({ key: d.key, label: d.label, value: scoreOf(record, d.key, c) })),
      }
    }

    api.route('/state', async () => {
      const c = conf()
      const stats = store.stats()
      let sharpReady = false
      try { sharpReady = Boolean(await renderer.sharp()) } catch (error) { sharpReady = false }
      const sharpPlan = sharpStatus({ moduleDir: api.dir, resourcesPath: safeResourcesPath(), exists: existsSync })
      return {
        ok: true,
        version: VERSION,
        enabled: c.enabled,
        startedAt,
        stats,
        personsTotal: stats.persons,
        personsShown: Math.min(stats.persons, 500),
        persons: store.all().slice(0, 500).map(personPayload),
        recent: store.meta().events.slice(0, 24),
        settings: {
          theme: c.theme,
          themeLabel: (themeObj(c) || {}).label || c.theme,
          radarTopN: c.radarTopN,
          totalLabel: c.totalLabel,
          defaultScore: c.defaultScore,
          scaleMin: c.scaleMin,
          scaleMax: c.scaleMax,
          noteSizeLimit: c.noteSizeLimit,
          cardScale: c.cardScale,
          format: c.format,
          botName: c.botName,
          dimensions: c.dimensions,
          guestCards: c.guestCards,
          allowQueryOthers: c.allowQueryOthers,
          notifyEnabled: c.notifyEnabled,
        },
        themes: Object.entries(CARD_THEMES).map(([id, theme]) => ({ id, label: (theme && theme.label) || id })),
        sharpReady,
        sharpMessage: sharpReady ? '' : sharpPlan.message,
        help: helpText(),
      }
    })

    api.route('/card.png', async (req, res) => {
      if (!conf().enabled) {
        api.core.http.send(res, 200, { ok: false, message: '印象卡片已关闭。' })
        return
      }
      const query = api.core.http.query(req)
      const id = String(query.person || '')
      const record = store.get(id)
      if (!record) {
        api.core.http.send(res, 200, { ok: false, message: '还没有这个人的档案。' })
        return
      }
      const ref = identity.refFromRecord(record)
      const out = await renderCard(record, ref, { radarTopN: Number(query.radar) || 0 })
      if (!out.ok) {
        api.core.http.send(res, 200, { ok: false, message: out.error || '渲染失败。' })
        return
      }
      try {
        const buf = await readFile(out.file)
        api.core.http.send(res, 200, buf, out.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
      } catch (error) {
        api.core.http.send(res, 200, { ok: false, message: '读不到渲染出来的卡片。' })
      }
    })

    api.route('/render', async (req) => {
      if (!conf().enabled) return { ok: false, message: '印象卡片已关闭。' }
      const body = await api.core.http.body(req)
      const record = store.get(String(body.personId || ''))
      if (!record) return { ok: false, message: '还没有这个人的档案。' }
      const ref = identity.refFromRecord(record)
      const out = await renderCard(record, ref, { radarTopN: Number(body.radarTopN) || 0 })
      if (!out.ok) return { ok: false, message: out.error || '渲染失败。' }
      return {
        ok: true,
        file: out.file,
        url: '/aurabot/api/ext/impression-card/card.png?person=' + encodeURIComponent(record.id) + '&radar=' + (Number(body.radarTopN) || 0) + '&t=' + Date.now(),
        person: personPayload(record),
      }
    })

    api.route('/refresh', async (req) => {
      const c = conf()
      if (!c.enabled) return { ok: false, message: '印象卡片已关闭。' }
      const body = await api.core.http.body(req)
      const record = store.get(String(body.personId || ''))
      if (!record) return { ok: false, message: '还没有这个人的档案，先发一张卡。' }
      const ref = identity.refFromRecord(record)
      const where = chatForPerson(record.userId)
      const updated = await refreshRecord(ref, where ? where.chatId : 'private:' + record.userId)
      return { ok: true, message: '已刷新 ' + ref.displayName + ' 的印象。', person: personPayload(updated) }
    })

    api.route('/adjust', async (req) => {
      if (!conf().enabled) return { ok: false, message: '印象卡片已关闭。' }
      const body = await api.core.http.body(req)
      const record = store.get(String(body.personId || ''))
      if (!record) return { ok: false, message: '还没有这个人的档案。' }
      const ref = identity.refFromRecord(record)
      const mode = body.mode === 'set' ? 'set' : 'add'
      const value = Number(body.value !== undefined ? body.value : body.delta)
      if (!Number.isFinite(value)) return { ok: false, message: '数值不对。' }
      const out = await adjustScore(ref, body.dimension || 'total', value, { mode, reason: String(body.reason || ''), notify: false })
      if (!out.ok) return { ok: false, message: out.message }
      return { ok: true, message: '已更新「' + out.label + '」。', person: personPayload(out.record) }
    })

    api.route('/delete', async (req) => {
      if (!conf().enabled) return { ok: false, message: '印象卡片已关闭。' }
      const body = await api.core.http.body(req)
      const id = String(body.personId || '')
      const record = store.get(id)
      if (!record) return { ok: false, message: '没有这个人的档案。' }
      store.remove(id)
      store.saveNow()
      return { ok: true, message: '已删除 ' + record.displayName + ' 的档案。' }
    })

    api.route('/send', async (req) => {
      if (!conf().enabled) return { ok: false, message: '印象卡片已关闭。' }
      if (api.config().enabled === false) return { ok: false, message: 'Aurabot 总开关关着。' }
      const body = await api.core.http.body(req)
      const record = store.get(String(body.personId || ''))
      if (!record) return { ok: false, message: '还没有这个人的档案。' }
      const where = body.chatId ? { chatId: String(body.chatId) } : chatForPerson(record.userId)
      if (!where) return { ok: false, message: '找不到可以发送的聊天。' }
      const ref = identity.refFromRecord(record)
      const out = await sendCard(where.chatId, ref, { radarTopN: Number(body.radarTopN) || 0 })
      return { ok: out.ok, message: out.message || '' }
    })

    api.route('/help', async () => ({ ok: true, text: helpText() }))

    // ---------- 主动微调 ----------

    async function proactiveTick () {
      const c = conf()
      if (disposed || !c.enabled || !c.proactiveEnabled) return
      if (!api.config().enabled) return
      const now = Date.now()
      if (now - lastPoll < Math.max(30, c.proactivePollSeconds) * 1000 - 1000) return
      lastPoll = now
      const rows = []
      for (let i = 0; i < 2; i++) rows.push(...rowsOfDay(dayKey(now - i * 86400000)))
      const byChat = new Map()
      for (const row of rows) {
        if (!row || !row.chatId) continue
        const list = byChat.get(String(row.chatId)) || []
        list.push(row)
        byChat.set(String(row.chatId), list)
      }
      const metaMap = store.meta().proactive || {}
      let fired = 0
      for (const [chatId, list] of byChat) {
        if (fired >= c.proactiveMaxPerTick) break
        const last = list[list.length - 1]
        if (!last || now - Number(last.t) > 3 * 3600 * 1000) continue
        const lastFired = Number(metaMap[chatId] || 0)
        if (now - lastFired < c.proactiveHours * 3600 * 1000) continue
        metaMap[chatId] = now
        store.saveNow()
        fired++
        const uids = [...new Set(list.slice(-120).map((row) => row.uid).filter(Boolean))]
        const targets = uids
          .map((uid) => store.get(personIdOf('qq', uid)))
          .filter(Boolean)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(0, 2)
        for (const record of targets) {
          if (disposed) return
          const ref = identity.refFromRecord(record)
          if (!ref) continue
          try {
            const out = await nudgeRecord(ref, chatId)
            if (out.ok) log.info('主动微调 ' + ref.displayName + '：' + (out.applied || []).map((x) => x.key + formatDelta(x.delta)).join('、'))
          } catch (error) {
            log.warn('主动微调失败：' + (error && error.message ? error.message : error))
          }
        }
      }
    }

    api.every(60_000, () => proactiveTick(), '印象卡片·主动微调')

    // ---------- 导出 ----------

    /** 别的模块传 personId 过来时，尽量造一个人物引用（没有档案也能改 / 生成）。 */
    async function refForPersonId (personId) {
      const id = String(personId || '').trim()
      const record = store.get(id)
      if (record) return identity.refFromRecord(record)
      const index = id.indexOf(':')
      const platform = index > 0 ? id.slice(0, index) : 'qq'
      const userId = index > 0 ? id.slice(index + 1) : id
      if (!/^\d{3,}$/.test(userId)) return null
      return identity.refFromUser(userId, { platform })
    }

    return {
      version: VERSION,
      get: (personId) => store.get(String(personId || '')),
      list: () => store.all(),
      helpText,
      adjust: async (personId, dimension, delta, opts) => {
        const ref = await refForPersonId(personId)
        if (!ref) return { ok: false, message: '没有这个人的档案，personId 也认不出来。' }
        return adjustScore(ref, dimension, delta, opts || {})
      },
      render: async (personId, opts) => {
        const ref = await refForPersonId(personId)
        if (!ref) return { ok: false, message: '没有这个人的档案，personId 也认不出来。' }
        const record = store.get(ref.personId)
        if (!record) return { ok: false, message: '还没有这个人的档案。' }
        return renderCard(record, ref, opts || {})
      },
      sendCard,
      refresh: async (personId, chatId) => {
        const ref = await refForPersonId(personId)
        if (!ref) return { ok: false, message: '没有这个人的档案，personId 也认不出来。' }
        return refreshRecord(ref, chatId || 'private:' + ref.userId)
      },
      generate: async (personId, chatId) => {
        const ref = await refForPersonId(personId)
        if (!ref) return { ok: false, message: 'personId 认不出来。' }
        return ensureRecord(ref, chatId || 'private:' + ref.userId)
      },
    }
  },
}
