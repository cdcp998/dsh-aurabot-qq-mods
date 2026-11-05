// 价格监控的核心逻辑测试：价格解析、指纹、好价判定、匹配、提醒判断。
// 不联网、不依赖宿主，跑 node --test。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parsePrice, formatPrice, productKey, scoreRate, heatScore,
  qualityOf, matchScore, pickCandidates, evaluateAlert,
} from '../lib/core.mjs'

test('价格解析：只取售价，跳过返还额、满减门槛、原价', () => {
  assert.equal(parsePrice('139元'), 139)
  assert.equal(parsePrice('165.6元（需用券）'), 165.6)
  assert.equal(parsePrice('68.52元（需买2件，共137.04元）'), 68.52, '取单价而不是总价')
  assert.equal(parsePrice('3590元（淘金币可抵25元起）'), 3590, '抵扣额不是售价')
  assert.equal(parsePrice('119.9元（返240积分）'), 119.9)
  assert.equal(parsePrice('原价299元，现价199元'), 199, '原价不算')
  assert.equal(parsePrice('满300元减50元'), null, '门槛不是售价')
  assert.equal(parsePrice(''), null)
  assert.equal(parsePrice('价格未知'), null)
  assert.equal(parsePrice(undefined), null)
})

test('价格展示：保留两位以内小数', () => {
  assert.equal(formatPrice(19.9), '19.9')
  assert.equal(formatPrice(19.999), '20')
  assert.equal(formatPrice(null), '—')
  assert.equal(formatPrice('abc'), '—')
})

test('商品指纹：同一件商品的不同爆料归一到同一个 key', () => {
  const a = productKey('移动端：德龙 Delonghi 全自动咖啡机 白色')
  const b = productKey('德龙 Delonghi 全自动咖啡机 白色（需用券）')
  assert.equal(a, b)
  assert.equal(productKey('立白 洗衣液 24斤'), productKey('立白洗衣液24斤（Plus会员）'))
  assert.equal(productKey('短'), '', '太短的不参与历史价比较')
  assert.ok(productKey('任天堂 Switch 2 标准版').includes('switch'))
})

test('综合分与值票支持率', () => {
  assert.equal(heatScore({ comments: 10, collection: 5, worthy: 8 }), 48)
  assert.equal(scoreRate(8, 2), 0.8)
  assert.equal(scoreRate(0, 0), null)
})

test('超级好价：评论、值、收藏、综合分、支持率都要够', () => {
  // 30 条评论 + 20 值 + 10 收藏 = 综合分 130，够 120
  const hit = qualityOf({ comments: 30, worthy: 20, collection: 10, unworthy: 1 })
  assert.equal(hit.quality, 'super')
  assert.equal(hit.label, '超级好价')
  // 评论不到 20 够不上超级好价，但其余门槛都过，落在早期好价
  assert.equal(qualityOf({ comments: 19, worthy: 20, collection: 10 }).quality, 'early')
  assert.equal(qualityOf({ comments: 30, worthy: 20, collection: 9 }).quality, 'early', '收藏不到 10，够不上超级好价，但够早期好价')
  // 评论差不多但综合分不到 120：降级成早期好价，而不是「超级」
  assert.equal(qualityOf({ comments: 20, worthy: 20, collection: 10 }).quality, 'early')
})

test('早期好价：值 ≥4、评论 ≥6、收藏 ≥4、互动 ≥16、综合分 ≥35、支持率 ≥95%', () => {
  assert.equal(qualityOf({ comments: 9, worthy: 4, collection: 4 }).quality, 'early', '综合分 39、互动 17')
  assert.equal(qualityOf({ comments: 6, worthy: 4, collection: 4 }).quality, '', '综合分只有 30，不够 35')
  assert.equal(qualityOf({ comments: 9, worthy: 4, collection: 3 }).quality, '', '收藏不到 4')
  assert.equal(qualityOf({ comments: 9, worthy: 3, collection: 4 }).quality, '', '值票不到 4')
  // 2 个不值就把支持率压到 95% 以下
  assert.equal(qualityOf({ comments: 9, worthy: 4, collection: 4, unworthy: 2 }).quality, '')
})

test('小样本例外：6 值 1 不值按 85% 算，不该被 95% 门槛一票否决', () => {
  assert.equal(qualityOf({ comments: 9, worthy: 6, collection: 4, unworthy: 1 }).quality, 'early')
  // 但 2 个不值就不享受例外
  assert.equal(qualityOf({ comments: 9, worthy: 6, collection: 4, unworthy: 2 }).quality, '')
})

test('售罄、过期、信号太弱的都不算好价', () => {
  assert.equal(qualityOf({ comments: 30, worthy: 30, collection: 20, soldOut: true }).quality, '')
  assert.equal(qualityOf({ comments: 30, worthy: 30, collection: 20, ended: true }).quality, '')
  assert.equal(qualityOf({ comments: 1, worthy: 1, collection: 1 }).quality, '')
  assert.equal(qualityOf({}).quality, '')
})

