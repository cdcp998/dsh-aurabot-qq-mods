// card.mjs / render.mjs 的纯函数测试：不联网、不依赖 sharp。
// 运行：node --test card.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CARD_WIDTH,
  CARD_HEIGHT,
  CARD_THEMES,
  themeOf,
  buildCardSvg,
  buildRadarSvg,
} from '../lib/card.mjs'
import {
  avatarUrl,
  avatarDataUri,
  fetchQqAvatar,
  findSharp,
  createCardRenderer,
} from '../lib/render.mjs'
import { selectRadarDimensions } from '../lib/dimensions.mjs'

const DIMENSIONS = [
  { key: 'familiarity', label: '熟悉', value: 7 },
  { key: 'trust', label: '信赖', value: 6 },
  { key: 'joy', label: '欢乐', value: 8 },
  { key: 'peace', label: '省心', value: 4 },
  { key: 'clinginess', label: '贴贴', value: 5 },
]

function buildSample (overrides) {
  return buildCardSvg({
    theme: 'parchment',
    title: '测试卡片',
    personName: '小明',
    personLabel: 'QQ 123456789',
    total: 7,
    totalLabel: '好感度',
    dimensions: DIMENSIONS,
    radarTopN: 5,
    scaleMin: 0,
    scaleMax: 10,
    description: '温柔可靠，偶尔有点抽象。',
    updatedText: '更新于 2026-01-01',
    footer: 'Aurabot',
    ...(overrides || {}),
  })
}

test('三套主题都能生成 940x500 的完整 SVG，且没有 undefined / NaN / Infinity', () => {
  assert.equal(CARD_WIDTH, 940)
  assert.equal(CARD_HEIGHT, 500)
  assert.deepEqual(Object.keys(CARD_THEMES), ['parchment', 'holo', 'cute'])
  for (const key of ['parchment', 'holo', 'cute']) {
    const svg = buildSample({ theme: key })
    assert.equal(typeof svg, 'string')
    assert.match(svg, /^<svg\s/)
    assert.ok(svg.includes('width="' + CARD_WIDTH + '"'))
    assert.ok(svg.includes('height="' + CARD_HEIGHT + '"'))
    assert.ok(svg.endsWith('</svg>'))
    assert.ok(svg.includes('小明'))
    assert.ok(svg.includes('好感度'))
    assert.ok(svg.includes('温柔可靠'))
    assert.ok(!svg.includes('undefined'))
    assert.ok(!svg.includes('NaN'))
    assert.ok(!svg.includes('Infinity'))
    assert.equal(themeOf(key).label, CARD_THEMES[key].label)
  }
  assert.equal(themeOf('不存在'), CARD_THEMES.parchment)
})

test('名字、标题和描述里的 XML 字符会被转义', () => {
  const evil = '<A&B> "引号" \'单\''
  const svg = buildCardSvg({
    theme: 'holo',
    title: evil,
    personName: evil,
    personLabel: evil,
    total: 3,
    totalLabel: '好感度',
    dimensions: DIMENSIONS,
    description: evil,
  })
  assert.ok(svg.includes('&lt;A&amp;B&gt;'))
  assert.ok(svg.includes('&quot;引号&quot;'))
  assert.ok(svg.includes('&#39;单&#39;'))
  assert.ok(!svg.includes('<A&B>'))
})

test('负分维度会入选雷达，顶点数等于选中的维度数', () => {
  const dims = [
    { key: 'a', label: '积极一', value: 9 },
    { key: 'b', label: '积极二', value: 8 },
    { key: 'negative', label: '消极', value: -4 },
    { key: 'd', label: '普通', value: 5 },
    { key: 'e', label: '积极三', value: 7 },
  ]
  const selected = selectRadarDimensions(dims, 4)
  assert.ok(selected.some((item) => item.value < 0))
  assert.equal(selected.length, 4)
  const svg = buildCardSvg({
    theme: 'cute',
    personName: '测试',
    total: 5,
    dimensions: dims,
    radarTopN: 4,
    description: '雷达测试。',
  })
  const vertexCount = (svg.match(/class="radar-vertex"/g) || []).length
  assert.equal(vertexCount, selected.length)
  assert.equal((svg.match(/data-radar-vertex="true"/g) || []).length, selected.length)
  assert.ok(svg.includes('data-dim="negative"'))
  assert.ok(svg.includes('radar-sector-neg'))
  const radar = buildRadarSvg(selected, { scaleMin: 0, scaleMax: 10, size: 400 })
  assert.equal((radar.match(/class="radar-vertex"/g) || []).length, selected.length)
})

