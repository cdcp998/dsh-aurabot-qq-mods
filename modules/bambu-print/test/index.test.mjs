// test/index.test.mjs —— 装配层集成测试。
// 用假的 api + 假打印机管理器 + 假云端登录驱动真实 vault / policy / status，验证：
// 权限门、群聊脱敏、多台反问、授权隔离（管理员拿不到别人的 token）、云端登录、接口选择。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mod from '../index.mjs'
import { createVault as createVaultFromLib } from '../lib/vault.mjs'

const FAST_KDF = { N: 1024, r: 8, p: 1 }
const OWNER = '100001'
const USER = '200002'
const OTHER = '300003'
const GROUP = '700001'
const SECRET = 'kR7#mQp2Lz'
const LANCODE = 'LANCODE-7788'
const CLOUD_TOKEN = 'CLOUD-TOKEN-do-not-leak-987654321'

function makeApi (dir, cfg = {}) {
  // 总开关的真名是 active（宿主的子标签页圆点也读它）；enabled 只是老配置的兼容读法。
  const settings = Object.assign({
    active: true, users: USER, groupMode: 'status',
    groupPhoto: true, allowGroupName: false, unlockDays: 7, maxBindings: 5,
    requestTimeoutMs: 2000, selectedTtlMinutes: 10, defaultInterface: 'cloud',
    ownerInterface: '', ownerLocalAllowed: true, tutkBridgePath: '', tutkTimeoutMs: 8000,
  }, cfg)
  const replies = []
  const onebotCalls = []
  const commands = []
  const routes = new Map()
  const tools = []
  const contexts = []
  const handlers = []
  const printer = { status: null, calls: [] }
  const captureStats = { count: 0 }
  const tutkMintStats = { count: 0 }
  const devices = { list: [{ serial: '01S00C000000001', name: 'X1C', model: 'X1C', ip: '192.168.1.60', accessCode: LANCODE }] }
  const manager = {
    targetKey: (t) => [t.mode, t.host, t.serial].join('|'),
    closeAll () {},
    async status (target) {
      if (typeof printer.status === 'function') return printer.status(target)
      return printer.status || { ok: false, error: '没有假状态' }
    },
    async command (target, action, params) {
      printer.calls.push({ target: { ...target }, action, params })
      return { ok: true, acked: true }
    },
  }
  const fakeSession = () => ({
    async login () { return { ok: true, accessToken: CLOUD_TOKEN, uid: '123456', region: 'us' } },
    async requestCode () { return { ok: true, channel: 'email' } },
    async submitCode () { return { ok: true, accessToken: CLOUD_TOKEN, uid: '123456', region: 'us' } },
    async submitTfa () { return { ok: true, accessToken: CLOUD_TOKEN, uid: '123456', region: 'us' } },
  })
  const api = {
    id: 'bambu-print',
    settings: () => settings,
    saveSettings: (patch) => Object.assign(settings, patch),
    dataDir: (...p) => path.join(dir, ...p),
    // 私聊白名单现在来自 Aurabot 自己的 allow.private（模块不再单独维护）
    config: () => ({
      ownerQQ: OWNER,
      // 准入名单来自 Aurabot 自己：私聊 + 群都走 cfg.allow（模块不再维护第二份）
      allow: {
        private: String(settings.users || '').split(/[,，\s]+/).filter(Boolean),
        groups: String(cfg.groupAllow === undefined ? GROUP : cfg.groupAllow).split(/[,，\s]+/).filter(Boolean),
      },
    }),
    isOwner: (qq) => String(qq) === OWNER,
    log: { info () {}, warn () {}, error () {}, debug () {} },
    reply: async (msg, text) => { replies.push({ chatId: msg.chatId, text: String(text) }) },
    sendImage: async (chatId, src) => { replies.push({ chatId, image: String(src) }) },
    // onebot 桩：记下调用，方便断言「帮助走了合并转发」
    onebot: async (action, params) => { api.__onebot.push({ action, params }); return {} },
    command: (c) => commands.push(c),
    route: (p, fn) => routes.set(p, fn),
    tool: (fn) => tools.push(fn),
    rule: () => {},
    context: (fn) => contexts.push(fn),
    on: (event, fn) => handlers.push({ event, fn }),
    onDispose: () => {},
    defineTool: (t) => t,
    core: { http: { body: async (req) => req.__body || {}, query: (req) => req.__query || {} } },
    __bambuTestHooks: {
      kdf: FAST_KDF,
      printerManager: manager,
      captureFrame: async () => { captureStats.count++; return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]) },
      listDevices: async () => ({ ok: true, devices: devices.list.map((d) => ({ ...d })) }),
      createCloudLogin: () => fakeSession(),
      mintTutcode: async () => {
        tutkMintStats.count++
        return { ok: true, uid: 'TUTKUID0123456789', authkey: 'AUTH', passwd: 'PASS', region: 'us', url: 'bambu:///tutk?uid=TUTKUID0123456789&authkey=AUTH&passwd=PASS&region=us' }
      },
      captureTutkFrame: async () => ({ ok: true, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]) }),
    },
  }
  api.__routes = routes
  api.__tools = tools
  api.__contexts = contexts
  api.__replies = replies
  api.__onebot = onebotCalls
  api.__commands = commands
  api.__handlers = handlers
  api.__settings = settings
  api.__printer = printer
  api.__devices = devices
  api.__capture = captureStats
  api.__tutkMint = tutkMintStats
  return api
}

/**
 * 模拟宿主 src/core/modules.js start() 的行为：先把 defaults 里「配置里还没有」的键写进配置，
 * 再调 setup()。这一步很关键——defaults 里写了 active:false 的话，老用户配置里的 enabled:true
 * 会在 setup 之前就被覆盖掉，升级一次就静默停机。boot 必须照宿主来，否则测不出这个回归。
 */
async function boot (dir, cfg) {
  const def = mod.default || mod
  const seeded = Object.assign({}, cfg)
  for (const key of Object.keys(def.defaults || {})) {
    if (!(key in seeded)) seeded[key] = def.defaults[key]
  }
  const api = makeApi(dir, seeded)
  // 让测试能直接看保险箱状态（判断「免码账号到底开没开会话」这类事）。
  // setup() 里是用 (testHooks.createVault || createVault) 实例化的，包一层就能抓到实例。
  const realCreate = api.__bambuTestHooks.createVault
  api.__bambuTestHooks.createVault = (options) => {
    const v = realCreate ? realCreate(options) : createVaultFromLib(options)
    api.__vault = v
    return v
  }
  api.__exports = def.setup(api) || {}
  return api
}

const msg = (over) => Object.assign({
  kind: 'private', chatId: 'private:' + USER, userId: USER, groupId: '', nickname: '用户',
  role: '', text: '', messageId: 'm1', images: [], stickers: [], records: [], forwards: [], raw: {},
}, over)

async function say (api, text, over) {
  const m = msg(Object.assign({ text }, over || {}))
  for (const h of api.__handlers.filter((x) => x.event === 'message')) {
    const handled = await h.fn(m)
    if (handled) return true
  }
  return false
}
/**
 * 取最后一次合并转发：返回 { call, nodes, text }。
 * nodes 是 onebot 的 messages 数组，text 把每页正文拼起来方便断言。
 */
const lastForward = (api) => {
  const calls = (api.__onebot || []).filter((c) => /forward/.test(String(c.action)))
  const call = calls.length ? calls[calls.length - 1] : null
  if (!call) return { call: null, nodes: [], text: '' }
  const nodes = Array.isArray(call.params.messages) ? call.params.messages : []
  const text = nodes.map((n) => {
    const data = n && n.data ? n.data : n
    return typeof data === 'string' ? data : String((data && data.content) || '')
  }).join('\n')
  return { call, nodes, text }
}
const route = (api, p, body) => api.__routes.get(p)({ __body: body || {}, __query: body || {} })
const lastText = (api) => api.__replies.filter((r) => r.text).pop()?.text || ''

const runningReport = () => ({
  print: {
    gcode_state: 'RUNNING', mc_percent: '42', mc_remaining_time: '98',
    gcode_start_time: String(Math.floor(Date.now() / 1000) - 3600),
    layer_num: '56', total_layer_num: '132', subtask_name: 'Benchy', gcode_file: 'Benchy.3mf',
    nozzle_temper: '215', nozzle_target_temper: '220', bed_temper: '60', bed_target_temper: '60',
    wifi_signal: '-55',
  },
})

/** 给某个用户设置安全码并解锁（面板/命令两条路径都走真实 vault）。 */
async function setupUser (api, qq, { owner = false } = {}) {
  const over = { userId: qq, chatId: 'private:' + qq }
  await say(api, '/打印机 设置安全码 ' + SECRET, over)
  return { api, qq, over }
}

/** 云端登录绑定（非主人的唯一路径），设备列表可定制。 */
async function loginCloud (api, qq, devices) {
  if (devices) api.__devices.list = devices
  const r = await route(api, '/login', { qq, account: 'me@example.com', password: 'pw-' + qq, region: 'us' })
  assert.equal(r.ok, true, '云端登录应当成功：' + JSON.stringify(r))
  return r
}

