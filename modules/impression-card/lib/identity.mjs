// 把 QQ 消息 / 工具参数里的人，解析成一张稳定的「人物引用」。
//
// Aurabot 没有 MaiBot 的 PersonInfo 表，所以称呼来自这几处：
//   1. 当前消息的发送者（群名片 > 昵称）
//   2. 群成员列表（api.onebot('get_group_member_list')，缓存 10 分钟）
//   3. 私聊陌生人资料（get_stranger_info，缓存 10 分钟）
//   4. 档案里记过的名字和别名
// 解析结果 → { personId: 'qq:123', platform, userId, displayName, userNickname, groupCard }

import { personIdOf } from './store.mjs'

const MEMBER_TTL = 10 * 60 * 1000
const STRANGER_TTL = 30 * 60 * 1000
const MAX_MEMBERS = 3000
const QQ_RE = /^\d{5,12}$/

function clean (value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.slice(0, max || 40)
}

/** 「@小明」「小明(QQ号)」这类写法统一一下。 */
export function normalizeTarget (raw) {
  let text = String(raw === undefined || raw === null ? '' : raw).trim()
  text = text.replace(/^@+/, '').trim()
  const paren = text.match(/^(.*?)[（(]\s*(\d{5,12})\s*[)）]$/)
  if (paren) return { name: paren[1].trim(), qq: paren[2] }
  return { name: text, qq: QQ_RE.test(text) ? text : '' }
}

