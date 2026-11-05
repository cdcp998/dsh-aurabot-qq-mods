// identity.mjs 的测试：用假的 api / store，不发网络请求。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdentity, normalizeTarget } from '../lib/identity.mjs'
import { createStore, createRecord } from '../lib/store.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function setup (onebot) {
  const dir = mkdtempSync(join(tmpdir(), 'impression-identity-'))
  const store = createStore({ file: join(dir, 'a.json') })
  const api = { onebot: onebot || (async (action) => { if (action === 'get_group_member_list') return []; return null }) }
  const identity = createIdentity({ api, store })
  return { dir, store, id: identity, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('normalizeTarget 去掉 @ 和括号里的 QQ 号', () => {
  assert.deepEqual(normalizeTarget('@小明'), { name: '小明', qq: '' })
  assert.deepEqual(normalizeTarget('小明（12345678）'), { name: '小明', qq: '12345678' })
  assert.deepEqual(normalizeTarget('12345678'), { name: '12345678', qq: '12345678' })
  assert.deepEqual(normalizeTarget(''), { name: '', qq: '' })
})

test('按 QQ 号解析，群名片优先于昵称', async () => {
  const env = setup(async (action) => {
    if (action === 'get_group_member_list') return [{ user_id: 10001, nickname: '小明', card: '明仔' }]
    return null
  })
  const ref = await env.id.refFromUser('10001', { groupId: '999' })
  assert.equal(ref.personId, 'qq:10001')
  assert.equal(ref.displayName, '明仔')
  assert.equal(ref.userNickname, '小明')
  env.cleanup()
})

test('私聊用陌生人资料兜底', async () => {
  const env = setup(async (action) => (action === 'get_stranger_info' ? { user_id: 20002, nickname: '路人乙' } : null))
  const ref = await env.id.refFromMessage({ userId: '20002', kind: 'private', nickname: '', raw: {} })
  assert.equal(ref.displayName, '路人乙')
  env.cleanup()
})

test('按名字解析：先档案，再群成员', async () => {
  const env = setup(async (action) => {
    if (action === 'get_group_member_list') return [{ user_id: 30003, nickname: '阿三', card: '' }]
    return null
  })
  env.store.upsert(createRecord({ personId: 'qq:10001', userId: '10001', displayName: '小明' }))
  const byRecord = await env.id.resolve('小明', { groupId: '999' })
  assert.equal(byRecord.ref.personId, 'qq:10001')
  const byMember = await env.id.resolve('阿三', { groupId: '999' })
  assert.equal(byMember.ref.userId, '30003')
  const missing = await env.id.resolve('不存在的人', { groupId: '999' })
  assert.equal(missing.ref, null)
  assert.match(missing.error, /找不到/)
  env.cleanup()
})

test('同名多人时要求更精确的指称', async () => {
  const env = setup(async () => [{ user_id: 1, nickname: '同名' }, { user_id: 2, nickname: '同名' }])
  const result = await env.id.resolve('同名', { groupId: '999' })
  assert.equal(result.ref, null)
  assert.match(result.error, /好几个人/)
  env.cleanup()
})

test('空 target 不猜人', async () => {
  const env = setup()
  const result = await env.id.resolve('', {})
  assert.equal(result.ref, null)
  assert.match(result.error, /没有指定/)
  env.cleanup()
})

test('身份说明包含 QQ / 昵称 / 群名片 / 别名', async () => {
  const env = setup()
  const ref = { personId: 'qq:1', userId: '1', displayName: '明仔', userNickname: '小明', groupCard: '明仔' }
  const block = env.id.identityBlock(ref, { aliases: ['老明'] })
  assert.match(block, /QQ：1/)
  assert.match(block, /昵称：小明/)
  assert.match(block, /群名片：明仔/)
  assert.match(block, /别名：.*老明/)
  env.cleanup()
})
