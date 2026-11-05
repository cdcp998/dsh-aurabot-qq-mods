// 「对方说他打了钱」的说法识别，以及待确认记录的清洗。
//
// 这一层的难点全在误判：说明「收到没」「有没有」「我没钱」全是疑问和否定，
// 不能因为里面有个「没」或「打」就当成打款；反过来「转了转了」「打过去啦」又得认。
//
// 所以否定模式要求否定词**紧贴**动作词（没打 / 不转 / 别付），单独一个「没」不算。
// 纯函数，测试直接跑。

/** 判定「对方说打了钱」的正面词。 */
export const POSITIVE_WORDS = [
  '打了', '转了', '付了', '已付', '到账', '扫了', '转过去', '打过去',
  '转啦', '打啦', '给了钱', '发了钱', '红包', '投喂', '请客',
]

/** 否定：必须是否定词紧贴动作词。 */
const NEGATIVE_PATTERN = /没(打|转|付|给|发|扫|充)|不(打|转|付|给|发|会|要|想)|别(打|转|付|给)|骗|假的|才怪|怎么可能|哪有|下次一定/

/** 太长的消息多半在讲别的事，别拿它当打款声明。 */
const MAX_CLAIM_CHARS = 60

export function isPaymentClaim (text) {
  const t = String(text === undefined || text === null ? '' : text).trim()
  if (!t || t.length > MAX_CLAIM_CHARS) return false
  if (NEGATIVE_PATTERN.test(t)) return false
  return POSITIVE_WORDS.some((word) => t.includes(word))
}

/**
 * 从一句话里挖金额：「转了15」「打赏 12.5 块」「给了20元」「发了个 8.88 的红包」。
 * 挖不到返回 null。带小数的只认到两位。
 */
export function extractAmount (text) {
  const t = String(text === undefined || text === null ? '' : text)
  const m = t.match(/(?:转了|打了|给了|打赏|投喂|付了|发了|扫了|红包|转你|给你)\s*([0-9]+(?:\.[0-9]{1,2})?)/)
    || t.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*(?:块|元|大洋|r|￥|¥)/i)
    || t.match(/([0-9]+(?:\.[0-9]{1,2})?)\s*的?\s*(?:红包|打赏|投喂)/)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * 金额校验：返回 { ok, value } 或 { ok:false, reason }。
 * NaN / Infinity 能穿过 `value <= 0` 和 `value > max` 两道比较（都是 false），
 * 一旦写进账本，之后所有 sum 都变 NaN，JSON 里还会出现非标准的 NaN 字面量。
 */
export function checkAmount (raw, max = 10000) {
  const n = Number(raw)
  if (raw === '' || raw === null || raw === undefined) return { ok: false, reason: '金额要大于 0。' }
  if (!Number.isFinite(n)) return { ok: false, reason: '金额不是有效数字，记不了。' }
  if (n <= 0) return { ok: false, reason: '金额要大于 0。' }
  if (n > max) return { ok: false, reason: '金额太大了，先确认一下再记。' }
  return { ok: true, value: Math.round(n * 100) / 100 }
}

/**
 * 待确认记录逐条洗一遍。文件可能被手工改过、也可能是旧版本留下的，
 * 缺字段补默认值，格式不对的丢掉，别让 /确认 里下标访问把命令打崩。
 *
 * ⚠ id 以字典键为准：手工改成 key="5"、id="3" 时，`/待确认` 显示 #3、
 * 管理员回 `/确认 3` 找不到，而不带编号确认又 pop 不掉键 "5" → 下次重复记账。
 */
export function sanitizeApproval (raw, key) {
  const id = String(key === undefined || key === null ? '' : key).trim()
  if (!id || !/^\d+$/.test(id)) return null
  if (!raw || typeof raw !== 'object') return null
  const amount = Number(raw.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const created = Number(raw.created)
  return {
    id,
    amount: Math.round(amount * 100) / 100,
    note: String(raw.note || '').slice(0, 40),
    chatId: String(raw.chatId || ''),
    groupId: String(raw.groupId || ''),
    groupName: String(raw.groupName || '').slice(0, 60),
    payer: String(raw.payer || ''),
    payerName: String(raw.payerName || '').slice(0, 40),
    requester: String(raw.requester || raw.payerName || raw.payer || '有人').slice(0, 40),
    // 用墙上时间，不能用单调时钟：要跨重载 / 重启判断有效期
    created: Number.isFinite(created) ? created : 0,
  }
}

export function sanitizeApprovals (data) {
  const out = {}
  let seq = 0
  const source = data && typeof data === 'object' ? data : {}
  const safeSeq = Number(source.seq)
  if (Number.isFinite(safeSeq) && safeSeq > 0) seq = Math.floor(safeSeq)
  const items = source.items && typeof source.items === 'object' && !Array.isArray(source.items) ? source.items : {}
  let dropped = 0
  for (const [key, raw] of Object.entries(items)) {
    const rec = sanitizeApproval(raw, key)
    if (!rec) { dropped += 1; continue }
    out[rec.id] = rec
    // 编号必须大于现存所有记录，否则新记录会跟旧编号撞上、互相顶掉
    seq = Math.max(seq, Number(rec.id))
  }
  return { seq, items: out, dropped }
}