export function createIdentity (opts) {
  const o = opts || {}
  const api = o.api
  const store = o.store
  const log = o.log || null
  const memberCache = new Map()
  const strangerCache = new Map()

  function refOf (userId, platform) {
    return {
      personId: personIdOf(platform || 'qq', userId),
      platform: platform || 'qq',
      userId: String(userId),
      displayName: '',
      userNickname: '',
      groupCard: '',
    }
  }

  function findMember (list, userId) {
    const target = String(userId)
    return (list || []).find((m) => String(m && (m.user_id ?? m.userId ?? m.uin ?? '')) === target) || null
  }

  async function groupMembers (groupId) {
    const gid = String(groupId || '').trim()
    if (!gid) return []
    const hit = memberCache.get(gid)
    if (hit && Date.now() - hit.at < MEMBER_TTL) return hit.list
    try {
      const raw = await api.onebot('get_group_member_list', { group_id: Number(gid) })
      const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.data) ? raw.data : []
      const trimmed = list.slice(0, MAX_MEMBERS)
      memberCache.set(gid, { at: Date.now(), list: trimmed })
      return trimmed
    } catch (error) {
      log?.debug?.('拉群成员失败：' + (error && error.message ? error.message : error))
      return hit ? hit.list : []
    }
  }

  async function stranger (userId) {
    const uid = String(userId || '').trim()
    if (!QQ_RE.test(uid)) return null
    const hit = strangerCache.get(uid)
    if (hit && Date.now() - hit.at < STRANGER_TTL) return hit.info
    try {
      const raw = await api.onebot('get_stranger_info', { user_id: Number(uid) })
      const info = raw && (raw.data || raw)
      if (info && typeof info === 'object') {
        strangerCache.set(uid, { at: Date.now(), info })
        return info
      }
    } catch (error) {
      log?.debug?.('查陌生人资料失败：' + (error && error.message ? error.message : error))
    }
    return null
  }

  /**
   * 由 QQ 号造人物引用。hints 里可以带当地知道的昵称/群名片，优先用它们。
   */
  async function refFromUser (userId, hints) {
    const h = hints || {}
    const ref = refOf(userId, h.platform)
    if (!ref.userId) return null
    const record = store.get(ref.personId)
    let nickname = clean(h.nickname)
    let card = clean(h.groupCard)
    if ((!nickname || !card) && h.groupId) {
      const members = await groupMembers(h.groupId)
      const member = findMember(members, ref.userId)
      if (member) {
        nickname = nickname || clean(member.nickname ?? member.card ?? '')
        card = card || clean(member.card ?? '')
      }
    }
    if (!nickname && !card && !h.groupId) {
      const info = await stranger(ref.userId)
      if (info) nickname = clean(info.nickname ?? info.nick ?? '')
    }
    ref.userNickname = nickname || clean(record && record.userNickname) || (record && record.displayName) || ('QQ' + ref.userId)
    ref.groupCard = card || clean(record && record.groupCard)
    ref.displayName = ref.groupCard || ref.userNickname
    return ref
  }

  /** 一条收到的消息 → 说话人。群名片优先，其次昵称。 */
  async function refFromMessage (msg) {
    if (!msg || !msg.userId) return null
    const sender = (msg.raw && msg.raw.sender) || {}
    return refFromUser(msg.userId, {
      groupId: msg.groupId || (msg.kind === 'group' ? String(msg.raw && msg.raw.group_id) : ''),
      nickname: clean(sender.nickname) || clean(msg.nickname),
      groupCard: clean(sender.card),
      platform: 'qq',
    })
  }

  function refFromRecord (record) {
    if (!record) return null
    return {
      personId: record.id,
      platform: record.platform || 'qq',
      userId: record.userId || '',
      displayName: record.displayName || record.userNickname || record.userId,
      userNickname: record.userNickname || record.displayName || '',
      groupCard: record.groupCard || '',
    }
  }

  /** 把 ref 上看到的名字补进档案（不覆盖已有名字）。 */
  function remember (record, ref) {
    if (!record || !ref) return record
    store.rememberAlias(record, ref.displayName, ref.userNickname, ref.groupCard)
    if (ref.displayName && ref.displayName !== record.displayName) record.displayName = ref.displayName
    if (ref.userNickname) record.userNickname = ref.userNickname
    if (ref.groupCard) record.groupCard = ref.groupCard
    return record
  }

  /**
   * 解析工具/命令里的 target：
   *   空 = 报错（调用方自己决定要不要用当前发言者）
   *   纯数字 = QQ 号
   *   名字 / 群名片 / 别名 = 先查档案，再查当前群成员
   * 返回 { ref, error }。
   */
  async function resolve (target, ctx) {
    const c = ctx || {}
    const norm = normalizeTarget(target)
    if (!norm.name && !norm.qq) return { ref: null, error: '没有指定对象。' }
    if (norm.qq) {
      const ref = await refFromUser(norm.qq, { groupId: c.groupId, platform: c.platform })
      return ref ? { ref, error: '' } : { ref: null, error: '找不到 QQ ' + norm.qq + ' 的人物信息。' }
    }
    const record = store.findByName(norm.name)
    if (record) return { ref: refFromRecord(record), error: '' }
    if (c.groupId) {
      const members = await groupMembers(c.groupId)
      const exact = members.filter((m) => {
        const nickname = clean(m.nickname)
        const card = clean(m.card)
        return nickname === norm.name || card === norm.name
      })
      if (exact.length === 1) {
        const ref = await refFromUser(exact[0].user_id, { groupId: c.groupId, nickname: exact[0].nickname, groupCard: exact[0].card })
        if (ref) return { ref, error: '' }
      }
      if (exact.length > 1) return { ref: null, error: '群里有好几个人叫「' + norm.name + '」，换 QQ 号或更完整的群名片试试。' }
    }
    return { ref: null, error: '找不到叫「' + norm.name + '」的人（可以试 QQ 号、昵称、群名片或别名）。' }
  }

  /** 给提示词看的人物身份说明。 */
  function identityBlock (ref, stored) {
    if (!ref) return '（未知）'
    const lines = []
    lines.push('- QQ：' + (ref.userId || '未知'))
    lines.push('- 昵称：' + (ref.userNickname || ref.displayName || '未知'))
    if (ref.groupCard) lines.push('- 群名片：' + ref.groupCard)
    const names = new Set([ref.displayName, ref.userNickname, ref.groupCard, ...((stored && stored.aliases) || [])].filter(Boolean))
    if (names.size > 1) lines.push('- 别名：' + [...names].join('、'))
    return lines.join('\n')
  }

  function clearCache () {
    memberCache.clear()
    strangerCache.clear()
  }

  return { refOf, refFromUser, refFromMessage, refFromRecord, resolve, remember, identityBlock, groupMembers, clearCache }
}
