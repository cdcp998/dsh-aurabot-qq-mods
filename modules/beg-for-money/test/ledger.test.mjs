// 账本层的单元测试：范围解析、按天聚合、文案、原子写盘、坏账本保护。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addDaysISO, amountOf, bucketByDay, createLedger, formatLedgerBrief, formatLedgerLines,
  isoDay, makeEntry, parseScope, round2, summarizeLedger, writeJsonAtomic,
} from '../lib/ledger.mjs'

const TODAY = '2026-11-05'
const quiet = { error () {}, warn () {}, info () {}, debug () {} }

function tempDir () {
  return mkdtempSync(join(tmpdir(), 'beg-ledger-'))
}

function sample () {
  return [
    { date: '2026-11-05', time: '09:00:00', amount: 12.5, note: '早饭', chatId: 'group:1', groupId: '1' },
    { date: '2026-11-05', time: '20:00:00', amount: 7.5, note: '', chatId: 'group:1', groupId: '1' },
    { date: '2026-11-03', time: '12:00:00', amount: 30, note: '大额', chatId: 'group:2', groupId: '2' },
    { date: '2026-10-01', time: '12:00:00', amount: 100, note: '很早', chatId: 'group:2', groupId: '2' },
    { date: '2026-11-04', time: '08:00:00', amount: 'bad', note: '手工改坏的一行', chatId: 'group:1', groupId: '1' },
  ]
}

test('isoDay / addDaysISO 用本地日期，跨月跨年都对', () => {
  assert.equal(isoDay(new Date(2026, 10, 5, 23, 30)), '2026-11-05')
  assert.equal(addDaysISO('2026-11-05', -1), '2026-11-04')
  assert.equal(addDaysISO('2026-03-01', -1), '2026-02-28')
  assert.equal(addDaysISO('2024-03-01', -1), '2024-02-29')
  assert.equal(addDaysISO('2026-01-01', -1), '2025-12-31')
  assert.equal(addDaysISO('乱七八糟', -1), '乱七八糟')
})

test('amountOf 把坏行当 0，round2 保留两位', () => {
  assert.equal(amountOf({ amount: 3 }), 3)
  assert.equal(amountOf({ amount: 'x' }), 0)
  assert.equal(amountOf(null), 0)
  assert.equal(round2(0.1 + 0.2), 0.3)
})

test('parseScope 认各种写法，看不懂的给 bad', () => {
  assert.deepEqual(parseScope('', TODAY), { kind: 'default' })
  assert.deepEqual(parseScope('今天', TODAY), { kind: 'day', value: TODAY })
  assert.deepEqual(parseScope('昨天', TODAY), { kind: 'day', value: '2026-11-04' })
  assert.deepEqual(parseScope('全部', TODAY), { kind: 'all' })
  assert.deepEqual(parseScope('ALL', TODAY), { kind: 'all' })
  assert.deepEqual(parseScope('7', TODAY), { kind: 'days', value: 7 })
  assert.deepEqual(parseScope('0', TODAY), { kind: 'days', value: 1 })
  assert.deepEqual(parseScope('2026-10-27', TODAY), { kind: 'day', value: '2026-10-27' })
  // 只写月-日的补零
  assert.deepEqual(parseScope('1-5', TODAY), { kind: 'day', value: '2026-01-05' })
  assert.deepEqual(parseScope('昨天天气', TODAY), { kind: 'bad', value: '昨天天气' })
})

test('bucketByDay 按天聚合，顺序今天在前，坏行不计金额', () => {
  const buckets = bucketByDay(sample(), TODAY, 7)
  assert.deepEqual(buckets.map((b) => b.date), ['2026-11-05', '2026-11-04', '2026-11-03'])
  assert.deepEqual(buckets[0], { date: '2026-11-05', count: 2, total: 20 })
  assert.deepEqual(buckets[1], { date: '2026-11-04', count: 1, total: 0 })
  assert.equal(bucketByDay(sample(), TODAY, 0).length, 0)
})

test('summarizeLedger：今天 / 最近 N 天 / 日期 / 累计', () => {
  const rows = sample()
  const todayView = summarizeLedger(rows, '', { todayISO: TODAY, currency: '元', recentDays: 7 })
  assert.equal(todayView.kind, 'default')
  assert.equal(todayView.count, 2)
  assert.equal(todayView.total, 20)
  assert.equal(todayView.spanCount, 4)
  assert.equal(todayView.spanTotal, 50)
  assert.equal(todayView.grand, 150)

  const daysView = summarizeLedger(rows, '2', { todayISO: TODAY, recentDays: 7 })
  assert.equal(daysView.label, '最近 2 天')
  assert.equal(daysView.count, 3)
  assert.equal(daysView.total, 20)

  const dayView = summarizeLedger(rows, '2026-11-03', { todayISO: TODAY })
  assert.equal(dayView.count, 1)
  assert.equal(dayView.total, 30)

  const allView = summarizeLedger(rows, '全部', { todayISO: TODAY })
  assert.equal(allView.count, 5)
  assert.equal(allView.total, 150)
  assert.equal(allView.first, '2026-10-01')

  assert.equal(summarizeLedger(rows, '胡说', { todayISO: TODAY }), null)
})

