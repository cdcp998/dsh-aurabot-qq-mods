// store.mjs 的测试：临时目录 + 原子落盘，不碰真实数据。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, createRecord, personIdOf, normalizeRecord } from '../lib/store.mjs'

function tmpFile (name) {
  const dir = mkdtempSync(join(tmpdir(), 'impression-store-'))
  return { dir, file: join(dir, name || 'affinity.json') }
}

test('personId 稳定', () => {
  assert.equal(personIdOf('qq', 12345), 'qq:12345')
  assert.equal(personIdOf('', ' 42 '), 'qq:42')
})

test('新增、读取、按名字与别名查找、删除、统计', () => {
  const { dir, file } = tmpFile()
  const store = createStore({ file })
  const record = createRecord({ personId: 'qq:10001', userId: '10001', displayName: '小明', total: 6 })
  record.scores = { trust: 8, chaos: -2 }
  store.upsert(record)
  assert.equal(store.get('qq:10001').total, 6)
  assert.equal(store.findByName('小明').id, 'qq:10001')
  store.rememberAlias(store.get('qq:10001'), '小明同学', '明仔')
  assert.equal(store.findByName('明仔').id, 'qq:10001')
  assert.equal(store.search('明').length, 1)
  assert.equal(store.stats().persons, 1)
  assert.equal(store.stats().avgTotal, 6)
  assert.equal(store.remove('qq:10001'), true)
  assert.equal(store.remove('qq:10001'), false)
  store.saveNow()
  rmSync(dir, { recursive: true, force: true })
})

test('落盘后重新打开能读回；脏字段被洗掉', () => {
  const { dir, file } = tmpFile()
  const store = createStore({ file })
  store.upsert(createRecord({ personId: 'qq:2', userId: '2', displayName: '阿二', total: 4.5 }))
  const record = store.get('qq:2')
  record.scores = { trust: 7, 'Bad Key': 9, chaos: 'x' }
  store.upsert(record)
  store.saveNow()
  const again = createStore({ file })
  assert.equal(again.get('qq:2').displayName, '阿二')
  assert.equal(again.get('qq:2').scores.trust, 7)
  assert.equal(again.get('qq:2').scores['Bad Key'], undefined)
  assert.equal(again.get('qq:2').scores.chaos, undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('坏文件会另存为 .broken 并重新开始，不让模块起不来', () => {
  const { dir, file } = tmpFile()
  writeFileSync(file, '{ 这不是 json', 'utf8')
  const store = createStore({ file })
  assert.equal(store.all().length, 0)
  assert.ok(existsSync(file + '.broken'))
  rmSync(dir, { recursive: true, force: true })
})

test('normalizeRecord 拒绝没有 id 的脏数据，修正非法数值', () => {
  assert.equal(normalizeRecord({}), null)
  assert.equal(normalizeRecord(null), null)
  const record = normalizeRecord({ id: 'qq:3', total: 'abc', scores: { trust: 'Infinity' }, aliases: ['a', 3, '  '] })
  assert.equal(record.total, 5)
  assert.equal(record.scores.trust, undefined)
  assert.deepEqual(record.aliases, ['a'])
})

test('alias 有上限，事件只留最近 100 条', () => {
  const { dir, file } = tmpFile()
  const store = createStore({ file })
  const record = createRecord({ personId: 'qq:4', userId: '4', displayName: '四号' })
  store.upsert(record)
  for (let i = 0; i < 30; i++) store.rememberAlias(store.get('qq:4'), '别名' + i)
  assert.ok(store.get('qq:4').aliases.length <= 12)
  for (let i = 0; i < 120; i++) store.pushEvent({ at: i, personId: 'qq:4', delta: 1 })
  assert.equal(store.meta().events.length, 100)
  rmSync(dir, { recursive: true, force: true })
})
