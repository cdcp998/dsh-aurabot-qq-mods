// 打款说法识别与待确认记录清洗的单元测试。
// 重点在误判：疑问句、否定句、开玩笑都不能算打款。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { POSITIVE_WORDS, checkAmount, extractAmount, isPaymentClaim, sanitizeApproval, sanitizeApprovals } from '../lib/detect.mjs'

test('正面说法认得出来', () => {
  for (const text of ['我转了', '打了打了', '刚付了', '到账了吗', '扫了收款码', '给你发红包了', '已付 20', '投喂一下', '转啦']) {
    assert.equal(isPaymentClaim(text), true, text)
  }
})

test('疑问和否定不能误判成打钱', () => {
  for (const text of [
    '我没打', '没转账', '不付', '别打给我', '你是不是骗我', '假的吧', '怎么可能', '哪有这回事',
    '收到没', '有没有人要打钱', '下次一定', '我没钱',
  ]) {
    assert.equal(isPaymentClaim(text), false, text)
  }
})

test('空消息和超长消息不算', () => {
  assert.equal(isPaymentClaim(''), false)
  assert.equal(isPaymentClaim('   '), false)
  assert.equal(isPaymentClaim(null), false)
  assert.equal(isPaymentClaim('转了' + '啊'.repeat(80)), false, '60 字以上的消息多半在讲别的事')
  assert.ok(POSITIVE_WORDS.length > 0)
})

test('extractAmount 从常见说法里挖金额', () => {
  assert.equal(extractAmount('我转了 15'), 15)
  assert.equal(extractAmount('打赏12.5块'), 12.5)
  assert.equal(extractAmount('给了 20 元'), 20)
  assert.equal(extractAmount('发了个 8.88 的红包'), 8.88)
  assert.equal(extractAmount('20块'), 20)
  assert.equal(extractAmount('转了'), null)
  assert.equal(extractAmount('今天天气不错'), null)
})

test('checkAmount 挡住 NaN / Infinity / 负数 / 超上限', () => {
  assert.deepEqual(checkAmount(15), { ok: true, value: 15 })
  assert.deepEqual(checkAmount('12.345'), { ok: true, value: 12.35 })
  assert.equal(checkAmount(0).ok, false)
  assert.equal(checkAmount(-1).ok, false)
  assert.equal(checkAmount(NaN).ok, false)
  assert.equal(checkAmount(Infinity).ok, false)
  assert.equal(checkAmount('abc').ok, false)
  assert.equal(checkAmount('').ok, false)
  assert.equal(checkAmount(null).ok, false)
  assert.equal(checkAmount(20000, 10000).ok, false)
  assert.equal(checkAmount(10000, 10000).ok, true)
})

test('sanitizeApproval：编号以字典键为准，缺字段补默认值', () => {
  const rec = sanitizeApproval({
    id: '3', amount: '15', note: 'x'.repeat(60), chatId: 'group:1', groupName: '群 1',
    payer: '123456', payerName: '小明', created: '1700000000000',
  }, '5')
  assert.equal(rec.id, '5', '以字典键为准，避免显示 #3 却删不掉键 "5"')
  assert.equal(rec.amount, 15)
  assert.equal(rec.note.length, 40)
  assert.equal(rec.requester, '小明')
  assert.equal(rec.created, 1700000000000)
})

test('sanitizeApproval 丢掉坏记录', () => {
  assert.equal(sanitizeApproval({ amount: 10 }, 'abc'), null, '编号不是数字')
  assert.equal(sanitizeApproval({ amount: 10 }, ''), null)
  assert.equal(sanitizeApproval({ amount: 0 }, '1'), null)
  assert.equal(sanitizeApproval({ amount: 'x' }, '1'), null)
  assert.equal(sanitizeApproval(null, '1'), null)
})

test('sanitizeApprovals：编号进位到比所有现存记录大，坏的计数丢掉', () => {
  const clean = sanitizeApprovals({
    seq: 2,
    items: {
      1: { amount: 5 },
      7: { amount: 8 },
      bad: { amount: 1 },
      9: { amount: -1 },
    },
  })
  assert.deepEqual(Object.keys(clean.items).sort(), ['1', '7'])
  assert.equal(clean.seq, 7, 'seq 不能小于现存最大编号，否则新记录会撞号')
  assert.equal(clean.dropped, 2)
  assert.deepEqual(sanitizeApprovals(null), { seq: 0, items: {}, dropped: 0 })
  assert.deepEqual(sanitizeApprovals('可不是对象'), { seq: 0, items: {}, dropped: 0 })
})
