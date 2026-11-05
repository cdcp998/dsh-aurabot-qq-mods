// 印象卡片的宿主渲染：找 DSH 自带 sharp、拉 QQ 头像、归一化头像、把 SVG 栅格化落盘。
// sharp 只在真正渲染时才懒加载，模块可以在 DSH Electron 主进程里安全 import。

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundledSharpPaths, localSharpPaths, firstExisting } from './sharp-plan.mjs'

const AVATAR_URL_BASE = 'https://q1.qlogo.cn/g?b=qq&nk='
const AVATAR_URL_SUFFIX = '&s=640'
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
const AVATAR_TIMEOUT_MS = 8000
const JPEG_BACKGROUND = '#12131a'

function normalizeSharpModule (mod) {
  if (!mod) return null
  if (typeof mod === 'function') return mod
  if (typeof mod.default === 'function') return mod.default
  if (mod.default && typeof mod.default.default === 'function') return mod.default.default
  return null
}

function looksLikeImage (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true
  if (buf[0] === 0x42 && buf[1] === 0x4d) return true
  if (buf.toString('ascii', 4, 8) === 'ftyp') return true
  return false
}

/**
 * 找宿主自带的 sharp：先尝试正常 import，再尝试 resourcesPath 下的 DSH 安装位置。
 * 找不到 / 加载失败返回 null，不抛异常。
 */
export async function findSharp (options) {
  const opts = options && typeof options === 'object' ? options : {}
  const importer = typeof opts.importer === 'function' ? opts.importer : (specifier) => import(specifier)
  // 扩展目录里已有的 sharp 优先（只读探测，模块不会自己安装）。
  const local = firstExisting(localSharpPaths(opts.moduleDir), existsSync)
  if (local) {
    try {
      const mod = await importer(pathToFileURL(local).href)
      const sharp = normalizeSharpModule(mod)
      if (sharp) return sharp
    } catch (error) {}
  }
  try {
    const mod = await importer('sharp')
    const sharp = normalizeSharpModule(mod)
    if (sharp) return sharp
  } catch (error) {}
  let resourcesPath = opts.resourcesPath
  if (resourcesPath === undefined) {
    try {
      resourcesPath = process.resourcesPath || ''
    } catch (error) {
      resourcesPath = ''
    }
  }
  const candidates = bundledSharpPaths(resourcesPath)
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const mod = await importer(pathToFileURL(file).href)
      const sharp = normalizeSharpModule(mod)
      if (sharp) return sharp
    } catch (error) {}
  }
  return null
}

/** 仅接受 5–12 位 ASCII 数字 QQ 号，返回固定 QQ 头像地址；非法输入返回空串。 */
export function avatarUrl (userId) {
  let id = ''
  if (typeof userId === 'string') id = userId
  else if (typeof userId === 'number' && Number.isInteger(userId)) id = String(userId)
  if (!/^[0-9]{5,12}$/.test(id)) return ''
  return AVATAR_URL_BASE + id + AVATAR_URL_SUFFIX
}

/**
 * 拉取 QQ 头像。任何失败、超时、超过 2MB、非图片都返回 null，不抛异常。
 * opts.fetchImpl / opts.timeoutMs 只用于测试和按需调整。
 */
export async function fetchQqAvatar (userId, options) {
  const opts = options && typeof options === 'object' ? options : {}
  const url = avatarUrl(userId)
  if (!url) return null
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (url, init) => fetch(url, init)
  const timeoutMs = clampNumber(opts.timeoutMs, 500, 30000, AVATAR_TIMEOUT_MS)
  const maxBytes = AVATAR_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => {
    try {
      controller.abort()
    } catch (error) {}
  }, timeoutMs)
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*' },
      redirect: 'follow',
    })
    if (!response || !response.ok) return null
    const headers = response.headers
    const contentType = headers && typeof headers.get === 'function' ? String(headers.get('content-type') || '').toLowerCase() : ''
    if (contentType && !contentType.startsWith('image/') && !contentType.includes('octet-stream')) return null
    const contentLength = headers && typeof headers.get === 'function' ? Number(headers.get('content-length')) : NaN
    if (Number.isFinite(contentLength) && contentLength > maxBytes) return null
    const arrayBuffer = await response.arrayBuffer()
    const buf = Buffer.from(arrayBuffer)
    if (buf.length < 16 || buf.length > maxBytes) return null
    if (!looksLikeImage(buf)) return null
    return buf
  } catch (error) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 把头像缩到 640 以内、取首帧并转成 PNG data URI；失败返回空字符串。 */
