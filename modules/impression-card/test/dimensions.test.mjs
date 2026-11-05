// dimensions.mjs 的纯函数测试：不联网、不依赖宿主。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_DIMENSIONS, DEFAULT_SCORE, formatNum, formatDelta, parseDimensionConfig,
  findDimension, selectRadarDimensions, parseRadarSpec, radarSectorClass,
  wrapDisplayText, escapeXml, fillTemplate, dimensionDoc, normalizeKey,
} from '../lib/dimensions.mjs'

test('出厂维度：22 项，key 唯一且都是合法 key', () => {
  assert.equal(DEFAULT_DIMENSIONS.length, 22)
  const keys = new Set(DEFAULT_DIMENSIONS.map((d) => d.key))
  assert.equal(keys.size, 22)
  for (const d of DEFAULT_DIMENSIONS) {
    assert.match(d.key, /^[a-z][a-z0-9_-]*$/)
    assert.ok(d.label)
  }
  assert.equal(DEFAULT_SCORE, 5)
})

test('数字格式化：整数不带小数，非整数保留一位', () => {
  assert.equal(formatNum(6), '6')
  assert.equal(formatNum(6.04), '6')
  assert.equal(formatNum(6.25), '6.3')
  assert.equal(formatNum('x'), '0')
  assert.equal(formatDelta(2), '+2')
  assert.equal(formatDelta(-1.5), '-1.5')
  assert.equal(formatDelta(0), '+0')
})

test('维度配置：空字符串回落内置，自定义行可覆盖，注释与重复 key 会被忽略', () => {
  assert.equal(parseDimensionConfig('').length, 22)
  const custom = parseDimensionConfig([
    '# 注释',
    'moe = 萌度 | 卖萌的浓度',
    'chaos | 混沌 | 整活的混沌感',
    '温柔',
    'moe = 重复的会被忽略',
  ].join('\n'))
  assert.equal(custom.length, 3)
  assert.deepEqual(custom[0], { key: 'moe', label: '萌度', description: '卖萌的浓度' })
  assert.equal(custom[1].key, 'chaos')
  assert.equal(custom[2].label, '温柔')
  assert.match(custom[2].key, /^dim-[a-z0-9]+$/)
  assert.equal(normalizeKey('温柔'), normalizeKey('温柔'))
})

test('按 key / 标签 / 旧别名找维度', () => {
  assert.equal(findDimension(DEFAULT_DIMENSIONS, 'trust').label, '信赖')
  assert.equal(findDimension(DEFAULT_DIMENSIONS, '信赖').key, 'trust')
  assert.equal(findDimension(DEFAULT_DIMENSIONS, 'trouble').key, 'peace')
  assert.equal(findDimension(DEFAULT_DIMENSIONS, '没有这个'), null)
})

test('雷达维度：默认取最高 N 项；有负分时换成最高 N-1 + 最低 1', () => {
  const items = [
    { key: 'a', label: 'A', value: 9 },
    { key: 'b', label: 'B', value: 7 },
    { key: 'c', label: 'C', value: 5 },
    { key: 'd', label: 'D', value: 3 },
    { key: 'e', label: 'E', value: 1 },
  ]
  assert.deepEqual(selectRadarDimensions(items, 3).map((x) => x.key), ['a', 'b', 'c'])
  const withNegative = items.map((x) => (x.key === 'e' ? { ...x, value: -4 } : x))
  assert.deepEqual(selectRadarDimensions(withNegative, 3).map((x) => x.key), ['a', 'b', 'e'])
  assert.deepEqual(selectRadarDimensions([], 5), [])
  assert.deepEqual(selectRadarDimensions(items, 1).map((x) => x.key), ['a'])
})

test('解析「雷达:N」参数', () => {
  assert.deepEqual(parseRadarSpec('小明 雷达:3'), { target: '小明', topN: 3 })
  assert.deepEqual(parseRadarSpec('雷达：8'), { target: '', topN: 8 })
  assert.deepEqual(parseRadarSpec('  '), { target: '', topN: 0 })
  assert.deepEqual(parseRadarSpec('小明'), { target: '小明', topN: 0 })
  assert.equal(parseRadarSpec('小明 radar:99').topN, 22)
  assert.deepEqual(parseRadarSpec('小明 雷达 :4'), { target: '小明', topN: 4 })
})

test('雷达扇区配色：负分 / 越界 / 正常', () => {
  assert.equal(radarSectorClass(3, 4, { scaleMin: 0, scaleMax: 10 }), 'pos')
  assert.equal(radarSectorClass(-1, 4, { scaleMin: 0, scaleMax: 10 }), 'neg')
  assert.equal(radarSectorClass(3, 12, { scaleMin: 0, scaleMax: 10 }), 'over')
})

test('折行：限制行数与每行宽度，超出加省略号', () => {
  const lines = wrapDisplayText('一二三四五六七八九十甲乙', 5, 3)
  assert.equal(lines.length, 3)
  assert.ok(lines.every((line) => [...line].length <= 5 || line.endsWith('…')))
  assert.ok(wrapDisplayText('abcdefghijklmnop', 4, 2).at(-1).endsWith('…'))
  assert.deepEqual(wrapDisplayText('', 5, 2), [''])
})

test('XML 转义与模板占位', () => {
  assert.equal(escapeXml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;')
  assert.equal(fillTemplate('你好 {name}，{未知}', { name: '小明' }), '你好 小明，{未知}')
  const doc = dimensionDoc([{ key: 'a', label: 'A', description: '' }])
  assert.equal(doc, '- a（A）：A')
})
