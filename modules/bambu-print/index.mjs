// index.mjs —— 拓竹打印机（bambu-print）模块入口（装配层）
//
// 四件事：
//   1. 把「谁是谁」弄清楚：私聊 / 群聊 / 白名单，默认拒绝；
//   2. 把每个用户的秘密锁在自己的保险箱里：安全码 → scrypt → AES-256-GCM，连主人也拿不到；
//   3. 把 Bambu 局域网 / 云端协议接起来：状态、暂停继续、停止、灯光、速度、温度、拍照（含云端 TUTK）；
//   4. 群聊默认脱敏：只说进度、已打印 / 剩余时间，不透露文件名和项目名。
//
// 设计约定：
// - 私聊里给「自己的」打印机；想用别人的打印机，必须由对方在私聊里主动授权（限时、可选范围、
//   只覆盖对方选中的绑定）。**授权的本质就是把绑定者自己的 Bambu 凭据限时共享给受权人**，
//   对方立即就能查看/管理这些打印机；但凭据只解密在进程内存里，对方拿不到绑定者的安全码，
//   也解不开其它绑定，且主人随时能撤销、到期自动失效。
// - 一个凭据（token / 局域网访问码）可以对应多台打印机：解析到多台时不猜，列编号让用户选。
// - 所有明文秘密只在本文件的局部变量里出现，绝不写日志、绝不拼进返回给聊天/面板的字符串。

import path from 'node:path'
import { createVault } from './lib/vault.mjs'
import { createPrinterManager } from './lib/printer.mjs'
import { captureFrame, learnCameraCert } from './lib/camera.mjs'
import { discoverPrinters, DISCOVERY_PORT } from './lib/discover.mjs'
import { prettyFingerprint } from './lib/tls-cert.mjs'
import { listDevices, REGIONS } from './lib/cloud.mjs'
import { mintTutcode, TUTK_DEFAULT_TIMEOUT_MS, TUTK_MAX_TIMEOUT_MS } from './lib/tutk.mjs'
import { captureViaBridge, checkBridgeBinary, defaultBridgePath, BAMBUSOURCE_URL, BAMBUSOURCE_FILE, BAMBUSOURCE_ADVICE } from './lib/tutk-bridge.mjs'
import { downloadBambuSource, isCnLikely, OBN_RELEASES, resolveDestDir } from './lib/tutk-lib.mjs'
import { createCloudLogin, verifyCloudToken, CloudAuthError } from './lib/cloud-auth.mjs'
import { normalizeStatus, formatStatus, formatChoiceList } from './lib/status.mjs'
import { SETTING_RULES, normalizeSettings, describeRules, effectiveEnabled } from './lib/settings.mjs'
import {
  parseIdList, roleOf, checkPrivate, checkGroup, groupMode, effectiveGroupMode, effectiveGroupPhoto,
  canControl, canPhoto, redaction, maskQQ, maskIp, createRateLimiter, parseMinutes,
} from './lib/policy.mjs'

// 帮助分成 4 页：一页一条消息，避免一次刷出几十行。
// 「风险」和「存储策略」是最该被看到的，所以放在第一页。
const HELP_PAGES = [
  {
    key: 'risk',
    title: '① 风险',
    lines: [
      '私聊发送同样有风险：私聊记录会以明文留存，撤回并不能可靠消除风险。请优先使用官方授权方式或临时凭据；如确需提供，请先评估风险，事后立即修改密码并检查账号授权与设备绑定情况。',
      '访问码 = 打印机控制权：谁拿到谁能暂停、停止、改温度。',
      '别把密码、访问码、安全码发到群里；群里也不接受绑定、解锁、授权等敏感操作。',
      '安全码和访问码一旦泄露，最坏情况是别人能控制你的打印机；账号密码泄露还可能连带你的 Bambu 账号。',
      '谨慎使用插件：请在你熟悉的「鱼」管理者下使用。',
    ],
  },
  {
    key: 'store',
    title: '② 数据存在哪',
    lines: [
      '秘密只加密存在本机 modules-data/bambu-print/，不落明文、不进日志、不上传。',
      '每人一把独立密钥，由各人自己的安全码派生，谁也解不开别人的。',
      '主人可以免安全码：密钥改由本机 host-key.bin 保管（数据目录可读即可解）。',
      '解锁只在内存留密钥，到期或「/打印机 锁定」即清；删数据目录等于永久删除。',
    ],
  },
  {
    key: 'watch',
    title: '③ 看状态与简单控制',
    lines: [
      '/打印机 状态 [打印机]',
      '  看进度、层数、已打印 / 剩余、预计完成、温度。多台不带名字会先问你哪一台。',
      '/打印机 暂停 · 继续 · 停止 [打印机]',
      '  停止要再发一次确认。群里只能暂停/继续，停止必须私聊。',
      '/打印机 灯 开|关 [打印机]',
      '  打印仓灯。不写开/关就当「开」。',
      '/打印机 速度 1-4 [打印机]',
      '  4 最快（运动模式），1 最慢（静音）。',
      '/打印机 温度 喷嘴=220 热床=60 [打印机]',
      '  至少给一个，0 表示关加热。例如「温度 喷嘴=220」。',
      '/打印机 拍照 [打印机]',
      '  拍一张打印仓。局域网优先，不行回退云端；群里要允许拍照。',
      '[打印机] 可以写编号、名字或序列号；只有一台时可以省。',
    ],
  },
  {
    key: 'account',
    title: '④ 登录云端账号',
    lines: [
      '/打印机 登录 <Bambu账号> <密码>',
      '  登录后自动同步账号下的打印机。OAuth 注册的账号要先去 App 里设密码。',
      '/打印机 验证码',
      '  云端要验证码时先发它，让云端把码发到你邮箱/手机。',
      '/打印机 验证码 <6位>',
      '  收到码后用这条提交。',
      '/打印机 两步验证 <6位>',
      '  云端要求两步验证时用。',
      '/打印机 同步',
      '  重新拉一次云端设备列表（换机器、换账号后用）。',
    ],
  },
  {
    key: 'share',
    title: '⑤ 列表、授权、群权限',
    lines: [
      '/打印机 列表',
      '  看自己绑定的打印机、编号、打码序列号，以及别人授权给你的。',
      '/打印机 授权 <对方QQ> [分钟] [status,control,photo]',
      '  把自己的凭据限时共享给对方，立即生效、随时能撤。默认 30 分钟、只给看状态。',
      '/打印机 撤销 <授权编号>',
      '  提前收回授权，编号在「列表」里能看到。',
      '/打印机 审计 [条数]',
      '  看自己的解锁 / 绑定 / 控制 / 授权记录，默认 10 条。',
      '/打印机 群权限 [只读|控制|关闭|跟随] [拍照 开|关] [文件名 开|关]',
      '  不带参数是查看，带参数才是改。只影响你自己那台在群里的表现。',
      '群里默认只说进度、层数、温度，文件名显示「已脱敏」。',
    ],
  },
  {
    key: 'security',
    title: '⑥ 安全码与解锁',
    lines: [
      '/打印机 设置安全码 <密码>',
      '  第一次使用。至少 8 位（纯数字至少 10 位），不能是连续或常见串；忘了只能清空重绑。',
      '/打印机 解锁 <安全码>',
      '  重启 / 过期 / 手动锁定后才需要。含安全码的消息会被尝试撤回。',
      '/打印机 锁定',
      '  立刻清掉内存里的密钥，之后要重新解锁。',
      '/打印机 改安全码 <旧> <新>',
      '  换安全码，不用重新绑定，已绑的打印机都保留。',
      '这些只能在私聊里用：群里发安全码等于公开它。',
      '主人默认不用安全码（设置里可关），所以主人通常不需要前三条。',
    ],
  },
]

// 局域网相关的说明只出现在主人自己的帮助里，其他用户看不到也用不了。
/**
 * 把帮助拼成「第 N 页」。一页一条消息，避免一次刷几十行被折叠。
 * @param {number} page 1-based
 * @param {boolean} isOwner 主人多看一页局域网
 */
function helpPage (page, isOwner) {
  const pages = HELP_PAGES.slice()
  // 主人那一页实际排第 7，标题里的圈号要和位置对上
  if (isOwner) pages.push({ key: 'owner', title: '⑦ 主人专用（局域网）', lines: OWNER_HELP_LINES })
  const total = pages.length
  const index = Math.min(total, Math.max(1, Math.round(Number(page) || 1))) - 1
  const current = pages[index]
  const head = '拓竹 · 帮助 ' + (index + 1) + '/' + total + '：' + current.title
  const body = current.lines.join('\n')
  const isLast = index === total - 1
  const nav = []
  if (index > 0) nav.push('/打印机 帮助 ' + index)
  if (!isLast) nav.push('/打印机 帮助 ' + (index + 2))
  // 最后一页也要说清楚「到头了」，否则用户不知道还要不要继续翻
  const tail = '\n—— ' + (nav.length ? nav.join(' | ') : '') + (isLast ? (nav.length ? ' · 已经是最后一页' : '已经是最后一页') : '')
  return head + '\n' + body + tail
}

/**
 * 帮助用「合并转发」发：一次把所有页塞进一个聊天气泡，翻页、不刷屏。
 * 返回合并转发需要的 nodes 数组（每页一个节点）。
 * @param {boolean} isOwner
 */
/** 序列号打码（模块级版本，供模块级函数用；setup 里有同名局部版本，逻辑一致）。 */
function localMaskSerial (serial) {
  const s = String(serial || '')
  if (!s) return ''
  if (s.length <= 6) return s.slice(0, 2) + '••'
  return s.slice(0, 4) + '••••' + s.slice(-3)
}

/**
 * 「你有多台打印机」的合并转发：每台一个节点，列出名字/型号/序列号/绑定名。
 * 比一行行纯文本更好认，也不会占满聊天。内容全部打码（序列号），不含任何秘密。
 * @param {Array} list vault.printers() 的结果
 */
function choiceForwardNodes (list) {
  const rows = Array.isArray(list) ? list : []
  return rows.map((item, index) => {
    const p = item && typeof item === 'object' ? item : {}
    const name = String(p.name || p.label || '').trim() || '未命名打印机'
    const parts = []
    if (p.label && p.label !== name) parts.push('绑定：' + p.label)
    if (p.model) parts.push('型号 ' + p.model)
    if (p.serial) parts.push('序列号 ' + localMaskSerial(p.serial))
    if (p.bindingLabel && p.bindingLabel !== name && p.bindingLabel !== p.label) parts.push('凭据：' + p.bindingLabel)
    return {
      type: 'node',
      data: {
        name: '拓竹',
        uin: '0',
        content: (index + 1) + '. ' + name + (parts.length ? '\n' + parts.join(' · ') : ''),
      },
    }
  })
}

function helpForwardNodes (isOwner) {
  const pages = HELP_PAGES.slice()
  if (isOwner) pages.push({ key: 'owner', title: '⑦ 主人专用（局域网）', lines: OWNER_HELP_LINES })
  // 每个节点只放这一段的标题和正文，**不写「帮助 1/7」**：
  // 合并转发本身就是一层折叠卡片，点开是并列的几段，页码只会显得啰嗦。
  return pages.map((page) => ({
    type: 'node',
    data: {
      name: '拓竹',
      uin: '0',
      content: page.title + '\n' + page.lines.join('\n'),
    },
  }))
}

const OWNER_HELP_LINES = [
  '/打印机 绑定 本地 <序列号> <IP> <访问码> [名称]',
  '/打印机 绑定 追加 <序列号> <IP> [访问码] [名称]',
  '/打印机 解绑 <编号> · 接口 云端|本地|自动',
  '/打印机 证书 [序号] · 证书 信任（换了固件 / 换机器后）',
]

// 局域网绑定表单的形状规则（面板和 /lan/bind 共用同一套）：只做「看起来像不像」，
// 真正的 owner / 解锁 / 上限 / 证书固定都在 bindLan 里判。
const SERIAL_RE = /^[A-Za-z0-9._-]{4,40}$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/