test('查询匹配：中文整串与英文词边界', () => {
  assert.ok(matchScore('switch 2', '任天堂 Nintendo Switch 2 港版 标准版') > 0.8)
  assert.ok(matchScore('索尼降噪耳机', '索尼 WH-1000XM5 头戴式无线降噪耳机') > 0.6)
  assert.ok(matchScore('咖啡机', '德龙 全自动咖啡机') >= 0.9)
  assert.equal(matchScore('显卡', '立白洗衣液'), 0)
  assert.equal(matchScore('', '任何标题'), 0)
})

test('匹配候选：唯一命中直接选中，多个命中和无命中都给候选项', () => {
  const items = [
    { title: '任天堂 Switch 2 标准版 港版', price: 3200, mall: '京东', key: 'a' },
    { title: '任天堂 Switch 2 收纳包', price: 39, mall: '天猫', key: 'b' },
    { title: '立白 洗衣液', price: 39, mall: '京东', key: 'c' },
  ]
  const one = pickCandidates('switch 2', items)
  assert.equal(one.kind, 'many')
  assert.equal(one.options.length, 2)
  const none = pickCandidates('显示器 4K', items)
  assert.equal(none.kind, 'none')
  assert.equal(none.options.length, 0, '完全不相关不给候选')
  const singleList = [{ title: '德龙 全自动咖啡机', price: 3000, mall: '天猫', key: 'd' }]
  assert.equal(pickCandidates('咖啡机', singleList).kind, 'one')
})

test('同款不同爆料只算一件商品', () => {
  const items = [
    { title: '立白 洗衣液 24斤（需用券）', price: 39, mall: '京东' },
    { title: '移动端：立白 洗衣液 24斤', price: 35, mall: '天猫' },
    { title: '立白 洗衣液 24斤', price: 45, mall: '拼多多' },
  ]
  const key = productKey('立白 洗衣液 24斤')
  const same = items.map((i) => ({ ...i, key: productKey(i.title) || key }))
  const picked = pickCandidates('立白 洗衣液 24斤', same)
  assert.equal(picked.kind, 'one')
  assert.equal(picked.item.price, 35, '同款里挑最便宜的')
})

test('降价提醒：达到百分比或金额才算', () => {
  const prev = { price: 100, lowest: 90 }
  assert.equal(evaluateAlert(prev, 95, { dropPercent: 5, dropAmount: 0 }).alert, true, '正好 5%')
  assert.equal(evaluateAlert(prev, 96, { dropPercent: 5, dropAmount: 0 }).alert, false, '只降了 4%')
  assert.equal(evaluateAlert(prev, 94, { dropPercent: 0, dropAmount: 5 }).alert, true, '只按金额：降 6 元')
  assert.equal(evaluateAlert(prev, 96, { dropPercent: 0, dropAmount: 5 }).alert, false, '只按金额：降 4 元')
  assert.deepEqual(evaluateAlert(prev, 95, { dropPercent: 5, dropAmount: 0 }).reasons, ['降价'])
})

test('降价提醒：创新低也提醒，涨价不提醒', () => {
  const prev = { price: 100, lowest: 90 }
  const low = evaluateAlert(prev, 88, { dropPercent: 5, dropAmount: 5 })
  assert.equal(low.alert, true)
  assert.ok(low.reasons.includes('历史最低'))
  assert.equal(evaluateAlert(prev, 120, { dropPercent: 5, dropAmount: 5 }).alert, false, '涨价不提醒')
  assert.equal(evaluateAlert(prev, 99, { dropPercent: 5, dropAmount: 5 }).alert, false, '小幅波动不提醒')
  assert.equal(evaluateAlert(prev, 92, { dropPercent: 0, dropAmount: 0 }).alert, false, '没设阈值、也没创新低就不提醒')
  assert.equal(evaluateAlert(prev, 70, { dropPercent: 0, dropAmount: 0 }).alert, true, '没设阈值也可能创新低')
  assert.equal(evaluateAlert(null, 88, { dropPercent: 5, dropAmount: 5 }).alert, false, '第一次看到不算降价')
  assert.equal(evaluateAlert({ price: 100 }, 88, { dropPercent: 5, dropAmount: 5 }).alert, true, '没有最低价记录时按降价算')
})

test('降价提醒：价格无效时不报成功', () => {
  assert.equal(evaluateAlert({ price: 100, lowest: 90 }, null).alert, false)
  assert.equal(evaluateAlert({ price: 100, lowest: 90 }, 0).alert, false)
  assert.equal(evaluateAlert({ price: 100, lowest: 90 }, NaN).alert, false)
})