test('空账本：文案说「空的」，不出现 NaN', () => {
  const view = summarizeLedger([], '', { todayISO: TODAY })
  assert.equal(view.grand, 0)
  assert.match(formatLedgerLines(view), /账本还是空的/)
  assert.match(formatLedgerBrief(view), /账本还是空的/)
})

test('命令行文案带明细，工具文案是一两句', () => {
  const rows = sample()
  const view = summarizeLedger(rows, '2026-11-05', { todayISO: TODAY, currency: '元' })
  const lines = formatLedgerLines(view)
  assert.match(lines, /2026-11-05 2 笔，共 20\.00元/)
  assert.match(lines, /09:00:00 12\.50元 早饭/)
  const brief = formatLedgerBrief(summarizeLedger(rows, '', { todayISO: TODAY, currency: '元', recentDays: 7 }))
  assert.match(brief, /今天 2 笔，共 20\.00元/)
  assert.match(brief, /累计 150\.00元（5 笔）/)
  assert.equal(formatLedgerLines(null), '看不懂这个范围，用 `/收款 2026-10-27`、`/收款 7` 或者 `/收款 全部`。')
})

test('明细超过 10 条时只列 10 条并说明还有几笔', () => {
  const rows = []
  for (let i = 0; i < 15; i++) {
    rows.push({ date: TODAY, time: '10:0' + (i % 10) + ':00', amount: 1, note: '第' + i })
  }
  const view = summarizeLedger(rows, '今天', { todayISO: TODAY, currency: '元' })
  assert.equal(view.rows.length, 10)
  assert.equal(view.extra, 5)
  assert.match(formatLedgerLines(view), /另有 5 笔/)
})

test('makeEntry 截断备注、换行压成空格', () => {
  const entry = makeEntry({ amount: 12.345, note: 'a\nb\tc' + 'x'.repeat(100), chatId: 'group:9', groupId: '9', payer: '123456', payerName: '小明' }, new Date(2026, 10, 5, 9, 5, 3))
  assert.equal(entry.date, '2026-11-05')
  assert.equal(entry.time, '09:05:03')
  assert.equal(entry.amount, 12.35)
  assert.equal(entry.note, ('a b c' + 'x'.repeat(100)).slice(0, 40))
  assert.equal(entry.payer, '123456')
})

test('账本：新增即时落盘，重载后读得回来', () => {
  const dir = tempDir()
  const file = join(dir, 'ledger.json')
  try {
    const ledger = createLedger({ file, log: quiet })
    assert.deepEqual(ledger.load(), { count: 0, broken: false })
    const a = ledger.record({ amount: 15, note: '第一笔', chatId: 'group:1' })
    assert.equal(a.amount, 15)
    const b = ledger.record({ amount: 'not-a-number', note: '' })
    assert.equal(b.amount, 0, '坏金额按 0 记，别写 NaN')
    assert.equal(ledger.count(), 2)

    const again = createLedger({ file, log: quiet })
    assert.equal(again.load().count, 2)
    assert.equal(again.all()[0].note, '第一笔')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('账本：解析失败时改名留档并禁止写入，不覆盖历史', () => {
  const dir = tempDir()
  const file = join(dir, 'ledger.json')
  try {
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const ledger = createLedger({ file, log: quiet })
    const result = ledger.load()
    assert.equal(result.broken, true)
    assert.equal(ledger.broken, true)
    assert.equal(ledger.record({ amount: 5 }), null, '坏账本拒绝写入')
    // 坏文件已经改名留档，原文件名不存在
    assert.equal(existsSync(file), false)
    assert.ok(readdirSync(dir).some((name) => name.startsWith('ledger.json.corrupt-')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('账本：removeEntry 能撤回刚记的一笔（审批删除失败时回滚用）', () => {
  const dir = tempDir()
  const file = join(dir, 'ledger.json')
  try {
    const ledger = createLedger({ file, log: quiet })
    ledger.load()
    const entry = ledger.record({ amount: 8 })
    assert.equal(ledger.count(), 1)
    assert.equal(ledger.removeEntry(entry), true)
    assert.equal(ledger.count(), 0)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).records.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeJsonAtomic 自动建目录；写不进去返回 false 而不是抛', () => {
  const dir = tempDir()
  try {
    const nested = join(dir, 'a', 'b', 'ledger.json')
    assert.equal(writeJsonAtomic(nested, { ok: 1 }), true)
    assert.deepEqual(JSON.parse(readFileSync(nested, 'utf8')), { ok: 1 })
    assert.equal(writeJsonAtomic('', { ok: 1 }), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
