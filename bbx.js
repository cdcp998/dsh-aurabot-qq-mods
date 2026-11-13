// assets/enroll/bbx.js —— 信封（BBX1）唯一的加解密实现。
//
// 一份代码，两处运行：
//   * 浏览器（GitHub Pages 静态页）：只有公钥，只能加密；
//   * Node 22（模块服务端）：持私钥，只能解密。
// 所以这里**不碰 Node 的任何东西**，只用 globalThis.crypto.subtle / TextEncoder，
// 浏览器和 Node 的行为逐字节一致（test/envelope.test.mjs 会在 Node 里跑互操作）。
//
// 格式见 docs/ENVELOPE.md：BBX1.<base64url( magic | ver | suite | eph | salt | iv | ct | tag )>
// 明文 body = BBXB | bodyVer | flags | iat | exp | ttlMin | region | jti | account | password
//
// 约定：本文件任何函数都不打印、不记录明文；错误只抛 EnvelopeError（带 code）。

export const MAGIC = 'BBX1'
export const BODY_MAGIC = 'BBXB'
export const VERSION = 1
export const SUITE = 1
export const KDF_INFO = new TextEncoder().encode('bambu-print/envelope/v1')

export const MAX_TEXT = 4096 // 整段信封文本上限
export const MAX_ACCOUNT = 200
export const MAX_PASSWORD = 256
export const MAX_TTL_MIN = 1440

const P256_POINT = 65 // 未压缩点：0x04 || X(32) || Y(32)
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const JTI_BYTES = 16
const HEAD_BYTES = 4 + 1 + 1 + P256_POINT + SALT_BYTES + IV_BYTES // 99
const BODY_FIXED = 4 + 1 + 1 + 4 + 4 + 2 + 1 + JTI_BYTES // 33

export const REGIONS = { us: 0, eu: 1, cn: 2 }
const REGION_NAMES = ['us', 'eu', 'cn']

export class EnvelopeError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'EnvelopeError'
    this.code = code || 'ENVELOPE'
  }
}

// ------------------------------------------------------------------ base64url

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_LOOKUP = new Map([...B64URL].map((ch, i) => [ch, i]))
// 标准 base64 的两个字符也接受（用户可能被别的工具转了一道），填充符忽略。
B64_LOOKUP.set('+', 62)
B64_LOOKUP.set('/', 63)

export function toBase64Url (bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let out = ''
  let i = 0
  for (; i + 2 < buf.length; i += 3) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63] + B64URL[n & 63]
  }
  const left = buf.length - i
  if (left === 1) {
    const n = buf[i] << 16
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63]
  } else if (left === 2) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8)
    out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63]
  }
  return out
}

export function fromBase64Url (text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, '').replace(/=+$/, '')
  if (!raw) return new Uint8Array(0)
  const out = new Uint8Array(Math.floor((raw.length * 6) / 8))
  let acc = 0
  let bits = 0
  let o = 0
  for (const ch of raw) {
    const v = B64_LOOKUP.get(ch)
    if (v === undefined) throw new EnvelopeError('BAD_FORMAT', '信封里有不认识的字符')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >>> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

// ------------------------------------------------------------------ 二进制小工具

function u8 (view) { return new Uint8Array(view) }

function concat (parts) {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function randomBytes (n) {
  const buf = new Uint8Array(n)
  const src = globalThis.crypto
  if (!src || typeof src.getRandomValues !== 'function') throw new EnvelopeError('NO_CRYPTO', '当前环境没有安全随机源')
  src.getRandomValues(buf)
  return buf
}

const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

function bytesOf (text, max, what) {
  const value = text == null ? '' : String(text)
  const bytes = utf8.encode(value)
  if (bytes.length > max) throw new EnvelopeError('BAD_PAYLOAD', what + '过长（最多 ' + max + ' 字节）')
  return bytes
}

class Writer {
  constructor () { this.parts = []; this.length = 0 }
  raw (bytes) { this.parts.push(bytes); this.length += bytes.length; return this }
  u8 (n) { return this.raw(new Uint8Array([n & 0xff])) }
  u16 (n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n & 0xffff); return this.raw(b) }
  u32 (n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0); return this.raw(b) }
  lp8 (bytes) { this.u8(bytes.length); return this.raw(bytes) }
  lp16 (bytes) { this.u16(bytes.length); return this.raw(bytes) }
  done () { return concat(this.parts) }
}