test('雷达图最左 / 最右的长标签和数值都落在 viewBox 内，不会被 sharp 裁字', () => {
  const dims = [
    { key: 'a', label: '一二三四五六七', value: 9 },
    { key: 'b', label: '七八九十一二三', value: 8 },
    { key: 'c', label: '负分维度很长', value: -2.3 },
    { key: 'd', label: '超过量程很多', value: 11.2 },
    { key: 'e', label: '普通维度标签', value: 5 },
  ]
  const svg = buildRadarSvg(dims, { scaleMin: 0, scaleMax: 10, size: 400 })
  const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)
  assert.ok(viewBox)
  const viewW = Number(viewBox[1])
  const viewH = Number(viewBox[2])
  const labels = [...svg.matchAll(/<text class="axis-label" x="([\d.]+)" y="([\d.]+)" text-anchor="(start|middle|end)" font-size="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)]
  assert.equal(labels.length, dims.length)
  // 与 card.mjs 相同的估算口径：CJK 记 1 个单位、ASCII 记 0.55 个单位，再乘字号。
  const wide = /[\u1100-\u11ff\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/
  const units = (text) => [...text].reduce((sum, ch) => sum + (wide.test(ch) ? 1 : 0.55), 0)
  for (const label of labels) {
    const x = Number(label[1])
    const anchor = label[3]
    const fontSize = Number(label[4])
    const text = label[5].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const width = units(text) * fontSize
    const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x
    const right = left + width
    assert.ok(left >= 0, '最左标签超出 viewBox：' + text + ' → ' + left.toFixed(1))
    assert.ok(right <= viewW, '最右标签超出 viewBox：' + text + ' → ' + right.toFixed(1))
    assert.ok(Number(label[2]) >= 0 && Number(label[2]) <= viewH)
  }
})

test('维度不足 3 项时雷达图优雅退化，并显示提示', () => {
  const svg = buildCardSvg({
    theme: 'parchment',
    personName: '测试',
    total: 5,
    dimensions: DIMENSIONS.slice(0, 2),
    description: '退化测试。',
  })
  assert.ok(svg.includes('class="radar-empty"'))
  assert.ok(svg.includes('维度不足 3 项'))
  assert.equal((svg.match(/class="radar-vertex"/g) || []).length, 0)
  const empty = buildCardSvg({ personName: '测试', dimensions: [] })
  assert.ok(empty.includes('暂无维度数据'))
  assert.ok(empty.includes('这个人还很神秘，暂无印象。'))
})

test('好感度量表条在范围内 / 超上限 / 低于下限时状态不同且带对应类名', () => {
  const inRange = buildSample({ total: 5 })
  assert.ok(inRange.includes('data-gauge-state="in"'))
  assert.ok(inRange.includes('class="gauge-bar-fill"'))
  assert.ok(!inRange.includes('gauge-bar-over'))
  assert.ok(!inRange.includes('gauge-bar-neg'))

  const over = buildSample({ total: 14 })
  assert.ok(over.includes('data-gauge-state="over"'))
  assert.ok(over.includes('class="gauge-bar-over"'))
  assert.notEqual(over, inRange)

  const under = buildSample({ total: -3 })
  assert.ok(under.includes('data-gauge-state="under"'))
  assert.ok(under.includes('class="gauge-bar-neg"'))
  assert.notEqual(under, inRange)

  const extreme = buildSample({ total: 1000 })
  const knob = extreme.match(/class="gauge-bar-knob" cx="([0-9.]+)"/)
  assert.ok(knob)
  const knobX = Number(knob[1])
  assert.ok(knobX >= 20 && knobX <= 920)
})

test('空头像画占位，只接受 data:image 开头的头像', () => {
  const empty = buildSample({ avatarDataUri: '' })
  assert.ok(empty.includes('avatar-placeholder'))
  assert.ok(!empty.includes('class="avatar-image"'))

  const bad = buildSample({ avatarDataUri: 'https://example.com/avatar.png' })
  assert.ok(bad.includes('avatar-placeholder'))
  assert.ok(!bad.includes('class="avatar-image"'))

  const uri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw5fWQAAAABJRU5ErkJggg=='
  const good = buildSample({ avatarDataUri: uri })
  assert.ok(good.includes('class="avatar-image"'))
  assert.ok(good.includes(uri))
  assert.ok(!good.includes('avatar-placeholder'))
})

test('avatarUrl 只接受 5–12 位纯数字 QQ 号', () => {
  assert.equal(avatarUrl('12345'), 'https://q1.qlogo.cn/g?b=qq&nk=12345&s=640')
  assert.equal(avatarUrl('123456789012'), 'https://q1.qlogo.cn/g?b=qq&nk=123456789012&s=640')
  assert.equal(avatarUrl(123456), 'https://q1.qlogo.cn/g?b=qq&nk=123456&s=640')
  for (const bad of ['', 'abc', '1234', '1234567890123', ' 12345', '12345 ', '１２３４５', null, undefined, {}, 1234.5]) {
    assert.equal(avatarUrl(bad), '', '非法 QQ 号应返回空串：' + String(bad))
  }
})

test('render.mjs 的失败路径不抛异常', async () => {
  const sharp = await findSharp({ resourcesPath: 'F:/no-such-resources-path', importer: async () => { throw new Error('没有 sharp') } })
  assert.equal(sharp, null)
  assert.equal(await fetchQqAvatar('abc'), null)
  assert.equal(await avatarDataUri(Buffer.from([1, 2, 3]), null), '')

  const renderer = createCardRenderer({ dataDir: 'unused', log: null })
  assert.equal(typeof renderer.renderCard, 'function')
  assert.equal(typeof renderer.sharp, 'function')
  assert.equal(typeof renderer.avatarDataUri, 'function')
  const failed = await renderer.renderCard({ svg: 'not svg', fileBase: 'x' })
  assert.equal(failed.ok, false)
  assert.equal(typeof failed.error, 'string')
})

test('fetchQqAvatar 能识别图片并拒绝非图片响应', async () => {
  const image = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)])
  const imageResponse = {
    ok: true,
    headers: { get: (name) => (name === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength),
  }
  const got = await fetchQqAvatar('123456', { fetchImpl: async () => imageResponse })
  assert.ok(Buffer.isBuffer(got))
  assert.equal(got.length, image.length)

  const textResponse = {
    ok: true,
    headers: { get: (name) => (name === 'content-type' ? 'text/plain' : null) },
    arrayBuffer: async () => new ArrayBuffer(32),
  }
  assert.equal(await fetchQqAvatar('123456', { fetchImpl: async () => textResponse }), null)
  assert.equal(await fetchQqAvatar('123456', { fetchImpl: async () => { throw new Error('断网') } }), null)
})