export async function avatarDataUri (buf, sharp) {
  const factory = normalizeSharpModule(sharp)
  if (!factory || !Buffer.isBuffer(buf) || !buf.length) return ''
  try {
    const out = await factory(buf, { animated: false })
      .rotate()
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer()
    if (!Buffer.isBuffer(out) || !out.length) return ''
    return 'data:image/png;base64,' + out.toString('base64')
  } catch (error) {
    return ''
  }
}

function clampNumber (value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeFormat (format) {
  const text = String(format === undefined || format === null || format === '' ? 'png' : format).trim().toLowerCase()
  if (text === 'png') return 'png'
  if (text === 'jpeg' || text === 'jpg') return 'jpeg'
  return ''
}

function safeFileBase (value) {
  const raw = String(value === undefined || value === null ? '' : value)
    .replace(/\.(png|jpe?g)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '')
    .slice(0, 80)
  return raw || 'impression-card'
}

function fileNameFor (fileBase, format) {
  const stem = safeFileBase(fileBase)
  const suffix = randomBytes(4).toString('hex')
  const extension = format === 'jpeg' ? 'jpg' : 'png'
  return stem + '-' + suffix + '.' + extension
}

/**
 * 创建卡片渲染器：负责把 SVG 栅格化到 dataDir，并复用同一个 sharp 实例。
 * renderCard 永远返回结果对象，失败不抛；扩展主流程可以按 ok 决定回退文字。
 */
export function createCardRenderer (config) {
  const opts = config && typeof config === 'object' ? config : {}
  const dataDir = typeof opts.dataDir === 'string' ? opts.dataDir.trim() : ''
  const log = opts.log
  const moduleDir = typeof opts.moduleDir === 'string' ? opts.moduleDir : ''
  let sharpPromise = null

  function getSharp () {
    if (!sharpPromise) {
      sharpPromise = findSharp({ moduleDir }).catch(() => null)
    }
    return sharpPromise
  }

  async function renderCard (request) {
    const req = request && typeof request === 'object' ? request : {}
    try {
      if (typeof req.svg !== 'string' || !req.svg.trim().startsWith('<svg')) {
        return { ok: false, error: 'SVG 内容为空或不是完整的 SVG' }
      }
      if (!dataDir) return { ok: false, error: '未配置卡片保存目录' }
      const format = normalizeFormat(req.format)
      if (!format) return { ok: false, error: '不支持的图片格式' }
      const scale = clampNumber(req.scale, 1, 4, 2)
      const sharp = await getSharp()
      if (typeof sharp !== 'function') return { ok: false, error: 'sharp 不可用' }
      const density = Math.round(72 * scale)
      let pipeline = sharp(Buffer.from(req.svg, 'utf8'), { density })
      pipeline = format === 'jpeg'
        ? pipeline.flatten({ background: JPEG_BACKGROUND }).jpeg({ quality: 90 })
        : pipeline.png({ compressionLevel: 9 })
      const buf = await pipeline.toBuffer()
      if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: '栅格化结果为空' }
      await mkdir(dataDir, { recursive: true })
      const file = join(dataDir, fileNameFor(req.fileBase, format))
      await writeFile(file, buf)
      try {
        if (log && typeof log.debug === 'function') log.debug('印象卡片已写入 ' + file)
      } catch (logError) {}
      return { ok: true, file, bytes: buf.length }
    } catch (error) {
      const message = error && error.message ? String(error.message) : '卡片渲染失败'
      try {
        if (log && typeof log.debug === 'function') log.debug('印象卡片渲染失败：' + message)
      } catch (logError) {}
      return { ok: false, error: message }
    }
  }

  return {
    renderCard,
    async sharp () {
      return getSharp()
    },
    async avatarDataUri (buf) {
      const sharp = await getSharp()
      return avatarDataUri(buf, sharp)
    },
  }
}