class Reader {
  constructor (buf) { this.buf = buf; this.at = 0 }
  get left () { return this.buf.length - this.at }
  need (n, what) {
    if (this.left < n) throw new EnvelopeError('BAD_PAYLOAD', '信封内容不完整（缺' + what + '）')
  }
  raw (n) { this.need(n, '数据'); const out = this.buf.subarray(this.at, this.at + n); this.at += n; return out }
  u8 () { return this.raw(1)[0] }
  u16 () { const b = this.raw(2); return new DataView(b.buffer, b.byteOffset, 2).getUint16(0) }
  u32 () { const b = this.raw(4); return new DataView(b.buffer, b.byteOffset, 4).getUint32(0) }
  lp8 (what) { this.need(1, what + '长度'); const n = this.u8(); this.need(n, what); return this.raw(n) }
  lp16 (what) { this.need(2, what + '长度'); const n = this.u16(); this.need(n, what); return this.raw(n) }
  text (bytes) { return utf8Decoder.decode(bytes) }
}

// ------------------------------------------------------------------ 明文 body

/**
 * 构造 body 明文。只有四个业务字段：账号、密码、签发/失效时间（+ 区域、jti）。
 * @returns {Uint8Array}
 */
export function encodeBody (input = {}) {
  const account = bytesOf(input.account, MAX_ACCOUNT, '账号')
  // 密码一个字符都不能动：首尾空格也可能是密码的一部分。
  const password = bytesOf(input.password, MAX_PASSWORD, '密码')
  // 账号和密码必须都有 —— 这个信封唯一的用途就是登录。
  if (!account.length) throw new EnvelopeError('BAD_PAYLOAD', '信封里没有 Bambu 账号')
  if (!password.length) throw new EnvelopeError('BAD_PAYLOAD', '信封里没有 Bambu 密码')
  const ttlMin = Math.round(Number(input.ttlMin))
  if (!Number.isFinite(ttlMin) || ttlMin < 1 || ttlMin > MAX_TTL_MIN) {
    throw new EnvelopeError('BAD_PAYLOAD', '生存时间要在 1~' + MAX_TTL_MIN + ' 分钟之间')
  }
  const iat = Math.floor(Number(input.iat))
  if (!Number.isFinite(iat) || iat <= 0) throw new EnvelopeError('BAD_PAYLOAD', '签发时间不正确')
  const exp = Math.floor(Number(input.exp))
  if (!Number.isFinite(exp) || exp <= iat) throw new EnvelopeError('BAD_PAYLOAD', '失效时间不正确')
  const region = REGIONS[String(input.region || 'cn')]
  if (region === undefined) throw new EnvelopeError('BAD_PAYLOAD', '区域只能是 us / eu / cn')
  const jti = input.jti instanceof Uint8Array ? input.jti : randomBytes(JTI_BYTES)
  if (jti.length !== JTI_BYTES) throw new EnvelopeError('BAD_PAYLOAD', 'jti 必须是 ' + JTI_BYTES + ' 字节')

  // flags 只留一位「带不带账号」，用来做一致性校验（真正判定一律以长度为准）。
  const flags = 2

  const w = new Writer()
  w.raw(utf8.encode(BODY_MAGIC))
  w.u8(1) // bodyVer
  w.u8(flags)
  w.u32(iat)
  w.u32(exp)
  w.u16(ttlMin)
  w.u8(region)
  w.raw(jti)
  w.lp16(account)
  w.lp16(password)
  return w.done()
}

/**
 * 解析 body。只做结构解析，不做时间/重放判定（那是服务端策略，见 lib/envelope.mjs）。
 * @returns {{account:string,password:string,iat:number,exp:number,ttlMin:number,region:string,jti:string,flags:number}}
 */
