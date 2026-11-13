// panel.js —— 拓竹：一个面板装下设置 / 用户总览 / 局域网绑定 / 审计。
//
// 面板宿主把整份文件当函数体执行：顶层拿到 React / h / ui / call，最后 return 一个组件。
//
// 设置一律走宿主草稿：cfg = { ...DEFAULTS, ...settings, ...draftSettings }，改值只调
// props.setSettings({ [key]: value })。本面板不再自己维护一份草稿，也不再渲染「保存设置」
// 按钮 —— 落盘由页面底部宿主那个「保存设置」统一负责，界面和真实设置永远一致。
// 总开关读写 active（标签页上那个小圆点读的就是草稿里的 ext.bambu-print.active），
// 「模块是否在跑」全部从 cfg.active 派生，不再有第二个开关。
// 秘密（访问码 / 主人安全码）只用 password 输入，提交成功立刻清空、不回显、不进渲染树。
//
// 路由：GET /overview、/lan/status、/audit、/tutk/status；POST /owner/unlock、/owner/lock、
// /lan/bind、/tutk/download。兼容期 /overview 没有 owner / rules 时退回 settings 同名字段；
// /lan/status 不存在时用 /overview.users 里 mode === 'lan' 的凭据兜底（只读 + 提示升级）。

const { useState, useEffect, useRef } = React

const PAGES = [
  { value: 'overview', label: '总览' },
  { value: 'lan', label: '局域网绑定' },
  { value: 'settings', label: '设置' },
  { value: 'audit', label: '审计' },
  { value: 'help', label: '帮助' },
]

// 「风险提示」认过之后记在本机，宿主重开面板也不再显示。
const RISK_ACK_KEY = 'aurabot.bambu-print.riskAck'

const SERIAL_RE = /^[A-Za-z0-9._-]{4,40}$/
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const BAMBUSOURCE_URL = 'https://github.com/ClusterM/open-bamboo-networking/releases'

const MODE_LABEL = { lan: '局域网', cloud: '云端' }
const VALUE_LABELS = {
  '': '跟随默认',
  off: '关闭（群里完全不理）',
  status: '仅状态（只读）',
  control: '允许控制',
  cloud: '云端接口（Bambu 云，需 token）',
  lan: '本地接口（局域网直连，需访问码）',
}

// 面板端的兜底默认值：服务端 /overview.rules 缺失（老宿主 / 老模块）时全靠这份。
const DEFAULTS = {
  active: false,
  multiUser: true,
  groupMode: 'status',
  groupPhoto: true,
  allowGroupName: false,
  defaultInterface: 'cloud',
  ownerInterface: '',
  ownerLocalAllowed: true,
  ownerNoCode: true,
  unlockDays: 7,
  maxBindings: 5,
  requestTimeoutMs: 6000,
  selectedTtlMinutes: 10,
  tutkBridgePath: '',
  tutkLibPath: '',
  tutkTimeoutMs: 20000,
}

const FALLBACK_RULES = {
  groupMode: { kind: 'enum', def: 'status', values: ['off', 'status', 'control'], label: '群模式', hint: '只作用于发起人自己的绑定；绑定者本人还能在自己的「群权限」里再收紧或放宽。' },
  groupPhoto: { kind: 'bool', def: true, label: '群聊允许拍照', hint: '关掉后群里只能看状态，不能要画面。' },
  allowGroupName: { kind: 'bool', def: false, label: '群里允许显示文件名', hint: '默认关：群里文件行显示「已脱敏」，项目名永远不显示。' },
  defaultInterface: { kind: 'enum', def: 'cloud', values: ['cloud', 'lan'], label: '默认接口', hint: '默认云端；非主人用户默认且只能是云端。' },
  ownerInterface: { kind: 'enumAllowEmpty', def: '', values: ['', 'cloud', 'lan'], label: '主人的接口覆盖', hint: '只影响主人自己。' },
  ownerLocalAllowed: { kind: 'bool', def: true, label: '允许主人使用本地接口', hint: '关掉后连主人也一律走云端（本地接口要求打印机和这台电脑在同一网段）。' },
  ownerNoCode: { kind: 'bool', def: true, label: '主人不用安全码', hint: '开着：主人不用解锁。代价是主人的绑定由本机主密钥保管——能读到数据目录的人可以解开主人的那份。' },
  multiUser: { kind: 'bool', def: true, label: '多用户模式', hint: '开着：每个 QQ 各绑各的、互相看不到，别人可以用授权共享。关掉：只服务主人一个人，其他人的命令和工具一律不响应。' },
  unlockDays: { kind: 'int', def: 7, min: 1, max: 30, step: 1, label: '解锁有效期（天）', hint: '到期后内存里的密钥自动清零（1~30 天，默认 7 天）。' },
  maxBindings: { kind: 'int', def: 5, min: 1, max: 20, step: 1, label: '每人最多凭据数', hint: '一个人最多能绑几条凭据（一个云端账号算一条，可含多台）。' },
  requestTimeoutMs: { kind: 'int', def: 6000, min: 2000, max: 20000, step: 500, label: '打印机超时（毫秒）', hint: '等打印机回执最长多久。' },
  selectedTtlMinutes: { kind: 'int', def: 10, min: 1, max: 60, step: 1, label: '群内选择记忆（分钟）', hint: '群里点过「第几台」之后记多久（下一条不用重选）。' },
  tutkBridgePath: { kind: 'text', def: '', label: '抓帧桥路径（留空 = 用模块自带的）', hint: '只有想换成别的桥程序时才填。' },
  tutkLibPath: { kind: 'text', def: '', label: 'BambuSource 库路径（留空 = 桥旁边自动找）', hint: '本模块不打包它（OBN 是 AGPL-3.0）。点下面的「下载」会自动取回并放到桥同目录，国内走加速代理。' },
  tutkTimeoutMs: { kind: 'int', def: 20000, min: 3000, max: 60000, step: 1000, label: '抓帧超时（毫秒）', hint: '云端抓一帧最长等多久（3000~60000）。' },
}

const EMPTY_RISK = [
  '私聊发送同样有风险：私聊记录会以明文留存，撤回并不能可靠消除风险。请优先使用官方授权方式或临时凭据；如确需提供，请先评估风险，事后立即修改密码并检查账号授权与设备绑定情况。',
  '谨慎使用插件：请在你熟悉的「鱼」管理者下使用。',
  '局域网访问码（LAN Access Code）等同于打印机控制权：谁拿到它，谁就能暂停、停止、改温度、发 G-code。',
  '安全码是每个用户自己那份秘密的唯一钥匙：忘了只能清空重绑，找不回来。主人可以免安全码，代价是那把钥匙由这台机器保管（设置里能关掉）。',
  '没有「管理员」这一级：别人看不到你的 token，除非你主动授权。授权就是把自己的 Bambu 凭据限时共享给对方，到期自动失效、随时能撤销；对方始终拿不到你的安全码。',
  '不要在任何群里发安全码、访问码。群里本模块也不接受绑定、解锁、授权等敏感操作。',
]

const TAIL_ACTIONS = {
  unlock: '解锁', lock: '锁定', bind: '绑定', unbind: '解绑', status: '查状态',
  control: '控制', photo: '拍照', grant: '授权', revoke: '撤销授权',
  reset: '重置', 'tutk-download': '下载 BambuSource',
  'owner-unlock': '主人解锁', 'owner-lock': '主人锁定', 'lan-bind': '局域网绑定',
}

function blankRow () {
  return { serial: '', ip: '', name: '' }
}

function fmtTime (ts) {
  const n = Number(ts)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const date = new Date(n > 1e12 ? n : n * 1000)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  } catch (error) { return '—' }
}