/** 直接调 api.tool 注册的工厂，模拟宿主在某个会话里取到的工具定义。 */
function toolsAt (api, chat) {
  const out = []
  for (const fn of api.__tools) {
    const r = fn({ chat })
    if (Array.isArray(r)) out.push(...r)
    else if (r) out.push(r)
  }
  return out.filter(Boolean)
}

/** 某个会话里能不能拿到 bambu_printer（拿不到返回 null）。 */
const bambuToolAt = (api, chat) => toolsAt(api, chat).find((t) => t.name === 'bambu_printer') || null

/** 直接调 api.context 注册的 handler，模拟宿主拼出来的群上下文。 */
const contextAt = (api, chat) => api.__contexts.map((fn) => String(fn({ chat }) || '')).join('')

/** 主人用局域网绑定（只有主人可用）。 */
async function bindOwnerLan (api) {
  return route(api, '/bind', { qq: OWNER, mode: 'lan', label: '我的 A1', accessCode: LANCODE, printers: [{ serial: '01S00A123456789', ip: '192.168.1.50', name: 'A1', model: 'A1' }] })
}

test('主人：局域网绑定成功；非主人：局域网绑定被拒绝（只给主人）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    const denied = await route(api, '/bind', { qq: USER, mode: 'lan', accessCode: LANCODE, printers: [{ serial: '01S00A123456789', ip: '192.168.1.50' }] })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'OWNER_ONLY')
    assert.equal(JSON.stringify(denied).includes(LANCODE), false)

    await setupUser(api, OWNER)
    const ok = await bindOwnerLan(api)
    assert.equal(ok.ok, true)
    assert.equal(JSON.stringify(ok).includes(LANCODE), false)
    const raw = await readFile(path.join(dir, 'vault.json'), 'utf8')
    assert.equal(raw.includes(LANCODE), false, 'vault.json 不能有明文访问码')
    assert.equal(raw.includes(SECRET), false, 'vault.json 不能有明文安全码')
    assert.equal(raw.includes(CLOUD_TOKEN), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('非主人：云端登录后自动同步设备；token 加密保存且任何响应都不回显', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    const r = await loginCloud(api, USER)
    assert.equal(r.count, 1)
    assert.equal(JSON.stringify(r).includes(CLOUD_TOKEN), false, '登录响应不能带 token')
    const list = await route(api, '/bindings', { qq: USER })
    assert.equal(list.ok, true)
    assert.equal(JSON.stringify(list).includes(CLOUD_TOKEN), false)
    assert.match(list.bindings[0].tokenMask, /^••••/)
    const raw = await readFile(path.join(dir, 'vault.json'), 'utf8')
    assert.equal(raw.includes(CLOUD_TOKEN), false)
    await say(api, '/打印机 列表')
    assert.match(lastText(api), /X1C/)
    assert.equal(lastText(api).includes(CLOUD_TOKEN), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('群聊默认脱敏：文件名/项目名不出现，进度、已打印、剩余时间保留', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    await say(api, '/打印机 状态', { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, role: 'member', messageId: 'm2' })
    const reply = lastText(api)
    assert.match(reply, /42%/)
    assert.match(reply, /已打印/)
    assert.match(reply, /剩余/)
    assert.match(reply, /文件：已脱敏/)
    assert.doesNotMatch(reply, /Benchy/)
    assert.doesNotMatch(reply, /.3mf/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('群聊只读：全局 status 拒绝暂停；用户把自己的群权限调到 control 后才允许', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    const groupOver = { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, role: 'member', messageId: 'm3' }
    await say(api, '/打印机 暂停', groupOver)
    assert.match(lastText(api), /只允许看状态|只允许查看状态/)
    assert.equal(api.__printer.calls.length, 0)
    // 绑定者本人（这里是非主人）在私聊里把自己的群权限调到 control
    await say(api, '/打印机 群权限 控制')
    assert.match(lastText(api), /允许控制/)
    await say(api, '/打印机 暂停', groupOver)
    assert.equal(api.__printer.calls.length, 1)
    assert.equal(api.__printer.calls[0].action, 'pause')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('多台打印机：无选择时用合并转发列出每台，回复「1」后给出状态', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await loginCloud(api, USER, [
      { serial: '01S00C000000001', name: 'X1C', model: 'X1C', ip: '192.168.1.60', accessCode: LANCODE },
      { serial: '01S00C000000002', name: 'P1S', model: 'P1S', ip: '192.168.1.61', accessCode: LANCODE },
    ])
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }

    await say(api, '/打印机 状态')
    // 多台未指定 → 合并转发，每台一个节点
    const fwd = lastForward(api)
    assert.ok(fwd.call, '多台时应当走合并转发，实际：' + JSON.stringify(api.__onebot.map((c) => c.action)))
    assert.equal(fwd.nodes.length, 2, '应当每台一个节点，实际 ' + fwd.nodes.length)
    assert.match(fwd.text, /X1C/)
    assert.match(fwd.text, /P1S/)
    // 序列号打码，不能给全串
    assert.match(fwd.text, /0{4,}|•/, '序列号应当打码')
    assert.doesNotMatch(fwd.text, /01S00C000000001/, '不能出现完整序列号')
    // 每个节点是「编号 + 名字 + 型号/序列号」的结构，点开能一眼认出哪台
    const first = fwd.nodes[0].data.content
    assert.match(first, /^1\. /, '第一个节点应当以编号开头：' + first)
    assert.match(first, /X1C/, '节点里要有型号/名字')
    const second = fwd.nodes[1].data.content
    assert.match(second, /^2\. /, '第二个节点编号应当是 2')
    assert.match(second, /P1S/)
    // 不再往聊天里刷纯文本
    assert.equal(api.__replies.filter((r) => r.text && /有多台打印机/.test(r.text)).length, 0, '不该再用纯文本刷屏')

    // 回「1」照样能选中
    await say(api, '1')
    assert.match(lastText(api), /42%/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('多台未指定：合并转发发不出去时退回纯文本清单，仍能按编号选', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await loginCloud(api, USER, [
      { serial: '01S00C000000001', name: 'X1C', model: 'X1C', ip: '192.168.1.60', accessCode: LANCODE },
      { serial: '01S00C000000002', name: 'P1S', model: 'P1S', ip: '192.168.1.61', accessCode: LANCODE },
    ])
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    // 老宿主：三个 forward 接口都不认
    api.onebot = async (action) => { if (/forward/.test(action)) throw new Error('不支持'); return {} }

    await say(api, '/打印机 状态')
    const text = lastText(api)
    assert.match(text, /有多台打印机/, '应当退回纯文本')
    assert.match(text, /X1C/)
    assert.match(text, /P1S/)
    assert.doesNotMatch(text, /01S00C000000001/, '退回文本里序列号也要打码')

    await say(api, '1')
    assert.match(lastText(api), /42%/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('别人（含主人）默认看不到 token，也不能操作；被授权后立刻可用且仍无 token', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER + ',' + OTHER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }

    // 主人也没绑定：列表为空、状态被拦住
    await say(api, '/打印机 列表', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.match(lastText(api), /还没绑定/)
    await say(api, '/打印机 状态', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.match(lastText(api), /还没绑定/)

    // 另一个白名单用户 OTHER：同样看不到
    await say(api, '/打印机 列表', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.match(lastText(api), /还没绑定/)

    // 用户授权给 OTHER —— 立即生效，不需要任何码
    await say(api, '/打印机 授权 ' + OTHER + ' 30 status,control')
    const issued = lastText(api)
    assert.match(issued, /已授权给/)
    assert.match(issued, /立即生效/)
    assert.doesNotMatch(issued, /授权码/)

    // OTHER 马上就能看到并控制
    await say(api, '/打印机 列表', { userId: OTHER, chatId: 'private:' + OTHER })
    const listText = lastText(api)
    assert.match(listText, /X1C/)
    assert.equal(listText.includes(CLOUD_TOKEN), false, '受权人也看不到 token 明文')

    await say(api, '/打印机 状态 1', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.match(lastText(api), /42%/)

    // 受权人不需要自己的安全码/绑定，就能控制（用的是绑定者的凭据）
    await say(api, '/打印机 暂停', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.equal(api.__printer.calls.length > 0, true, '受权人能下发控制（用的是绑定者的凭据）：' + lastText(api))
    assert.equal(api.__printer.calls[api.__printer.calls.length - 1].action, 'pause')

    // 但 token 依然拿不到：受权人没有自己的保险箱
    const theirBindings = await route(api, '/bindings', { qq: OTHER })
    assert.equal(theirBindings.ok, false, '受权人拿不到别人的绑定')

    // 撤销后立刻不能再用
    const grantId = (await route(api, '/overview')).grants[0].id
    await say(api, '/打印机 撤销 ' + grantId)
    await say(api, '/打印机 列表', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.match(lastText(api), /还没绑定/)

    // 不能授权给自己
    await say(api, '/打印机 授权 ' + USER + ' 30 status')
    assert.match(lastText(api), /不用授权给自己/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('接口选择：非主人恒云端；主人可切本地并落到 mode=lan', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    // 非主人切本地 → 拒绝
    await say(api, '/打印机 接口 本地')
    assert.match(lastText(api), /只有主人/)
    // 主人：设安全码 → 局域网绑定 → 切本地 → 状态走 LAN
    await setupUser(api, OWNER)
    assert.equal((await bindOwnerLan(api)).ok, true)
    await say(api, '/打印机 接口 本地', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.match(lastText(api), /本地接口/)
    await say(api, '/打印机 状态', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.equal(api.__printer.calls.length, 0, '状态查询不算控制命令')
    assert.match(lastText(api), /42%|通道：本地接口/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('群聊里发安全码/登录/绑定命令会被拒绝，不会执行', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await say(api, '/打印机 设置安全码 ' + SECRET, { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, role: 'member' })
    assert.match(lastText(api), /只能在私聊/)
    const raw = await readFile(path.join(dir, 'vault.json'), 'utf8').catch(() => '')
    assert.equal(raw.includes(SECRET), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('面板 /groupperm：需解锁、只接受合法值、返回最新偏好', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await loginCloud(api, USER)
    const locked = await route(api, '/groupperm', { qq: USER, groupMode: 'control' })
    assert.equal(locked.ok, true, '刚登录完是解锁状态')
    assert.equal(locked.prefs.groupMode, 'control')
    const bad = await route(api, '/groupperm', { qq: USER, groupMode: 'admin' })
    assert.equal(bad.ok, false)
    const photo = await route(api, '/groupperm', { qq: USER, groupPhoto: false, groupShowName: true })
    assert.equal(photo.ok, true)
    assert.equal(photo.prefs.groupPhoto, false)
    assert.equal(photo.prefs.groupShowName, true)
    assert.equal(JSON.stringify(photo).includes(CLOUD_TOKEN), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('回归：合并转发之后 api.command.run 必须返回非空（否则宿主会再让模型回一句）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER + ',' + OWNER })
    await setupUser(api, USER)
    // 宿主 hub 的 onCommand 是 if (reply) 才认为「命令处理过了」，
    // 返回空串 = 没处理 → 继续走模型 → 用户会看到「这条命令没法执行」这种插话。
    const cmd = api.__commands.find((c) => c.name === '打印机')
    assert.ok(cmd, '应当注册了 /打印机 命令')

    // 帮助：转发成功 → 必须非空
    const helpReply = await cmd.run('帮助', msg({ userId: USER, chatId: 'private:' + USER }))
    assert.ok(String(helpReply || '').length > 0, '帮助转发后 run 不能返回空，否则宿主会接着让模型回话')
    assert.equal(api.__onebot.filter((c) => /forward/.test(c.action)).length >= 1, true, '应当真的发了合并转发')

    // 帮助：forward 全失败 → 退回文本，同样非空
    api.onebot = async (action) => { if (/forward/.test(action)) throw new Error('不支持'); return {} }
    const fbReply = await cmd.run('帮助', msg({ userId: USER, chatId: 'private:' + USER }))
    assert.match(String(fbReply), /帮助 1\/6/, '回退文本要能直接当回复发出去')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('插件名是「拓竹」，帮助与转发节点都用这个名字', async () => {
  const def = mod.default || mod
  assert.equal(def.name, '拓竹', '模块对外名字应当是「拓竹」')
  assert.equal(def.id, 'bambu-print', 'id 不变（改名不影响安装路径）')

  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await say(api, '/打印机 帮助')
    const fwd = lastForward(api)
    assert.ok(fwd.call, '帮助应当走合并转发')
    // 转发节点的作者名也跟着改
    assert.equal(fwd.call.params.messages[0].data.name, '拓竹')
    // 回退文本的标题同样用新名
    api.onebot = async (action) => { if (/forward/.test(action)) throw new Error('不支持'); return {} }
    await say(api, '/打印机 帮助 1')
    assert.match(lastText(api), /^拓竹 · 帮助 1\/6/, '帮助标题要用新名：' + lastText(api).split('\n')[0])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('多用户模式开关：关掉后只服务主人，别人的绑定/命令一律不响应', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    // 默认开着：两个用户都能用
    const api = await boot(dir, { users: USER + ',' + OWNER })
    assert.equal(api.__settings.multiUser, true, '默认应当是多用户模式')
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    await say(api, '/打印机 状态', { userId: USER, chatId: 'private:' + USER })
    assert.match(lastText(api), /42%/, '多用户模式下普通用户能用')

    // 关掉：普通用户立刻不响应，主人照旧
    api.saveSettings({ multiUser: false })
    const before = api.__replies.length
    await say(api, '/打印机 状态', { userId: USER, chatId: 'private:' + USER })
    assert.equal(api.__replies.length, before, '单用户模式下不该有任何回应（连报错都不给）')

    // 群聊里也一样不响应
    const beforeGroup = api.__replies.length
    await say(api, '/打印机 状态', { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, userId: USER, role: 'member' })
    assert.equal(api.__replies.length, beforeGroup, '单用户模式下群里也不响应')

    // 主人仍然能用
    await setupUser(api, OWNER)
    await bindOwnerLan(api)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    await say(api, '/打印机 状态', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.match(lastText(api), /42%/, '单用户模式下主人照常能用')

    // 模型工具也拿不到（不能从工具入口绕过）
    const tools = api.__tools.flatMap((fn) => { try { const r = fn({ chat: { kind: 'private', userId: USER } }); return [].concat(r || []) } catch { return [] } })
    assert.equal(tools.length, 0, '单用户模式下普通用户不该拿到 bambu_printer 工具：' + JSON.stringify(tools.map((t) => t.name)))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('帮助用合并转发：默认一条塞进全部页，含风险与存储策略', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)

    await say(api, '/打印机 帮助')
    const fwd = lastForward(api)
    assert.ok(fwd.call, '应当用合并转发发送帮助，实际 onebot 调用：' + JSON.stringify(api.__onebot.map((c) => c.action)))
    assert.equal(fwd.nodes.length, 6, '默认要把 6 页全塞进同一条转发，实际 ' + fwd.nodes.length + ' 页')
    const all = fwd.text

    // 合并转发里不写「帮助 N/6」：卡片本身就是折叠的一串，页码只是噪音。
    assert.doesNotMatch(all, /帮助 \d+\/\d+/, '合并转发的节点里不该出现页码')
    // 第 1 页：风险告知（含「私聊也会留明文」和「撤回不可靠」）
    assert.match(all, /① 风险/)
    assert.match(all, /风险/)
    assert.match(all, /私聊记录会以明文留存/)
    assert.match(all, /撤回并不能可靠消除风险/)
    assert.match(all, /事后立即修改密码/)
    assert.match(all, /访问码 = 打印机控制权/)
    // 第 2 页：本地存储策略
    assert.match(all, /② 数据存在哪/)
    assert.match(all, /modules-data/)
    assert.match(all, /host-key/)
    // 第 6 页：安全码与解锁
    assert.match(all, /⑥ 安全码与解锁/)
    assert.match(all, /暂停 · 继续 · 停止/)
    assert.match(all, /0 表示关加热/)
    assert.match(all, /群里只能暂停\/继续，停止必须私聊/)
    assert.match(all, /OAuth/)
    assert.match(all, /默认 30 分钟、只给看状态/)
    assert.match(all, /默认 10 条/)
    assert.match(all, /至少 8 位/)

    // 每页都不长（一页一条折叠卡片，太长照样没人看）
    for (const node of fwd.nodes) assert.ok(String(node).split('\n').length <= 16, '单页太长：' + String(node).slice(0, 40))

    // 不再往聊天里刷一坨纯文本
    assert.equal(api.__replies.filter((r) => r.text && /拓竹 · 帮助/.test(r.text)).length, 0, '帮助不该再用普通文本刷屏')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('合并转发按会话类型选 action；失败时退回文本且仍能指定页码', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { groupAllow: GROUP })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }

    // 群聊：用 send_group_forward_msg，带 group_id
    await say(api, '/打印机 帮助', { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, userId: USER, role: 'member' })
    const groupCall = api.__onebot.filter((c) => c.action === 'send_group_forward_msg').pop()
    assert.ok(groupCall, '群聊应当用 send_group_forward_msg')
    assert.equal(groupCall.params.group_id, GROUP)
    assert.ok(Array.isArray(groupCall.params.messages) && groupCall.params.messages.length === 6)

    // 私聊：用 send_private_forward_msg，带 user_id
    await say(api, '/打印机 帮助', { userId: USER, chatId: 'private:' + USER })
    const privCall = api.__onebot.filter((c) => c.action === 'send_private_forward_msg').pop()
    assert.ok(privCall, '私聊应当用 send_private_forward_msg')
    assert.equal(privCall.params.user_id, USER)

    // 三个 forward 接口都失败 → 退回分页文本，且「帮助 2」指的是回退文本的第 2 页
    api.onebot = async (action) => { if (/forward/.test(action)) throw new Error('不支持'); return {} }
    await say(api, '/打印机 帮助 2')
    const fallback = lastText(api)
    assert.match(fallback, /帮助 2\/6/, '退回文本时仍要认页码')
    assert.match(fallback, /modules-data/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('帮助按角色分页：非主人 6 页看不到局域网，主人 7 页', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)
    await say(api, '/打印机 帮助')
    const userFwd = lastForward(api)
    assert.equal(userFwd.nodes.length, 6, '非主人应当只有 6 页')
    assert.doesNotMatch(userFwd.text, /绑定 本地/, '非主人不该看到局域网绑定')
    assert.doesNotMatch(userFwd.text, /证书/, '非主人不该看到证书说明')

    await setupUser(api, OWNER)
    await say(api, '/打印机 帮助', { userId: OWNER, chatId: 'private:' + OWNER })
    const ownerFwd = lastForward(api)
    assert.equal(ownerFwd.nodes.length, 7, '主人应当多一页')
    // 合并转发里不写页码；主人那页的圈号要排第 7
    assert.match(ownerFwd.text, /⑦ 主人专用/)
    assert.match(ownerFwd.text, /主人专用/)
    assert.match(ownerFwd.text, /绑定 本地/)
    assert.match(ownerFwd.text, /证书/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// review P2-4 / P1-4：以前这条用例名义测 TUTK，实际一直走局域网（云端设备带了 LAN ip + 访问码）。
// 现在拆成两条，分别覆盖「证书学不到就不抓拍」和「真的走 TUTK 铸码 + 桥」。

test('拍照（LAN）：纯局域网打印机摄像头证书学不到 → 拒绝抓拍，不把访问码交给未校验的对端', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, OWNER)
    assert.equal((await bindOwnerLan(api)).ok, true)
    // 学证书失败：这是 review P1-4 / P2-4 的关键分支（旧实现会拿空锚点直接抓帧）
    api.__bambuTestHooks.learnCameraCert = async () => ({ ok: false, code: 'TLS_NO_CERT', error: '端口 6000 没回证书' })
    const capture = api.__capture
    const before = capture.count

    // 走群聊路径（私聊的拍照/控制权限判定另有既有问题，见给 Lead 的说明），这里只验证抓拍分支的 fail-closed
    await say(api, '/打印机 拍照', { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, userId: OWNER, role: 'member' })

    assert.equal(api.__replies.filter((r) => r.image).length, 0, '证书没固定就不该发出图片')
    assert.equal(capture.count, before, '注入的 captureFrame 不能被调用（否则访问码已经发出去了）')
    const text = lastText(api)
    assert.match(text, /拍照失败/, '应当明确失败：' + text)
    assert.match(text, /证书|不抓拍/, '要说清是证书问题：' + text)
    assert.equal(text.includes(LANCODE), false, '回复里不能有访问码')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('拍照（云端 + LAN 地址）：LAN 证书学不到 → 不走局域网抓帧，改走 TUTK 且不回显访问码', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { tutkBridgePath: '/opt/tutk-bridge' })
    await setupUser(api, USER)
    // 云端设备带局域网信息：旧实现会优先拿空锚点走 LAN，把访问码发给未校验的对端
    await loginCloud(api, USER)
    api.__bambuTestHooks.learnCameraCert = async () => ({ ok: false, code: 'TLS_NO_CERT', error: '端口 6000 没回证书' })
    const capture = api.__capture
    const mint = api.__tutkMint
    const before = { capture: capture.count, mint: mint.count }
    api.__bambuTestHooks.captureViaBridge = async () => ({ ok: true, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]), via: 'mjpeg' })

    await say(api, '/打印机 群权限 拍照 开')
    await say(api, '/打印机 拍照', { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, role: 'member' })

    assert.equal(capture.count, before.capture, 'LAN 证书没固定时绝不能调用 captureFrame（访问码会流出）')
    assert.equal(mint.count, before.mint + 1, '云端打印机应当回退到 TUTK 铸码')
    const image = api.__replies.filter((r) => r.image).pop()
    assert.ok(image, '应当通过 TUTK 出图：' + lastText(api))
    assert.equal(JSON.stringify(api.__replies).includes(LANCODE), false, '回复里不能有访问码')
    assert.equal(JSON.stringify(api.__replies).includes(CLOUD_TOKEN), false, '回复里不能有云端 token')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('拍照（TUTK 分支）：纯云端设备（无 LAN 地址）→ 真铸码 + 走桥出图，不回显凭据', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { tutkBridgePath: '/opt/tutk-bridge' })
    await setupUser(api, USER)
    // 纯云端设备：没有 ip / accessCode，只能走 TUTK
    await loginCloud(api, USER, [{ serial: '01S00C000000002', name: 'P1S', model: 'P1S' }])
    const mint = api.__tutkMint
    const capture = api.__capture
    const before = { mint: mint.count, capture: capture.count }
    let bridgeAsked = null
    api.__bambuTestHooks.captureViaBridge = async (opts) => {
      bridgeAsked = opts
      return { ok: true, jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]), via: 'mjpeg' }
    }

    await say(api, '/打印机 群权限 拍照 开')
    await say(api, '/打印机 拍照', { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, role: 'member' })

    assert.equal(mint.count, before.mint + 1, '必须真的铸了一次 ttcode（证明走的是 TUTK，不是 LAN）')
    assert.equal(capture.count, before.capture, '纯云端设备不该走局域网抓帧')
    assert.ok(bridgeAsked, '应当调用抓帧桥')
    assert.match(String(bridgeAsked.url || ''), /^bambu:\/\/\/tutk/, '桥拿到的是铸码后的 TUTK 地址')

    const image = api.__replies.filter((r) => r.image).pop()
    assert.ok(image, '应当发出图片：' + lastText(api))
    assert.match(image.image, /^base64:\/\//)
    const all = JSON.stringify(api.__replies) + '\n' + lastText(api)
    assert.equal(all.includes(CLOUD_TOKEN), false, '回复里不能有云端 token')
    assert.equal(all.includes(LANCODE), false, '回复里不能有访问码')
    assert.equal(all.toLowerCase().includes('authkey'), false, '回复里不能回显 ttcode')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('回复里不再出现撤回相关文案，也不再调 delete_msg', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    // 撤回已整体移除：不管 onebot 支不支持，都不该再调 delete_msg
    api.onebot = async (action) => { if (action === 'delete_msg') throw new Error('no permission'); return {} }

    await say(api, '/打印机 设置安全码 ' + SECRET)
    const regText = lastText(api)
    assert.doesNotMatch(regText, /撤回/, '设置安全码的回复里不该提撤回：' + regText)
    assert.equal(regText.includes(SECRET), false, '回复里不能回显安全码')

    await say(api, '/打印机 解锁 ' + SECRET)
    const unlockText = lastText(api)
    assert.doesNotMatch(unlockText, /撤回/, '解锁的回复里不该提撤回：' + unlockText)
    assert.match(unlockText, /已解锁/)

    assert.equal(api.__onebot.filter((c) => c.action === 'delete_msg').length, 0, '不该再调用撤回接口')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('解锁有效期按天：默认 7 天 / 最小 1 天 / 最大 30 天，旧的分钟配置会迁移', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, USER)

    const dflt = await route(api, '/unlock', { qq: USER, code: SECRET })
    assert.equal(dflt.ok, true)
    assert.equal(dflt.unlockDays, 7, '默认 7 天')
    assert.ok(dflt.until - Date.now() > 6.9 * 86400000)

    api.__settings.unlockDays = 30
    const thirty = await route(api, '/unlock', { qq: USER, code: SECRET })
    assert.equal(thirty.unlockDays, 30, '改成 30 天立即生效')

    api.__settings.unlockDays = 0
    assert.equal((await route(api, '/unlock', { qq: USER, code: SECRET })).unlockDays, 1, '下界 1 天')

    api.__settings.unlockDays = 999
    assert.equal((await route(api, '/unlock', { qq: USER, code: SECRET })).unlockDays, 30, '上界 30 天')

    // 只有旧分钟配置时：按天向上取整迁移（15 分钟 → 1 天）
    const legacy = await boot(dir)
    assert.equal((await route(legacy, '/overview')).settings.unlockDays, 7)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('面板 /tutk/download：注入下载成功 → 返回路径/版本/是否就绪，不泄露任何凭据', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const modDir = path.join(dir, 'module')
    const bridgeDir = path.join(modDir, 'assets', 'tutk-bridge')
    await (await import('node:fs/promises')).mkdir(bridgeDir, { recursive: true })
    const exeName = process.platform === 'win32' ? 'bambu-tutk-bridge.exe' : 'bambu-tutk-bridge-linux-x64'
    const libName = process.platform === 'win32' ? 'BambuSource.dll' : 'libBambuSource.so'
    const fsp = await import('node:fs/promises')
    // 假桥必须可执行：checkBridgeBinary 在非 Windows 上会 access(X_OK)，
    // 而 writeFile 建出来是 0644（CI 的 Linux runner 会因此判 MISSING）。
    await fsp.writeFile(path.join(bridgeDir, exeName), Buffer.alloc(2048, 1))
    if (process.platform !== 'win32') await fsp.chmod(path.join(bridgeDir, exeName), 0o755)
    await fsp.writeFile(path.join(bridgeDir, libName), Buffer.alloc(128 * 1024, 2))

    const api = await boot(dir)
    api.dir = modDir
    let asked = null
    api.__bambuTestHooks.downloadBambuSource = async (opts) => {
      asked = opts
      return { ok: true, path: path.join(bridgeDir, libName), bytes: 5606400, version: 'v2.3.0', via: 'githubproxy.cc', proxy: true, mode: 'range', sha256: 'a'.repeat(64), verified: true }
    }

    // 这条路由会写盘、写下东西还会被 dlopen，所以要主人解锁才能用。
    const locked = await route(api, '/tutk/download', {})
    assert.equal(locked.ok, false)
    assert.equal(locked.code, 'LOCKED', '未解锁主人不能触发下载')
    assert.equal(asked, null, '被拦下时不应该真的去下载')

    await setupUser(api, OWNER)
    const r = await route(api, '/tutk/download', {})
    assert.equal(r.ok, true)
    // 默认落到数据目录，不写进模块目录：插件盯着模块目录，一改就热重载、解锁会话被清空。
    assert.equal(asked.destDir, path.join(api.dataDir(), 'bambusource'), '默认落到数据目录而不是模块目录')
    assert.equal(r.version, 'v2.3.0')
    assert.equal(r.proxy, true)
    assert.equal(r.verified, true, '有钉死哈希时要如实回报已校验')
    assert.equal(r.ready, true, '库放好后自检应通过')
    assert.equal(JSON.stringify(r).includes(CLOUD_TOKEN), false)

    // 下载失败：如实报错 + 保留 code
    api.__bambuTestHooks.downloadBambuSource = async () => ({ ok: false, code: 'ALL_SOURCES_FAILED', error: '所有下载源都失败了，请手动下载：https://github.com/ClusterM/open-bamboo-networking/releases' })
    const bad = await route(api, '/tutk/download', {})
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'ALL_SOURCES_FAILED')
    assert.match(bad.message, /手动下载/)

    // 指定目录时用它，而不是桥目录
    api.__bambuTestHooks.downloadBambuSource = async (opts) => { asked = opts; return { ok: true, path: 'x', bytes: 1, version: 'v1', via: 'github.com', proxy: false, mode: 'range' } }
    const custom = path.join(dir, 'libs')
    const r2 = await route(api, '/tutk/download', { dir: custom })
    assert.equal(r2.ok, true)
    assert.equal(asked.destDir, custom)

    // 填的是**完整库文件路径**时，落盘名也要用用户填的那个（review 复查 P2）
    const customLib = path.join(dir, 'libs2', 'custom-source' + path.extname(libName))
    const r3 = await route(api, '/tutk/download', { dir: customLib })
    assert.equal(r3.ok, true)
    assert.equal(asked.destDir, path.join(dir, 'libs2'), '库文件路径要拆成父目录')
    assert.equal(asked.fileName, 'custom-source' + path.extname(libName), '自定义文件名要透传给下载器')
    assert.notEqual(asked.fileName, libName, '不能退回标准名，否则运行时按自定义路径找不到库')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
test('授权依赖所有者保持解锁：主人锁上后受权人收到明确提示', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER + ',' + OTHER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    await say(api, '/打印机 授权 ' + OTHER + ' 30 status')
    assert.match(lastText(api), /已授权给/)
    // 主人锁定 → 秘密不在内存里，受权人拿不到
    await say(api, '/打印机 锁定')
    await say(api, '/打印机 列表', { userId: OTHER, chatId: 'private:' + OTHER })
    // 授权记录还在，但解不出打印机（列表为空或提示先解锁）
    const afterLock = lastText(api)
    assert.ok(/还没绑定|解锁/.test(afterLock), '锁上没有秘密时不能假装查到：' + afterLock)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('授权范围严格生效：只给 status 就不能控制，只给 photo 也能在列表里看到', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER + ',' + OTHER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }

    await say(api, '/打印机 授权 ' + OTHER + ' 30 status')
    assert.match(lastText(api), /已授权给/)
    await say(api, '/打印机 状态 1', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.match(lastText(api), /42%/)
    const before = api.__printer.calls.length
    await say(api, '/打印机 暂停', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.equal(api.__printer.calls.length, before, '只有 status 范围，不能下发命令')
    assert.match(lastText(api), /没有「控制」范围|没有控制权限/)

    // 只给拍照的授权：也应该能在列表里看到（否则 /拍照 找不到目标）
    const api2 = await boot(dir, { users: USER + ',' + OTHER })
    await say(api2, '/打印机 解锁 ' + SECRET)
    await say(api2, '/打印机 授权 ' + OTHER + ' 30 photo')
    await say(api2, '/打印机 列表', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.match(lastText(api2), /X1C/)
    // 只有拍照范围：/拍照 不会被范围拦下（拍不拍得到另说，不能报「没有拍照范围」）
    await say(api2, '/打印机 拍照', { userId: OTHER, chatId: 'private:' + OTHER })
    assert.doesNotMatch(lastText(api2), /没有「拍照」范围/, '有 photo 范围就不该被范围拒绝')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('私聊准入继承 Aurabot 白名单：不在 allow.private 里的人用不了', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    // 只把 USER 放进 Aurabot 的私聊白名单，OUTSIDER 虽然是本模块老用户也不放行
    const api = await boot(dir, { users: USER })
    const OUTSIDER = '400004'
    // 业务命令被拒（帮助文本仍可看，只是告知用法）
    await say(api, '/打印机 状态', { userId: OUTSIDER, chatId: 'private:' + OUTSIDER })
    assert.match(lastText(api), /白名单/)

    // 授权也不会把人变成可用用户：授权只是共享别人的打印机，仍需在 Aurabot 白名单里
    await setupUser(api, USER)
    await loginCloud(api, USER)
    await say(api, '/打印机 授权 ' + OUTSIDER + ' 30 status')
    assert.match(lastText(api), /已授权给/)
    const gut = await route(api, '/overview')
    assert.equal(gut.settings.users.includes(OUTSIDER), false, '模块不再有自己的私聊名单')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('只读出口与绑定入口：dashboard() 只给打码值，bindLan() 只认主人', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    const exp = api.__exports
    assert.equal(typeof exp.dashboard, 'function')
    assert.equal(typeof exp.bindLan, 'function')

    const data = exp.dashboard()
    assert.equal(data.enabled, true)
    assert.equal(Array.isArray(data.users), true)
    const me = data.users.find((u) => (u.bindingList || []).length)
    assert.ok(me, '应当有绑定记录')
    // 完整 QQ 给人认；序列号 / 凭据仍打码；不含任何秘密
    assert.equal(me.qq, USER, 'dashboard 给完整 QQ')
    assert.match(me.qqMasked, /\*/)
    const dumped = JSON.stringify(data)
    assert.equal(dumped.includes(CLOUD_TOKEN), false, 'dashboard 不能带 token')
    assert.equal(dumped.includes(LANCODE), false, 'dashboard 不能带访问码')
    assert.equal(dumped.includes(SECRET), false, 'dashboard 不能带安全码')
    for (const b of me.bindingList) {
      for (const p of b.printers) assert.ok(!('serial' in p), '只给 serialMasked')
    }

    // bindLan 只认主人
    const denied = await exp.bindLan({ ownerQQ: USER, label: 'x', accessCode: 'A', printers: [{ serial: '01S00A123456789', ip: '192.168.1.9' }] })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'OWNER_ONLY')

    // 主人没解锁时也拒绝（秘密没法加密落库）
    const locked = await exp.bindLan({ ownerQQ: OWNER, label: 'x', accessCode: 'A', printers: [{ serial: '01S00A123456789', ip: '192.168.1.9' }] })
    assert.equal(locked.ok, false)
    assert.equal(locked.code, 'LOCKED')

    // 主人解锁后能绑，且返回探测结果
    await setupUser(api, OWNER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    const ok = await exp.bindLan({ ownerQQ: OWNER, label: '我的 A1', accessCode: LANCODE, printers: [{ serial: '01S00A123456789', ip: '192.168.1.50', name: 'A1' }] })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(ok.count, 1)
    assert.ok(ok.binding.id)
    assert.equal(ok.probe && ok.probe.ok, true)
    // 落盘仍是加密的
    const raw = await readFile(path.join(dir, 'vault.json'), 'utf8')
    assert.equal(raw.includes(LANCODE), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('群聊准入继承 Aurabot 的群白名单：不在 allow.groups 里的群，模块不响应', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    // Aurabot 只放行了 700001；模块自己没有群名单了
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }

    const inGroup = { kind: 'group', chatId: 'group:' + GROUP, groupId: GROUP, userId: USER, role: 'member' }
    await say(api, '/打印机 状态', inGroup)
    assert.match(lastText(api), /42%/, '白名单里的群能用')

    const outGroup = { kind: 'group', chatId: 'group:999999', groupId: '999999', userId: USER, role: 'member' }
    await say(api, '/打印机 状态', outGroup)
    assert.doesNotMatch(lastText(api), /42%/, '不在白名单的群不该响应')

    const ov = await route(api, '/overview')
    assert.equal(ov.settings.groups, GROUP, '生效的群名单来自 Aurabot')
    assert.equal('hostGroupAllow' in ov.settings, true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('自签名证书：第一次连局域网自动固定，之后就能看到指纹', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const { generateSelfSignedCert } = await import('../lib/tls-cert.mjs')
    const cert = generateSelfSignedCert({ commonName: '01S00A123456789' })
    const api = await boot(dir)
    let learned = 0
    api.__bambuTestHooks.printerManager.learnCert = async () => {
      learned++
      return { ok: true, pem: cert.certPem, fingerprint256: cert.fingerprint256, subject: '01S00A123456789' }
    }
    await setupUser(api, OWNER)
    await bindOwnerLan(api)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }

    await say(api, '/打印机 状态', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.ok(learned >= 1, '第一次连局域网应当学习证书：' + lastText(api))

    await say(api, '/打印机 证书', { userId: OWNER, chatId: 'private:' + OWNER })
    const text = lastText(api)
    assert.match(text, /局域网（8883）/)
    assert.match(text, /[0-9a-f]{2}(:[0-9a-f]{2})+/, '应当显示分段指纹')
    assert.match(text, /证书\s*信任/, '要告诉用户怎么重新固定')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('证书命令只给主人：其他人用不了，帮助里也不提', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }

    // 非主人：两条都被挡住，且不泄露任何指纹
    for (const arg of ['证书', '证书 信任']) {
      await say(api, '/打印机 ' + arg, { userId: USER, chatId: 'private:' + USER })
      const text = lastText(api)
      assert.match(text, /只提供给主人/, arg + ' 应当只给主人')
      assert.doesNotMatch(text, /[0-9a-f]{2}:[0-9a-f]{2}/, '不该露出指纹')
    }

    // 帮助（合并转发，一次给全部页）里也没有证书相关说明
    await say(api, '/打印机 帮助', { userId: USER, chatId: 'private:' + USER })
    const helpFwd = lastForward(api)
    assert.ok(helpFwd.call, '非主人帮助也应当走合并转发')
    assert.doesNotMatch(helpFwd.text, /证书/, '非主人帮助里不该出现证书说明')
    // 退回文本的路径同样不能出现
    api.onebot = async (action) => { if (/forward/.test(action)) throw new Error('不支持'); return {} }
    await say(api, '/打印机 帮助', { userId: USER, chatId: 'private:' + USER })
    assert.doesNotMatch(lastText(api), /证书/, '回退文本里也不该出现证书说明')

    // 群聊里主人也用不了（证书只走私聊）
    await setupUser(api, OWNER)
    await bindOwnerLan(api)
    api.__bambuTestHooks.printerManager.learnCert = async () => ({ ok: true, pem: '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----', fingerprint256: 'a'.repeat(64) })
    await say(api, '/打印机 状态', { userId: OWNER, chatId: 'private:' + OWNER })
    const before = api.__replies.length
    await say(api, '/打印机 证书', { kind: 'group', userId: OWNER, chatId: 'group:' + GROUP, groupId: GROUP })
    const groupReplies = api.__replies.slice(before).map((r) => String(r.text || '')).join('\n')
    assert.match(groupReplies, /私聊/, '群里要明确让他去私聊')
    // 群里要么明确「去私聊」，要么干脆不理；绝不能给出指纹
    assert.doesNotMatch(groupReplies, /[0-9a-f]{2}:[0-9a-f]{2}/, '群里不该露出指纹')

    // 主人私聊可以看
    await say(api, '/打印机 证书', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.match(lastText(api), /局域网（8883）/)
    assert.match(lastText(api), /[0-9a-f]{2}:[0-9a-f]{2}/, '主人能看到分段指纹')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ---------- 设置规则 / 启动对齐 / 主人专用面板路由 ----------

test('模块声明用 active 做 flag：defaults 里没有 enabled，/overview 带完整 rules', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const def = mod.default || mod
    assert.equal(def.flag, 'active', '子标签页圆点读的是 active')
    assert.equal(Object.hasOwn(def.defaults, 'enabled'), false, 'defaults 里不能有 enabled（宿主会再画一个总开关）')
    // defaults 里也不能有 active：宿主 start() 会把 defaults 里缺的键直接写进配置，
    // 写了 active:false 就会把老用户配置里的 enabled:true 覆盖成「关」。
    assert.equal(Object.hasOwn(def.defaults, 'active'), false, 'defaults 里不能有 active（宿主会用它覆盖老配置）')
    // 版本以 module.json 为准，不写死：两边不一致时根目录的 scripts/check.mjs 也会拦，
    // 但测试里写死一个数字只会让本地和 CI 各说各话（改版本就得记得回来改测试）。
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'module.json'), 'utf8'))
    assert.equal(def.version, manifest.version)

    const api = await boot(dir)
    const ov = await route(api, '/overview')
    assert.equal(ov.ok, true)
    assert.equal(typeof ov.rules, 'object')
    // 面板拿到的规则和服务端夹取同源
    assert.equal(ov.rules.unlockDays.max, 30)
    assert.equal(ov.rules.unlockDays.min, 1)
    assert.equal(ov.rules.unlockDays.def, 7)
    assert.equal(ov.rules.groupMode.kind, 'enum')
    assert.deepEqual(ov.rules.groupMode.values, ['off', 'status', 'control'])
    assert.equal(ov.rules.tutkTimeoutMs.max, 60000)
    assert.equal(Object.hasOwn(ov.rules, 'enabled'), false, '规则里不能有 enabled')
    assert.equal(typeof ov.rules.unlockDays.label, 'string')
    // 可序列化（面板会整体塞进渲染树）
    assert.deepEqual(JSON.parse(JSON.stringify(ov.rules)), ov.rules)
    // 其余字段保持不变
    for (const key of ['enabled', 'settings', 'risk', 'users', 'grants', 'audit', 'counts', 'owner']) assert.ok(key in ov, '缺 ' + key)
    // 主人状态：面板顶部和局域网页都要它。qq 是完整号（面板在本机主人自己浏览器里跑），
    // qqMasked 仍然保留给外部调用方 / 日志。
    assert.equal(typeof ov.owner.online, 'boolean')
    assert.equal(ov.owner.qq, OWNER, '要给完整主人 QQ，面板才认得出是谁')
    assert.match(String(ov.owner.qqMasked), /\*/)
    assert.equal(ov.owner.lanAllowed, true)
    assert.equal(ov.owner.unlockDays, 7)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('升级回归：defaults 里不写 active，老配置的 enabled:true 不会被升级成「关」', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    // 宿主 start() 会先把 defaults 补进配置再调 setup()；boot() 已经照做。
    // 结论：老用户开着（enabled:true、没有 active）升级后必须还是开着。
    const api = await boot(dir, { active: undefined, enabled: true, users: USER })
    assert.equal(api.settings().active, true, '升级后开关必须还是开着')
    await route(api, '/overview')
    const ov = await route(api, '/overview')
    assert.equal(ov.enabled, true)
    assert.equal(api.__exports.dashboard().enabled, true, '模块确实按「开着」跑')
    // 命令也照常工作（不会被总开关拦下）
    await setupUser(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    await loginCloud(api, USER)
    await say(api, '/打印机 状态')
    assert.doesNotMatch(lastText(api), /没开总开关/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('启动对齐：老配置只有 enabled 时把 active 写成同一个值', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    // 只给 enabled（模拟升级前存的配置），active 没写过
    const legacy = { active: undefined, enabled: true, users: USER, groupMode: 'status', unlockDays: 7, maxBindings: 5 }
    const api = await boot(dir, legacy)
    assert.equal(api.settings().active, true, '启动后 active 要和 enabled 对齐')
    // dashboard() 会读 vault，先让模块 ready 一次
    await route(api, '/overview')
    assert.equal(api.__exports.dashboard().enabled, true, '模块确实按「开着」跑')

    // 反过来：enabled=false 的老配置对齐成 active=false
    const dir2 = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
    try {
      const api2 = await boot(dir2, { active: undefined, enabled: false, users: USER })
      assert.equal(api2.settings().active, false)
      await route(api2, '/overview')
      assert.equal(api2.__exports.dashboard().enabled, false)
    } finally { await rm(dir2, { recursive: true, force: true }) }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('启动对齐：存量越界设置 boot 一次后按规则归一化落盘', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { unlockDays: 999, maxBindings: 0, requestTimeoutMs: 100, tutkTimeoutMs: 1 })
    const s = api.settings()
    assert.equal(s.unlockDays, 30, '999 应归一化成 30')
    assert.equal(s.maxBindings, 1, '0 应归一化成 1')
    assert.equal(s.requestTimeoutMs, 2000, '100 应归一化成 2000')
    assert.equal(s.tutkTimeoutMs, 3000, '1 应归一化成 3000')
    // 生效设置也用同一份夹取
    const ov = await route(api, '/overview')
    assert.equal(ov.settings.unlockDays, 30)
    assert.equal(ov.settings.unlockMinutes, 30 * 1440)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('启动对齐：不合法的枚举值也落回默认（groupMode / defaultInterface / ownerInterface）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { groupMode: 'hack', defaultInterface: 'auto', ownerInterface: 'x', groupPhoto: 'yes' })
    const s = api.settings()
    assert.equal(s.groupMode, 'status')
    assert.equal(s.defaultInterface, 'cloud')
    assert.equal(s.ownerInterface, '')
    assert.equal(s.groupPhoto, true)
    // 落盘的是归一化后的值，而不是原样留着非法值
    assert.equal(api.settings().groupMode, 'status')
    assert.equal(api.settings().defaultInterface, 'cloud')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('/lan/status：主人 QQ 给完整号、序列号打码、只列局域网绑定，且不含访问码', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    await setupUser(api, OWNER)
    // 没解锁时也应当能读到状态（元数据而已）
    let st = await route(api, '/lan/status')
    assert.equal(st.ok, true)
    assert.equal(st.ownerOnline, true, '设置安全码后是解锁状态')
    assert.equal(st.unlockDays, 7)
    assert.equal(st.lanAllowed, true)
    assert.equal(st.ownerQQ, OWNER, '面板要认出主人，给完整号')
    assert.match(st.ownerMasked, /\*/, 'qqMasked 仍然保留（给外部调用方）')
    assert.deepEqual(st.bindings, [], '还没有绑定时是空数组')

    const bound = await bindOwnerLan(api)
    assert.equal(bound.ok, true)
    st = await route(api, '/lan/status')
    assert.equal(st.bindings.length, 1)
    assert.equal(st.bindings[0].mode, undefined, '只列 lan 绑定，不再重复给 mode')
    assert.equal(st.bindings[0].label, '我的 A1')
    assert.ok(st.bindings[0].printers.length >= 1)
    assert.match(st.bindings[0].printers[0].serialMasked, /••••/)
    const dumped = JSON.stringify(st)
    assert.equal(dumped.includes(LANCODE), false, '/lan/status 不能带访问码原文')
    assert.equal(dumped.includes('01S00A123456789'), false, '序列号也要打码')

    // 锁定后 ownerOnline 变 false，但仍然给元数据（面板要能显示「未解锁」）
    const locked = await route(api, '/owner/lock', {})
    assert.equal(locked.ok, true)
    st = await route(api, '/lan/status')
    assert.equal(st.ownerOnline, false)
    assert.equal(st.bindings.length, 1, '未解锁时 listBindings 只给元数据，列表还在')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('/lan/bind：没解锁返回 LOCKED；解锁后能绑；形状不对返回 BAD_INPUT；返回里没有访问码', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir)
    const printers = [{ serial: '01S00A123456789', ip: '192.168.1.50', name: 'A1' }]

    // 还没设安全码 / 没解锁：明确 LOCKED，不偷偷落库
    const locked = await route(api, '/lan/bind', { label: '我的 A1', accessCode: LANCODE, printers })
    assert.equal(locked.ok, false)
    assert.equal(locked.code, 'LOCKED')

    await setupUser(api, OWNER)
    // 形状校验：缺序列号 / IP 不对 / 空访问码都要具体说哪一行
    for (const [body, pattern] of [
      [{ label: 'x', accessCode: LANCODE, printers: [{}] }, /至少/],
      [{ label: 'x', accessCode: LANCODE, printers: [{ serial: '01', ip: '192.168.1.50' }] }, /第 1 行/],
      [{ label: 'x', accessCode: LANCODE, printers: [{ serial: '01S00A123456789', ip: '999.1.1' }] }, /第 1 行/],
      [{ label: 'x', accessCode: '', printers }, /访问码/],
    ]) {
      const bad = await route(api, '/lan/bind', body)
      assert.equal(bad.ok, false, JSON.stringify(body))
      assert.equal(bad.code, 'BAD_INPUT')
      assert.match(bad.message, pattern)
    }

    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    const ok = await route(api, '/lan/bind', { label: '我的 A1', accessCode: LANCODE, printers })
    assert.equal(ok.ok, true, JSON.stringify(ok))
    assert.equal(ok.count, 1)
    assert.ok(ok.binding && ok.binding.id)
    assert.equal(ok.binding.mode, 'lan')
    const dumped = JSON.stringify(ok)
    assert.equal(dumped.includes(LANCODE), false, '返回里不能有访问码原文')

    // 绑定确实进了 /lan/status，并且秘密是加密落盘的
    const st = await route(api, '/lan/status')
    assert.equal(st.bindings.length, 1)
    const raw = await readFile(path.join(dir, 'vault.json'), 'utf8')
    assert.equal(raw.includes(LANCODE), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ---------- P1-1：模型工具 / 群上下文不能绕过宿主群白名单 ----------

test('P1-1 模型工具：已绑定用户在未获准群拿不到 bambu_printer；获准群能拿到', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)

    // Aurabot 只放行了 GROUP；999999 不在白名单里
    const outChat = { kind: 'group', groupId: '999999', userId: USER }
    assert.equal(toolsAt(api, outChat).length, 0, '未获准群不该拿到任何工具')
    assert.equal(bambuToolAt(api, outChat), null, '未获准群不该拿到 bambu_printer')

    const inChat = { kind: 'group', groupId: GROUP, userId: USER }
    const tool = bambuToolAt(api, inChat)
    assert.ok(tool, '白名单里的群应当能拿到 bambu_printer')
    assert.equal(tool.name, 'bambu_printer')
    assert.equal(typeof tool.execute, 'function')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('P1-1 群上下文：未获准群返回空串；获准群里有打印机名', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)

    assert.equal(contextAt(api, { kind: 'group', groupId: '999999', userId: USER }), '', '未获准群不给任何打印机名字')

    const text = contextAt(api, { kind: 'group', groupId: GROUP, userId: USER })
    assert.match(text, /拓竹打印机/, '获准群应当带上上下文：' + text)
    assert.match(text, /X1C/, '上下文里应当有打印机名：' + text)
    assert.equal(text.includes(CLOUD_TOKEN), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('P1-1 群模式 control + 有控制权限：未获准群依然拿不到工具，获准群拿到', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER, groupMode: 'control' })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    // 绑定者本人把群权限确认到 control（这条路径本身要能用）
    const gp = await route(api, '/groupperm', { qq: USER, groupMode: 'control' })
    assert.equal(gp.ok, true, JSON.stringify(gp))
    assert.equal(gp.prefs.groupMode, 'control')

    assert.equal(bambuToolAt(api, { kind: 'group', groupId: '999999', userId: USER }), null, '群模式再松也不能绕过群白名单')
    const tool = bambuToolAt(api, { kind: 'group', groupId: GROUP, userId: USER })
    assert.ok(tool, '白名单群 + control 应当能控制')
    // 真去执行一次 pause，确认工具本身在获准群里仍然可用（群权限语义没被改坏）
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    const r = await tool.execute({ action: 'pause' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(api.__printer.calls.length, 1)
    assert.equal(api.__printer.calls[0].action, 'pause')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('P1-1 回归：私聊工具清单不受群白名单影响', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    // 群白名单为空，私聊照样能用
    const api = await boot(dir, { users: USER, groupAllow: '' })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    const tool = bambuToolAt(api, { kind: 'private', userId: USER })
    assert.ok(tool, '私聊不该被群白名单牵连')
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    const r = await tool.execute({ action: 'status' })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.match(r.message, /42%/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ---------- P2-1：受权用户不能经模型工具直接停止 ----------

test('P2-1 私聊工具 stop：一律拒绝并要求命令二次确认，且不下发给打印机管理器', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER + ',' + OTHER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    // USER 把 control 授权给 OTHER：受权人私聊里本来是有控制权限的
    await say(api, '/打印机 授权 ' + OTHER + ' 30 status,control')
    assert.match(lastText(api), /已授权给/)

    const tool = bambuToolAt(api, { kind: 'private', userId: OTHER })
    assert.ok(tool, '受权人应当能拿到工具')

    const before = api.__printer.calls.length
    const r = await tool.execute({ action: 'stop' })
    assert.equal(r.ok, false, '工具不能直接停止：' + JSON.stringify(r))
    assert.match(r.message, /停止|确认/)
    assert.equal(api.__printer.calls.length, before, '拒绝时不能向打印机管理器下发任何命令')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('P2-1 回归：私聊工具 status 仍正常，pause 仍可下发', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    const tool = bambuToolAt(api, { kind: 'private', userId: USER })
    assert.ok(tool)
    const st = await tool.execute({ action: 'status' })
    assert.equal(st.ok, true, JSON.stringify(st))
    assert.match(st.message, /42%/)
    assert.equal(api.__printer.calls.length, 0, '状态查询不算控制命令')
    assert.equal(tool.name, 'bambu_printer')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('暂停中的打印机不显示纪元级已打印时长（startOf 返回 null 的回归）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    // PAUSE、没有 gcode_start_time、进度 42%、剩余 30 分钟 —— review 的复现输入
    api.__printer.status = {
      ok: true, stale: false, receivedAt: Date.now(), status: null,
      report: { print: { gcode_state: 'PAUSE', mc_percent: '42', mc_remaining_time: '30', nozzle_temper: '215', bed_temper: '60' } },
    }
    await say(api, '/打印机 状态', { userId: USER, chatId: 'private:' + USER })
    const text = lastText(api)
    assert.doesNotMatch(text, /20770/, '不能把 epoch 当开始时间')
    assert.doesNotMatch(text, /\d{4,}\s*天/, '不该出现几千天的已打印时长：' + text)
    // 仍然要有合理的已打印/剩余信息（按进度估算）
    assert.match(text, /42%/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('私聊控制权限：自己绑定的白名单用户在私聊 pause / 拍照不该被误拒（chat 归一化回归）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    // 曾经的 bug：ensureControl/ensurePhoto 传 {kind:'private'} 给 policy，
    // normalizeChat 用 String(chat) 得到 '[object Object]' → 归一成空 → 「未知的会话类型」，
    // 于是自己绑定的用户私聊里控制/拍照全被拒。
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    const over = { userId: USER, chatId: 'private:' + USER }
    await say(api, '/打印机 暂停', over)
    const text = lastText(api)
    assert.doesNotMatch(text, /没有控制权限/)
    assert.doesNotMatch(text, /未知的会话类型/)
    assert.ok(api.__printer.calls.length >= 1, '控制命令要真的下发：' + text)
    api.__printer.calls.length = 0
    await say(api, '/打印机 拍照', over)
    const shot = lastText(api)
    assert.doesNotMatch(shot, /没有拍照权限/)
    assert.doesNotMatch(shot, /未知的会话类型/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('免安全码主人：面板开启后不用解锁就能绑局域网、查状态；别的用户仍要安全码', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    // 主人直接开启免码
    const opened = await route(api, '/owner/nocode', {})
    assert.equal(opened.ok, true, JSON.stringify(opened))
    assert.equal(opened.mode, 'host')
    assert.equal(api.__vault.isUnlocked(OWNER), true, '开启后会话应当直接开着')
    assert.equal(api.__vault.isCodeless(OWNER), true)

    // 不用输任何安全码就能绑局域网
    const bound = await bindOwnerLan(api)
    assert.equal(bound.ok, true, JSON.stringify(bound))
    // /bind 的局域网分支返回 { binding:{id,label,mode} }（没有 count，那是 /lan/bind 的形状）
    assert.ok(bound.binding && bound.binding.id, '应当真的建了一条绑定')
    assert.equal(api.__vault.printers(OWNER).length, 1)

    // 也不用解锁就能查状态／控制
    api.__printer.status = { ok: true, stale: false, receivedAt: Date.now(), report: runningReport(), status: null }
    await say(api, '/打印机 状态', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.match(lastText(api), /42%/)
    assert.doesNotMatch(lastText(api), /保险箱还锁着/)

    // /lan/status 也要显示已解锁
    const st = await route(api, '/lan/status')
    assert.equal(st.ownerOnline, true)

    // 会话被锁定后，命令进来会自动再开（免码的意义就在这里）
    await route(api, '/owner/lock', {})
    assert.equal(api.__vault.isUnlocked(OWNER), false)
    await say(api, '/打印机 状态', { userId: OWNER, chatId: 'private:' + OWNER })
    assert.equal(api.__vault.isUnlocked(OWNER), true, '免码主人下次命令应当自动开会话')

    // 别的用户没设安全码：绝不会被免码路径打开
    assert.equal(api.__vault.isCodeless(USER), false)
    await say(api, '/打印机 状态', { userId: USER, chatId: 'private:' + USER })
    assert.doesNotMatch(lastText(api), /42%/, '未设安全码的用户不该能查状态')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('免安全码：已经设过安全码的主人不会被悄悄改成免码（防绕过）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, OWNER)   // 主人自己设了安全码
    const r = await route(api, '/owner/nocode', {})
    assert.equal(r.ok, false)
    assert.equal(r.code, 'NEED_CODE')
    assert.equal(api.__vault.isCodeless(OWNER), false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('设置里关掉「主人不用安全码」后，免码路径不再生效', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER, ownerNoCode: false })
    const r = await route(api, '/owner/nocode', {})
    // 关掉之后仍然可以建账号，但自动解锁不会发生（设置生效点在 isCodelessOwner）
    await route(api, '/owner/lock', {}).catch(() => {})
    assert.equal(api.__vault.isUnlocked(OWNER), false, '关掉开关后不该自动开')
    assert.ok(r.ok === false || api.__vault.isUnlocked(OWNER) === false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('/lan/discover：只返回序列号/IP/名字/型号，永远不含访问码', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    api.__bambuTestHooks.discoverPrinters = async () => ({
      ok: true,
      devices: [
        { serial: '01S00A123456789', ip: '192.168.1.50', name: 'A1', model: 'C12', signal: '-50' },
        { serial: '02P00B987654321', ip: '192.168.1.77', name: 'P1S', model: 'C11', signal: '' },
      ],
    })
    const r = await route(api, '/lan/discover', {})
    assert.equal(r.ok, true)
    assert.equal(r.devices.length, 2)
    assert.equal(r.devices[0].serial, '01S00A123456789')
    assert.equal(r.port, 2021)
    assert.match(r.note, /访问码不会广播|访问码/)
    // 关键：发现结果里不可能有任何凭据
    const dumped = JSON.stringify(r)
    assert.equal(dumped.includes('accessCode'), false)
    assert.equal(dumped.includes(LANCODE), false)

    // 搜索失败要如实说，且不编造设备
    api.__bambuTestHooks.discoverPrinters = async () => ({ ok: false, code: 'SOCKET_FAILED', message: '没有网卡' })
    const bad = await route(api, '/lan/discover', {})
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'SOCKET_FAILED')
    assert.deepEqual(bad.devices, [])

    // 一台都没搜到：ok 但空列表 + 说明
    api.__bambuTestHooks.discoverPrinters = async () => ({ ok: true, devices: [] })
    const none = await route(api, '/lan/discover', {})
    assert.equal(none.ok, true)
    assert.deepEqual(none.devices, [])
    assert.match(none.note, /没搜到/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('审计接口：操作者给完整 QQ（不打码），且仍然不含任何秘密', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { users: USER })
    await setupUser(api, USER)
    await loginCloud(api, USER)
    // 造一条能看出操作者的记录（解锁会写一条）
    await route(api, '/lock', { qq: USER })
    await route(api, '/unlock', { qq: USER, code: SECRET })

    for (const p of ['/overview', '/audit']) {
      const r = await route(api, p, p === '/audit' ? { limit: 50 } : undefined)
      assert.equal(r.ok, true)
      const rows = r.audit || []
      assert.ok(rows.length, p + ' 应当有审计记录')
      const mine = rows.find((x) => String(x.actor || '').includes(USER))
      assert.ok(mine, p + ' 的操作者要给完整 QQ：' + JSON.stringify(rows.slice(0, 2)))
      assert.equal(mine.actor, USER)
      assert.match(String(mine.actorMasked), /\*/, 'actorMasked 仍然保留（兼容老调用方）')
      const dumped = JSON.stringify(rows)
      assert.equal(dumped.includes(SECRET), false, '审计里不能出现安全码')
      assert.equal(dumped.includes(CLOUD_TOKEN), false, '审计里不能出现 token')
      assert.equal(dumped.includes(LANCODE), false, '审计里不能出现访问码')
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('/owner/unlock：错码给 BAD_CODE，对的码返回 until + unlockDays', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-int-'))
  try {
    const api = await boot(dir, { unlockDays: 3 })
    await setupUser(api, OWNER)
    await route(api, '/owner/lock', {})
    const bad = await route(api, '/owner/unlock', { code: 'wrong-code' })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'BAD_CODE')
    assert.match(bad.message, /安全码不对/)
    const good = await route(api, '/owner/unlock', { code: SECRET })
    assert.equal(good.ok, true, JSON.stringify(good))
    assert.equal(good.unlockDays, 3, '按设置里的天数返回')
    assert.ok(good.until > Date.now())
    assert.equal(JSON.stringify(good).includes(SECRET), false, '返回里不能回显安全码')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