export function decodeBody (bytes) {
  const r = new Reader(bytes instanceof Uint8Array ? bytes : u8(bytes))
  r.need(4 + 2, '头部')
  const magic = r.text(r.raw(4))
  if (magic !== BODY_MAGIC) throw new EnvelopeError('BAD_PAYLOAD', '信封内容不是本模块的格式')
  const bodyVer = r.u8()
  if (bodyVer !== 1) throw new EnvelopeError('BAD_VERSION', '信封版本不支持（' + bodyVer + '）')
  const flags = r.u8()
  const iat = r.u32()
  const exp = r.u32()
  const ttlMin = r.u16()
  const regionCode = r.u8()
  const jti = r.raw(JTI_BYTES)
  const account = r.text(r.lp16('账号'))
  const password = r.text(r.lp16('密码'))
  if (r.left !== 0) throw new EnvelopeError('BAD_PAYLOAD', '信封尾部有多余内容')

  if (regionCode > 2) throw new EnvelopeError('BAD_PAYLOAD', '区域标记不正确')
  if (!account) throw new EnvelopeError('BAD_PAYLOAD', '信封里没有 Bambu 账号')
  if (!password) throw new EnvelopeError('BAD_PAYLOAD', '信封里没有 Bambu 密码')
  if (!(flags & 2)) throw new EnvelopeError('BAD_PAYLOAD', '信封标记和内容不一致')
  if (!(exp > iat)) throw new EnvelopeError('BAD_PAYLOAD', '信封的时间范围不正确')
  if (!(ttlMin >= 1 && ttlMin <= MAX_TTL_MIN)) throw new EnvelopeError('BAD_PAYLOAD', '生存时间超出范围')
  const accountBytes = utf8.encode(account).length
  const passwordBytes = utf8.encode(password).length
  if (accountBytes > MAX_ACCOUNT || passwordBytes > MAX_PASSWORD) {
    throw new EnvelopeError('BAD_PAYLOAD', '信封字段过长')
  }
  return {
    account,
    password,
    iat,
    exp,
    ttlMin,
    region: REGION_NAMES[regionCode],
    jti: toBase64Url(jti),
    flags,
  }
}

// ------------------------------------------------------------------ 密钥

/** 生成一对 P-256 ECDH 密钥。返回 { privateKey, publicKey, publicRaw }。 */
export async function generateKeyPair () {
  const subtle = requireSubtle()
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicRaw }
}

/** 私钥导出成 JWK（只有服务端会用到；私钥永远不离开那台机器）。 */
export async function exportPrivateJwk (privateKey) {
  return requireSubtle().exportKey('jwk', privateKey)
}

/** 从 JWK 还原私钥。 */
export async function importPrivateJwk (jwk) {
  if (!jwk || jwk.kty !== 'EC' || !jwk.d) throw new EnvelopeError('BAD_KEY', '私钥格式不正确')
  return requireSubtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
}

/** 公钥：87 字符 base64url 的未压缩点。 */
export function publicKeyToText (publicRaw) {
  const raw = publicRaw instanceof Uint8Array ? publicRaw : u8(publicRaw)
  if (raw.length !== P256_POINT || raw[0] !== 0x04) throw new EnvelopeError('BAD_KEY', '公钥格式不正确')
  return toBase64Url(raw)
}

/** 文本公钥 → CryptoKey（网页端只需这一步）。 */
export async function importPublicKey (text) {
  const raw = fromBase64Url(text)
  if (raw.length !== P256_POINT || raw[0] !== 0x04) throw new EnvelopeError('BAD_KEY', '公钥不正确（应该是 87 个字符）')
  return requireSubtle().importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
}

function requireSubtle () {
  const c = globalThis.crypto
  if (!c || !c.subtle) throw new EnvelopeError('NO_CRYPTO', '当前环境不支持 WebCrypto（需要 https 或 localhost）')
  return c.subtle
}

/**
 * ECDH → HKDF(SHA-256) → AES-256-GCM。分两步走而不是一步链式 deriveKey：
 * 一步链式在 Chrome/Firefox 里没问题，但 Node 会把中间结果按 HKDF 的 key usages 校验并报
 * 「Unsupported key usage for a HKDF key」。分步（deriveBits → importKey → deriveKey）两边都支持，
 * 而且结果逐字节相同：都是 HKDF-Extract(salt, ECDH) 再 HKDF-Expand(info)。
 */
async function deriveAesKey (privateKey, publicKey, salt) {
  const subtle = requireSubtle()
  const shared = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256)
  const hkdf = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: KDF_INFO },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ------------------------------------------------------------------ 信封

/**
 * 加密：网页端调用。
 * @param {string|CryptoKey} recipient 服务端公钥文本或 CryptoKey
 * @param {object} body 见 encodeBody
 * @returns {Promise<string>} 'BBX1.xxxx'
 */
