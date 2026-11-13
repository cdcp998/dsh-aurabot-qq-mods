// assets/enroll/enroll-form.js —— 表单判定 / 校验 / 组装 payload 的纯函数。
//
// 这里**不 import bbx.js**：本文件只做字符串与数值判断，加解密一律交给 bbx.js，
// 这样它能同时在浏览器（index.html）和 Node 单测里直接 import 使用。
//
// 只有一件事：填 Bambu 账号 + 密码，生成一段登录信封。
// （安全码已经取消；「只建号」「改安全码」这些用法也一并去掉了。）

export const TTL_MIN = 1
export const TTL_MAX = 1440
export const ACCOUNT_MAX = 200
export const PASSWORD_MAX = 256
export const REGIONS = ['cn', 'us', 'eu']
export const DEFAULT_REGION = 'cn'
export const DEFAULT_TTL_MIN = 10

/** 页面下拉框的选项，和 index.html 保持一致（默认中国大陆）。 */
export const REGION_OPTIONS = [
  { value: 'cn', label: '中国大陆（bambulab.cn）' },
  { value: 'us', label: '国际（bambulab.com）' },
  { value: 'eu', label: '欧洲' },
]

/** 唯一用途。保留常量是为了让调用点读起来明确。 */
export const KIND_LABEL = { login: '登录' }

/** 一句话说明（界面提示用）。 */
export const KIND_HINTS = {
  login: '登录 Bambu 云端，自动同步账号下的打印机。',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_RE = /^\d{5,15}$/

const utf8 = typeof TextEncoder === 'function' ? new TextEncoder() : null

function text (value) {
  return value == null ? '' : String(value)
}

function trimmed (value) {
  return text(value).trim()
}

function byteLength (value) {
  const string = text(value)
  return utf8 ? utf8.encode(string).length : string.length
}

/** 现在只有登录这一种信封。 */
export function classify () {
  return 'login'
}

/**
 * 校验一份表单。不抛错，全部问题都放进返回值。
 * 永远不把账号 / 密码原文写进 errors 或 warnings（界面会直接显示这些文字）。
 *
 * @param {{account?:string, password?:string, ttlMin?:string|number|null}} input
 * @returns {{ok:boolean, errors:string[], kind:'login', warnings:string[]}}
 */
export function validateInputs (input = {}) {
  const account = trimmed(input.account)
  // 密码不 trim：首尾空格也是密码的一部分
  const password = text(input.password)
  const ttlRaw = input.ttlMin

  const errors = []
  const warnings = []

  // ---- 账号和密码都是必填
  if (!account && !password) errors.push('请填写 Bambu 账号和密码')
  else if (!account) errors.push('请填写 Bambu 账号')
  else if (!password) errors.push('请填写 Bambu 密码')

  if (account) {
    if (!EMAIL_RE.test(account) && !PHONE_RE.test(account)) {
      errors.push('Bambu 账号要填邮箱（如 name@example.com）或 5~15 位数字的手机号')
    }
    if (byteLength(account) > ACCOUNT_MAX) errors.push('Bambu 账号太长（最多 ' + ACCOUNT_MAX + ' 字节）')
    if (byteLength(password) > PASSWORD_MAX) errors.push('Bambu 密码太长（最多 ' + PASSWORD_MAX + ' 字节）')
    if (password && !password.trim()) warnings.push('Bambu 密码只有空格，确认一下没填错。')
  }

  // ---- 生存时间
  const ttlText = trimmed(ttlRaw)
  const ttlNum = ttlText === '' ? NaN : Number(ttlText)
  if (!Number.isFinite(ttlNum)) {
    errors.push('生存时间要填 ' + TTL_MIN + '~' + TTL_MAX + ' 的整数分钟')
  } else if (!Number.isInteger(ttlNum)) {
    errors.push('生存时间必须是整数分钟')
  } else if (ttlNum < TTL_MIN || ttlNum > TTL_MAX) {
    errors.push('生存时间要在 ' + TTL_MIN + '~' + TTL_MAX + ' 分钟之间')
  }

  return { ok: errors.length === 0, errors, kind: 'login', warnings }
}

/**
 * 组装 bbx.sealEnvelope 需要的明文 body。
 * 只拼数据，不做合法性判定（先调 validateInputs）。
 *
 * @param {{account?:string, password?:string, ttlMin?:string|number, region?:string, now?:number}} input
 *        now：Unix 秒，缺省取当前时间；单测可注入。
 */
export function buildPayload (input = {}) {
  const ttlRaw = Math.round(Number(input.ttlMin))
  // 没传就用默认 10 分钟（页面固定这个值，但直接调这个函数时也要有合理默认）
  const ttlMin = Number.isFinite(ttlRaw) && ttlRaw >= TTL_MIN && ttlRaw <= TTL_MAX ? ttlRaw : DEFAULT_TTL_MIN
  const nowRaw = Number(input.now)
  const iat = Number.isFinite(nowRaw) && nowRaw > 0 ? Math.floor(nowRaw) : Math.floor(Date.now() / 1000)
  const region = REGIONS.includes(trimmed(input.region).toLowerCase())
    ? trimmed(input.region).toLowerCase()
    : DEFAULT_REGION
  return {
    account: trimmed(input.account),
    password: text(input.password), // 密码原样保留（不 trim）
    ttlMin,
    region,
    iat,
    exp: iat + ttlMin * 60,
  }
}

/**
 * 账号掩码：'a***@b.com' / '138****8888'。空值返回空串。
 * 只在界面上展示用，不参与加密。
 */
export function maskAccount (account) {
  const value = trimmed(account)
  if (!value) return ''
  const at = value.indexOf('@')
  if (at > 0 && at < value.length - 1) {
    const local = value.slice(0, at)
    return local[0] + '***@' + value.slice(at + 1)
  }
  const digits = value.replace(/[^\d]/g, '')
  const body = PHONE_RE.test(value) ? value : digits || value
  const len = body.length
  if (len <= 1) return '*'
  const head = len >= 11 ? 3 : len >= 9 ? 2 : 1
  const tail = len >= 11 ? 4 : len >= 9 ? 3 : 2
  if (head + tail >= len) return body.slice(0, 1) + '****'
  return body.slice(0, head) + '****' + body.slice(len - tail)
}