export default {
  id: 'bambu-print',
  name: '拓竹',
  version: '1.0.0',
  api: 1,
  description: '看拓竹 3D 打印机状态、暂停继续、停止、灯光、温度和拍照；每个用户一条独立加密凭据，默认谁也看不到别人的 token，只有本人主动授权才限时共享。',
  panel: 'panel.js',
  // 子标签页上的「开/关」小圆点读的是 flag 指向的那个设置项。这里故意用 active 而不是 enabled：
  // 宿主对 flag === 'enabled'（或 settings 里有 enabled）的模块，会在页面标题栏再画一个总开关，
  // 那个开关和本模块面板里的开关各写各的，用户看到的就是「保存设置按钮和规则不一样」。
  // 用 active 就只拿到圆点，不加第二个开关；active 和旧配置里的 enabled 由 effectiveEnabled 判定。
  flag: 'active',
  // 挂到面板「平台」分组下（默认按名字猜会落到「系统」）
  group: 'platform',
  // 注意：defaults 里**既没有 enabled 也没有 active**。
  //   · 没有 enabled：宿主见到 settings / defaults 里的 enabled 会在页面标题栏再画一个总开关，
  //     和面板里那个各写各的 —— 这就是「保存按钮和规则不一样」的另一半。
  //   · 没有 active：宿主启动时会把 defaults 里缺的键直接写进配置（src/core/modules.js start()），
  //     若在这里写 active:false，老用户配置里的 enabled:true 会被这句话覆盖成「关」，
  //     升级一次就静默停机。所以 active 一律由下面 setup() 里的启动对齐用 saveSettings 写入，
  //     写入值来自 effectiveEnabled(旧配置)，老用户的开关状态不会被重置。
  defaults: {
    groupMode: 'status',
    groupPhoto: true,
    allowGroupName: false,
    unlockDays: 7,
    maxBindings: 5,
    requestTimeoutMs: 6000,
    selectedTtlMinutes: 10,
    defaultInterface: 'cloud',
    ownerInterface: '',
    ownerLocalAllowed: true,
    tutkBridgePath: '',
    tutkLibPath: '',
    tutkTimeoutMs: 20000,
  },
  // 面板自己画设置表单（panel.js）。这里声明空数组，避免宿主再渲染一份重复的设置栏。
  settings: [],

  setup(api) {
    const testHooks = api.__bambuTestHooks || {}
    const log = api.log
    const capture = testHooks.captureFrame || captureFrame
    const discoverDevices = testHooks.listDevices || listDevices

    // ---------- 设置 ----------
    // 启动对齐（在 vault 创建之前做，只碰设置，不碰任何秘密）：
    //   1) 老配置里只有 enabled 的，把 active 写成同一个值 —— 否则标签页圆点（读 active）
    //      和真实开关（读 enabled）就是两个意思，这正是「保存按钮和规则不一样」的来源之一；
    //   2) 把存量设置按规则表归一化，只写有差异的键（不整份覆盖，免得动到别人的字段）。
    try {
      const s0 = api.settings() || {}
      const want = effectiveEnabled(s0)
      if (s0.active !== want) api.saveSettings({ active: want })
      const n = normalizeSettings(s0)
      const diff = {}
      const keys = []
      for (const key of Object.keys(SETTING_RULES)) {
        if (key === 'active') continue
        if (JSON.stringify(s0[key]) !== JSON.stringify(n[key])) {
          diff[key] = n[key]
          keys.push(key)
        }
      }
      if (keys.length) {
        api.saveSettings(diff)
        log.info('拓竹打印机：已把 ' + keys.length + ' 条不合规则的设置归一化')
      }
    } catch (error) {
      log.warn('对齐拓竹打印机开关 / 归一化设置失败：' + (error && error.message ? error.message : error))
    }

    /**
     * Aurabot 自己的私聊白名单（cfg.allow.private）+ 主人。
     * 模块不再单独维护「私聊白名单」：能在 Aurabot 里跟她私聊的人，才有资格在本模块绑定/使用打印机。
     */
    /** Aurabot 自己的群白名单（cfg.allow.groups）：模块不再单独维护一份群号列表。 */
    const hostGroupAllow = () => {
      try {
        const cfg = api.config ? api.config() : null
        const list = Array.isArray(cfg && cfg.allow && cfg.allow.groups) ? cfg.allow.groups : []
        return parseIdList(list)
      } catch {
        return parseIdList('')
      }
    }

    const hostPrivateAllow = () => {
      try {
        const cfg = api.config ? api.config() : null
        const list = Array.isArray(cfg && cfg.allow && cfg.allow.private) ? cfg.allow.private : []
        return parseIdList(list.concat(String((cfg && cfg.ownerQQ) || '')))
      } catch {
        return parseIdList('')
      }
    }
    /** 解锁有效期：按「天」配置（1~30 天，默认 7 天），内部统一换算成分钟。 */
    const unlockDaysOf = (s) => {
      const raw = s ? s.unlockDays : null
      // 有值就夹到 1~30（0、负数、999 都落到边界）；空值才算「没配」
      if (raw !== null && raw !== undefined && raw !== '') {
        const n = Number(raw)
        if (Number.isFinite(n)) return Math.min(30, Math.max(1, Math.round(n)))
      }
      const legacy = s ? Number(s.unlockMinutes) : NaN // 老版本按分钟存，按天向上取整迁移
      if (Number.isFinite(legacy) && legacy > 0) return Math.min(30, Math.max(1, Math.ceil(legacy / 1440)))
      return 7
    }
    /**
     * 生效设置：一律经 normalizeSettings 归一化（和 /overview.rules、面板表单同一份规则），
     * 这样「面板上看到的」和「模块真按的」永远是同一套夹取逻辑。
     * 返回字段集合保持和以前完全一样（enabled 是判定结果，不是存储键）。
     */
    const settings = () => {
      const raw = api.settings() || {}
      const n = normalizeSettings(raw)
      return {
        enabled: effectiveEnabled(raw),
        // 私聊准入直接用 Aurabot 自己的白名单（主人 + cfg.allow.private），模块不再维护第二份名单。
        users: hostPrivateAllow(),
        groups: hostGroupAllow(),
        // 多用户模式：关掉就只服务主人一个人
        multiUser: n.multiUser,
        groupMode: n.groupMode,
        groupPhoto: n.groupPhoto,
        allowGroupName: n.allowGroupName,
        unlockMinutes: unlockDaysOf({ unlockDays: n.unlockDays }) * 1440,
        maxBindings: n.maxBindings,
        requestTimeoutMs: n.requestTimeoutMs,
        selectedTtlMinutes: n.selectedTtlMinutes,
        defaultInterface: n.defaultInterface,
        ownerInterface: n.ownerInterface,
        ownerLocalAllowed: n.ownerLocalAllowed,
        // 主人免安全码：默认开。关掉后主人也得自己设安全码（原有行为）。
        ownerNoCode: n.ownerNoCode,
        tutkBridgePath: n.tutkBridgePath,
        tutkLibPath: n.tutkLibPath,
        tutkTimeoutMs: n.tutkTimeoutMs,
      }
    }

    // ---------- 保险箱 ----------
    const vault = (testHooks.createVault || createVault)({
      dir: api.dataDir(),
      log,
      kdf: testHooks.kdf,
      lockMinutes: settings().unlockMinutes,
      maxBindings: settings().maxBindings,
    })
    /**
     * 免安全码账号的自动解锁。
     *
     * 主人可以完全不设安全码（设置里 `ownerNoCode`）。这种账号的 DEK 由本机主密钥包着，
     * 所以在面板/命令里任何「需要已解锁」的地方，都先尝试自动开一次会话，用户完全无感。
     * 设了安全码的账号 `isCodeless()` 为 false，这里什么都不做 —— 绝不会绕过安全码。
     */
    const ownerQQOf = () => String((api.config() && api.config().ownerQQ) || '')
    /** 免码只在「设置里允许」且「这个账号确实是免码建的」时成立。 */
    const isCodelessOwner = () => {
      try {
        if (settings().ownerNoCode === false) return false
        return !!vault.isCodeless && vault.isCodeless(ownerQQOf())
      } catch { return false }
    }
    /** 免码账号 → 自动解锁并返回 true；其它情况原样返回当前是否已解锁。 */
    const ensureOwnerSession = async () => {
      const qq = ownerQQOf()
      if (!qq) return false
      try {
        await ready()
        if (vault.isUnlocked(qq)) return true
        if (!isCodelessOwner()) return false
        await vault.unlockWithoutCode(qq)
        return vault.isUnlocked(qq)
      } catch (error) {
        log.warn('免安全码账号自动解锁失败：' + ((error && error.message) || error))
        return false
      }
    }
    /** 统一的「这个用户现在能不能用」判断：免码主人会自动开，其它人照旧要解锁。 */
    const isUsableNow = async (qq) => {
      const id = String(qq || '')
      if (!id) return false
      try {
        if (vault.isUnlocked(id)) return true
      } catch { /* 未加载 */ }
      if (id === ownerQQOf() && isCodelessOwner()) return ensureOwnerSession()
      return false
    }

    let loadPromise = null
    /** 把设置里的「解锁有效期（天）」同步到保险箱；每次解锁前都同步一次，改设置立即生效。 */
    const applyLockMinutes = () => {
      try { vault.setLockMinutes(settings().unlockMinutes) } catch { /* 还没 load 完，等 ready() 里再设 */ }
      return settings().unlockMinutes
    }
    const ready = () => {
      if (!loadPromise) {
        loadPromise = vault.load().then(() => {
          applyLockMinutes()
          return true
        }).catch((error) => { loadPromise = null; throw error })
      }
      return loadPromise
    }

    // ---------- 打印机管理 ----------
    /**
     * 打印机自签名证书的信任存档：内存里按 serial 缓存 PEM，落盘走 vault（加密）。
     * 上层（printer manager / camera）只问「这台打印机的证书是什么」，不关心存在哪。
     */
    const certTrust = {
      // target 里的 tlsCa / tlsFingerprint 就是 vault 解密出来的固定记录（见 targetOf）
      get (target) {
        if (!target || !target.tlsCa) return null
        return { pem: target.tlsCa, fingerprint256: target.tlsFingerprint || '' }
      },
      // 落盘不在这里做：ensureCert() 要走「指纹变了先报错」的确认流程，
      // 由它自己调 vault.setPrinterCert 并处理 CERT_CHANGED。这里只回答「有没有锚点」。
      save () {
        return false
      },
    }

    const manager = testHooks.printerManager || (testHooks.createPrinterManager || createPrinterManager)({
      log,
      clientFactory: testHooks.clientFactory,
      statusTtlMs: 3000,
      certTrust,
    })
    api.onDispose(() => { try { manager.closeAll() } catch (error) { /* 忽略 */ } vault.lockAll() })

    /**
     * 首次连局域网时先学一次打印机证书（TOFU），之后再连就一定用锚点严格校验。
     * 失败不阻断：命令会照常尝试，报错里会带「证书未固定」的原因。
     */
    const certLeases = new Map()
    async function ensureCert (printer, who, opts = {}) {
      if (!printer || printer.mode === 'cloud') return { ok: true, skipped: true }
      if (printer.tlsCa) return { ok: true, cached: true }
      const key = String(printer.bindingId || '') + ':' + String(printer.serial || '')
      if (certLeases.has(key)) return certLeases.get(key)
      const task = (async () => {
        // 授权来的打印机：证书要记在「绑定者」的保险库里，不能记到受权人名下
        const qq = String(printer.ownerQQ || (who && who.userId) || '')
        if (!qq || !printer.ip) return { ok: false, code: 'NO_LEARN_CONTEXT', error: '缺少学习证书所需的上下文' }
        // 测试里注入的 manager 可能没有 learnCert：跳过学习（等价于「证书已固定」）
        if (typeof manager.learnCert !== 'function') return { ok: true, skipped: true }
        const learned = await manager.learnCert({ mode: 'lan', ip: printer.ip, serial: printer.serial, accessCode: printer.accessCode, ownerQQ: qq, bindingId: printer.bindingId, port: 8883 })
        if (!learned.ok) return learned
        try {
          await vault.setPrinterCert(qq, { bindingId: printer.bindingId, serial: printer.serial, port: 8883 }, learned, { force: opts.force === true })
          if (printer) {
            printer.tlsCa = learned.pem
            printer.tlsFingerprint = learned.fingerprint256
          }
          await audit(qq, 'pin-cert', true, (learned.fingerprint256 || '').slice(0, 12), printer.serial)
          return { ok: true, learned: true, fingerprint256: learned.fingerprint256 }
        } catch (error) {
          // 证书换过又不是本人确认：把旧指纹报回去，让人看清楚再决定
          return { ok: false, code: error.code || 'CERT_FAILED', error: explain(error) }
        }
      })()
      certLeases.set(key, task)
      task.finally(() => { setTimeout(() => certLeases.delete(key), 5000).unref?.() })
      return task
    }

    /**
     * 摄像头端口的证书（:6000 / :322）：同样先学后用，存在同一个 vault 记录里。
     *
     * 归属规则（review P1-4）：证书永远记在**绑定者**（printer.ownerQQ）名下。
     * 受权人自己的保险库里根本没有这条绑定，按 who.userId 存必然失败；
     * 失败之后如果还继续去抓帧，就是拿空锚点把访问码发给一个没校验过的对端。
     */
    async function learnCameraCertOf (printer, who) {
      const qq = String(printer.ownerQQ || (who && who.userId) || '')
      if (!qq || !printer.ip) return { ok: false, code: 'NO_LEARN_CONTEXT', error: '缺少学习证书所需的上下文' }
      // 受权人代拍时，绑定者的保险箱可能没解锁：那就没法把学到的证书存回去，不能假装学会了。
      let stored = true
      try {
        if (!vault.isUnlocked(qq)) stored = false
      } catch (error) {
        stored = false
      }
      const learned = await (testHooks.learnCameraCert || learnCameraCert)({ host: printer.ip, port: Number(printer.camPort) || 6000, timeoutMs: 8000 })
      if (!learned || learned.ok !== true) return learned || { ok: false, code: 'LEARN_FAILED', error: '没读到摄像头证书' }
      if (!stored) {
        // 只在本进程内临时用一次，不落盘；下一次还得重新学（TOFU 未固定，调用方据此决定要不要继续）
        printer.cameraCa = learned.pem
        printer.cameraFingerprint = learned.fingerprint256
        return { ...learned, persisted: false }
      }
      try {
        await vault.setPrinterCert(qq, { bindingId: printer.bindingId, serial: printer.serial, certPort: Number(printer.camPort) || 6000 }, learned, {})
        printer.cameraCa = learned.pem
        printer.cameraFingerprint = learned.fingerprint256
        return { ...learned, persisted: true }
      } catch (error) {
        return { ok: false, code: error.code || 'CERT_FAILED', error: explain(error) }
      }
    }

    const limiter = createRateLimiter()
    const observedStart = new Map()
    const selections = new Map()
    let pendingStop = new Map()
    const pendingLogins = new Map() // qq → { session, account, region, until, need }  云端登录等验证码（只放内存，5 分钟）
    const LOGIN_TTL_MS = 5 * 60 * 1000
    const now = () => Date.now()

    function maskSerial(serial) {
      const s = String(serial || '')
      if (!s) return ''
      if (s.length <= 6) return s.slice(0, 2) + '••'
      return s.slice(0, 4) + '••••' + s.slice(-3)
    }

    // ---------- 接口选择：默认云端；主人可切本地；非主人默认云端 ----------
    const REGION_HOST = (region) => (REGIONS[region] && REGIONS[region].mqtt) || REGIONS.us.mqtt

    /**
     * 决定这次走云端还是本地。
     * - 用户偏好 interface（cloud / lan / auto）优先；
     * - 没有偏好时：主人看 settings.defaultInterface，非主人恒为 cloud（需求：非主人默认云端）；
     * - settings.ownerLocalAllowed=false 时强制云端；
     * - 云端需要 accessToken+uid；本地需要打印机 IP + 访问码（云端设备发现时带回的也算）。
     */
    function endpointOf(printer, who, { force = '' } = {}) {
      const s = settings()
      const hasLan = !!(String(printer.ip || '').trim() && String(printer.accessCode || '').trim())
      const hasCloud = printer.mode === 'cloud' && !!printer.accessToken && !!printer.uid
      // 授权来的打印机：凭据是绑定者主动共享的，按「和绑定者同等」选接口（否则主人绑的
      // 局域网打印机被授权出去就完全用不了）。安全码仍然不共享。
      const isOwner = !!(who && who.isOwner) || printer.granted === true
      // 局域网接口只提供给主人（以及拿到授权的人）：其他用户一律云端。
      if (!isOwner) {
        if (!hasCloud) {
          return {
            ok: false,
            code: 'CLOUD_ONLY',
            message: '这个模块的局域网接口只提供给主人使用；其他用户请用 Bambu 账号登录（云端接口）。',
          }
        }
        return { ok: true, transport: 'cloud', hasLan, hasCloud }
      }
      const pref = s.ownerInterface || (who && who.userId ? vault.publicPrefs(who.userId).interface : '')
      const def = s.defaultInterface
      let choice = force || pref || def
      if (choice === 'auto') choice = hasCloud ? 'cloud' : hasLan ? 'lan' : 'cloud'
      if (!s.ownerLocalAllowed) choice = 'cloud'
      if (choice === 'cloud' && !hasCloud) choice = hasLan ? 'lan' : 'cloud'
      if (choice === 'lan' && !hasLan) choice = hasCloud ? 'cloud' : 'lan'
      if (choice === 'cloud' && !hasCloud) {
        return { ok: false, code: 'NO_CLOUD', message: '这台打印机没有云端凭据（access token + uid），只能走本地接口：请用局域网 IP + 访问码绑定，或让主人检查绑定。' }
      }
      if (choice === 'lan' && !hasLan) {
        return { ok: false, code: 'NO_LAN', message: '这台打印机没有可用的局域网地址 / 访问码，切不回本地接口。' }
      }
      return { ok: true, transport: choice, hasLan, hasCloud }
    }

    function targetOf(printer, who, opts = {}) {
      const ep = endpointOf(printer, who, opts)
      if (!ep.ok) return ep
      const mode = ep.transport
      return {
        ok: true,
        transport: mode,
        mode,
        host: mode === 'cloud' ? REGION_HOST(printer.region) : printer.ip,
        port: 8883,
        serial: printer.serial,
        accessCode: mode === 'lan' ? printer.accessCode : '',
        accessToken: mode === 'cloud' ? printer.accessToken : '',
        uid: printer.uid,
        region: printer.region,
        tlsFingerprint: printer.tlsFingerprint || '',
        tlsCa: printer.tlsCa || '',
        cameraCa: printer.cameraCa || '',
        ownerQQ: who && who.userId ? String(who.userId) : '',
        bindingId: printer.bindingId || '',
        name: printer.name,
      }
    }

    const keyOf = (target) => manager.targetKey ? manager.targetKey(target) : [target.mode, target.host, target.serial].join('|')

    /** 下发命令：先按接口选择组装 target，失败时把中文原因交回去。 */
    async function doCommand(printer, who, action, params = {}) {
      const t = targetOf(printer, who)
      if (!t.ok) return { ok: false, error: t.message, code: t.code }
      // 控制也要先固定证书：否则就是「不校验还发访问码」
      if (t.mode === 'lan' && !t.tlsCa) {
        const learned = await ensureCert(printer, who)
        if (!learned.ok) return { ok: false, error: '还没能确认这台打印机的证书：' + (learned.error || learned.code || '未知原因'), code: learned.code || 'CERT_UNVERIFIED' }
        const again = targetOf(printer, who)
        if (again.ok) return { ...(await manager.command(again, action, params)), transport: again.transport }
      }
      const r = await manager.command(t, action, params)
      return { ...r, transport: t.transport }
    }

    function senderOf(msg) {
      return { userId: String(msg.userId || ''), chatId: String(msg.chatId || ''), isOwner: api.isOwner(msg.userId), role: msg.role || '' }
    }

    /** 「有得用」：自己有绑定，或者持有未过期的授权（受权人没有自己的保险箱也算）。 */
    function hasUsable(qq) {
      if (vault.hasUser(qq)) return true
      return vault.grantSessions(qq).length > 0
    }

    function gate(msg) {
      const s = settings()
      const who = senderOf(msg)
      // 关掉多用户模式：只服务主人一个人，其他人（含已有绑定 / 持授权的人）一律不响应
      if (s.multiUser === false && !who.isOwner) {
        // reason 留空 = 静默不理。单用户模式下对别人解释「只给主人用」没必要，
        // 反而让人知道这儿有个只服务主人的机器人。
        return { ok: false, code: 'SINGLE_USER', reason: '', role: 'guest', isPrivate: msg.kind !== 'group', groupId: '', s }
      }
      const role = roleOf({ userId: who.userId, isOwner: who.isOwner, settings: s })
      if (msg.kind === 'group') {
        const groupId = String(msg.groupId || '')
        const hasBinding = hasUsable(who.userId)
        const g = checkGroup({ groupId, userId: who.userId, settings: s, hasBinding })
        const prefs = vault.publicPrefs(who.userId)
        return { ...g, role, isPrivate: false, groupId, s, prefs, mode: effectiveGroupMode(s, prefs), photo: effectiveGroupPhoto(s, prefs) }
      }
      const hasBinding = hasUsable(who.userId)
      const p = checkPrivate({ userId: who.userId, isOwner: who.isOwner, settings: s, hasBinding })
      return { ...p, role, isPrivate: true, groupId: '', s }
    }

    /**
     * 群白名单准入（和 gate() 同源）：模型工具和 api.context 都不许绕过 cfg.allow.groups。
     * 非群聊直接放行（私聊准入仍由 checkPrivate / ensureControl 负责）；群聊只判
     * 「这个群在宿主白名单里 + 这个人有得用」，其余群权限语义（groupMode / 所有者偏好）保持不变。
     */
    function groupAllowed(chat) {
      if (!chat || chat.kind !== 'group') return true
      const userId = String(chat.userId || '')
      // 保险箱还没加载完时按「没有绑定」处理（安全默认），不把异常抛给宿主
      let hasBinding = false
      try { hasBinding = hasUsable(userId) } catch { hasBinding = false }
      const g = checkGroup({
        groupId: String(chat.groupId || ''),
        userId,
        settings: settings(),
        hasBinding,
      })
      return g.ok === true
    }

    /** 把解锁时长（毫秒）说成人话：优先「天」，不是整天才用小时/分钟。 */
    function lockSpanText (ms) {
      const total = Math.max(0, Math.round(Number(ms) || 0))
      const days = Math.floor(total / 86400000)
      const hours = Math.floor((total % 86400000) / 3600000)
      const minutes = Math.round((total % 3600000) / 60000)
      if (days > 0) return days + ' 天' + (hours > 0 ? ' ' + hours + ' 小时' : '')
      if (hours > 0) return hours + ' 小时'
      return (minutes || 1) + ' 分钟'
    }

    // 撤回（delete_msg）已经整体移除，原因：
    //   · 机器人撤自己发的消息经常没权限，成功率不稳，写了「已尝试撤回」也做不到；
    //   · 那句提示本身就在聊天里留下一笔「这里有敏感消息」的注脚，反而更显眼。
    // 现在改成在风险提示里把话说清楚（私聊会留明文），不再假装能擦掉已发出的消息。

    async function audit(actorQQ, action, ok, note, target) {
      try { await vault.audit({ actor: String(actorQQ || ''), action, ok, note: String(note || '').slice(0, 160), target }) } catch (error) { /* 审计失败不拖垮功能 */ }
    }

    // ---------- 打印机解析 ----------
    function pickPrinter(list, selector) {
      if (!list.length) return { ok: false, code: 'NO_PRINTER', message: '你还没绑定打印机。打开面板「拓竹」绑定，或在私聊里发「/打印机」看用法。' }
      const raw = String(selector || '').trim()
      if (!raw) {
        if (list.length === 1) return { ok: true, printer: list[0] }
        return {
          ok: false,
          code: 'NEED_CHOICE',
          message: '你有多台打印机，告诉我哪一台：\n' + formatChoiceList(list) + '\n回复编号或名字。',
          // 聊天里用合并转发列出每台（面板/接口调用方仍然读 message）
          forwardNodes: choiceForwardNodes(list),
          forwardFallback: '你有多台打印机，告诉我哪一台：\n' + formatChoiceList(list) + '\n回复编号或名字。',
        }
      }
      const n = Number(raw.replace(/^#/, ''))
      if (Number.isInteger(n) && n >= 1 && n <= list.length) return { ok: true, printer: list[n - 1] }
      const lower = raw.toLowerCase()
      const scored = list.map((p) => {
        const fields = [p.name, p.label, p.bindingLabel, p.serial].filter(Boolean).map((x) => String(x).toLowerCase())
        return { p, exact: fields.some((f) => f === lower), partial: fields.some((f) => f.includes(lower)) }
      })
      const exact = scored.filter((x) => x.exact).map((x) => x.p)
      if (exact.length === 1) return { ok: true, printer: exact[0] }
      const partial = scored.filter((x) => x.partial).map((x) => x.p)
      if (partial.length === 1) return { ok: true, printer: partial[0] }
      const candidates = exact.length > 1 ? exact : partial
      if (candidates.length) return { ok: false, code: 'AMBIGUOUS', message: '「' + raw + '」对上了好几台：\n' + formatChoiceList(candidates) + '\n说得更具体些，或直接回编号。' }
      return { ok: false, code: 'NO_PRINTER', message: '没找到「' + raw + '」这台打印机。\n' + formatChoiceList(list) }
    }

    function listOf(qq) {
      const out = vault.printers(qq).slice()
      for (const g of vault.grantSessions(qq)) {
        // 只给了「拍照」的授权也要出现在列表里，否则 /拍照 找不到目标
        if (!['status', 'control', 'photo'].some((x) => g.scopes.includes(x))) continue
        const r = vault.grantedPrinters(qq, g.grantId)
        if (!r || !r.ok) continue
        for (const p of r.printers) out.push({ ...p, granted: true, ownerQQ: g.ownerQQ, scopes: g.scopes })
      }
      return out
    }

    /**
     * 群权限以「打印机主人」的偏好为准：绑定 token 的用户 > 模块设置 > 主人。
     * 别人的授权打印机在群里，也按原主人的偏好。
     */
    function groupAccessFor(printer, who, s) {
      const ownerQQ = String(printer && printer.ownerQQ ? printer.ownerQQ : who.userId)
      const prefs = vault.publicPrefs(ownerQQ)
      return { ownerQQ, prefs, mode: effectiveGroupMode(s, prefs), photo: effectiveGroupPhoto(s, prefs) }
    }

    /** 选中打印机之后再判群权限：绑定用户自己的设置 > 模块设置 > 主人。 */
    function ensureControl(printer, who, msg, s) {
      if (msg.kind !== 'group') {
        // 授权来的打印机：发起人是受权者，凭据是绑定者共享的，按「有授权就能控制」判
        if (printer && printer.granted) {
          return Array.isArray(printer.scopes) && printer.scopes.includes('control') ? null : '这个授权没有「控制」范围。'
        }
        // policy 的 normalizeChat 用 String(chat)：传 {kind:'private'} 会被归一成空串，
        // 一律返回「未知的会话类型」→ 自己绑定的用户在私聊里控制/拍照被误拒。必须传字符串。
        const ok = canControl({ chat: 'private', role: roleOf({ userId: who.userId, isOwner: who.isOwner, settings: s }), settings: s }).ok
        return ok ? null : '你没有控制权限。'
      }
      const acc = groupAccessFor(printer, who, s)
      if (acc.mode === 'off') return '这台打印机的主人在群里关掉了控制。'
      if (acc.mode !== 'control') return '这台打印机的主人在群里只允许看状态；要控制请私聊他/她。'
      return null
    }

    function ensureVisible(printer, who, msg, s) {
      if (msg.kind !== 'group') return null
      const acc = groupAccessFor(printer, who, s)
      if (acc.mode === 'off') return '这台打印机的主人在群里关掉了打印机功能。'
      return null
    }

    function ensurePhoto(printer, who, msg, s) {
      if (msg.kind !== 'group') {
        if (printer && printer.granted) {
          return Array.isArray(printer.scopes) && printer.scopes.includes('photo') ? null : '这个授权没有「拍照」范围。'
        }
        return canPhoto({ chat: 'private', role: roleOf({ userId: who.userId, isOwner: who.isOwner, settings: s }), settings: s }).ok ? null : '没有拍照权限。'
      }
      const acc = groupAccessFor(printer, who, s)
      if (acc.mode === 'off') return '这台打印机的主人在群里关掉了打印机功能。'
      if (!acc.photo) return '这台打印机的主人在群里关掉了拍照。'
      return null
    }

    function canUseScope(printer, scope) {
      if (!printer.granted) return true
      return Array.isArray(printer.scopes) && printer.scopes.includes(scope)
    }

    function lockedHint() {
      return '保险箱还锁着：先私聊我「/打印机 解锁 <安全码>」。安全码是唯一钥匙，我、主人也都看不到。'
    }

    function explain(error) {
      const code = error && error.code ? error.code : ''
      const table = {
        NO_USER: '这个 QQ 还没有绑定。',
        EXISTS: '已经绑定过了，用「/打印机 解锁」。',
        BAD_CODE: '安全码不对。',
        LOCKED_OUT: '错太多次了，先等一会儿再试。',
        LOCKED: '保险箱锁着，先解锁。',
        WEAK_CODE: '安全码太弱：至少 8 位，纯数字至少 10 位，别用连续数字。',
        NOT_FOUND: '找不到这条记录。',
        BAD_INPUT: '参数不对。',
        EXPIRED: '已经过期了。',
        TOO_MANY: '绑定数量到上限了。',
        AUTH_FAILED: '账号或密码不对。',
        NO_ACCOUNT: '缺少 Bambu 账号（邮箱或手机号）。',
        NO_PASSWORD: '缺少密码。用 OAuth 注册的账号请先在 Bambu 手机 App 里设置密码。',
        NO_CODE: '缺少验证码。',
        CODE_EXPIRED: '验证码过期了，重新发一次。',
        CODE_INCORRECT: '验证码不对。',
        CODE_FAILED: '验证码登录失败。',
        TFA_FAILED: '两步验证失败。',
        CSRF_FAILED: '拿不到 CSRF token，两步验证做不了，可以改用验证码登录。',
        TOKEN_EXPIRED: '云端 token 已失效，需要重新登录。',
        RATE_LIMITED: '请求太频繁，过一会儿再试。',
        CLOUD_DOWN: 'Bambu 云端暂时不可用。',
        TIMEOUT: '连接超时。',
        NO_TOKEN: '云端没有返回 token。',
        NO_SESSION: '登录会话过期了，请重新登录。',
        NO_FETCH: '当前环境不支持联网。',
      }
      return table[code] || (error && error.message ? String(error.message) : '未知错误')
    }

    function pickSelected(list, who, chatId, selector) {
      if (!list.length) return { ok: false, code: 'NO_PRINTER', message: '你还没绑定打印机。打开面板「拓竹」绑定，或在私聊里发「/打印机」看用法。' }
      const sel = String(selector || '').trim()
      if (sel) {
        const picked = pickPrinter(list, sel)
        if (picked.ok) selections.set(chatId, { ownerQQ: who.userId, ref: picked.printer.ref, at: now() })
        return picked
      }
      const cached = selections.get(chatId)
      const ttl = settings().selectedTtlMinutes * 60000
      if (cached && cached.ownerQQ === who.userId && now() - cached.at < ttl) {
        const found = list.find((p) => p.ref === cached.ref)
        if (found) return { ok: true, printer: found }
      }
      if (list.length === 1) return { ok: true, printer: list[0] }
      const choiceText = '你有多台打印机，先告诉我是哪一台（回编号，之后 ' + settings().selectedTtlMinutes + ' 分钟内不用重复说）：'
      return {
        ok: false,
        code: 'NEED_CHOICE',
        message: choiceText + '\n' + formatChoiceList(list),
        forwardNodes: choiceForwardNodes(list),
        forwardFallback: choiceText + '\n' + formatChoiceList(list),
      }
    }

    /**
     * 我们**第一次看到这台打印机在跑**的时刻（给它算「已打印多久」用）。
     *
     * 只有 RUNNING 才有意义：暂停 / 空闲 / 出错时返回 null 表示「没观测到」。
     * 以前这里返回 0，归一化那边只检查 Number.isFinite，于是 0 被当成 Unix epoch，
     * 暂停中的打印机就会显示「已打印 20770 天」（review 复查的功能问题）。
     */
    function startOf(target, status) {
      const key = keyOf(target)
      if (!status || status.state !== 'RUNNING') {
        // 不在跑就把记录清掉：下次重新开始打印时从那一刻重新计时
        observedStart.delete(key)
        return null
      }
      const stamp = now()
      if (!observedStart.has(key)) observedStart.set(key, stamp)
      const value = observedStart.get(key)
      return Number.isFinite(value) && value > 0 ? value : stamp
    }

    async function fetchStatus(printer, { force = false, reveal = true, chat = null } = {}) {
      const who = chat ? { userId: String(chat.userId || ''), isOwner: chat.isOwner === true } : null
      const target = targetOf(printer, who)
      if (!target.ok) return { ok: false, code: target.code, message: target.message }
      // 首次连局域网：先把打印机自己的自签名证书学下来，之后才真正校验
      if (target.mode === 'lan' && !target.tlsCa) {
        const pinned = await ensureCert(printer, who)
        if (!pinned.ok && pinned.code === 'CERT_CHANGED') {
          const ownerSide = String(printer.ownerQQ || '') === String((who && who.userId) || '')
          return {
            ok: false,
            code: 'CERT_CHANGED',
            message: '这台打印机的证书和上次固定的不一样了：可能是重刷了固件，也可能有人在冒充。' +
              (ownerSide ? '确认是本人操作后，私聊发「/打印机 证书 信任」重新固定。' : '这台打印机的主人也需要先确认：让他私聊发「/打印机 证书 信任」重新固定后再试。'),
          }
        }
      }
      const r = await manager.status(target, { timeoutMs: settings().requestTimeoutMs, force })
      if (!r.ok) return { ok: false, code: r.code || 'OFFLINE', message: '连不上打印机「' + (printer.name || printer.label || '这台') + '」：' + r.error }
      const started = startOf(target, r.status)
      const status = normalizeStatus(r.report || r.status || {}, { observedStart: started })
      if (!status) return { ok: false, code: 'OFFLINE', message: '打印机回了话，但没带状态数据。' }
      // 群内显示文件名的偏好来自「打印机主人」，不是提问者；未解锁也读得到（不是秘密）
      const prefs = vault.publicPrefs(printer.ownerQQ || (chat ? chat.userId : ''))
      const red = chat
        ? redaction({ chat, requesterQQ: chat.userId, ownerQQ: printer.ownerQQ || chat.userId, prefs, settings: settings() })
        : { hideName: !reveal, hideProject: !reveal }
      let text = formatStatus(status, {
        printerName: printer.name || printer.label || '打印机',
        redactName: red.hideName,
        redactProject: red.hideProject,
        stale: r.stale,
        now: now(),
      })
      // 面板/私聊里标出走的哪条通道，方便排查「云端慢还是本地不通」
      if (chat && chat.showTransport === true) text += '\n通道：' + (target.transport === 'cloud' ? '云端接口' : '本地接口')
      return { ok: true, text, status, transport: target.transport, printer: { name: printer.name || '', model: printer.model || '', label: printer.label || '', serialMasked: maskSerial(printer.serial) } }
    }

    /**
     * 拍一张。顺序和切片器一致：
     *   1) 有局域网地址 + 访问码 → 直接走局域网（A1/P1 :6000 MJPEG；X1/H2/P2S :322 RTSPS，需要 ffmpeg）；
     *   2) 局域网不通 / 没有局域网信息 → 用该打印机所属用户的云端 token 铸 ttcode，走 TUTK 云画面，
     *      由本机配置的 TUTK 桥接程序取一帧；
     *   3) 两条都不行 → 如实说明缺什么（token / 桥接程序 / ffmpeg），不假装拍到了。
     *
     * 注：云端 token 与 ttcode 只在本函数局部变量里出现，不写日志、不进错误文本。
     */
    async function snapshotOf(printer, who) {
      const s = settings()
      const ip = String(printer.ip || '').trim()
      const code = String(printer.accessCode || '').trim()
      let lanError = null
      if (ip && code) {
        try {
          // 摄像头也是自签名证书：先用锚点严格校验；没固定过就先学一次。
          // 学不到锚点就**绝不抓拍**（review P1-4）：没有锚点的 MJPEG 连接不校验证书，
          // 认证包里就是访问码，等于把它交给一个可能是 MITM 的对端。
          let anchors = printer.cameraCa ? [printer.cameraCa] : []
          let pinned = anchors.length > 0
          if (!anchors.length && typeof learnCameraCertOf === 'function') {
            const learned = await learnCameraCertOf(printer, who)
            if (learned && learned.ok && learned.pem) {
              anchors = [learned.pem]
              pinned = true
            } else {
              const why = (learned && (learned.error || learned.code)) || '没读到摄像头证书'
              // 云端打印机还能回退 TUTK；纯局域网打印机只能如实失败。
              if (printer.mode !== 'cloud') {
                return { ok: false, code: (learned && learned.code) || 'CAMERA_UNPINNED', message: '摄像头证书没固定，为了不把访问码交给不认识的对端，这次不抓拍：' + why }
              }
              lanError = '摄像头证书没固定：' + why
            }
          }
          if (!pinned) {
            // 走到这里说明是云端打印机且锚点缺失：局域网这条路不安全，直接跳到云端 TUTK。
            throw Object.assign(new Error(lanError || '摄像头证书没固定，跳过局域网抓拍'), { code: 'CAMERA_UNPINNED' })
          }
          // 画面端口有两套证书：A1/P1 的 MJPEG(:6000) 用上面的 anchors；
          // X1/H2/P2S/X2D 的 RTSPS(:322) 是另一个证书，必须单独 pin（见 review 复查 P1）。
          // 没 pin 时 captureRtspsSnapshot 会在 spawn ffmpeg **之前**失败，访问码连 stdin 都没进过。
          const jpeg = await capture({
            host: ip,
            accessCode: code,
            model: printer.model,
            timeoutMs: 15000,
            ca: anchors,
            expectedFingerprint: String(printer.rtspsFingerprint || ''),
            rtspsCa: String(printer.rtspsCa || ''),
          })
          // 第一次用 RTSPS 时把 :322 的指纹固定下来（下次起就是严格比对）
          const shotPin = jpeg && jpeg.fingerprint256
          if (shotPin && !printer.rtspsFingerprint && typeof learnCameraCertOf === 'function') {
            try {
              const ownerQQ = String(printer.ownerQQ || (who && who.userId) || '')
              if (ownerQQ && vault.isUnlocked(ownerQQ)) {
                await vault.setPrinterCert(ownerQQ, { bindingId: printer.bindingId, serial: printer.serial, certPort: 322 }, { pem: jpeg.pem, fingerprint256: shotPin, subject: jpeg.subject, notAfter: jpeg.notAfter }, {})
                printer.rtspsFingerprint = shotPin
                printer.rtspsCa = String(jpeg.pem || '')
                await audit(ownerQQ, 'pin-cert', true, ('rtsps ' + String(shotPin).slice(0, 12)), printer.serial)
              }
            } catch (error) {
              // 固定失败不影响这一张图，只是下次还要重新学
              log.warn('固定 RTSPS 证书失败：' + ((error && error.message) || error))
            }
          }
          return { ok: true, jpeg, note: printer.mode === 'cloud' ? '云端账号的打印机，画面走局域网' : '' }
        } catch (error) {
          lanError = String((error && error.message) || error)
        }
      }

      // ---- 云端 TUTK ----
      if (printer.mode !== 'cloud') {
        return { ok: false, code: 'NO_LAN', message: '局域网拍不了：' + (lanError || '没有可用的地址/访问码') }
      }
      // 抓帧桥：默认用模块自带的（assets/tutk-bridge/），也可在设置里换成自己的
      const bridgePath = String(api.settings().tutkBridgePath || '').trim() || defaultBridgePath(api.dir)
      const libPath = String(api.settings().tutkLibPath || '').trim()
      if (!bridgePath) {
        return {
          ok: false,
          code: 'NO_TUTK_TOOL',
          message: (lanError ? '局域网拍不了（' + lanError + '）。' : '') +
            '云端画面要走 TUTK：模块自带抓帧桥，请在设置里指定它的路径。',
        }
      }
      // 优先用 ref 里已经带出来的 token（授权路径下秘密在授权会话里，不需要本人再解锁）
      let accessToken = String(printer.accessToken || '')
      let tokenRegion = String(printer.region || 'us')
      if (!accessToken) {
        // 自己的绑定：要求本人保险箱已解锁
        const secretOwner = String(printer.ownerQQ || (who && who.userId) || '')
        try {
          const secret = vault.secretOf(secretOwner, printer.bindingId)
          if (secret && secret.mode === 'cloud') { accessToken = secret.accessToken; tokenRegion = secret.region || tokenRegion }
        } catch (error) {
          return { ok: false, code: 'LOCKED', message: '云端画面需要这台打印机的 token：请让绑定者私聊「/打印机 解锁 <安全码>」后再试。' }
        }
      }
      if (!accessToken) {
        return { ok: false, code: 'NO_TOKEN', message: '这台打印机没有云端 token，铸不了云画面凭据。' }
      }
      const minted = await (testHooks.mintTutcode || mintTutcode)({
        accessToken,
        serial: printer.serial,
        region: tokenRegion,
        devVersion: printer.model || '',
        timeoutMs: 12000,
      })
      if (!minted.ok) return { ok: false, code: minted.code, message: '云画面铸码失败：' + minted.error }
      const timeoutMs = Math.min(TUTK_MAX_TIMEOUT_MS, Math.max(3000, Number(s.tutkTimeoutMs) || TUTK_DEFAULT_TIMEOUT_MS))
      const bridgeCheck = await checkBridgeBinary(bridgePath, { libPath })
      const frame = await (testHooks.captureViaBridge || captureViaBridge)({
        url: minted.url,
        bridgePath,
        libPath: libPath || bridgeCheck.libPath || '',
        seconds: Math.max(2, Math.round(timeoutMs / 1000)),
        timeoutMs: timeoutMs + 20000,
      })
      if (!frame.ok) {
        if (frame.code === 'NO_BAMBUSOURCE' || frame.code === 'MISSING') {
          return { ok: false, code: 'NO_BAMBUSOURCE', message: BAMBUSOURCE_ADVICE + '把它放到抓帧桥同目录（' + path.dirname(bridgePath) + '），或在设置里填「BambuSource 库路径」。' }
        }
        return { ok: false, code: frame.code, message: '云画面抓帧失败：' + frame.error }
      }
      return { ok: true, jpeg: frame.jpeg, note: '云端 TUTK 画面（' + (frame.via === 'h264' ? 'H.264' : 'MJPEG') + ' 经 ' + path.basename(bridgePath) + '）' }
    }

    /** 登录成功后的落库：加密保存 token、发现设备。返回发现到的台数与名字（只含名字，不含秘密）。 */
    async function saveCloudLogin (qq, loginResult, accountLabel) {
      const label = 'Bambu 云账号' + (accountLabel ? '（' + String(accountLabel).replace(/[\r\n]/g, '').slice(0, 30) + '）' : '')
      const r = await vault.addBinding(qq, {
        label,
        mode: 'cloud',
        accessToken: loginResult.accessToken,
        uid: loginResult.uid,
        region: loginResult.region || 'us',
      })
      let count = 0
      let names = []
      try {
        const found = await discoverDevices({ accessToken: loginResult.accessToken, uid: loginResult.uid, region: loginResult.region || 'us' })
        if (found.ok && found.devices.length) {
          await vault.setDiscoveredPrinters(qq, r.id, found.devices)
          count = found.devices.length
          names = found.devices.map((d) => d.name || '未命名').slice(0, 5)
        }
      } catch (error) { /* 发现失败不影响登录 */ }
      return { id: r.id, count, names }
    }

    // ---------- 命令分发 ----------
    async function handleCommand(arg, msg) {
      await ready()
      const text = String(arg || '').trim()
      const s = settings()
      const who = senderOf(msg)
      // 免安全码的主人：任何命令进来先无感开一次会话（设了安全码的账号这里什么都不做）
      if (who.isOwner) await ensureOwnerSession()
      // 多用户模式关掉 = 只服务主人一个人：别人连帮助都不给，静默不理
      if (s.multiUser === false && !who.isOwner) return null
      // 总开关关着就什么都不响应，**帮助也不例外**：
      // 关掉的意思是「这个模块现在不工作」，这时候还回一大段帮助会让人以为它是开着的。
      if (!s.enabled) return '拓竹模块没开总开关：让主人在面板「拓竹」里打开。'
      // 帮助分页：默认第 1 页（风险），「/打印机 帮助 2」翻页
      const helpFor = (q, page) => helpPage(page || 1, !!(q && q.isOwner))
      if (!text) return helpFor(who)
      const parts = text.split(/\s+/)
      const head = String(parts[0] || '').toLowerCase()
      const rest = parts.slice(1).join(' ').trim()

      // 帮助走「合并转发」：一整段折叠成一张卡片，不刷屏。
      // markForward 让上层用 onebot 的 forward 接口发；宿主不支持时自动退回普通文本。
      if (/^(帮助|help|用法|命令)$/.test(head)) {
        const page = Number(rest.match(/\d+/)?.[0]) || 1
        return { forwardNodes: helpForwardNodes(!!(who && who.isOwner)), fallback: helpFor(who, page) }
      }

      // 敏感操作只认私聊：先于任何绑定/白名单判断，免得群里给出「你还没绑定」这种误导。
      if (msg.kind !== 'private' && /^(设置安全码|设安全码|register|改安全码|改码|changecode|解锁|unlock|登录|登陆|login|验证码|code|两步验证|2fa|tfa|绑定|添加|bind|解绑|取消绑定|unbind|同步|刷新|sync|授权|grant|撤销|revoke|群权限|群设置|groupperm|接口|interface|通道|证书|cert|锁定|lock)$/.test(head)) {
        return '这个操作只能在私聊里做：群里发安全码、访问码会被所有人看到。'
      }

      const g = gate(msg)
      if (!g.ok) return g.reason

      if (/^(列表|绑定列表|我的)$/.test(head)) {
        const list = listOf(who.userId)
        if (!list.length) return '你还没绑定打印机。打开面板「拓竹」→ 绑定。'
        return '你的打印机：\n' + formatChoiceList(list) + '\n\n用「/打印机 状态 1」这样带编号或名字。'
      }

      if (/^(解锁|unlock)$/.test(head)) {
        if (msg.kind !== 'private') return '安全码只能在私聊里发，群里发我也不会用。'
        const code = rest
        if (!code) return '用法：/打印机 解锁 <安全码>（第一次绑定安全码时设的）'
        try {
          applyLockMinutes()
          const r = await vault.unlock(who.userId, code)
          await audit(who.userId, 'unlock', true, '', who.userId)
          return '已解锁，有效期 ' + lockSpanText(r.until - now()) + '。'
        } catch (error) {
          await audit(who.userId, 'unlock', false, error.code || 'BAD_CODE')
          return '解锁失败：' + explain(error)
        }
      }

      if (/^(锁定|lock)$/.test(head)) {
        vault.lock(who.userId)
        await audit(who.userId, 'lock', true)
        return '已锁定，本机内存里的密钥清掉了。'
      }

      if (/^(设置安全码|设安全码|register)$/.test(head)) {
        if (msg.kind !== 'private') return '安全码只能在私聊里设置，群里发我也不会用。'
        if (!rest) return '用法：/打印机 设置安全码 <至少 8 位，纯数字至少 10 位>'
        try {
          if (vault.hasUser(who.userId)) return '你已经设过安全码了。要换用「/打印机 改安全码 <旧> <新>」；忘了只能让主人清空你的数据重来。'
          applyLockMinutes()
          await vault.register(who.userId, rest)
          const r = await vault.unlock(who.userId, rest)
          await audit(who.userId, 'register', true)
          return '好了，安全码已设置并解锁 ' + lockSpanText(r.until - now()) + '。\n' +
            '这个安全码是你全部打印机秘密的唯一钥匙：我、主人都看不到，忘了只能清空重绑。\n' +
            '下一步：/打印机 登录 <Bambu 账号> <密码>'
        } catch (error) {
          await audit(who.userId, 'register', false, error.code || 'BAD_INPUT')
          return '设置失败：' + explain(error)
        }
      }

      if (/^(改安全码|改码|changecode)$/.test(head)) {
        if (msg.kind !== 'private') return '只能在私聊里改安全码。'
        const [oldCode, newCode] = rest.split(/\s+/)
        if (!oldCode || !newCode) return '用法：/打印机 改安全码 <旧安全码> <新安全码>'
        try {
          await vault.changeCode(who.userId, oldCode, newCode)
          await audit(who.userId, 'changecode', true)
          return '安全码已更换（绑定数据不用重绑）。'
        } catch (error) {
          await audit(who.userId, 'changecode', false, error.code || 'BAD_CODE')
          return '更换失败：' + explain(error)
        }
      }

      if (/^(登录|登陆|login)$/.test(head)) {
        if (msg.kind !== 'private') return '登录只能在私聊里做：账号密码不能发到群里。'
        const parts2 = rest.split(/\s+/)
        const account = parts2[0] || ''
        const password = parts2.slice(1).join(' ')
        if (!account) {
          const pending = pendingLogins.get(who.userId)
          return [
            '用 Bambu 账号登录（和 ha-bambulab 的流程一致）：',
            '1) /打印机 登录 <账号> <密码> —— 账号是邮箱或手机号',
            '2) 如果云端要求验证码：/打印机 验证码 —— 先让云端发码，再 /打印机 验证码 <6位>',
            '3) 如果要求两步验证：/打印机 两步验证 <码>',
            '',
            '注意：用 OAuth（Google/Apple 等）注册的账号，需要先在 Bambu 手机 App 里设置密码（Account Security → Change Password），之后才能用账号+密码登录。',
            pending ? '（你有一个登录会话在等：' + pending.need + '，5 分钟内有效）' : '',
          ].filter(Boolean).join('\n')
        }
        const region = Object.hasOwn(REGIONS, String(parts2[parts2.length - 1])) ? String(parts2.pop()) : 'us'
        // region 可能在末尾，重新算密码
        const pass = parts2.slice(1).join(' ')
        try {
          const session = (testHooks.createCloudLogin || createCloudLogin)({ account, password: pass || password, region: region })
          const r = await session.login()
          if (r.ok) {
            pendingLogins.delete(who.userId)
            const saved = await saveCloudLogin(who.userId, r, account)
            await audit(who.userId, 'login', true, 'cloud')
            return '登录成功，云端 token 已加密保存' + (saved.count ? '，发现 ' + saved.count + ' 台打印机：' + saved.names.join('、') : '；账号下暂时没发现打印机，可稍后 /打印机 同步') + '。'
          }
          if (r.need === 'code') {
            pendingLogins.set(who.userId, { session, account, region, until: now() + LOGIN_TTL_MS, need: '验证码' })
            await audit(who.userId, 'login', false, 'need-code')
            return '云端要求验证码。发「/打印机 验证码」让我请求验证码，然后「/打印机 验证码 <6位>」提交（5 分钟内有效）。'
          }
          if (r.need === 'tfa') {
            pendingLogins.set(who.userId, { session, account, region, until: now() + LOGIN_TTL_MS, need: '两步验证' })
            await audit(who.userId, 'login', false, 'need-tfa')
            return '云端要求两步验证。请在验证器里看 6 位码，发「/打印机 两步验证 <6位>」（5 分钟内有效）。'
          }
          return '登录没完成：云端返回了不认识的响应。'
        } catch (error) {
          await audit(who.userId, 'login', false, error.code || 'AUTH_FAILED')
          return '登录失败：' + explain(error)
        }
      }

      if (/^(验证码|code)$/.test(head)) {
        if (msg.kind !== 'private') return '验证码只能在私聊里发。'
        const pending = pendingLogins.get(who.userId)
        if (!pending || pending.until < now()) {
          pendingLogins.delete(who.userId)
          return '没有等待中的登录，或者已经超过 5 分钟。请重新「/打印机 登录 <账号> <密码>」。'
        }
        const code = rest.replace(/\s+/g, '')
        try {
          if (!code) {
            const r = await pending.session.requestCode()
            await audit(who.userId, 'login-code', true, r.channel)
            return '验证码已发送到你账号的' + (r.channel === 'email' ? '邮箱' : '手机') + '。收到后发「/打印机 验证码 <数字>」。'
          }
          const r = await pending.session.submitCode(code)
          pendingLogins.delete(who.userId)
          const saved = await saveCloudLogin(who.userId, r, pending.account)
          await audit(who.userId, 'login', true, 'code')
          return '验证码通过，登录成功，token 已加密保存' + (saved.count ? '，发现 ' + saved.count + ' 台打印机：' + saved.names.join('、') : '') + '。'
        } catch (error) {
          await audit(who.userId, 'login-code', false, error.code || 'CODE_FAILED')
          return '验证码登录失败：' + explain(error)
        }
      }

      if (/^(两步验证|2fa|tfa)$/.test(head)) {
        if (msg.kind !== 'private') return '两步验证码只能在私聊里发。'
        const pending = pendingLogins.get(who.userId)
        if (!pending || pending.until < now()) {
          pendingLogins.delete(who.userId)
          return '没有等待中的两步验证，或者已经超过 5 分钟。请重新登录。'
        }
        try {
          const r = await pending.session.submitTfa(rest)
          pendingLogins.delete(who.userId)
          const saved = await saveCloudLogin(who.userId, r, pending.account)
          await audit(who.userId, 'login', true, 'tfa')
          return '两步验证通过，登录成功，token 已加密保存' + (saved.count ? '，发现 ' + saved.count + ' 台打印机：' + saved.names.join('、') : '') + '。'
        } catch (error) {
          await audit(who.userId, 'login-2fa', false, error.code || 'TFA_FAILED')
          return '两步验证失败：' + explain(error)
        }
      }

      if (/^(绑定|添加|bind)$/.test(head)) {
        if (msg.kind !== 'private') return '绑定只能在私聊里做。'
        if (!who.isOwner) {
          return '绑定打印机请用「/打印机 登录 <Bambu 账号> <密码>」：登录成功后账号下的打印机会自动同步，token 会加密保存。'
        }
        if (!rest) {
          const list = vault.listBindings(who.userId)
          return [
            '绑定（主人可用局域网；其他人用云端登录）：',
            '· 云端登录：/打印机 登录 <账号> <密码>',
            '· 本地（仅主人）：/打印机 绑定 本地 <序列号> <打印机IP> <访问码> [名称]',
            '· 追加（仅主人）：/打印机 绑定 追加 <序列号> <打印机IP> [访问码] [名称]',
            '· 看/解绑：/打印机 列表、/打印机 解绑 <编号>',
            '',
            list.length ? '你现在有 ' + list.length + ' 条凭据：\n' + list.map((b, i) => (i + 1) + '. ' + b.label + '（' + (b.mode === 'cloud' ? '云端' : '本地') + '，' + b.printers.length + ' 台）').join('\n') : '还没有绑定。',
          ].join('\n')
        }
        if (!vault.isUnlocked(who.userId)) return lockedHint()
        const p = rest.split(/\s+/)
        const sub = String(p[0] || '').toLowerCase()
        try {
          if (sub === '云端' || sub === 'cloud') return '云端请用账号登录：/打印机 登录 <账号> <密码>（不再手填 access token）。'
          const append = sub === '追加' || sub === 'add'
          const seq = p[1] || ''
          const ip = p[2] || ''
          const code = p[3] || ''
          const name = p.slice(4).join(' ')
          if (!seq || !/^\d{1,3}(\.\d{1,3}){3}$/.test(String(ip))) {
            return '用法：/打印机 绑定 本地 <序列号> <打印机IP> <访问码> [名称]'
          }
          if (!append && !code) {
            return '本地绑定要带访问码（打印机屏幕上「局域网访问码」）。'
          }
          const printer = { serial: seq, ip, name: name || seq.slice(-6), ...(code ? { accessCode: code } : {}) }
          if (append) {
            const lan = vault.listBindings(who.userId).filter((b) => b.mode === 'lan').pop()
            if (!lan) {
              return '还没有本地凭据可以追加：先发「/打印机 绑定 本地 <序列号> <IP> <访问码>」。'
            }
            const existing = vault.printers(who.userId).filter((x) => x.bindingId === lan.id)
              .map((x) => ({ serial: x.serial, ip: x.ip, name: x.name, model: x.model }))
            await vault.setDiscoveredPrinters(who.userId, lan.id, [...existing, printer])
            await audit(who.userId, 'bind', true, 'lan+', lan.id)
            return '已把这台加进「' + lan.label + '」，现在共 ' + (existing.length + 1) + ' 台。'
          }
          const r = await vault.addBinding(who.userId, { label: '我的打印机', mode: 'lan', accessCode: code, printers: [printer] })
          await audit(who.userId, 'bind', true, 'lan', r.id)
          return '本地凭据已加密保存。下一步：/打印机 状态'
        } catch (error) {
          await audit(who.userId, 'bind', false, error.code || 'BAD_INPUT')
          return '绑定失败：' + explain(error)
        }
      }

      if (/^(解绑|取消绑定|unbind)$/.test(head)) {
        if (msg.kind !== 'private') return '解绑只能在私聊里做。'
        if (!vault.isUnlocked(who.userId)) return lockedHint()
        const n = Number(rest)
        const list = vault.listBindings(who.userId)
        if (!Number.isInteger(n) || n < 1 || n > list.length) return '用法：/打印机 解绑 <编号>；先用 /打印机 列表 看编号。'
        try {
          await vault.removeBinding(who.userId, list[n - 1].id)
          await audit(who.userId, 'unbind', true, '', list[n - 1].id)
          return '已解绑「' + list[n - 1].label + '」。'
        } catch (error) {
          return '解绑失败：' + explain(error)
        }
      }

      if (/^(同步|刷新|sync)$/.test(head)) {
        if (!vault.isUnlocked(who.userId)) return lockedHint()
        const list = vault.listBindings(who.userId).filter((b) => b.mode === 'cloud')
        if (!list.length) return '没有云端凭据可同步；本地凭据不用同步。'
        const lines = []
        for (const b of list) {
          const secret = vault.secretOf(who.userId, b.id)
          const found = await discoverDevices({ accessToken: secret.accessToken, uid: secret.uid, region: secret.region })
          if (found.ok) {
            await vault.setDiscoveredPrinters(who.userId, b.id, found.devices)
            lines.push('· ' + b.label + '：' + found.devices.length + ' 台' + (found.devices.length ? '（' + found.devices.map((d) => d.name || '未命名').join('、') + '）' : ''))
          } else {
            lines.push('· ' + b.label + '：拉取失败（' + found.error + '）')
          }
        }
        await audit(who.userId, 'sync', true, String(list.length))
        return '云端设备已同步：\n' + lines.join('\n')
      }

      if (/^(状态|status|进度)$/.test(head)) {
        const list = listOf(who.userId)
        const picked = pickSelected(list, who, msg.chatId, rest)
        if (!picked.ok) return needsChoice(picked)
        const hidden = ensureVisible(picked.printer, who, msg, s)
        if (hidden) return hidden
        if (!canUseScope(picked.printer, 'status')) return '这个授权没有「查看」范围。'
        if (!picked.printer.granted && !vault.isUnlocked(who.userId)) return lockedHint()
        const r = await fetchStatus(picked.printer, { reveal: g.isPrivate, chat: { ...msg, isOwner: who.isOwner } })
        await audit(who.userId, 'status', r.ok, r.ok ? '' : r.code, picked.printer.ref)
        return r.ok ? r.text : r.message
      }

      if (/^(暂停|pause|继续|恢复|resume|停止|取消|stop)$/.test(head)) {
        const action = /^(暂停|pause)$/.test(head) ? 'pause' : /^(继续|恢复|resume)$/.test(head) ? 'resume' : 'stop'
        const list = listOf(who.userId)
        const confirm = /确认|confirm/i.test(rest)
        const selector = rest.replace(/确认|confirm/gi, '').trim()
        const picked = pickSelected(list, who, msg.chatId, selector)
        if (!picked.ok) return needsChoice(picked)
        const denied = ensureControl(picked.printer, who, msg, s)
        if (denied) return denied
        if (!canUseScope(picked.printer, 'control')) return '这个授权没有「控制」范围。'
        if (!picked.printer.granted && !vault.isUnlocked(who.userId)) return lockedHint()
        if (action === 'stop') {
          const key = who.userId + '|' + picked.printer.ref
          const until = pendingStop.get(key) || 0
          if (!confirm) {
            pendingStop.set(key, now() + 60000)
            return '停止是不可撤销的：确实要停，1 分钟内再发「/打印机 停止 ' + (picked.printer.index || picked.printer.name || '1') + ' 确认」。'
          }
          if (until < now()) {
            pendingStop.delete(key)
            return '先发一次「/打印机 停止」确认要停哪一台，再回「确认」；直接说确认不算。'
          }
          pendingStop.delete(key)
        }
        const r = await doCommand(picked.printer, who, action)
        await audit(who.userId, action, r.ok, r.ok ? '' : r.error, picked.printer.ref)
        return r.ok
          ? ({ pause: '已暂停。', resume: '继续打印。', stop: '已下发停止。' })[action] + (r.acked ? '' : '（打印机没回执，稍后看状态确认）')
          : '操作失败：' + r.error
      }

      if (/^(灯|light)$/.test(head)) {
        const on = /^(开|打开|on|亮)$/i.test(rest.split(/\s+/)[0] || '')
        const off = /^(关|关闭|off|灭)$/i.test(rest.split(/\s+/)[0] || '')
        if (!on && !off) return '用法：/打印机 灯 开|关 [打印机]'
        const picked = pickSelected(listOf(who.userId), who, msg.chatId, parts.slice(2).join(' '))
        if (!picked.ok) return needsChoice(picked)
        const denied = ensureControl(picked.printer, who, msg, s)
        if (denied) return denied
        if (!canUseScope(picked.printer, 'control')) return '这个授权没有「控制」范围。'
        const r = await doCommand(picked.printer, who, 'light', { on })
        await audit(who.userId, 'light', r.ok, on ? 'on' : 'off', picked.printer.ref)
        return r.ok ? '打印仓灯已' + (on ? '打开' : '关闭') + (r.acked ? '' : '（没回执，稍后看状态）') : '操作失败：' + r.error
      }

      if (/^(速度|speed)$/.test(head)) {
        const level = Number((rest.split(/\s+/)[0] || '').replace(/[^0-9]/g, ''))
        if (!(level >= 1 && level <= 4)) return '速度是 1~4（1 最慢、4 最快），比如「/打印机 速度 2」。'
        const picked = pickSelected(listOf(who.userId), who, msg.chatId, parts.slice(2).join(' '))
        if (!picked.ok) return needsChoice(picked)
        const denied = ensureControl(picked.printer, who, msg, s)
        if (denied) return denied
        if (!canUseScope(picked.printer, 'control')) return '这个授权没有「控制」范围。'
        const r = await doCommand(picked.printer, who, 'speed', { level })
        await audit(who.userId, 'speed', r.ok, String(level), picked.printer.ref)
        return r.ok ? '速度已切到 ' + level + ' 档。' + (r.acked ? '' : '（没回执，稍后看状态）') : '操作失败：' + r.error
      }

      if (/^(温度|temp|temperature)$/.test(head)) {
        const nozzle = rest.match(/(?:喷嘴|nozzle|喷头)\s*[=:：]?\s*(\d{2,3})/i)
        const bed = rest.match(/(?:热床|bed)\s*[=:：]?\s*(\d{1,3})/i)
        if (!nozzle && !bed) return '用法：/打印机 温度 喷嘴=220 热床=60（至少给一个；0 表示关加热）'
        const picked = pickSelected(listOf(who.userId), who, msg.chatId, rest.replace(/\S*[=:：]\s*\d+/g, '').trim())
        if (!picked.ok) return needsChoice(picked)
        const denied = ensureControl(picked.printer, who, msg, s)
        if (denied) return denied
        if (!canUseScope(picked.printer, 'control')) return '这个授权没有「控制」范围。'
        const params = { nozzle: nozzle ? Number(nozzle[1]) : undefined, bed: bed ? Number(bed[1]) : undefined }
        if (params.nozzle > 300 || params.bed > 120) return '温度超出范围（喷嘴 0~300、热床 0~120）。'
        const r = await doCommand(picked.printer, who, 'temperature', params)
        await audit(who.userId, 'temperature', r.ok, JSON.stringify(params), picked.printer.ref)
        return r.ok ? '温度已下发。' + (r.acked ? '' : '（没回执，稍后看状态）') : '操作失败：' + r.error
      }

      if (/^(拍照|图片|照片|photo|snapshot)$/.test(head)) {
        const picked = pickSelected(listOf(who.userId), who, msg.chatId, rest)
        if (!picked.ok) return needsChoice(picked)
        const denied = ensurePhoto(picked.printer, who, msg, s)
        if (denied) return denied
        if (!canUseScope(picked.printer, 'photo')) return '这个授权没有「拍照」范围。'
        if (!picked.printer.granted && !vault.isUnlocked(who.userId)) return lockedHint()
        const shot = await snapshotOf(picked.printer, who)
        await audit(who.userId, 'photo', shot.ok, shot.ok ? shot.note : shot.code, picked.printer.ref)
        if (!shot.ok) return '拍照失败：' + shot.message
        return { image: shot.jpeg, caption: '📷 ' + (picked.printer.name || '打印机') + ' 当前画面' + (shot.note ? '（' + shot.note + '）' : '') }
      }

      if (/^(授权|grant)$/.test(head)) {
        if (msg.kind !== 'private') return '授权只能在私聊里做。'
        if (!vault.isUnlocked(who.userId)) return lockedHint()
        const pieces = rest.split(/\s+/)
        const adminQQ = pieces[0] || ''
        if (!/^\d{4,15}$/.test(adminQQ)) return '用法：/打印机 授权 <对方QQ> [分钟] [status,control,photo]'
        if (adminQQ === who.userId) return '不用授权给自己 —— 这些打印机本来就是你绑定的。'
        const minutes = parseMinutes(pieces[1], 30, 1440)
        const scopes = String(pieces[2] || 'status,control').split(/[,，\s]+/).filter((x) => Object.hasOwn({ status: 1, control: 1, photo: 1 }, x))
        if (!scopes.length) return '范围只能是 status / control / photo。'
        try {
          const r = await vault.createGrant({ ownerQQ: who.userId, granteeQQ: adminQQ, bindingIds: [], scopes, minutes })
          await audit(who.userId, 'grant', true, 'to ' + maskQQ(adminQQ) + ' ' + scopes.join(','), r.grantId)
          const list = listOf(who.userId).filter((p) => !p.granted)
          const until = new Date(r.expiresAt).toLocaleString('zh-CN', { hour12: false })
          return [
            '已授权给 ' + maskQQ(adminQQ) + '（立即生效）：对方现在就能用**你自己的 Bambu 凭据**查看/管理你的打印机。',
            '  · 范围：' + scopes.join('、') + '（' + (scopes.includes('control') ? '可暂停/停止/改温度/灯光/速度' : '只能看，不能动') + '）',
            '  · 涉及 ' + (list.length || 1) + ' 台：' + (list.map((p) => p.name || p.serial).slice(0, 5).join('、') || '你当前绑定的打印机'),
            '  · 有效期：到 ' + until + ' 自动失效；随时可以「/打印机 撤销 ' + r.grantId + '」',
            '',
            '对方能看到状态里的文件信息，也能像你一样操作这些打印机；但**拿不到你的安全码**，也碰不到你没授权的绑定。',
            '注意：共享期间你要保持解锁（凭据只从你的保险箱里现解，不另存副本）。',
          ].join('\n')
        } catch (error) {
          return '生成授权失败：' + explain(error)
        }
      }

      if (/^(撤销|revoke)$/.test(head)) {
        if (msg.kind !== 'private') return '撤销只能在私聊里做。'
        if (!rest) return '用法：/打印机 撤销 <授权编号>；用「/打印机 审计」能看编号。'
        try {
          await vault.revokeGrant({ byQQ: who.userId, grantId: rest })
          await audit(who.userId, 'revoke', true, '', rest)
          return '已撤销。'
        } catch (error) {
          return '撤销失败：' + explain(error)
        }
      }

      if (/^(群权限|群设置|groupperm)$/.test(head)) {
        if (msg.kind !== 'private') return '群权限只能私聊调；群里发我不动。'
        const raw = rest.trim().toLowerCase()
        const cur = vault.publicPrefs(who.userId)
        if (!raw) {
          return [
            '你对「自己的」打印机在群里的权限（绑定 token 的用户有最高决定权）：',
            '· 群聊模式：' + ({ off: '不响应', status: '只读状态', control: '允许控制', '': '跟随模块设置（' + ({ off: '不响应', status: '只读状态', control: '允许控制' })[s.groupMode] + '）' })[cur.groupMode] || cur.groupMode,
            '· 群内拍照：' + (cur.groupPhoto === null ? '跟随模块设置（' + (s.groupPhoto ? '允许' : '不允') + '）' : cur.groupPhoto ? '允许' : '不允许'),
            '· 群内显示文件名：' + (cur.groupShowName ? '显示（还需模块总开关允许）' : '不显示'),
            '用法：/打印机 群权限 只读 | 控制 | 关闭 | 跟随；/打印机 群权限 拍照 开|关|跟随；/打印机 群权限 文件名 开|关',
          ].join('\n')
        }
        const pieces = raw.split(/\s+/)
        try {
          if (/^(拍照|photo)$/.test(pieces[0])) {
            const v = pieces[1] || ''
            const value = /^(开|on|允许|1)$/i.test(v) ? true : /^(关|off|不|0)$/i.test(v) ? false : null
            if (value === null) return '用法：/打印机 群权限 拍照 开|关|跟随'
            const r = await vault.setPrefs(who.userId, { groupPhoto: v === '跟随' ? null : value })
            await audit(who.userId, 'groupperm', true, 'photo=' + value)
            return '群内拍照已设为：' + (v === '跟随' ? '跟随模块设置' : value ? '允许' : '不允许') + '。'
          }
          if (/^(文件名|name)$/.test(pieces[0])) {
            const value = /^(开|on|显示|1)$/i.test(pieces[1] || '')
            const r = await vault.setPrefs(who.userId, { groupShowName: value })
            await audit(who.userId, 'groupperm', true, 'name=' + value)
            return '群内' + (value ? '会显示' : '不显示') + '你打印的文件名（还要模块设置也允许才生效；项目名永远不显示）。'
          }
          const v = pieces[0]
          const mode = /^(只读|status)$/.test(v) ? 'status' : /^(控制|control)$/.test(v) ? 'control' : /^(关闭|off|不响应)$/.test(v) ? 'off' : /^(跟随|默认|follow)$/.test(v) ? '' : null
          if (mode === null) return '用法：/打印机 群权限 只读 | 控制 | 关闭 | 跟随'
          await vault.setPrefs(who.userId, { groupMode: mode })
          await audit(who.userId, 'groupperm', true, 'mode=' + (mode || 'follow'))
          return '你的打印机在群里的权限已改为：' + ({ off: '不响应', status: '只读状态', control: '允许控制', '': '跟随模块设置' })[mode] + '。'
        } catch (error) {
          return '设置失败：' + explain(error)
        }
      }

      if (/^(接口|interface|通道)$/.test(head)) {
        if (msg.kind !== 'private') return '接口切换只能在私聊里做。'
        const raw = rest.trim().toLowerCase()
        if (!raw) {
          const p = vault.publicPrefs(who.userId)
          const def = who.isOwner ? s.defaultInterface : 'cloud'
          const cur = p.interface || '跟随全局'
          return '当前接口：' + ({ cloud: '云端', lan: '本地', '': '跟随全局（' + (def === 'lan' ? '本地' : '云端') + '）' }[p.interface] || cur) + '\n用法：/打印机 接口 云端 | 本地 | 自动（auto 有云端凭据就云端，否则本地）'
        }
        const value = /云端|cloud/.test(raw) ? 'cloud' : /自动|auto/.test(raw) ? 'auto' : /本地|局域网|lan/.test(raw) ? 'lan' : null
        if (value === null) return '接口只能是「云端」「本地」或「自动」。'
        if (value === 'lan' && !who.isOwner) return '只有主人可以切到本地接口；你默认走云端。'
        if (value === 'lan' && !s.ownerLocalAllowed) return '主人已经把本地接口关掉了（settings.ownerLocalAllowed）。'
        try {
          const r = await vault.setPrefs(who.userId, { interface: value })
          await audit(who.userId, 'interface', true, value)
          return '已切到' + ({ cloud: '云端接口', lan: '本地接口', auto: '自动选择' }[value]) + '。'
        } catch (error) {
          return '切换失败：' + explain(error)
        }
      }

      if (/^(证书|证书固定|信任|cert)$/.test(head)) {
        // 局域网只给主人：证书固定 / 重新固定也只给主人，其他人连这条命令都不存在
        if (!who.isOwner) return '证书操作只提供给主人；其他用户的打印机走云端接口，不需要处理本地证书。'
        if (msg.kind !== 'private') return '证书操作只能在私聊里做。'
        const act = rest.trim().toLowerCase()
        const refs = vault.printers(who.userId)
        if (!refs.length) return '你还没有绑定打印机。'
        const pick = /^[\d]+$/.test(act) ? refs[Number(act) - 1] : refs[0]
        if (!pick) return '没有第 ' + act + ' 台打印机。'
        if (pick.mode !== 'lan') return '只有局域网连接才有打印机证书；这台走云端。'
        if (/^(信任|确认|重新|重新固定|trust)$/.test(act)) {
          const learned = await ensureCert(pick, who, { force: true })
          if (learned.ok) {
            return '已重新固定「' + (pick.name || pick.serial) + '」的证书：' + String(learned.fingerprint256 || '').slice(0, 16) + '…\n以后每次连接都会校验它，证书再变就会拒绝。'
          }
          return '重新固定失败：' + (learned.error || learned.code || '未知原因')
        }
        const fp = String(pick.tlsFingerprint || '')
        const cam = String(pick.cameraFingerprint || '')
        const rtsps = String(pick.rtspsFingerprint || '')
        return '「' + (pick.name || pick.serial) + '」的证书\n' +
          '局域网（8883）：' + (fp ? prettyFingerprint(fp) : '还没固定（下次连接会自动学习）') + '\n' +
          '摄像头（6000）：' + (cam ? prettyFingerprint(cam) : '还没固定（第一次拍照时会自动学习）') + '\n' +
          '画面（322）：' + (rtsps ? prettyFingerprint(rtsps) : '还没固定（第一次抓 X1 系列画面时会自动学习）') + '\n' +
          '确认打印机换了固件 / 换了机器，再发「/打印机 证书 信任」重新固定。'
      }

      if (/^(审计|日志|audit)$/.test(head)) {
        const limit = Math.min(50, Math.max(1, Number(rest) || 10))
        const list = vault.auditList(limit).filter((x) => String(x.actor) === who.userId)
        if (!list.length) return '没有你的操作记录。'
        return '最近的记录：\n' + list.map((x) => new Date(x.at).toLocaleString('zh-CN', { hour12: false }) + ' · ' + x.action + ' · ' + (x.ok ? '成功' : '失败') + (x.note ? ' · ' + x.note : '')).join('\n')
      }

      return '没听懂这个操作。\n' + helpFor(who, 3)
    }

    // ---------- 入口：命令 + 消息 + 群里的选择 ----------
    /**
     * 打印机没选定的统一出口：把 NEED_CHOICE 的合并转发一起带上去。
     * 这样「/打印机 状态」遇到多台时会用合并转发列出每一台，而不是刷一坨纯文本。
     */
    function needsChoice (picked) {
      if (picked && Array.isArray(picked.forwardNodes) && picked.forwardNodes.length) {
        return { forwardNodes: picked.forwardNodes, fallback: String(picked.forwardFallback || picked.message || '') }
      }
      return String((picked && picked.message) || '')
    }

    /**
     * 发一条回复。三种形态：
     *   { image }                         → 发图
     *   { forwardNodes, fallback }        → 合并转发（发不出去就退回 fallback 文本）
     *   字符串                            → 普通文本
     */
    async function replyWith(msg, reply) {
      if (!reply) return
      if (reply && reply.image) {
        await api.sendImage(msg.chatId, 'base64://' + reply.image.toString('base64'))
        if (reply.caption) await api.reply(msg, reply.caption)
        return
      }
      if (reply && Array.isArray(reply.forwardNodes) && reply.forwardNodes.length) {
        const sent = await sendForward(msg, reply.forwardNodes)
        if (sent) return
        // 合并转发不被支持（老宿主 / 权限不足）：退回分页文本，至少内容还在
        await api.reply(msg, String(reply.fallback || ''))
        return
      }
      await api.reply(msg, String(reply))
    }

    /**
     * 用合并转发发一组节点。
     * 群聊优先 send_group_forward_msg，私聊用 send_private_forward_msg；
     * 两个都失败再试通用的 send_forward_msg。全都失败返回 false（调用方回退文本）。
     */
    async function sendForward(msg, nodes) {
      const payload = { messages: nodes }
      const isGroup = msg && msg.kind === 'group'
      const groupId = String((msg && msg.groupId) || '')
      const userId = String((msg && msg.userId) || '')
      const attempts = []
      if (isGroup && groupId) attempts.push(['send_group_forward_msg', { ...payload, group_id: groupId }])
      if (!isGroup && userId) attempts.push(['send_private_forward_msg', { ...payload, user_id: userId }])
      // 通用兜底：有的实现只认 send_forward_msg
      attempts.push(['send_forward_msg', isGroup ? { ...payload, group_id: groupId } : { ...payload, user_id: userId }])
      for (const [action, params] of attempts) {
        try {
          await api.onebot(action, params, { timeoutMs: 10000 })
          return true
        } catch (error) {
          log.debug && log.debug('[bambu] ' + action + ' 失败：' + ((error && error.message) || error))
        }
      }
      return false
    }

    api.on('message', async (msg) => {
      const s = settings()
      if (!s.enabled) return false
      const text = String(msg.text || '').trim()
      if (!text) return false
      await ready()
      const who = senderOf(msg)

      // 明确命令先处理：新用户还没绑定，也要能用「设置安全码 / 绑定」
      const cmd = text.match(/^[/／]\s*打印机\s*([\s\S]*)$/)
      if (cmd) {
        await replyWith(msg, await handleCommand(cmd[1], msg))
        return true
      }

      const g = gate(msg)
      if (!g.ok) return false
      // 限流只防刷屏，不参与安全判定
      const limit = limiter.hit('cmd:' + who.userId, 20, 60000)
      if (!limit.ok) {
        await api.reply(msg, '慢一点，一分钟 20 次够了（还剩 ' + Math.ceil(limit.retryMs / 1000) + ' 秒解禁）。')
        return true
      }
      const list = listOf(who.userId)
      if (!list.length) return false
      if (!/打印机|3d打印|打印(进度|状态|到哪|完了|好了|失败了)/i.test(text)) return false
      const intent = detectIntent(text)
      if (!intent) return false
      await replyWith(msg, await handleCommand(intent, msg))
      return true
    })

    // 多台打印机时，用户回「1」或「第二台」把选择补完
    api.on('message', async (msg) => {
      const s = settings()
      if (!s.enabled) return false
      const text = String(msg.text || '').trim()
      if (!/^(#?\d{1,2}|第\s*[一二三四五六七八九十\d]+\s*台?|它|这台|那台)$/.test(text)) return false
      await ready()
      const g = gate(msg)
      if (!g.ok) return false
      const who = senderOf(msg)
      const list = listOf(who.userId)
      if (!list.length) return false
      let ref = ''
      const n = text.match(/^#?(\d{1,2})$/)
      if (n) {
        const idx = Number(n[1])
        if (idx >= 1 && idx <= list.length) ref = list[idx - 1].ref
      } else {
        const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
        const m = text.match(/第\s*([一二三四五六七八九十\d]+)/)
        const idx = m ? (cn[m[1]] || Number(m[1])) : 0
        if (idx >= 1 && idx <= list.length) ref = list[idx - 1].ref
      }
      if (!ref) return false
      selections.set(msg.chatId, { ownerQQ: who.userId, ref, at: now() })
      const printer = list.find((p) => p.ref === ref)
      const r = await fetchStatus(printer, { reveal: g.isPrivate, chat: { ...msg, isOwner: who.isOwner } })
      await api.reply(msg, r.ok ? r.text : r.message)
      return true
    })

    // ---------- 给她的工具 ----------
    api.tool(({ chat }) => {
      if (chat.kind === 'system') return []
      const s = settings()
      if (!s.enabled) return []
      const userId = String(chat.userId || '')
      if (!userId) return []
      // P1-1：群白名单先挡住，再看模块自身的开关/绑定/群模式（不能靠工具路径绕过 allow.groups）
      if (chat.kind === 'group' && !groupAllowed(chat)) return []
      const isOwner = api.isOwner(userId)
      // 单用户模式：别人连工具都不给（否则能绕过命令入口直接操作）
      if (s.multiUser === false && !isOwner) return []
      if (chat.kind === 'group' && groupMode(s) === 'off' && !hasUsable(userId)) return []
      if (chat.kind === 'private' && !isOwner && !s.users.includes(userId)) return []
      if (!hasUsable(userId)) return []
      const list = listOf(userId)
      if (!list.length) return []
      const names = list.map((p) => p.name || p.label || p.ref).slice(0, 5).join('、')
      return api.defineTool({
        name: 'bambu_printer',
        description: '查看/控制用户自己的拓竹 3D 打印机（' + names + '）。只能操作该用户自己绑定的打印机；别人的打印机需要对方先授权。',
        properties: {
          action: { type: 'string', enum: ['status', 'pause', 'resume', 'stop', 'light', 'speed', 'temperature'], description: '要做的动作' },
          printer: { type: 'string', description: '打印机编号/名字/序列号；只有一台时可省略' },
          on: { type: 'boolean', description: 'light 用：true 开灯，false 关灯' },
          level: { type: 'integer', description: 'speed 用：1~4' },
          nozzle: { type: 'integer', description: 'temperature 用：喷嘴目标温度' },
          bed: { type: 'integer', description: 'temperature 用：热床目标温度' },
        },
        required: ['action'],
        execute: async ({ action, printer, on, level, nozzle, bed }) => {
          const picked = pickPrinter(list, printer || '')
          if (!picked.ok) return { ok: false, message: picked.message }
          const actor = { userId, isOwner }
          if (chat.kind === 'group') {
            const acc = groupAccessFor(picked.printer, actor, s)
            if (acc.mode === 'off') return { ok: false, message: '这台打印机的主人在群里关掉了打印机功能。' }
            if (action !== 'status' && acc.mode !== 'control') return { ok: false, message: '这台打印机的主人在群里只允许查看状态。' }
          }
          if (!picked.printer.granted && !vault.isUnlocked(userId)) return { ok: false, message: '用户的保险箱锁着：请他在私聊里发「/打印机 解锁 <安全码>」再来。' }
          const scope = action === 'status' ? 'status' : 'control'
          if (!canUseScope(picked.printer, scope)) return { ok: false, message: '这个授权没有这个范围。' }
          if (action === 'status') {
            const r = await fetchStatus(picked.printer, { reveal: chat.kind === 'private', chat: { ...chat, isOwner } })
            return r.ok ? { ok: true, message: r.text } : { ok: false, message: r.message }
          }
          // P2-1：停止一律不给工具下发 —— 即使私聊里拿到 control 授权，也必须本人用命令二次确认。
          // 放在 ensureControl 之前：不判权限、不下发 doCommand、不写成功审计。
          if (action === 'stop') return { ok: false, message: '停止打印不能由我直接下发：请发「/打印机 停止」再确认一次。' }
          const denied = ensureControl(picked.printer, actor, chat, s)
          if (denied) return { ok: false, message: denied }
          const params = {}
          if (action === 'light') params.on = on !== false
          if (action === 'speed') params.level = Math.min(4, Math.max(1, Number(level) || 2))
          if (action === 'temperature') { if (Number.isFinite(nozzle)) params.nozzle = nozzle; if (Number.isFinite(bed)) params.bed = bed }
          const r = await doCommand(picked.printer, { userId, isOwner }, action, params)
          await audit(userId, action, r.ok, r.ok ? '' : r.error, picked.printer.ref)
          return r.ok ? { ok: true, message: '已经下发到「' + (picked.printer.name || '打印机') + '」。' } : { ok: false, message: '操作失败：' + r.error }
        },
      })
    })

    api.rule((kind) => kind === 'private' ? '用户问拓竹 3D 打印机的状态/进度/剩余时间，或要暂停/继续/停止/开灯/调温时，用 bambu_printer 工具。只能操作他本人绑定的打印机；结果照实转述，不要编造进度。' : '')
    api.context(({ chat }) => {
      // P1-1：未获准群连打印机名字都不给
      if (!chat || chat.kind !== 'group' || !groupAllowed(chat)) return ''
      if (!hasUsable(chat.userId)) return ''
      const list = listOf(chat.userId)
      if (!list.length) return ''
      return '（群聊里用户自己的拓竹打印机：' + list.map((p) => p.name || p.label).slice(0, 4).join('、') + '。群聊状态默认隐藏文件名和项目名。）'
    })

    // ---------- 面板接口 ----------
    const body = (req) => api.core.http.body(req)
    const query = (req) => api.core.http.query(req)

    api.route('/overview', async () => {
      await ready()
      const s = settings()
      return {
        ok: true,
        enabled: s.enabled,
        settings: { users: s.users.join(','), hostAllow: hostPrivateAllow(), groups: s.groups.join(','), hostGroupAllow: hostGroupAllow(), groupMode: s.groupMode, groupPhoto: s.groupPhoto, allowGroupName: s.allowGroupName, unlockDays: unlockDaysOf(api.settings()), unlockMinutes: s.unlockMinutes, defaultInterface: s.defaultInterface, ownerInterface: s.ownerInterface, ownerLocalAllowed: s.ownerLocalAllowed, tutkBridgePath: s.tutkBridgePath, tutkLibPath: s.tutkLibPath, tutkTimeoutMs: s.tutkTimeoutMs, tutkBuiltinBridgePath: defaultBridgePath(api.dir) },
        // 面板的表单字段 / 范围 / 选项 / 提示全部由这份规则驱动，和 settings() 的夹取完全同源。
        rules: describeRules(),
        // 主人状态：面板顶部和「局域网绑定」页都要它，不再逼面板先调 /lan/status 才知道解锁没。
        // qq 是完整号：面板跑在本机主人自己的浏览器里，要认出「这条凭据是谁的」得看全号；
        // 秘密（token / 访问码 / 安全码）仍然一条都不给。qqMasked 留着给外部调用方 / 日志用。
        owner: {
          qq: String((api.config() && api.config().ownerQQ) || ''),
          qqMasked: maskQQ(String((api.config() && api.config().ownerQQ) || '')),
          online: vault.isUnlocked(String((api.config() && api.config().ownerQQ) || '')),
          lanAllowed: s.ownerLocalAllowed,
          unlockDays: unlockDaysOf(api.settings()),
          // 免安全码：开关 + 这个账号实际是不是免码建的 + 有没有建过账号
          noCode: s.ownerNoCode !== false,
          codeless: (() => { try { return !!vault.isCodeless && vault.isCodeless(ownerQQOf()) } catch { return false } })(),
          hasAccount: (() => { try { return !!ownerQQOf() && vault.hasUser(ownerQQOf()) } catch { return false } })(),
        },
        risk: '访问码 / token 等同于打印机控制权；安全码是唯一解密钥匙（忘了只能清空重绑）。默认谁也看不到别人的 token；本人主动授权 = 限时共享自己的凭据，对方能查看/管理这些打印机，但拿不到安全码，也随时可被撤销。任何人都不应把安全码、访问码发到群里。',
        users: vault.listUsers().map((u) => {
          const p = vault.publicPrefs(u.qq)
          // 未解锁时 listBindings 只能给元数据（没有秘密），正好够列表展示
          const bindings = vault.listBindings(u.qq).map((b) => ({
            id: b.id,
            label: b.label || '',
            mode: b.mode,
            tokenMask: b.tokenMask || '',
            printers: (b.printers || []).map((x) => ({ serialMasked: maskSerial(x.serial), name: x.name || '', model: x.model || '' })),
          }))
          return {
            // 完整 QQ 给面板列「谁绑了」（本机主人界面）；序列号 / token 仍然只给打码值。
            qq: String(u.qq),
            qqMasked: maskQQ(u.qq), bindings: u.bindings, printers: u.printers, unlocked: u.unlocked, lockedUntil: u.lockedUntil,
            createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, bindingList: bindings,
            interface: p.interface || '', groupMode: p.groupMode || '', groupPhoto: p.groupPhoto, groupShowName: p.groupShowName === true,
          }
        }),
        grants: vault.listGrants().map((g) => ({ id: g.id, ownerMasked: maskQQ(g.ownerQQ), granteeMasked: maskQQ(g.granteeQQ), scopes: g.scopes, expiresAt: g.expiresAt, revoked: g.revoked })),
        // 审计的操作者给完整 QQ：面板在本机主人自己的浏览器里跑，要能认出「这是谁做的」，
        // 打码反而让这条记录失去意义。秘密（token / 访问码 / 安全码）仍然一条都不给。
        audit: vault.auditList(50).map((a) => ({ at: a.at, actor: String(a.actor || ''), actorMasked: maskQQ(a.actor), action: a.action, ok: a.ok, note: a.note || '' })),
        counts: vault.summary(),
      }
    })

    api.route('/unlock', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!/^\d{4,15}$/.test(qq)) return { ok: false, code: 'BAD_INPUT', message: 'QQ 号不对' }
      try {
        // 改设置后立即按新的「天」生效，不用重载模块
        const minutes = applyLockMinutes()
        const r = await vault.unlock(qq, String(b.code || ''))
        await audit(qq, 'unlock', true)
        return { ok: true, until: r.until, unlockMinutes: minutes, unlockDays: Math.round(minutes / 1440) }
      } catch (error) {
        await audit(qq, 'unlock', false, error.code || 'BAD_CODE')
        return { ok: false, code: error.code || 'BAD_CODE', message: explain(error) }
      }
    })

    api.route('/lock', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      vault.lock(qq)
      await audit(qq, 'lock', true)
      return { ok: true }
    })

    // 面板：给某个用户设默认接口（cloud / lan / auto / ''=跟随全局）
    api.route('/interface', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!vault.hasUser(qq)) return { ok: false, code: 'NO_USER', message: '这个 QQ 还没绑定' }
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '先解锁这个用户再改接口（偏好本身不含秘密，但改它需要本人）' }
      const value = b.value == null ? '' : String(b.value).trim().toLowerCase()
      if (!['', 'cloud', 'lan', 'auto'].includes(value)) return { ok: false, code: 'BAD_INPUT', message: '接口只能是 cloud / lan / auto / 跟随全局' }
      try {
        const r = await vault.setPrefs(qq, { interface: value })
        await audit(qq, 'interface', true, value || 'follow')
        return { ok: true, interface: r.prefs.interface }
      } catch (error) {
        return { ok: false, code: error.code || 'BAD_INPUT', message: explain(error) }
      }
    })

    // 面板：绑定用户自己的群权限（只读 / 控制 / 关闭 / 跟随；拍照、文件名）
    api.route('/groupperm', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!vault.hasUser(qq)) return { ok: false, code: 'NO_USER', message: '这个 QQ 还没绑定' }
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '先解锁这个用户再改群权限' }
      const patch = {}
      if (b.groupMode !== undefined) {
        const mode = String(b.groupMode || '').toLowerCase()
        if (!['', 'off', 'status', 'control'].includes(mode)) return { ok: false, code: 'BAD_INPUT', message: '群模式只能是跟随 / off / status / control' }
        patch.groupMode = mode
      }
      if (b.groupPhoto !== undefined) patch.groupPhoto = b.groupPhoto === null || b.groupPhoto === '' ? null : b.groupPhoto === true
      if (b.groupShowName !== undefined) patch.groupShowName = b.groupShowName === true
      if (!Object.keys(patch).length) return { ok: false, code: 'BAD_INPUT', message: '没有要改的项' }
      try {
        const r = await vault.setPrefs(qq, patch)
        await audit(qq, 'groupperm', true, JSON.stringify(patch))
        return { ok: true, prefs: r.prefs }
      } catch (error) {
        return { ok: false, code: error.code || 'BAD_INPUT', message: explain(error) }
      }
    })

    api.route('/bindings', async (req) => {
      await ready()
      const q = query(req)
      const qq = String(q.qq || '')
      if (!vault.hasUser(qq)) return { ok: false, code: 'NO_USER', message: '这个 QQ 还没绑定' }
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      return { ok: true, bindings: vault.listBindings(qq).map((b) => ({ id: b.id, label: b.label, mode: b.mode, tokenMask: b.tokenMask, printers: b.printers.map((p) => ({ serialMasked: maskSerial(p.serial), name: p.name || '', model: p.model || '' })) })) }
    })

    api.route('/bind', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      const mode = b.mode === 'cloud' ? 'cloud' : 'lan'
      if (mode === 'lan' && String(qq) !== String(api.config().ownerQQ)) {
        return { ok: false, code: 'OWNER_ONLY', message: '局域网绑定只提供给主人；其他用户请用「云端登录」（Bambu 账号）。' }
      }
      try {
        if (mode === 'lan') {
          const printers = Array.isArray(b.printers) ? b.printers : []
          const cleaned = printers.map((p) => ({ serial: String(p.serial || '').trim(), ip: String(p.ip || '').trim(), name: String(p.name || '').trim(), accessCode: p.accessCode ? String(p.accessCode) : undefined }))
            .filter((p) => p.serial && /^\d{1,3}(\.\d{1,3}){3}$/.test(p.ip))
          if (!cleaned.length) return { ok: false, code: 'BAD_INPUT', message: '局域网绑定至少要一台打印机：序列号 + IP' }
          const r = await vault.addBinding(qq, { label: String(b.label || '我的打印机'), mode, accessCode: b.accessCode ? String(b.accessCode) : undefined, printers: cleaned })
          await audit(qq, 'bind', true, mode, r.id)
          return { ok: true, binding: { id: r.id, label: String(b.label || ''), mode } }
        }
        const region = Object.hasOwn(REGIONS, String(b.region)) ? String(b.region) : 'us'
        const r = await vault.addBinding(qq, { label: String(b.label || '云端账号'), mode, accessToken: String(b.accessToken || ''), uid: String(b.uid || ''), region })
        await audit(qq, 'bind', true, mode, r.id)
        let warning = ''
        try {
          const found = await listDevices({ accessToken: String(b.accessToken || ''), uid: String(b.uid || ''), region })
          if (found.ok && found.devices.length) await vault.setDiscoveredPrinters(qq, r.id, found.devices)
          else warning = found.ok ? '云端账号下没发现打印机。' : '云端设备列表拉取失败：' + found.error
        } catch (error) {
          warning = '云端设备列表拉取失败：' + String(error.message || error)
        }
        return { ok: true, binding: { id: r.id, label: String(b.label || ''), mode }, warning }
      } catch (error) {
        return { ok: false, code: error.code || 'BAD_INPUT', message: explain(error) }
      }
    })

    api.route('/unbind', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      try {
        await vault.removeBinding(qq, String(b.bindingId || ''))
        await audit(qq, 'unbind', true, '', String(b.bindingId || ''))
        return { ok: true }
      } catch (error) {
        return { ok: false, code: error.code || 'NOT_FOUND', message: explain(error) }
      }
    })

    api.route('/status', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      const list = vault.printers(qq)
      const picked = pickPrinter(list, String(b.selector || ''))
      if (!picked.ok) {
        return picked.code === 'NEED_CHOICE'
          ? { ok: true, needChoice: true, choices: list.map((p) => ({ index: p.index, label: p.bindingLabel || p.label || '', name: p.name || '', model: p.model || '', serialMasked: maskSerial(p.serial) })) }
          : { ok: false, code: picked.code, message: picked.message }
      }
      const isOwner = String(qq) === String(api.config().ownerQQ)
      const r = await fetchStatus(picked.printer, { reveal: b.reveal !== false, chat: { userId: qq, kind: 'private', isOwner, showTransport: true } })
      return r.ok
        ? { ok: true, text: r.text, status: r.status, transport: r.transport, printer: { ...r.printer, serialMasked: maskSerial(picked.printer.serial), ipMasked: maskIp(picked.printer.ip) } }
        : { ok: false, code: r.code, message: r.message }
    })

    api.route('/control', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      const action = String(b.action || '')
      if (!['pause', 'resume', 'stop', 'light', 'speed', 'temperature', 'home'].includes(action)) return { ok: false, code: 'BAD_INPUT', message: '不认识的动作' }
      if (action === 'stop' && b.confirm !== true) return { ok: false, code: 'NEED_CONFIRM', message: '停止打印需要确认：再点一次「确认停止」' }
      const list = vault.printers(qq)
      const picked = pickPrinter(list, String(b.selector || ''))
      if (!picked.ok) {
        return picked.code === 'NEED_CHOICE'
          ? { ok: true, needChoice: true, choices: list.map((p) => ({ index: p.index, label: p.bindingLabel || p.label || '', name: p.name || '', model: p.model || '', serialMasked: maskSerial(p.serial) })) }
          : { ok: false, code: picked.code, message: picked.message }
      }
      const params = {}
      if (action === 'light') params.on = b.on !== false
      if (action === 'speed') params.level = Math.min(4, Math.max(1, Number(b.level) || 2))
      if (action === 'temperature') { if (Number.isFinite(Number(b.nozzle))) params.nozzle = Number(b.nozzle); if (Number.isFinite(Number(b.bed))) params.bed = Number(b.bed) }
      if (action === 'temperature' && params.nozzle === undefined && params.bed === undefined) return { ok: false, code: 'BAD_INPUT', message: '至少给一个温度' }
      const isOwner = String(qq) === String(api.config().ownerQQ)
      const r = await doCommand(picked.printer, { userId: qq, isOwner }, action, params)
      await audit(qq, action, r.ok, r.ok ? '' : String(r.error || '').slice(0, 100), picked.printer.ref)
      return r.ok ? { ok: true, message: '已下发到「' + (picked.printer.name || '打印机') + '」（' + (r.transport === 'cloud' ? '云端接口' : '本地接口') + '）' + (r.acked ? '' : '，没回执，稍后看状态') } : { ok: false, code: r.code || 'PRINTER_ERROR', message: r.error }
    })

    api.route('/photo', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      const list = vault.printers(qq)
      const picked = pickPrinter(list, String(b.selector || ''))
      if (!picked.ok) return picked.code === 'NEED_CHOICE' ? { ok: true, needChoice: true, choices: list.map((p) => ({ index: p.index, label: p.bindingLabel || p.label || '', name: p.name || '', model: p.model || '', serialMasked: maskSerial(p.serial) })) } : { ok: false, code: picked.code, message: picked.message }
      const shot = await snapshotOf(picked.printer, { userId: qq, isOwner: true })
      await audit(qq, 'photo', shot.ok, shot.ok ? shot.note : shot.code, picked.printer.ref)
      if (!shot.ok) return { ok: false, code: shot.code || 'CAMERA_ERROR', message: shot.message }
      return { ok: true, image: 'data:image/jpeg;base64,' + shot.jpeg.toString('base64'), printer: { name: picked.printer.name || '', serialMasked: maskSerial(picked.printer.serial) } }
    })

    api.route('/grant', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      const grantee = String(b.grantee || '')
      if (!/^\d{4,15}$/.test(grantee)) return { ok: false, code: 'BAD_INPUT', message: '对方 QQ 不对' }
      if (grantee === qq) return { ok: false, code: 'BAD_INPUT', message: '不用授权给自己' }
      const scopes = (Array.isArray(b.scopes) ? b.scopes : ['status']).filter((x) => ['status', 'control', 'photo'].includes(String(x)))
      if (!scopes.length) return { ok: false, code: 'BAD_INPUT', message: '范围只能是 status/control/photo' }
      const minutes = parseMinutes(b.minutes, 30, 1440)
      const bindingIds = Array.isArray(b.bindingIds) ? b.bindingIds.map(String) : []
      const owned = vault.listBindings(qq).map((x) => x.id)
      if (bindingIds.some((id) => !owned.includes(id))) return { ok: false, code: 'NOT_FOUND', message: '有不存在的绑定' }
      try {
        const r = await vault.createGrant({ ownerQQ: qq, granteeQQ: grantee, bindingIds, scopes, minutes })
        await audit(qq, 'grant', true, 'to ' + maskQQ(grantee) + ' ' + scopes.join(','), r.grantId)
        return { ok: true, grantId: r.grantId, expiresAt: r.expiresAt, scopes, count: r.count, message: '已授权，立即生效；对方现在就能用你的凭据操作这些打印机，到期自动失效。' }
      } catch (error) {
        return { ok: false, code: error.code || 'BAD_INPUT', message: explain(error) }
      }
    })

    api.route('/revoke', async (req) => {
      await ready()
      const b = await body(req)
      const grantId = String(b.grantId || '')
      const qq = String(b.qq || '')
      if (!qq) return { ok: false, code: 'BAD_INPUT', message: '撤销授权必须由授权人本人解锁后操作' }
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      try {
        await vault.revokeGrant({ byQQ: qq, grantId })
        await audit(qq, 'revoke', true, '', grantId)
        return { ok: true }
      } catch (error) {
        return { ok: false, code: error.code || 'NOT_FOUND', message: explain(error) }
      }
    })

    // 面板：退出云端账号（删掉该用户所有云端绑定，不碰局域网绑定）
    api.route('/logout', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '这个用户还没解锁：先让他用安全码解锁再操作。' }
      const cloudBindings = vault.listBindings(qq).filter((x) => x.mode === 'cloud')
      if (!cloudBindings.length) return { ok: false, code: 'NO_CLOUD', message: '这个用户没有云端绑定' }
      if (b.confirm !== true) return { ok: false, code: 'NEED_CONFIRM', message: '退出会删掉云端 token，需要确认：再带 confirm=true 提交' }
      let removed = 0
      for (const binding of cloudBindings) {
        try { await vault.removeBinding(qq, binding.id); removed++ } catch (error) { /* 单条失败不拖垮 */ }
      }
      await audit(qq, 'logout', true, removed + ' bindings')
      return { ok: true, removed, message: '已退出云端账号，删掉 ' + removed + ' 条云端绑定' }
    })

    // 面板：云端登录（账号 + 密码 → 可能需要验证码 / 两步验证）
    // 会话只放内存 5 分钟；密码不进日志、不回显；成功才把 token 交给 vault 加密保存。
    api.route('/login', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!/^\d{4,15}$/.test(qq)) return { ok: false, code: 'BAD_INPUT', message: 'QQ 号不对' }
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '先解锁这个用户：登录成功后 token 会加密进他自己的保险箱' }
      const account = String(b.account || '').trim()
      const password = String(b.password || '')
      const region = Object.hasOwn(REGIONS, String(b.region)) ? String(b.region) : 'us'
      if (!account) return { ok: false, code: 'NO_ACCOUNT', message: '缺少 Bambu 账号（邮箱或手机号）' }
      if (!password) return { ok: false, code: 'NO_PASSWORD', message: '缺少密码（OAuth 注册的账号请先在 Bambu 手机 App 里设置密码）' }
      try {
        const session = (testHooks.createCloudLogin || createCloudLogin)({ account, password, region })
        const r = await session.login()
        if (r.ok) {
          pendingLogins.delete(qq)
          const saved = await saveCloudLogin(qq, r, account)
          await audit(qq, 'login', true, 'cloud')
          return { ok: true, loggedIn: true, bindingId: saved.id, count: saved.count, names: saved.names, message: '登录成功，token 已加密保存' }
        }
        if (r.need) {
          pendingLogins.set(qq, { session, account, region, until: now() + LOGIN_TTL_MS, need: r.need })
          await audit(qq, 'login', false, 'need-' + r.need)
          return { ok: true, need: r.need, message: r.need === 'code' ? '云端要求验证码：先点「发送验证码」，再填收到的数字' : '云端要求两步验证：请填验证器里的 6 位码' }
        }
        return { ok: false, code: 'UNKNOWN', message: '云端返回了不认识的响应' }
      } catch (error) {
        await audit(qq, 'login', false, error.code || 'AUTH_FAILED')
        return { ok: false, code: error.code || 'AUTH_FAILED', message: explain(error) }
      }
    })

    api.route('/login/code', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      const pending = pendingLogins.get(qq)
      if (!pending || pending.until < now()) {
        pendingLogins.delete(qq)
        return { ok: false, code: 'NO_SESSION', message: '没有等待中的登录，或已超过 5 分钟' }
      }
      try {
        if (b.send === true) {
          const r = await pending.session.requestCode()
          await audit(qq, 'login-code', true, r.channel)
          return { ok: true, sent: true, channel: r.channel, message: '验证码已发送（' + (r.channel === 'email' ? '邮箱' : '手机') + '）' }
        }
        const r = await pending.session.submitCode(String(b.code || ''))
        pendingLogins.delete(qq)
        const saved = await saveCloudLogin(qq, r, pending.account)
        await audit(qq, 'login', true, 'code')
        return { ok: true, loggedIn: true, bindingId: saved.id, count: saved.count, names: saved.names }
      } catch (error) {
        await audit(qq, 'login-code', false, error.code || 'CODE_FAILED')
        return { ok: false, code: error.code || 'CODE_FAILED', message: explain(error) }
      }
    })

    api.route('/login/tfa', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      const pending = pendingLogins.get(qq)
      if (!pending || pending.until < now()) {
        pendingLogins.delete(qq)
        return { ok: false, code: 'NO_SESSION', message: '没有等待中的两步验证，或已超过 5 分钟' }
      }
      try {
        const r = await pending.session.submitTfa(String(b.code || ''))
        pendingLogins.delete(qq)
        const saved = await saveCloudLogin(qq, r, pending.account)
        await audit(qq, 'login', true, 'tfa')
        return { ok: true, loggedIn: true, bindingId: saved.id, count: saved.count, names: saved.names }
      } catch (error) {
        await audit(qq, 'login-2fa', false, error.code || 'TFA_FAILED')
        return { ok: false, code: error.code || 'TFA_FAILED', message: explain(error) }
      }
    })

    // 面板：TUTK 云端画面自检（只报能不能用，不回显任何凭据）
    api.route('/tutk/status', async () => {
      await ready()
      const s = settings()
      const bridgePath = s.tutkBridgePath || defaultBridgePath(api.dir)
      const bridge = await checkBridgeBinary(bridgePath, { libPath: s.tutkLibPath })
      const builtinPath = defaultBridgePath(api.dir)
      return {
        ok: true,
        bridge: {
          path: bridgePath,
          builtin: bridgePath === builtinPath,
          customized: !!s.tutkBridgePath,
          ok: bridge.ok,
          code: bridge.code || '',
          message: bridge.message || '',
        },
        lib: {
          path: bridge.libPath || s.tutkLibPath || '',
          ok: bridge.libOk === true,
          message: bridge.libMessage || '',
          download: BAMBUSOURCE_URL,
          file: BAMBUSOURCE_FILE,
        },
        cn: isCnLikely({}),
        timeoutMs: s.tutkTimeoutMs,
        note: '云端画面 = 云端 token 铸 ttcode + 本机 TUTK 抓帧桥。桥已随模块预编译（不需要 .NET）；还需要一份 BambuSource 库（OBN 的产物，本模块不打包）：' + BAMBUSOURCE_ADVICE + '把 ' + BAMBUSOURCE_FILE + ' 放到桥同目录即可。有局域网地址+访问码时优先走局域网。',
      }
    })

    // 面板：一键下载并放置 BambuSource 库（云端画面唯一的外部依赖）。
    // 国内网络自动先走 GitHub 加速代理，失败回退直连；只下载、不碰任何用户秘密。
    //
    // 这条路由要写盘、写下去的东西又会被 dlopen 执行，所以和别的面板写操作一样上锁：
    // 必须主人、且主人当前是解锁状态。解锁状态本身就代表「本机这台 Aurabot 的主人确认过」。
    api.route('/tutk/download', async (req) => {
      await ready()
      const owner = ownerQQOf()
      if (!owner) return { ok: false, code: 'NO_OWNER', message: '还没确定主人是谁，先完成初始化' }
      if (!(await ensureOwnerSession())) return { ok: false, code: 'LOCKED', message: '先解锁主人再说：这个按钮会下载一个之后会被加载执行的原生库，不能匿名触发。' }
      const b = await body(req)
      const configured = String(b.dir || api.settings().tutkLibPath || '').trim()
      const bridgePath = String(api.settings().tutkBridgePath || '').trim() || defaultBridgePath(api.dir)
      // 「BambuSource 库路径」这个设置填的是**库文件**路径（面板 / README / 预检都按文件理解），
      // 但下载器要的是目录。这里按形状判定：看起来像文件（.so/.dll/.dylib 或就是标准库名）
      // 就取它的父目录，否则当目录用 —— 否则配置 /opt/libBambuSource.so 会写到
      // /opt/libBambuSource.so/libBambuSource.so（review P2-3）。
      //
      // 没配置时**不要**写进模块目录（以前就是写进 assets/tutk-bridge/）：插件会盯着模块
      // 目录的文件数与 mtime，一有变化就热重载模块，内存里的解锁会话随之清空 ——
      // 用户点完下载、刚解锁的主人就被锁回去了。上游的 aura-mimo 也写着
      // 「可变数据写 api.dataDir()，模块目录保持静态」。所以默认落到数据目录，
      // 再用下面的 libPath 把它交给抓帧桥（桥本身不动）。
      const defaultLibDir = path.join(api.dataDir(), 'bambusource')
      const resolved = resolveDestDir(configured || defaultLibDir, BAMBUSOURCE_FILE)
      const destDir = resolved.dir
      if (!destDir) return { ok: false, code: 'NO_DIR', message: '找不到放库的目录，请先在设置里填「BambuSource 库路径」（填目录，或填完整的库文件路径）' }
      const cn = typeof b.cn === 'boolean' ? b.cn : undefined
      const result = await (testHooks.downloadBambuSource || downloadBambuSource)({
        destDir,
        // 用户填的若是完整库文件路径（如 /tmp/libs/custom-source.so），落盘名也要用他填的那个，
        // 否则会写成标准名，而运行时仍按自定义路径找不到库（review 复查 P2）。
        fileName: resolved.fileName,
        cn,
        timeoutMs: Math.min(10 * 60 * 1000, Math.max(60000, Number(b.timeoutMs) || 8 * 60 * 1000)),
      })
      if (!result.ok) {
        await audit('', 'tutk-download', false, result.code || 'FAILED')
        return { ok: false, code: result.code || 'FAILED', message: result.error + '（命令：/打印机 帮助 里没有这一步，是面板按钮）' }
      }
      // 落盘位置变了（不再写进模块目录），把库路径记进设置，抓帧时才能找到它。
      // 只在这个文件确实是我们刚下下来的那份时才写，避免把用户的显式配置覆盖掉。
      if (!String(api.settings().tutkLibPath || '').trim()) {
        try { api.saveSettings({ tutkLibPath: result.path }) } catch { /* 设置存不下不影响这次下载 */ }
      }
      await audit('', 'tutk-download', true, (result.version || '') + ' ' + (result.bytes || 0) + 'B' + (result.verified === false ? ' (no sha256)' : ''))
      const status = await checkBridgeBinary(bridgePath, { libPath: result.path })
      return {
        ok: true,
        path: result.path,
        bytes: result.bytes,
        version: result.version,
        via: result.via,
        proxy: result.proxy === true,
        cn: cn === undefined ? isCnLikely({}) : cn,
        // 这个版本的 sha256 在表里还是空的 → 如实告诉面板「这次没有校验」，
        // 别让用户以为下载下来的东西一定验过。
        verified: result.verified === true,
        sha256: result.sha256 || '',
        ready: status.ok === true && status.libOk === true,
      }
    })

    // 面板：用某个用户的云端 token 铸一次 ttcode，验证账号/设备是否支持云画面（不抓帧、不返回凭据）
    api.route('/tutk/mint', async (req) => {
      await ready()
      const b = await body(req)
      const qq = String(b.qq || '')
      if (!(await isUsableNow(qq))) return { ok: false, code: 'LOCKED', message: '先解锁这个用户（需要它的 token 铸码）' }
      const list = vault.printers(qq).filter((p) => p.mode === 'cloud')
      const picked = pickPrinter(list, String(b.selector || ''))
      if (!picked.ok) {
        return picked.code === 'NEED_CHOICE'
          ? { ok: true, needChoice: true, choices: list.map((p) => ({ index: p.index, label: p.bindingLabel || '', name: p.name || '', model: p.model || '', serialMasked: maskSerial(p.serial) })) }
          : { ok: false, code: 'NO_CLOUD', message: '这个用户没有云端绑定的打印机' }
      }
      let secret
      try { secret = vault.secretOf(qq, picked.printer.bindingId) } catch (error) { return { ok: false, code: 'LOCKED', message: explain(error) } }
      if (!secret || secret.mode !== 'cloud' || !secret.accessToken) return { ok: false, code: 'NO_TOKEN', message: '这台打印机没有云端 token' }
      const minted = await (testHooks.mintTutcode || mintTutcode)({ accessToken: secret.accessToken, serial: picked.printer.serial, region: secret.region || picked.printer.region || 'us', devVersion: picked.printer.model || '', timeoutMs: 12000 })
      await audit(qq, 'tutk-mint', minted.ok, minted.ok ? '' : minted.code, picked.printer.ref)
      return minted.ok
        ? { ok: true, message: '云端已发放 TUTK 凭据，这台打印机支持云画面。', printer: { name: picked.printer.name || '', serialMasked: maskSerial(picked.printer.serial) } }
        : { ok: false, code: minted.code, message: minted.error }
    })

    api.route('/audit', async (req) => {
      await ready()
      const q = query(req)
      const limit = Math.min(200, Math.max(1, Number(q.limit) || 50))
      return {
        ok: true,
        // 同 /overview：操作者给完整 QQ，面板才认得出是谁；秘密不出现在审计里。
        audit: vault.auditList(limit).map((a) => ({ at: a.at, actor: String(a.actor || ''), actorMasked: maskQQ(a.actor), action: a.action, ok: a.ok, note: a.note || '' })),
      }
    })

    // ---------- 主人专用面板路由（面板不再需要知道 QQ，主人从 api.config() 取） ----------
    // 注意：/lan/bind 要用到后面才定义的 bindLan，所以这三条路由的注册放在 bindLan 之后。

    /**
     * 主人免安全码：建一个 mode:'host' 的账号（DEK 由本机主密钥包着），并立即开一个会话。
     * 只对主人开放；别的用户仍然必须自己设安全码。
     */
    api.route('/owner/nocode', async (req) => {
      await ready()
      const b = await body(req)
      const ownerQQ = ownerQQOf()
      if (!ownerQQ) return { ok: false, code: 'NO_OWNER', message: '没读到主人 QQ，无法建免码账号。' }
      try {
        if (!vault.hasUser(ownerQQ)) {
          await vault.registerWithoutCode(ownerQQ)
          await audit(ownerQQ, 'register', true, '免安全码（面板）', ownerQQ)
        } else if (!isCodelessOwner()) {
          // 已经设过安全码：不悄悄改掉，告诉他这是个有意的决定
          return { ok: false, code: 'NEED_CODE', message: '这个主人账号已经设过安全码，不能直接改成免码（那样会绕过已有安全码）。要换方式请先清空数据重来。' }
        }
        // 免码时 applyLockMinutes 会按设置里的天数开一个长会话
        applyLockMinutes()
        const session = await vault.unlockWithoutCode(ownerQQ)
        return { ok: true, mode: 'host', until: session.until }
      } catch (error) {
        return { ok: false, code: (error && error.code) || 'FAILED', message: explain(error) }
      }
    })

    /**
     * 搜索局域网里的拓竹打印机（SSDP UDP 2021）。
     *
     * 只读：广播里**没有访问码**，所以这里只给序列号 / IP / 名字 / 型号 / 信号；
     * 面板可以让用户点一台把序列号和 IP 填好，访问码仍然要手工输。
     */
    api.route('/lan/discover', async (req) => {
      await ready()
      const b = await body(req)
      const timeoutMs = Number(b.timeoutMs) || 3000
      const scanner = testHooks.discoverPrinters || discoverPrinters
      try {
        const found = await scanner({ timeoutMs })
        if (!found || found.ok !== true) {
          return { ok: false, code: (found && found.code) || 'DISCOVERY_FAILED', message: (found && found.message) || '搜索失败', devices: [] }
        }
        const devices = (Array.isArray(found.devices) ? found.devices : []).map((d) => ({
          serial: String((d && d.serial) || ''),
          ip: String((d && d.ip) || ''),
          name: String((d && d.name) || '').slice(0, 60),
          model: String((d && d.model) || '').slice(0, 30),
          signal: String((d && d.signal) || ''),
        }))
        await audit('', 'discover-lan', true, devices.length + ' 台', '')
        return {
          ok: true,
          devices,
          port: DISCOVERY_PORT,
          // 说清楚为什么没有访问码，免得用户以为「搜到了就能直接用」
          note: devices.length
            ? '访问码不会广播（那是打印机的安全设计），点一台把序列号和 IP 填好后，还要输屏幕上那 8 位访问码。'
            : '这个网段没搜到拓竹打印机：确认打印机和这台电脑在同一局域网、打印机已开机联网。',
        }
      } catch (error) {
        return { ok: false, code: 'DISCOVERY_FAILED', message: '搜索局域网失败：' + ((error && error.message) || error), devices: [] }
      }
    })

    api.route('/owner/unlock', async (req) => {
      await ready()
      const b = await body(req)
      const ownerQQ = String((api.config() && api.config().ownerQQ) || '')
      if (!ownerQQ) return { ok: false, code: 'NO_OWNER', message: '没读到主人 QQ，无法定位要解锁的保险箱。' }
      try {
        // 改设置后立即按新的「天」生效，不用重载模块
        const minutes = applyLockMinutes()
        const r = await vault.unlock(ownerQQ, String(b.code || ''))
        await audit(ownerQQ, 'unlock', true, 'panel', ownerQQ)
        return { ok: true, until: r.until, unlockDays: Math.max(1, Math.round(minutes / 1440)) }
      } catch (error) {
        await audit(ownerQQ, 'unlock', false, error.code || 'BAD_CODE', ownerQQ)
        return { ok: false, code: error.code || 'BAD_CODE', message: explain(error) }
      }
    })

    api.route('/owner/lock', async () => {
      await ready()
      const ownerQQ = String((api.config() && api.config().ownerQQ) || '')
      if (!ownerQQ) return { ok: false, code: 'NO_OWNER', message: '没读到主人 QQ。' }
      vault.lock(ownerQQ)
      await audit(ownerQQ, 'lock', true, 'panel', ownerQQ)
      return { ok: true }
    })

    // 局域网状态：只列 mode === 'lan' 的绑定，序列号打码；未解锁时 listBindings 只给元数据。
    api.route('/lan/status', async () => {
      await ready()
      const ownerQQ = String((api.config() && api.config().ownerQQ) || '')
      let bindings = []
      try {
        bindings = vault.listBindings(ownerQQ)
          .filter((b) => b.mode === 'lan')
          .map((b) => ({
            id: b.id,
            label: b.label || '',
            tokenMask: b.tokenMask || '',
            printers: (b.printers || []).map((p) => ({ serialMasked: maskSerial(p.serial), name: p.name || '', model: p.model || '' })),
          }))
      } catch (error) {
        // 保险箱还没 load 好时不给假数据，但也不让面板整页报错
        log.warn('读取局域网绑定时失败：' + (error && error.message ? error.message : error))
      }
      return {
        ok: true,
        ownerQQ,
        ownerMasked: maskQQ(ownerQQ),
        ownerOnline: ownerQQ ? vault.isUnlocked(ownerQQ) : false,
        unlockDays: unlockDaysOf(api.settings()),
        lanAllowed: settings().ownerLocalAllowed,
        bindings,
      }
    })

    // ---------- 命令（主人） ----------
    api.command({
      name: '打印机',
      aliases: ['拓竹', 'bambu', '3dprint'],
      desc: '拓竹 3D 打印机：状态 / 暂停 / 继续 / 停止 / 灯 / 速度 / 温度 / 拍照 / 授权',
      async run(arg, msg) {
        const reply = await handleCommand(arg, msg)
        if (reply && reply.image) {
          await api.sendImage(msg.chatId, 'base64://' + reply.image.toString('base64'))
          return reply.caption || ''
        }
        // 帮助是多页合并转发：这里自己发出去，避免被 String(reply) 变成 [object Object]。
        // 注意**必须返回非空字符串**：宿主的 onCommand 用 if (reply) 判断
        // 「命令处理了没有」，返回 '' 会被当成没处理，接着走模型回复
        // （现象就是插件已经发了聊天记录，模型又接一句「这条命令我这边没法执行」）。
        if (reply && Array.isArray(reply.forwardNodes) && reply.forwardNodes.length) {
          const sent = await sendForward(msg, reply.forwardNodes)
          if (sent) return '已发送，点开上面的聊天记录看分页。'
          return String(reply.fallback || '')
        }
        return String(reply || '')
      },
    })

    /**
     * 面板「局域网绑定」页和 /lan/bind 路由共用的绑定入口。
     * 只允许绑到主人自己名下；判断复用 /bind 的同一套逻辑，秘密直接进 vault 加密。
     */
    async function bindLan ({ ownerQQ, label, accessCode, printers } = {}) {
      await ready()
      const qq = String(ownerQQ || '')
      const owner = String(api.config().ownerQQ || '')
      if (!qq || qq !== owner) return { ok: false, code: 'OWNER_ONLY', message: '局域网绑定只提供给主人。' }
      if (!vault.isUnlocked(qq)) {
        return { ok: false, code: 'LOCKED', message: '先解锁主人（/打印机 解锁 <安全码>），再绑定局域网打印机。' }
      }
      const cleaned = (Array.isArray(printers) ? printers : [])
        .map((p) => ({ serial: String(p && p.serial || '').trim(), ip: String(p && p.ip || '').trim(), name: String(p && p.name || '').trim() }))
        .filter((p) => p.serial && /^\d{1,3}(\.\d{1,3}){3}$/.test(p.ip))
      if (!cleaned.length) return { ok: false, code: 'BAD_INPUT', message: '局域网绑定至少要一台打印机：序列号 + IP' }
      try {
        const r = await vault.addBinding(qq, {
          label: String(label || '我的打印机'),
          mode: 'lan',
          accessCode: accessCode ? String(accessCode) : undefined,
          printers: cleaned,
        })
        await audit(qq, 'bind', true, 'lan', r.id)
        // 绑定完立刻固定证书（TOFU 的第一次），让后续每次连接都在校验
        let cert = null
        try {
          const fresh = vault.printers(qq).filter((x) => x.bindingId === r.id)
          if (fresh.length) {
            const got = await ensureCert(fresh[0], { userId: qq, isOwner: true })
            cert = got && got.ok ? { fingerprint256: got.fingerprint256, learned: got.learned === true } : { error: got && (got.error || got.code) }
          }
        } catch (error) {
          cert = { error: String((error && error.message) || error) }
        }
        // 绑定完顺手探一次状态，让面板能立刻说「连上了/连不上」，而不是等下次手动查
        let probe = null
        try {
          const list = vault.printers(qq).filter((x) => x.bindingId === r.id)
          if (list.length) {
            const st = await fetchStatus(list[0], { reveal: false, chat: { userId: qq, kind: 'private', isOwner: true } })
            probe = { ok: st.ok === true, message: st.ok ? '已连上打印机' : String(st.message || '暂时连不上（打印机可能关机或不在同一网段）') }
          }
        } catch (error) {
          probe = { ok: false, message: '绑定成功，但探测失败：' + String((error && error.message) || error) }
        }
        return { ok: true, binding: { id: r.id, label: String(label || ''), mode: 'lan' }, count: cleaned.length, probe, cert }
      } catch (error) {
        return { ok: false, code: error.code || 'BAD_INPUT', message: explain(error) }
      }
    }

    // 面板的局域网绑定：只做形状校验（和面板表单同一套规则），其余原样交给 bindLan
    // （owner 校验、解锁校验、序列号 / IP 校验、证书固定、连通性探测都在里面）。
    // 注册在这里是因为 bindLan 是函数声明之后才可用 —— api.route 是 setup 同步执行的。
    api.route('/lan/bind', async (req) => {
      await ready()
      const b = await body(req)
      const ownerQQ = String((api.config() && api.config().ownerQQ) || '')
      if (!ownerQQ) return { ok: false, code: 'NO_OWNER', message: '没读到主人 QQ，无法绑定局域网打印机。' }
      const label = String(b.label || '').trim() || '局域网打印机'
      const accessCode = String(b.accessCode || '').trim()
      const rows = Array.isArray(b.printers) ? b.printers : []
      const printers = rows
        .map((p) => ({ serial: String(p && p.serial || '').trim(), ip: String(p && p.ip || '').trim(), name: String(p && p.name || '').trim() }))
        .filter((p) => p.serial || p.ip)
      if (!printers.length) return { ok: false, code: 'BAD_INPUT', message: '至少要填一台打印机的序列号 + IP。' }
      const badIndex = printers.findIndex((p) => !SERIAL_RE.test(p.serial) || !IPV4_RE.test(p.ip))
      if (badIndex >= 0) return { ok: false, code: 'BAD_INPUT', message: '第 ' + (badIndex + 1) + ' 行不完整：序列号（4~40 位字母数字，可带 . _ -）和 IP（形如 192.168.1.50）都要填对。' }
      if (!accessCode) return { ok: false, code: 'BAD_INPUT', message: '要填打印机屏幕上那条访问码（Access Code）。' }
      try {
        const r = await bindLan({ ownerQQ, label, accessCode, printers })
        return r || { ok: false, code: 'FAILED', message: '绑定没有成功' }
      } catch (error) {
        return { ok: false, code: (error && error.code) || 'FAILED', message: explain(error) }
      }
    })

    return {
      bindLan,
      helpText: helpPage(3, false),
      run: (arg, msg) => handleCommand(arg, msg),
      summary: () => vault.summary(),
      // 只读数据出口（dashboard()/bindLan() 保留给外部调用方与测试）：
      // 都只给打码值，绝不含 token / 访问码 / 安全码。
      dashboard: () => {
        const s = settings()
        return {
          enabled: s.enabled,
          counts: vault.summary(),
          users: vault.listUsers().map((u) => ({
            qq: String(u.qq),
            qqMasked: maskQQ(u.qq),
            bindings: u.bindings,
            printers: u.printers,
            unlocked: u.unlocked,
            lockedUntil: u.lockedUntil,
            lastSeenAt: u.lastSeenAt,
            bindingList: vault.listBindings(u.qq).map((b) => ({
              id: b.id,
              label: b.label || '',
              mode: b.mode,
              tokenMask: b.tokenMask || '',
              printers: (b.printers || []).map((x) => ({ serialMasked: maskSerial(x.serial), name: x.name || '', model: x.model || '' })),
            })),
          })),
          ownerQQ: String(api.config().ownerQQ || ''),
          ownerOnline: vault.isUnlocked(String(api.config().ownerQQ || '')),
          lanAllowed: s.ownerLocalAllowed,
        }
      },
    }
  },
}

/** 自然语言意图：只在明确提到打印机时调用，避免抢话 */
function detectIntent(text) {
  const t = String(text || '')
  if (/暂停|pause/i.test(t)) return '暂停'
  if (/继续|恢复|resume/i.test(t)) return '继续'
  if (/停止|取消打印|stop/i.test(t)) return '停止'
  if (/拍照|照片|看看.*画面|来张图/i.test(t)) return '拍照'
  if (/进度|到哪|还剩|剩余|多久|状态|完成|好了|失败/i.test(t)) return '状态'
  if (/开灯|关灯|灯/i.test(t)) return /关灯/i.test(t) ? '灯 关' : '灯 开'
  return null
}