export async function sealEnvelope (recipient, body) {
  const subtle = requireSubtle()
  const publicKey = typeof recipient === 'string' ? await importPublicKey(recipient) : recipient
  if (!publicKey) throw new EnvelopeError('BAD_KEY', '缺少公钥')
  const plain = encodeBody(body)
  const eph = await generateKeyPair()
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveAesKey(eph.privateKey, publicKey, salt)

  const head = concat([
    utf8.encode(MAGIC),
    new Uint8Array([VERSION, SUITE]),
    eph.publicRaw,
    salt,
    iv,
  ])
  if (head.length !== HEAD_BYTES) throw new EnvelopeError('INTERNAL', '信封头部长度不对')
  const sealed = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: head, tagLength: 128 },
    key,
    plain,
  ))
  return MAGIC + '.' + toBase64Url(concat([head, sealed]))
}

/**
 * 解密：服务端调用。只做格式/加密校验，时间与一次性由 lib/envelope.mjs 判。
 * @param {CryptoKey} privateKey
 * @param {string} text 用户贴来的整段
 * @returns {Promise<object>} decodeBody 的结果
 */
export async function openEnvelope (privateKey, text) {
  const subtle = requireSubtle()
  if (!privateKey) throw new EnvelopeError('BAD_KEY', '缺少私钥')
  const raw = String(text == null ? '' : text).trim()
  if (!raw) throw new EnvelopeError('BAD_FORMAT', '信封是空的')
  if (raw.length > MAX_TEXT) throw new EnvelopeError('TOO_LARGE', '这段太长了，不像是本模块的信封')
  const dot = raw.indexOf('.')
  if (dot < 0) throw new EnvelopeError('BAD_FORMAT', '信封格式不对（应该以 BBX1. 开头）')
  if (raw.slice(0, dot) !== MAGIC) throw new EnvelopeError('BAD_FORMAT', '信封格式不对（应该以 BBX1. 开头）')
  const bytes = fromBase64Url(raw.slice(dot + 1))
  if (bytes.length < HEAD_BYTES + 1 + TAG_BYTES) throw new EnvelopeError('BAD_FORMAT', '信封内容不完整')
  if (bytes.length > HEAD_BYTES + MAX_TEXT + TAG_BYTES) throw new EnvelopeError('TOO_LARGE', '信封内容过长')

  const version = bytes[4]
  const suite = bytes[5]
  if (version !== VERSION) throw new EnvelopeError('BAD_VERSION', '信封版本不支持（' + version + '）')
  if (suite !== SUITE) throw new EnvelopeError('BAD_SUITE', '信封的加密套件不支持（' + suite + '）')
  if (bytes[6] !== 0x04) throw new EnvelopeError('BAD_FORMAT', '信封里的临时公钥格式不对')

  const head = bytes.subarray(0, HEAD_BYTES)
  const ephemeralRaw = head.subarray(6, 6 + P256_POINT)
  const salt = head.subarray(6 + P256_POINT, 6 + P256_POINT + SALT_BYTES)
  const iv = head.subarray(6 + P256_POINT + SALT_BYTES, HEAD_BYTES)
  const sealed = bytes.subarray(HEAD_BYTES)

  let ephemeral
  try {
    ephemeral = await subtle.importKey('raw', ephemeralRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, [])
  } catch {
    throw new EnvelopeError('BAD_FORMAT', '信封里的临时公钥不正确')
  }
  const key = await deriveAesKey(privateKey, ephemeral, salt)
  let plain
  try {
    plain = new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: head, tagLength: 128 },
      key,
      sealed,
    ))
  } catch {
    // 篡改 / 不是给这把私钥的 / 根本不认识的密文：一律同一个错误，不泄露区别。
    throw new EnvelopeError('BAD_TAG', '这段信封解不开：可能不是给这台机器的，或者内容被改过')
  }
  return decodeBody(plain)
}

// ------------------------------------------------------------------ 便捷判定（网页端提示用）

/** 判断一段文本「看起来像不像」信封，用于输入框实时提示。 */
export function looksLikeEnvelope (text) {
  const raw = String(text == null ? '' : text).trim()
  return raw.startsWith(MAGIC + '.') && raw.length > 110
}

/** 生存时间（分钟）→ 人话。 */
export function describeTtl (minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0))
  if (n < 60) return n + ' 分钟'
  const hours = Math.floor(n / 60)
  const rest = n % 60
  return hours + ' 小时' + (rest ? ' ' + rest + ' 分钟' : '')
}
