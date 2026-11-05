// 白名单、监控时段、每轮上限这些「不刷屏」的逻辑：纯函数，直接跑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseGroupIds, hourInBeijing, withinWindow } from '../index.mjs'

test('白名单解析：一行一个、逗号、空格都行；非数字丢掉', () => {
  assert.deepEqual([...parseGroupIds('123456\n234567')].sort(), ['123456', '234567'])
  assert.deepEqual([...parseGroupIds('123456, 234567，345678')].sort(), ['123456', '234567', '345678'])
  assert.deepEqual([...parseGroupIds('')], [])
  assert.deepEqual([...parseGroupIds(null)], [])
  assert.deepEqual([...parseGroupIds('群号abc 12 123456')].sort(), ['123456'], '太短和带字母的都不算群号')
})

test('监控时段：开始=结束 表示全天', () => {
  for (const h of [0, 9, 23]) assert.equal(withinWindow(h, 0, 0), true)
  assert.equal(withinWindow(12, 9, 9), true)
})

test('监控时段：普通区间含开始不含结束', () => {
  assert.equal(withinWindow(9, 9, 18), true)
  assert.equal(withinWindow(17, 9, 18), true)
  assert.equal(withinWindow(18, 9, 18), false, '到结束那一小时就停')
  assert.equal(withinWindow(8, 9, 18), false)
  assert.equal(withinWindow(2, 9, 18), false)
})

test('监控时段：开始大于结束表示跨午夜', () => {
  assert.equal(withinWindow(22, 22, 7), true)
  assert.equal(withinWindow(23, 22, 7), true)
  assert.equal(withinWindow(0, 22, 7), true)
  assert.equal(withinWindow(6, 22, 7), true)
  assert.equal(withinWindow(7, 22, 7), false, '7 点就停了')
  assert.equal(withinWindow(12, 22, 7), false)
})

test('监控时段：参数坏掉时放行（宁可查一次，也别整天不动）', () => {
  assert.equal(withinWindow(10, undefined, 18), true)
  assert.equal(withinWindow(10, 9, null), true)
  assert.equal(withinWindow(NaN, 9, 18), true)
})

test('北京时间小时：不看服务器时区', () => {
  // 2026-11-05T00:30:00Z = 北京时间 08:30
  assert.equal(hourInBeijing(Date.UTC(2026, 10, 5, 0, 30)), 8)
  // 2026-11-05T16:30:00Z = 北京时间次日 00:30
  assert.equal(hourInBeijing(Date.UTC(2026, 10, 5, 16, 30)), 0)
})
