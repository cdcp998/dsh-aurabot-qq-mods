// 链接识别 + 帮助文案。纯函数部分直接跑，联网部分在集成测试里。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { linkKind } from '../index.mjs'

test('链接识别：什么值得买 / 京东 / 淘宝 / 拼多多 / 抖音', () => {
  assert.equal(linkKind('https://www.smzdm.com/p/185447378/').kind, 'smzdm')
  assert.equal(linkKind('https://go.smzdm.com/abc/ca_aa_yh_1').kind, 'smzdm')
  assert.equal(linkKind('https://item.jd.com/100012043978.html').kind, 'jd')
  assert.equal(linkKind('https://detail.tmall.com/item.htm?id=1').kind, 'taobao')
  assert.equal(linkKind('https://item.taobao.com/item.htm?id=1').kind, 'taobao')
  assert.equal(linkKind('https://mobile.yangkeduo.com/goods.html?goods_id=1').kind, 'pdd')
  assert.equal(linkKind('https://haohuo.jinritemai.com/views/product/detail?id=1').kind, 'douyin')
  assert.equal(linkKind('https://example.com/x').kind, 'unknown')
})

test('链接识别：不是链接的当作商品名', () => {
  const r = linkKind('索尼 WH-1000XM5')
  assert.equal(r.isLink, false)
  assert.equal(r.query, undefined)
  assert.equal(linkKind('').isLink, false)
  assert.equal(linkKind(null).isLink, false)
})

test('链接识别：网址夹在文字里也能挑出来', () => {
  const r = linkKind('帮我看看这个 https://www.smzdm.com/p/185447378/ 值不值')
  assert.equal(r.isLink, true)
  assert.equal(r.kind, 'smzdm')
  assert.equal(r.url, 'https://www.smzdm.com/p/185447378/')
})

test('链接识别：不是网址格式但带 http 的，当成 unknown 不崩', () => {
  const r = linkKind('https://%%%')
  assert.equal(r.isLink, true)
  assert.equal(r.kind, 'unknown')
})