return function Panel (props) {
  const given = props || {}
  const notify = function (label, kind) {
    if (typeof given.toast === 'function') given.toast(label, kind)
  }
  const request = typeof call === 'function'
    ? call
    : function () { return Promise.resolve({ ok: false, message: '接口不可用' }) }
  const editable = typeof given.setSettings === 'function'
  const persist = typeof given.save === 'function' ? given.save : null

  // ---- 宿主草稿：cfg 是唯一真相，set 只写草稿 ----
  const configured = Object.assign({}, DEFAULTS, given.settings || {}, given.draftSettings || {})
  const [localPatch, setLocalPatch] = useState({})
  const cfg = editable ? configured : Object.assign({}, configured, localPatch)
  const set = function (key, value) {
    if (editable) {
      given.setSettings({ [key]: value })
      return
    }
    // 老宿主没有 setSettings：只改本页，并只对改的这一项立即落盘（不做整份保存）
    setLocalPatch(function (previous) { return Object.assign({}, previous, { [key]: value }) })
    if (persist) {
      Promise.resolve(persist({ [key]: value })).catch(function (err) {
        notify('保存失败：' + ((err && err.message) || String(err)), 'err')
      })
    }
  }
  const dirty = editable && Object.keys(Object.assign({}, given.settings || {}, given.draftSettings || {})).some(function (key) {
    return JSON.stringify((given.settings || {})[key]) !== JSON.stringify((given.draftSettings || {})[key])
  })

  // ---- 状态 ----
  const [ov, setOv] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState('')
  const [page, setPage] = useState('overview')
  // 风险横幅是否已被「我知道」收起（读 localStorage，读不到就当没认过）
  const [riskAcked, setRiskAcked] = useState(function () {
    try { return window.localStorage.getItem(RISK_ACK_KEY) === '1' } catch (e) { return false }
  })
  const [onlyBound, setOnlyBound] = useState(false)
  const [expanded, setExpanded] = useState({})
  const [lanStatus, setLanStatus] = useState(null)
  const [lanError, setLanError] = useState('')
  const [lanLoading, setLanLoading] = useState(false)
  const [lanLoaded, setLanLoaded] = useState(false)
  const [lanUnsupported, setLanUnsupported] = useState(false)
  const [unlockCode, setUnlockCode] = useState('')
  const [unlockError, setUnlockError] = useState('')
  const [bindLabel, setBindLabel] = useState('局域网打印机')
  const [accessCode, setAccessCode] = useState('')
  const [rows, setRows] = useState([blankRow()])
  const [formError, setFormError] = useState('')
  const [bindResult, setBindResult] = useState(null)
  const [audit, setAudit] = useState(null)
  const [auditError, setAuditError] = useState('')
  const [tutkCheck, setTutkCheck] = useState(null)
  const unlockRef = useRef(null)
  const codeRef = useRef(null)
  const [discovering, setDiscovering] = useState(false)
  const [discovered, setDiscovered] = useState(null)
  const [discoverError, setDiscoverError] = useState('')

  // ---- 读取 ----
  const load = async function () {
    setLoading(true)
    try {
      // GET /overview：不带 body 才是 get()，契约里它是只读路由
      const r = await request('/overview')
      if (!r || r.ok === false) {
        setLoadError((r && r.message) || '接口没有返回数据。')
        setOv(null)
      } else {
        setLoadError('')
        setOv(r)
      }
    } catch (err) {
      setLoadError(String((err && err.message) || err))
      setOv(null)
    } finally {
      setLoading(false)
    }
  }

  const loadLan = async function () {
    setLanLoading(true)
    try {
      const r = await request('/lan/status')
      if (!r || r.ok === false) {
        const code = r && r.code
        if (!r || code === 'NOT_FOUND' || code === 'NO_ROUTE' || code === 'UNSUPPORTED') {
          setLanUnsupported(true)
          setLanStatus(null)
          setLanError('')
        } else {
          setLanError((r && r.message) || '读取局域网状态失败。')
          setLanStatus(null)
          setLanUnsupported(false)
        }
      } else {
        setLanStatus(r)
        setLanUnsupported(false)
        setLanError('')
      }
    } catch (err) {
      const msg = String((err && err.message) || err)
      if (/404|not found|NOT_FOUND/i.test(msg)) {
        setLanUnsupported(true)
        setLanStatus(null)
        setLanError('')
      } else {
        setLanStatus(null)
        setLanError('读取局域网状态失败：' + msg)
      }
    } finally {
      setLanLoaded(true)
      setLanLoading(false)
    }
  }

  const switchPage = function (next) {
    // 离开局域网页就把秘密 state 一起清掉：密码框是非受控的，切页会重挂，
    // 不清就会出现「框里空了但 state 里还留着访问码」的错位。
    if (next !== 'lan') {
      setUnlockCode('')
      setAccessCode('')
      setUnlockError('')
      setFormError('')
      clearSecret(unlockRef)
      clearSecret(codeRef)
    }
    setPage(next)
    if (next === 'lan' && !lanLoaded && !lanLoading) loadLan()
  }

  // 首屏只读一次 /overview + /lan/status：后者只为顶部卡片的「主人是否解锁」，
  // 之后切页不再重复请求（/overview 永远不会因为切页重拉）。
  useEffect(function () {
    load()
    loadLan()
  }, [])

  // ---- 局域网：解锁 / 锁定 / 绑定 ----
  const clearSecret = function (ref) {
    try { if (ref && ref.current) ref.current.value = '' } catch (err) {}
  }

  const unlockOwner = async function () {
    setUnlockError('')
    const code = String(unlockCode || '').trim()
    if (!code) { setUnlockError('先填主人自己设的安全码。'); return }
    setBusy('unlock')
    try {
      const r = await request('/owner/unlock', { code: code })
      if (!r || r.ok === false) {
        setUnlockError((r && r.message) || '解锁没有成功。')
        return
      }
      setUnlockCode('')
      clearSecret(unlockRef)
      notify('主人已解锁')
      await load()
      await loadLan()
    } catch (err) {
      setUnlockError(String((err && err.message) || err))
    } finally {
      setBusy('')
    }
  }

  /** 免安全码：建（或复用）主人的免码账号并立即开一个会话。 */
  const enableNoCode = async function () {
    setUnlockError('')
    setBusy('nocode')
    try {
      const r = await request('/owner/nocode', {})
      if (!r || r.ok === false) {
        setUnlockError((r && r.message) || '开启失败。')
        return
      }
      notify('已开启，不用安全码也能用了')
      await load()
      await loadLan()
    } catch (err) {
      setUnlockError(String((err && err.message) || err))
    } finally {
      setBusy('')
    }
  }

  const lockOwner = async function () {
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm('锁定后要重新输安全码才能再用局域网，确定锁定吗？')
      : true
    if (!ok) return
    setBusy('lock')
    try {
      const r = await request('/owner/lock', {})
      if (!r || r.ok === false) {
        notify((r && r.message) || '锁定没有成功', 'err')
        return
      }
      notify('已锁定')
      await load()
      await loadLan()
    } catch (err) {
      notify('锁定失败：' + String((err && err.message) || err), 'err')
    } finally {
      setBusy('')
    }
  }

  /**
   * 搜索局域网打印机。只拿得到序列号 / IP / 名字 / 型号 —— 访问码不广播。
   * 点一台就把序列号和 IP 填进表单，访问码仍然要手工输。
   */
  const discoverLan = async function () {
    setDiscovering(true)
    setDiscoverError('')
    setDiscovered(null)
    try {
      const r = await request('/lan/discover', { timeoutMs: 3500 })
      if (!r || r.ok === false) {
        setDiscoverError((r && r.message) || '搜索失败。')
        setDiscovered([])
        return
      }
      setDiscovered(Array.isArray(r.devices) ? r.devices : [])
      if (r.note) notify(r.note)
    } catch (err) {
      setDiscoverError(String((err && err.message) || err))
      setDiscovered([])
    } finally {
      setDiscovering(false)
    }
  }

  const useDiscovered = function (device) {
    if (!device) return
    // 填成一行：序列号 + IP + 名字。已有的空行直接复用，避免越点越多
    setRows(function (previous) {
      const empty = previous.length === 1 && !previous[0].serial && !previous[0].ip && !previous[0].name
      const row = { serial: device.serial || '', ip: device.ip || '', name: device.name || '' }
      return empty ? [row] : previous.concat([row])
    })
    notify('已填好「' + (device.name || device.serial || '这台打印机') + '」，还差访问码')
  }

  const patchRow = function (index, key, value) {
    setRows(function (previous) {
      return previous.map(function (row, i) {
        return i === index ? Object.assign({}, row, { [key]: value }) : row
      })
    })
  }
  const addRow = function () { setRows(function (previous) { return previous.concat([blankRow()]) }) }
  const removeRow = function (index) {
    setRows(function (previous) { return previous.length <= 1 ? previous : previous.filter(function (_, i) { return i !== index }) })
  }

  const submitBind = async function () {
    setFormError('')
    setBindResult(null)
    const printers = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {}
      const serial = String(row.serial || '').trim()
      const ip = String(row.ip || '').trim()
      const name = String(row.name || '').trim()
      if (!serial && !ip && !name) continue
      if (!serial) { setFormError('第 ' + (i + 1) + ' 行缺序列号：打印机屏幕上 / 机身贴纸上的那串，4~40 位。'); return }
      if (!SERIAL_RE.test(serial)) { setFormError('第 ' + (i + 1) + ' 行的序列号格式不对：只接受 4~40 位字母、数字和「.」「_」「-」。'); return }
      if (!ip) { setFormError('第 ' + (i + 1) + ' 行缺局域网 IP：形如 192.168.1.50。'); return }
      if (!IP_RE.test(ip)) { setFormError('第 ' + (i + 1) + ' 行的 IP 格式不对：要形如 192.168.1.50 的 IPv4 地址。'); return }
      printers.push({ serial: serial, ip: ip, name: name })
    }
    if (!printers.length) { setFormError('至少填一台打印机：序列号 + 局域网 IP。'); return }
    const code = String(accessCode || '').trim()
    if (!code) { setFormError('要填打印机屏幕上那条访问码（Access Code）：没有它连不上，也不会保存任何东西。'); return }

    setBusy('bind')
    try {
      const r = await request('/lan/bind', {
        label: String(bindLabel || '').trim() || '局域网打印机',
        accessCode: code,
        printers: printers,
      })
      if (!r || r.ok === false) {
        setFormError((r && r.message) || '绑定没有成功。')
        await loadLan()
        return
      }
      // 秘密只在提交这一刻用到：成功立刻清空，不回显、不留在渲染树里
      setAccessCode('')
      clearSecret(codeRef)
      setRows([blankRow()])
      setBindResult(r)
      notify('绑定好了')
      // 绑定会改计数和凭据列表：两份数据都刷一次，别让总览还显示旧台数
      await load()
      await loadLan()
    } catch (err) {
      setFormError(String((err && err.message) || err))
    } finally {
      setBusy('')
    }
  }

  // ---- 审计 / 云端画面 ----
  const loadAudit = async function () {
    setBusy('audit')
    try {
      const r = await request('/audit', { limit: 50 })
      if (!r || r.ok === false) {
        setAuditError((r && r.message) || '读取失败')
        return
      }
      setAuditError('')
      setAudit(Array.isArray(r.audit) ? r.audit : [])
    } catch (err) {
      setAuditError(String((err && err.message) || err))
    } finally {
      setBusy('')
    }
  }

  const checkTutk = async function () {
    setBusy('tutk')
    try {
      const r = await request('/tutk/status')
      if (!r || r.ok !== true) { setTutkCheck({ ok: false, text: (r && r.message) || '检查失败' }); return }
      const bridge = r.bridge || {}
      const lib = r.lib || {}
      if (!bridge.ok) setTutkCheck({ ok: false, text: '抓帧桥不可用：' + (bridge.message || bridge.code || '未知原因') + '（留空即用模块自带的）' })
      else if (!lib.ok) setTutkCheck({ ok: false, text: '桥没问题，只差 BambuSource 库：点右边的「下载」会自动取回；也可以手动从 ' + (r.lib && r.lib.download ? r.lib.download : BAMBUSOURCE_URL) + ' 取 ' + (r.lib && r.lib.file ? r.lib.file : 'BambuSource') })
      else setTutkCheck({ ok: true, text: '都就绪了。桥：' + (bridge.path || '') + '；库：' + (lib.path || '') })
    } catch (err) {
      setTutkCheck({ ok: false, text: '检查失败：' + String((err && err.message) || err) })
    } finally {
      setBusy('')
    }
  }

  const downloadLib = async function () {
    setBusy('lib')
    setTutkCheck({ ok: false, text: '正在下载 BambuSource（分段读取，只拉需要的那几 MB）…' })
    try {
      const r = await request('/tutk/download', { dir: String(cfg.tutkLibPath || '').trim() })
      if (!r || r.ok !== true) { setTutkCheck({ ok: false, text: (r && r.message) || '下载失败' }); return }
      setTutkCheck({
        ok: r.ready === true,
        text: '已下载 ' + (r.version || '') + '（' + Math.round((r.bytes || 0) / 1048576) + 'MB，来自 ' + (r.via || '') +
          (r.proxy ? '（走了加速代理）' : '（直连）') + '），放在 ' + (r.path || '') +
          (r.ready ? '，已经就绪。' : '。不过自检还没通过，点「检查」看差什么。'),
      })
      notify(r.ready ? 'BambuSource 已就绪' : '下载完成，但自检未通过', r.ready ? 'ok' : 'err')
    } catch (err) {
      setTutkCheck({ ok: false, text: '下载失败：' + String((err && err.message) || err) })
    } finally {
      setBusy('')
    }
  }

  // ======== 首屏：loading / 失败 ========
  if (!ov && loading) {
    return h('div', { className: 'ab-grid' },
      h(ui.Card, { title: '拓竹' },
        h(ui.Empty, { icon: '⏳', text: '正在读取面板数据…' })))
  }
  if (!ov) {
    return h('div', { className: 'ab-grid' },
      h(ui.Card, { title: '拓竹' },
        h('div', { className: 'ab-note err' }, loadError || '读取不到面板数据。'),
        h('div', { className: 'ab-flex', style: { marginTop: 8 } },
          h(ui.Btn, { small: true, onClick: function () { load() } }, '重试'))))
  }

  // ======== 数据（/overview 已就绪）========
  const owner = ov.owner && typeof ov.owner === 'object'
    ? ov.owner
    : ((ov.settings && ov.settings.owner && typeof ov.settings.owner === 'object') ? ov.settings.owner : {})
  const users = Array.isArray(ov.users) ? ov.users : []
  const counts = ov.counts && typeof ov.counts === 'object' ? ov.counts : {}
  const countsUsers = counts.users === undefined ? users.length : counts.users
  const countsBound = counts.boundUsers === undefined ? users.filter(function (u) { return Number(u.bindings || 0) > 0 }).length : counts.boundUsers
  const countsBindings = counts.bindings === undefined
    ? users.reduce(function (sum, u) { return sum + Number(u.bindings || 0) }, 0)
    : counts.bindings
  const countsPrinters = counts.printers === undefined
    ? users.reduce(function (sum, u) { return sum + Number(u.printers || 0) }, 0)
    : counts.printers
  const countsUnlocked = counts.unlocked === undefined ? users.filter(function (u) { return u.unlocked === true }).length : counts.unlocked
  const countsGrants = counts.activeGrants === undefined ? null : counts.activeGrants

  const hostAllow = ov.settings && Array.isArray(ov.settings.hostAllow) ? ov.settings.hostAllow : []
  const hostGroupAllow = ov.settings && Array.isArray(ov.settings.hostGroupAllow) ? ov.settings.hostGroupAllow : []
  const allowCount = hostAllow.length
  const groupCount = hostGroupAllow.length

  // rules：优先 /overview.rules，兼容期退回 settings.rules，最后退回内置规则
  const rules = (function () {
    const merged = Object.assign({}, FALLBACK_RULES)
    const source = (ov.rules && typeof ov.rules === 'object' && ov.rules)
      || (ov.settings && ov.settings.rules && typeof ov.settings.rules === 'object' && ov.settings.rules)
      || null
    if (source) {
      Object.keys(source).forEach(function (key) {
        if (!source[key] || typeof source[key] !== 'object') return
        merged[key] = Object.assign({}, merged[key] || {}, source[key])
      })
    }
    return merged
  })()

  const ownerOnline = Boolean(
    (lanStatus && lanStatus.ownerOnline === true) ||
    (owner.online === true)
  )
  // 主人：优先完整 QQ（本机主人界面），老服务端只给打码值时退回打码值
  const ownerQQ = String((owner.qq || (lanStatus && lanStatus.ownerQQ) || '') || '')
  const ownerMasked = String((owner.qqMasked || (lanStatus && lanStatus.ownerMasked) || '') || '')
  const unlockDays = Number(
    (owner.unlockDays || (lanStatus && lanStatus.unlockDays) || cfg.unlockDays)
  ) || Number(cfg.unlockDays) || 7
  const lanAllowed = lanStatus && typeof lanStatus.lanAllowed === 'boolean'
    ? lanStatus.lanAllowed
    : (typeof owner.lanAllowed === 'boolean' ? owner.lanAllowed : cfg.ownerLocalAllowed !== false)

  // 顶部那行现状：用「就绪 / 没解锁」比「已解锁」好懂，也更贴合免码时的实际情况
  const summary = countsUsers + ' 个用户 · ' + countsPrinters + ' 台打印机 · ' +
    (ownerOnline ? (owner.codeless === true ? '主人免安全码' : '主人已解锁') : '主人还没解锁') +
    (cfg.active === true ? '' : ' · 模块关着')

  const isWin = typeof navigator !== 'undefined' && /windows/i.test(String(navigator.userAgent || ''))
  const bambuSourceFile = isWin ? 'BambuSource.dll' : 'libBambuSource.so'
  const bambuSourceAdvice = isWin ? 'obn-windows-x64.zip 里的 lib/v02.09.01/BambuSource.dll' : 'obn-linux-x64.tar.gz 里的 lib/libBambuSource.so'
  const tutkBuiltinPath = String((ov.settings && ov.settings.tutkBuiltinBridgePath) || '')

  // ======== 小部件 ========
  const btn = function (label, onClick, opts) {
    const o = opts || {}
    return h(ui.Btn, { small: o.small !== false, kind: o.kind, disabled: o.disabled, onClick: onClick }, label)
  }
  const note = function (label, kind) {
    return label ? h('div', { className: kind === 'err' ? 'ab-note err' : 'ab-note', style: { marginTop: 8 } }, label) : null
  }
  const grid = function (children) {
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 } }, children)
  }
  const groupTitle = function (title, hint) {
    return h('div', { style: { marginTop: 14, marginBottom: 2 } },
      h('div', { style: { fontSize: 13, fontWeight: 600 } }, title),
      hint ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, lineHeight: 1.6 } }, hint) : null)
  }
  const textInput = function (value, onChange, opts) {
    const o = opts || {}
    return h('input', {
      className: 'ab-input', type: o.type || 'text', min: o.min, max: o.max, step: o.step,
      'data-key': o.key, placeholder: o.placeholder, value: value === undefined || value === null ? '' : value,
      style: Object.assign({ width: '100%' }, o.style || {}),
      onChange: function (e) { onChange(e.target.value) },
      onBlur: o.onBlur,
    })
  }
  // 秘密输入：不进 value（受控值会让每次输入都被清掉），只经 onChange 进 state；
  // 渲染树里永远看不到原文，提交成功后再用 ref 把 DOM 里的值一起清掉。
  const secretInput = function (ref, onChange, opts) {
    const o = opts || {}
    return h('input', {
      ref: ref, type: 'password', autoComplete: 'off', className: 'ab-input',
      'data-secret': o.name, placeholder: o.placeholder, defaultValue: '',
      style: Object.assign({ flex: '1 1 220px', minWidth: 180 }, o.style || {}),
      onChange: function (e) { onChange(e.target.value) },
    })
  }
  const stat = function (label, value) {
    return h('div', { key: 'stat-' + label, style: { minWidth: 96 } },
      h('div', { className: 'ab-small ab-muted' }, label),
      h('div', { style: { fontSize: 18, fontWeight: 600 } }, String(value)))
  }

  // ======== 风险提示（一条横幅，点「我知道」后永久收起）========
  // 完整内容不在这里展开：它搬到了「帮助」页（风险告知 + 本地安全策略）。
  // 认过之后就不再占版面 —— 记在 localStorage，宿主重开面板也还认。
  const serverRisk = typeof ov.risk === 'string' && ov.risk.trim() ? ov.risk.trim() : ''
  const dismissRisk = function () {
    try { window.localStorage.setItem(RISK_ACK_KEY, '1') } catch (e) { /* 无痕模式等：本次仍收起 */ }
    setRiskAcked(true)
  }
  const riskBanner = riskAcked
    ? null
    : h('div', {
      style: {
        padding: '8px 12px', border: '1px solid #e5484d', borderRadius: 8,
        background: 'rgba(229,72,77,.08)', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
      },
    },
    h('span', { style: { color: '#e5484d', fontWeight: 700, fontSize: 13 } }, '⚠️ 高权限设备控制'),
    h('span', { className: 'ab-small', style: { color: '#e5484d', flex: '1 1 220px', lineHeight: 1.6 } },
      '访问码等于打印机控制权，别发到群里。'),
    h(ui.Btn, { small: true, onClick: dismissRisk }, '我知道'),
    h(ui.Btn, {
      small: true, kind: 'ghost',
      onClick: function () { switchPage('help') },
    }, '看完整说明'))

  // ======== 顶部卡片：唯一的总开关（right 插槽，和内置页同位置）========
  const topCard = h(ui.Card, {
    title: '拓竹',
    desc: summary,
    right: h(ui.Switch, {
      on: cfg.active === true,
      title: '总开关：关掉后不再响应打印机命令',
      onChange: function (value) { set('active', value) },
    }),
  },
  h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, lineHeight: 1.7 } },
    cfg.active === true
      ? '开着：会响应打印机相关命令（仍受 Aurabot 的白名单和群权限限制）。'
      : '关着：私聊和群里的打印机命令都不再响应，也不会去连打印机；面板本身还能打开。'),
  dirty
    ? h('div', { className: 'ab-note warn', style: { marginTop: 8 } },
      '设置改过了还没保存：点页面底部的「保存设置」才会生效。')
    : null,
  !editable
    ? h('div', { className: 'ab-note warn', style: { marginTop: 8 } },
      '当前宿主版本较老，拿不到草稿接口：这里的改动只在本页生效，并且每改一项就立刻保存。')
    : null)

  // ======== 页内分页 ========
  const pageNav = h(ui.Seg, { value: page, options: PAGES, onChange: switchPage })

  // ======== ① 总览 ========
  const shownUsers = onlyBound
    ? users.filter(function (u) { return Number(u.bindings || 0) > 0 })
    : users

  // 用户行：key / 显示都用完整 QQ（面板在本机主人自己的浏览器里跑，要认出「这是谁」）。
  // 老服务端只给 qqMasked 时退回打码值，不至于整页认不出人来。
  const userQQ = function (user) { return String((user && (user.qq || user.qqMasked)) || '') }

  const userRow = function (user, index) {
    const item = user || {}
    const key = userQQ(item) || ('u-' + index)
    const open = expanded[key] === true
    const bindings = Array.isArray(item.bindingList) ? item.bindingList : []
    const toggle = function () {
      setExpanded(function (previous) {
        const next = Object.assign({}, previous)
        if (next[key]) delete next[key]
        else next[key] = true
        return next
      })
    }
    return h('div', { key: 'user-' + key, style: { borderBottom: '1px solid rgba(0,0,0,.06)' } },
      h('div', {
        role: 'button',
        tabIndex: 0,
        onClick: toggle,
        onKeyDown: function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
        },
        style: {
          display: 'grid', gridTemplateColumns: '150px 64px 72px 92px 1fr', gap: 8, alignItems: 'center',
          padding: '8px', fontSize: 12, cursor: 'pointer',
        },
      },
      h('span', { style: { fontWeight: 600 } }, userQQ(item) || '—'),
      h('span', { className: 'ab-small ab-muted' }, Number(item.bindings || 0) + ' 条'),
      h('span', { className: 'ab-small ab-muted' }, Number(item.printers || 0) + ' 台'),
      h('span', { className: 'ab-small', style: { color: item.unlocked ? '#2f9e44' : '#888' } }, item.unlocked ? '已解锁' : '未解锁'),
      h('span', { className: 'ab-small ab-muted' },
        '最近活跃 ' + fmtTime(item.lastSeenAt) + (bindings.length ? ' · 点开看打印机' : ''))),
      open
        ? h('div', { style: { padding: '0 8px 10px 8px' } },
          bindings.length
            ? bindings.map(function (binding, i) {
              const b = binding || {}
              const printers = Array.isArray(b.printers) ? b.printers : []
              return h('div', { key: 'bind-' + (b.id || i), style: { marginTop: 6 } },
                h('div', { className: 'ab-small' },
                  h('b', null, b.label || '未命名'),
                  h('span', { className: 'ab-muted' }, ' · ' + (MODE_LABEL[b.mode] || b.mode || '—') +
                    (b.tokenMask ? ' · 凭据 ' + b.tokenMask : '') + ' · ' + printers.length + ' 台')),
                printers.length
                  ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 } },
                    printers.map(function (p, j) {
                      const printer = p || {}
                      return h('span', {
                        key: 'printer-' + (printer.serialMasked || j),
                        className: 'ab-small',
                        style: { padding: '2px 8px', borderRadius: 999, background: 'rgba(0,0,0,.05)' },
                      }, (printer.name || printer.model || '打印机') + ' · ' + (printer.serialMasked || '—'))
                    }))
                  : h('div', { className: 'ab-small ab-muted' }, '这条凭据下面还没有发现打印机'))
            })
            : h('div', { className: 'ab-small ab-muted' }, '这个用户还没有绑定任何凭据。'))
        : null)
  }

  const overviewPage = h(ui.Card, {
    title: '用户与打印机',
    desc: '每行一个用户：谁是、绑了几条凭据、几台打印机、现在解没解锁。点开才看得到他那几条凭据和打印机。序列号打码，token、访问码、安全码一律不出现，这里也不会改任何东西。',
  },
  h('div', { className: 'ab-flex', style: { flexWrap: 'wrap', gap: 16 } },
    stat('已绑定用户', countsBound),
    stat('用户总数', countsUsers),
    stat('凭据', countsBindings),
    stat('打印机', countsPrinters),
    stat('解锁中', countsUnlocked)),
  countsGrants === null || countsGrants === 0
    ? null
    : h('div', { className: 'ab-small ab-muted', style: { marginTop: 4 } }, '生效中的授权 ' + countsGrants + ' 条'),
  h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' } },
    h(ui.Btn, { small: true, kind: onlyBound ? 'primary' : undefined, onClick: function () { setOnlyBound(function (previous) { return !previous }) } },
      onlyBound ? '只看已绑定 ✓' : '只看已绑定'),
    h('span', { className: 'ab-small ab-muted' }, '当前显示 ' + shownUsers.length + ' 人（只是本页筛选，不改设置）')),
  shownUsers.length
    ? h('div', { style: { marginTop: 8 } },
      h('div', {
        style: {
          display: 'grid', gridTemplateColumns: '150px 64px 72px 92px 1fr', gap: 8,
          padding: '6px 8px', fontSize: 12, color: '#666', borderBottom: '2px solid rgba(0,0,0,.1)',
        },
      }, h('span', null, 'QQ'), h('span', null, '凭据'), h('span', null, '打印机'), h('span', null, '状态'), h('span', null, '最近活跃')),
      shownUsers.map(userRow))
    : h(ui.Empty, { icon: '👤', text: onlyBound ? '还没有人绑定过打印机。关掉「只看已绑定」可以看到全部用户。' : '还没有用户绑定过打印机。' }))

  // ======== ② 局域网绑定 ========
  const lanBindings = lanUnsupported
    ? users.reduce(function (acc, user) {
      const list = Array.isArray(user.bindingList) ? user.bindingList : []
      return acc.concat(list.filter(function (b) { return b && b.mode === 'lan' }).map(function (b) {
        return {
          id: b.id, label: b.label, tokenMask: b.tokenMask, printers: b.printers,
          qq: user.qq, qqMasked: user.qqMasked,
        }
      }))
    }, [])
    : (lanStatus && Array.isArray(lanStatus.bindings) ? lanStatus.bindings : [])

  // 顶部状态条：主人解没解锁一眼看到；解锁了就在同一行给「立即锁定」
  const lanStatusLine = h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
    h('span', { className: 'ab-small', style: { fontWeight: 600, color: ownerOnline ? '#2f9e44' : undefined } },
      ownerOnline ? '已解锁（' + unlockDays + ' 天内有效）' : '主人未解锁'),
    h('span', { className: 'ab-small ab-muted' },
      ownerOnline
        ? ('主人 ' + (ownerQQ || ownerMasked || ''))
        : '先解锁，才能把访问码加密保存。'),
    ownerOnline ? btn(busy === 'lock' ? '锁定中…' : '立即锁定', lockOwner, { disabled: busy === 'lock' }) : null)

  // 免安全码时：不需要输任何东西，点一下就建好账号并解锁
  const noCodeAllowed = owner.noCode !== false || owner.codeless === true
  const noCodeBlock = !ownerOnline && noCodeAllowed
    ? h('div', { style: { marginTop: 10 } },
      h('div', { className: 'ab-flex', style: { gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        btn(busy === 'nocode' ? '正在开启…' : '不用安全码，直接开启', enableNoCode, { kind: 'primary', disabled: busy === 'nocode' })),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 4, lineHeight: 1.7 } },
        '主人默认不用安全码：点一下就能用，绑定由这台机器保管。' +
        '代价是：能读到本模块数据目录的人，可以解开主人的绑定；其它用户仍然各用各的安全码，互相看不到。' +
        '想更严一点，可以关掉设置里的「主人不用安全码」，再用下面的安全码方式。'))
    : null

  const unlockForm = !ownerOnline
    ? h('div', { style: { marginTop: 10 } },
      noCodeBlock,
      h('div', { className: 'ab-label', style: { marginTop: noCodeAllowed ? 12 : 0, marginBottom: 4 } },
        noCodeAllowed ? '或者用安全码（如果你设过的话）' : '主人安全码'),
      h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
        secretInput(unlockRef, setUnlockCode, { name: 'owner-code', placeholder: '主人自己设的安全码' }),
        btn(busy === 'unlock' ? '解锁中…' : '解锁', unlockOwner, { kind: noCodeAllowed ? 'outline' : 'primary', disabled: busy === 'unlock' })),
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 4, lineHeight: 1.6 } },
        '安全码只用于这一次提交，成功后立刻清空。'),
      note(unlockError, 'err'))
    : null

  // 发现模式：搜同网段的拓竹打印机。广播里没有访问码，所以点一台只填序列号和 IP。
  const discoverBlock = h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(0,0,0,.06)' } },
    h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      btn(discovering ? '搜索中…' : '搜索局域网打印机', discoverLan, { disabled: discovering }),
      h('span', { className: 'ab-small ab-muted' },
        '同一网段、已开机的打印机会列出来。点一台就把序列号和 IP 填好。')),
    note(discoverError, 'err'),
    Array.isArray(discovered)
      ? (discovered.length
        ? h('div', { style: { marginTop: 8 } },
          h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } },
            '搜到 ' + discovered.length + ' 台。访问码不会广播，选好后还要手工填。'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            discovered.map(function (d, i) {
              const key = (d && (d.serial || d.ip)) || ('dev-' + i)
              return h('div', {
                key: 'discovered-' + key,
                style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '4px 8px', borderRadius: 6, background: 'rgba(0,0,0,.03)' },
              },
              h('span', { className: 'ab-small', style: { fontWeight: 600 } }, (d && (d.name || d.serial)) || '未知打印机'),
              h('span', { className: 'ab-small ab-muted' },
                [d && d.model, d && d.serial, d && d.ip].filter(function (x) { return x }).join(' · ')),
              d && d.signal ? h('span', { className: 'ab-small ab-muted' }, '信号 ' + d.signal) : null,
              btn('用这台', function () { useDiscovered(d) }, { small: true }))
            })))
        : h('div', { className: 'ab-small ab-muted', style: { marginTop: 6 } },
          '这个网段没搜到拓竹打印机。确认打印机已开机联网，并且和这台电脑在同一个局域网。'))
      : null)

  const lanAllowedWarn = lanAllowed === false
    ? h('div', { className: 'ab-note err', style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      h('span', null, '设置里「允许主人使用本地接口」是关的：绑上了也用不了局域网。'),
      btn('去设置', function () { switchPage('settings') }, { small: true }))
    : null

  const rowNode = function (row, index) {
    const value = row || blankRow()
    return h('div', { key: 'lan-row-' + index, style: { display: 'flex', gap: 8, marginBottom: 6, flexWrap: 'wrap', alignItems: 'center' } },
      textInput(value.serial, function (v) { patchRow(index, 'serial', v) }, { key: 'serial-' + index, placeholder: '序列号，例如 01S00A123456789', style: { flex: '2 1 200px' } }),
      textInput(value.ip, function (v) { patchRow(index, 'ip', v) }, { key: 'ip-' + index, placeholder: 'IP，例如 192.168.1.50', style: { flex: '1 1 140px' } }),
      textInput(value.name, function (v) { patchRow(index, 'name', v) }, { key: 'name-' + index, placeholder: '名字（可空）', style: { flex: '1 1 120px' } }),
      rows.length > 1 ? btn('删除', function () { removeRow(index) }, { small: true, kind: 'ghost' }) : null)
  }

  const bindForm = h('div', { style: { marginTop: 10 } },
    grid([
      h('div', { key: 'lan-label', style: { minWidth: 0 } },
        h('div', { className: 'ab-label', style: { marginBottom: 4 } }, '凭据名'),
        textInput(bindLabel, setBindLabel, { key: 'lan-label', placeholder: '例如：我的 A1' }),
        h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, lineHeight: 1.6 } }, '只是一个方便认的名字。同一条凭据下的几台打印机共用一个访问码。')),
      h('div', { key: 'lan-code', style: { minWidth: 0 } },
        h('div', { className: 'ab-label', style: { marginBottom: 4 } }, '访问码（Access Code）'),
        secretInput(codeRef, setAccessCode, { name: 'lan-access-code', placeholder: '打印机屏幕上那条 Access Code', style: { width: '100%' } }),
        h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, lineHeight: 1.6 } }, '打印机屏幕上那 8 位。只用于这次提交，成功后立即清空，之后也查不回来。')),
    ]),
    h('div', { className: 'ab-small ab-muted', style: { margin: '8px 0 4px' } }, '要绑的打印机：序列号 + 局域网 IP（名字可以不填）。点上面的「搜索局域网打印机」能自动填。'),
    rows.map(rowNode),
    h('div', { className: 'ab-flex', style: { gap: 8, marginTop: 4, flexWrap: 'wrap' } },
      btn('+ 添加一台', addRow, { small: true }),
      btn(busy === 'bind' ? '提交中…' : '提交绑定', submitBind, { kind: 'primary', disabled: busy === 'bind' })),
    note(formError, 'err'))

  const bindSuccess = bindResult
    ? h('div', { style: { marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid #2f9e44', background: 'rgba(47,158,68,.07)' } },
      h('div', { className: 'ab-small', style: { color: '#2f9e44', fontWeight: 700 } }, '✓ 绑定成功（' + (bindResult.count || 1) + ' 台）'),
      bindResult.probe
        ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 2 } },
          bindResult.probe.ok ? '已连上打印机，可以去查状态了。' : '暂时连不上：' + (bindResult.probe.message || '未知原因'))
        : null,
      h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, lineHeight: 1.6 } },
        bindResult.cert && bindResult.cert.fingerprint256
          ? '已固定打印机自己的自签名证书（' + String(bindResult.cert.fingerprint256).slice(0, 16) + '…），以后每次连接都会校验它。'
          : '绑定成功了，但证书还没固定（' + ((bindResult.cert && bindResult.cert.error) || '打印机可能没开机') + '）。下次连上它时会自动学一次，之后才严格校验。'),
      h('div', { style: { marginTop: 6 } }, btn('知道了', function () { setBindResult(null) }, { small: true })))
    : null

  const lanList = lanBindings.length
    ? h('div', { style: { marginTop: 12 } },
      h('div', { className: 'ab-small ab-muted', style: { marginBottom: 4 } }, '已绑定的局域网凭据（序列号打码）'),
      h('div', { style: { border: '1px solid rgba(0,0,0,.08)', borderRadius: 8, overflow: 'hidden' } },
        lanBindings.map(function (b, i) {
          const printers = Array.isArray(b.printers) ? b.printers : []
          return h('div', {
            key: 'lan-binding-' + (b.id || i),
            style: { padding: '6px 8px', fontSize: 12, borderBottom: '1px solid rgba(0,0,0,.06)' },
          },
          h('div', null,
            h('b', null, b.label || '未命名'),
            h('span', { className: 'ab-muted' },
              (b.tokenMask ? ' · 凭据 ' + b.tokenMask : '') + ' · ' + printers.length + ' 台' +
              ((b.qq || b.qqMasked) ? ' · ' + (b.qq || b.qqMasked) : ''))),
          printers.length
            ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 2 } },
              printers.map(function (p) {
                const printer = p || {}
                return (printer.name || printer.model || '打印机') + ' · ' + (printer.serialMasked || '—')
              }).join('，'))
            : null)
        })))
    : h(ui.Empty, { icon: '🖨️', text: '还没有绑定局域网打印机。点上面的「搜索局域网打印机」或直接填序列号和 IP。' })

  const lanPage = h(ui.Card, {
    title: '局域网绑定',
    desc: '只有主人能用。可以点「搜索局域网打印机」自动填好序列号和 IP，再补上屏幕上的访问码即可。访问码加密保存，提交后立即清空，之后也查不回来。',
  },
  lanStatusLine,
  unlockForm,
  lanAllowedWarn,
  discoverBlock,
  lanLoading && !lanLoaded ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 8 } }, '正在读取局域网状态…') : null,
  note(lanError, 'err'),
  lanUnsupported
    ? h('div', { className: 'ab-note warn', style: { marginTop: 8 } }, '当前模块版本不支持面板绑定，请升级。')
    : null,
  lanUnsupported ? null : bindForm,
  bindSuccess,
  lanList)

  // ======== ③ 设置（服务端 rules 驱动）========
  const valueLabel = function (v) {
    if (VALUE_LABELS[v] !== undefined) return VALUE_LABELS[v]
    return String(v)
  }
  const hintOf = function (key, rule) {
    const base = typeof rule.hint === 'string' && rule.hint.trim() ? rule.hint.trim() : (FALLBACK_RULES[key] ? FALLBACK_RULES[key].hint : '')
    if (key !== 'groupMode') return base
    const allowText = '谁能在私聊里用、哪些群能用，都跟着 Aurabot 自己的白名单走（目前私聊 ' + allowCount + ' 个号、群 ' + groupCount + ' 个群，另外还有主人）。本模块不再单独维护一份名单。'
    return base ? base + ' ' + allowText : allowText
  }
  const clampNumber = function (key, rule) {
    const min = Number.isFinite(Number(rule.min)) ? Number(rule.min) : null
    const max = Number.isFinite(Number(rule.max)) ? Number(rule.max) : null
    const raw = cfg[key]
    let n = Number(raw)
    if (raw === '' || raw === null || raw === undefined || !Number.isFinite(n)) {
      const fallback = rule.def !== undefined ? rule.def : (FALLBACK_RULES[key] ? FALLBACK_RULES[key].def : 0)
      const f = Number(fallback)
      set(key, Number.isFinite(f) ? f : 0)
      return
    }
    n = Math.round(n)
    if (min !== null) n = Math.max(min, n)
    if (max !== null) n = Math.min(max, n)
    if (Number(raw) === n) return
    set(key, n)
  }
  const controlOf = function (key, rule) {
    // 规则来自 /overview.rules（lib/settings.mjs 同一份表）；老宿主没有 rules 时用 FALLBACK_RULES 兜底。
    // kind 只有 bool / int / enum / enumAllowEmpty / text 五种，未知一律按文本渲染。
    const kind = String(rule.kind || (FALLBACK_RULES[key] ? FALLBACK_RULES[key].kind : 'text') || 'text')
    if (kind === 'bool') {
      return h(ui.Switch, { on: cfg[key] === true, onChange: function (v) { set(key, v) } })
    }
    if (kind === 'int' || kind === 'number') {
      return h('input', {
        className: 'ab-input', 'data-key': key, type: 'number', style: { width: '100%' },
        min: Number.isFinite(Number(rule.min)) ? Number(rule.min) : undefined,
        max: Number.isFinite(Number(rule.max)) ? Number(rule.max) : undefined,
        step: Number(rule.step) || 1,
        value: cfg[key] === undefined || cfg[key] === null ? '' : cfg[key],
        onChange: function (e) {
          const raw = e.target.value
          set(key, raw === '' ? '' : Number(raw))
        },
        onBlur: function () { clampNumber(key, rule) },
      })
    }
    if (kind === 'enum' || kind === 'enumAllowEmpty') {
      let values = Array.isArray(rule.values) ? rule.values.slice() : []
      if (kind === 'enumAllowEmpty' && values.indexOf('') < 0) values = [''].concat(values)
      const options = values.map(function (v) { return { value: String(v), label: valueLabel(String(v)) } })
      const current = cfg[key] === undefined || cfg[key] === null
        ? (rule.def === undefined ? '' : String(rule.def))
        : String(cfg[key])
      return h(ui.Select, { value: current, options: options, onChange: function (v) { set(key, String(v)) } })
    }
    const placeholder = key === 'tutkBridgePath' ? tutkBuiltinPath : (key === 'tutkLibPath' ? bambuSourceFile : undefined)
    return textInput(cfg[key], function (v) { set(key, v) }, { key: key, placeholder: placeholder })
  }
  const fieldBlock = function (key) {
    const rule = rules[key] || {}
    const hint = hintOf(key, rule)
    return h('div', { key: 'field-' + key, style: { minWidth: 0 } },
      h('div', { className: 'ab-label', style: { marginBottom: 4 } }, rule.label || (FALLBACK_RULES[key] ? FALLBACK_RULES[key].label : key)),
      controlOf(key, rule),
      hint ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, lineHeight: 1.6 } }, hint) : null)
  }

  const tlsBlock = h('div', { style: { marginTop: 8 } },
    h('div', { className: 'ab-small', style: { fontWeight: 600 } }, '局域网 TLS（打印机自签名证书）'),
    h('div', { className: 'ab-flex', style: { alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 } },
      h('span', { className: 'ab-small ab-muted' }, '控制面 8883 与摄像头 6000：首次连接自动学习，之后严格校验'),
      h('span', { className: 'ab-small', style: { color: '#2f9e44' } }, '始终开启')),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 2, lineHeight: 1.6 } },
      '证书变了会拒绝连接并说明原因。确认是自己重刷了固件，就私聊发「/打印机 证书 信任」重新固定；想看当前指纹发「/打印机 证书」。'),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 4, lineHeight: 1.7 } },
      '证书内容（含公钥）和访问码一起加密存在保险库里，磁盘上看不到明文；面板和日志里只出现分段指纹。'),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 4, lineHeight: 1.7 } },
      '画面端口 322（X1/H2/P2S/X2D）的证书单独固定：启动 ffmpeg 前先比对指纹，对不上就不抓拍。'))

  const tutkActions = h('div', { style: { marginTop: 10 } },
    h('div', { className: 'ab-flex', style: { gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
      btn(busy === 'tutk' ? '检查中…' : '检查云端画面组件', checkTutk, { disabled: busy === 'tutk' }),
      btn(busy === 'lib' ? '下载中…（只拉需要的几 MB）' : '下载 BambuSource 库', downloadLib, { kind: 'primary', disabled: busy === 'lib' }),
      tutkCheck
        ? h('span', { className: 'ab-small', style: { color: tutkCheck.ok ? '#2f9e44' : '#e5484d' } }, tutkCheck.text)
        : h('span', { className: 'ab-small ab-muted' }, '「检查」只读文件、不连打印机。')),
    h('div', { className: 'ab-small ab-muted', style: { marginTop: 6, lineHeight: 1.7 } },
      '本模块不打包 BambuSource（OBN 是 AGPL-3.0）。点「下载」会自动取回并放到桥同目录，国内走加速代理；也可以手动从 ',
      h('a', { href: BAMBUSOURCE_URL, target: '_blank', rel: 'noreferrer', style: { color: '#4f8cff' } }, 'Releases'),
      ' 取 ' + bambuSourceAdvice + '。'))

  const settingsPage = h(ui.Card, {
    title: '设置',
    desc: '每一项的范围和说明都由服务端同一份规则给出。改完点页面底部的「保存设置」才生效——面板里不会再画第二个保存按钮。',
  },
  groupTitle('多用户与准入', '关掉多用户模式后，这个模块只服务主人一个人。'),
  grid([fieldBlock('multiUser'), fieldBlock('groupMode'), fieldBlock('groupPhoto'), fieldBlock('allowGroupName')]),
  groupTitle('接口与时长'),
  grid([
    fieldBlock('defaultInterface'), fieldBlock('ownerInterface'), fieldBlock('ownerLocalAllowed'),
    fieldBlock('unlockDays'), fieldBlock('maxBindings'), fieldBlock('requestTimeoutMs'), fieldBlock('selectedTtlMinutes'),
  ]),
  tlsBlock,
  groupTitle('云端画面（TUTK）', '抓帧桥随模块预编译好，留空即用；只差一份 BambuSource 库。'),
  grid([fieldBlock('tutkBridgePath'), fieldBlock('tutkLibPath'), fieldBlock('tutkTimeoutMs')]),
  tutkActions)

  // ======== ⑤ 帮助：风险告知 + 本地安全策略 ========
  // 风险卡「我知道」收起后，完整内容在这里；也是查「这东西到底怎么保护我」的地方。
  const helpPage = h(ui.Card, {
    title: '帮助',
    desc: '这里说明这个模块会碰什么、怎么保护它，以及哪些地方只是「尽力而为」。',
  },
  groupTitle('风险告知', '这些一旦出事是实打实的，先看一眼。'),
  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    EMPTY_RISK.map(function (line, index) {
      return h('div', { key: 'help-risk-' + index, className: 'ab-small', style: { lineHeight: 1.75 } },
        h('span', { style: { fontWeight: 600 } }, (index + 1) + '. '), line)
    })),
  serverRisk
    ? h('div', { className: 'ab-small ab-muted', style: { marginTop: 4, lineHeight: 1.7 } }, '模块自述：' + serverRisk)
    : null,

  groupTitle('本地安全策略', '秘密怎么存、谁能解开、哪里会拒绝连接。'),

  h('div', { className: 'ab-small', style: { lineHeight: 1.85 } },
    h('div', null, '· ', h('b', null, '每个用户一把独立密钥。'), '绑定数据用随机密钥加密（AES-256-GCM），密钥由该用户自己的安全码经 scrypt 派生。没有「主人后门」，谁也解不开别人的。'),
    h('div', null, '· ', h('b', null, '主人可以免安全码。'), '这时那把密钥由本机的 host-key.bin（32 字节随机、0600）保管。代价是：能读到本模块数据目录的人可以解开主人的绑定。设置里可以关掉这个便利。'),
    h('div', null, '· ', h('b', null, '控制面与摄像头要求先固定证书。'), '局域网 MQTT(8883) 与 MJPEG(6000) 第一次连接只握手读证书、不发访问码；之后每次都用它当锚点严格校验。没固定过证书就拒绝发访问码，不会「先连上试试」。'),
    h('div', null, '· ', h('b', null, '画面端口(322)单独核对。'), 'X1/H2/P2S/X2D 的画面走 ffmpeg，它没法做证书 pin；所以模块在启动 ffmpeg 之前先握手取证书、和固定过的指纹比对，对不上就不启动，访问码连 stdin 都不进。'),
    h('div', null, '· ', h('b', null, '云端用系统 CA。'), '云端 MQTT 用系统根证书 + 主机名校验，不会因为配置里有自签锚点就降级成不校验。'),
    h('div', null, '· ', h('b', null, '凭据不进命令行、不进日志。'), '访问码和 token 不会出现在进程参数里；错误文本会先擦掉秘密再返回。'),
    h('div', null, '· ', h('b', null, '群聊默认脱敏。'), '群里只说进度、层数、温度；文件名显示「已脱敏」，项目名永远不显示。'),
    h('div', null, '· ', h('b', null, '会话到期自动清。'), '解锁只在内存里保留 DEK，到期或「立即锁定」就清零；重启模块也清零。')),

  groupTitle('它是怎么连打印机的', '两种接口，各自的前提不同。'),
  h('div', { className: 'ab-small', style: { lineHeight: 1.85 } },
    h('div', null, '· ', h('b', null, '云端接口'), '（默认，所有用户）：Bambu 账号登录换 token，走云端 MQTT 看状态、下命令。'),
    h('div', null, '· ', h('b', null, '本地接口'), '（主人，或拿到授权的人）：局域网直连，需要打印机屏幕上的访问码。要求打印机和这台电脑在同一网段。'),
    h('div', null, '· ', h('b', null, '画面'), '：有局域网地址就优先走局域网（A1/P1 走 MJPEG，X1 系列走 RTSPS）；否则回退云端 TUTK，需要一份 BambuSource 库。')),

  groupTitle('命令速查', '这些也可以直接对她说；聊天里发「/打印机 帮助」会分页给出同样的内容。'),
  h('div', { className: 'ab-small ab-muted', style: { lineHeight: 1.8 } },
    h('div', null, '/打印机 状态 · 暂停 · 继续 · 停止 · 灯 开/关 · 速度 1-4 · 温度 喷嘴=220 热床=60 · 拍照'),
    h('div', null, '/打印机 列表 · 授权 <对方QQ> [分钟] · 撤销 <授权编号> · 审计 · 群权限'),
    h('div', null, '/打印机 解锁 · 锁定 · 设置安全码 · 改安全码（只走私聊）'),
    h('div', null, '主人额外：/打印机 绑定 本地 … · 解绑 <编号> · 接口 云端|本地|自动 · 证书 [序号]'),
    h('div', { style: { marginTop: 4 } }, '聊天里「/打印机 帮助」第 1 页是风险、第 2 页是数据存储策略、之后是命令；「帮助 2」直接翻页。')))

  // ======== ④ 审计 ========
  const auditRows = Array.isArray(audit) ? audit : (Array.isArray(ov.audit) ? ov.audit : [])
  const auditList = auditRows.map(function (row, index) {
    const item = row || {}
    return h('div', {
      key: 'audit-' + index,
      style: {
        display: 'grid', gridTemplateColumns: '110px 130px 90px 56px 1fr', gap: 8,
        padding: '6px 8px', fontSize: 12,
        background: index % 2 ? 'transparent' : 'rgba(0,0,0,.028)',
        borderBottom: '1px solid rgba(0,0,0,.06)',
      },
    },
    h('span', { className: 'ab-small ab-muted' }, fmtTime(item.at)),
    // 操作者显示完整 QQ（本机主人界面）；老服务端只给 actorMasked 时退回打码值
    h('span', null, item.actor || item.actorMasked || '—'),
    h('span', null, TAIL_ACTIONS[item.action] || item.action || '—'),
    h('span', { style: { color: item.ok ? '#2f9e44' : '#e5484d' } }, item.ok ? '成功' : '失败'),
    h('span', { className: 'ab-small ab-muted' }, item.note || ''))
  })

  const auditPage = h(ui.Card, {
    title: '审计',
    desc: '解锁、绑定、控制、授权各记一行。操作者显示完整 QQ（这台电脑上的主人自己看）；备注里不会有密码、访问码或 token。',
    right: btn(busy === 'audit' ? '读取中…' : '读取最近 50 条', loadAudit, { disabled: busy === 'audit' }),
  },
  auditList.length
    ? h('div', { style: { border: '1px solid rgba(0,0,0,.08)', borderRadius: 8, overflow: 'hidden' } },
      h('div', {
        style: {
          display: 'grid', gridTemplateColumns: '110px 130px 90px 56px 1fr', gap: 8,
          padding: '6px 8px', fontSize: 12, color: '#666', borderBottom: '2px solid rgba(0,0,0,.1)',
        },
      }, h('span', null, '时间'), h('span', null, '操作者'), h('span', null, '动作'), h('span', null, '结果'), h('span', null, '备注')),
      auditList)
    : h(ui.Empty, { icon: '🧾', text: '还没有审计记录，点右上角「读取最近 50 条」看看。' }),
  note(auditError, 'err'))

  // 帮 助页按前后顺序放在最后；这个三元链要保持和 PAGES 一致
  const pageBody = page === 'overview'
    ? overviewPage
    : page === 'lan'
      ? lanPage
      : page === 'settings'
        ? settingsPage
        : page === 'help'
          ? helpPage
          : auditPage

  return h('div', { className: 'ab-grid' },
    riskBanner,
    topCard,
    pageNav,
    pageBody)
}