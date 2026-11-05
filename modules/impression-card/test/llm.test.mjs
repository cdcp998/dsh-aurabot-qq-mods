// llm.mjs 的单元测试：提示词拼装、JSON 提取、微调写入、截断。
// 只跑纯函数，不联网、不依赖 sharp。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROMPTS,
  applyGeneration,
  applyNudge,
  buildColdStartPrompt,
  buildCompactPrompt,
  buildCurrentScores,
  buildNudgePrompt,
  coerceFloat,
  extractJsonObject,
  limitLabel,
  parseNudgePayload,
  renderTemplate,
  shouldIgnoreNudgeDescription,
  textByteLength,
  textWithinLimit,
  truncateText,
} from '../lib/llm.mjs'
import { defaultDimensions } from '../lib/dimensions.mjs'

const PERSONA = '你是个贪吃又爱睡的大肥鱼，说话直来直去，偶尔毒舌，喜欢白米饭。'
const DIMS = [
  { key: 'joy', label: '欢乐', description: '快乐' },
  { key: 'trust', label: '信赖', description: '信任' },
  { key: 'hope', label: '希望', description: '期待' },
]
const PLACEHOLDER_RE = /\{([a-z_]+)\}/g

// 从渲染结果里捞残留的 {xxx} 占位符。
function unresolvedPlaceholders (text) {
  return [...String(text).matchAll(PLACEHOLDER_RE)].map((match) => match[1])
}

function assertNoPlaceholders (text) {
  assert.deepEqual(unresolvedPlaceholders(text), [])
}

test('DEFAULT_PROMPTS 提供五套中文模板和完整占位符', () => {
  for (const key of ['coldStart', 'refreshGuidance', 'lightRefresh', 'compact', 'notify']) {
    assert.equal(typeof DEFAULT_PROMPTS[key], 'string', key)
    assert.ok(DEFAULT_PROMPTS[key].trim().length > 0, key)
  }
  const coldKeys = [
    'nickname', 'persona', 'name', 'task_intro', 'total_label', 'default_score',
    'scale_min', 'scale_max', 'dimensions_doc', 'scores_keys_doc', 'person_identities',
    'memory_block', 'recent_chat', 'refresh_guidance', 'existing_block', 'size_limit',
  ]
  for (const key of coldKeys) assert.ok(DEFAULT_PROMPTS.coldStart.includes('{' + key + '}'), key)
  const nudgeKeys = [
    'nickname', 'persona', 'name', 'total_label', 'default_score', 'scale_min',
    'scale_max', 'dimensions_doc', 'current_scores_block', 'current_note',
    'note_policy', 'person_identities', 'recent_chat', 'size_limit',
  ]
  for (const key of nudgeKeys) assert.ok(DEFAULT_PROMPTS.lightRefresh.includes('{' + key + '}'), key)
  for (const key of ['nickname', 'persona', 'name', 'used', 'limit_label', 'description']) {
    assert.ok(DEFAULT_PROMPTS.compact.includes('{' + key + '}'), key)
  }
})

test('冷启动提示词：人格、22 个维度、最近聊天都在，没有残留占位符', () => {
  const dimensions = defaultDimensions()
  const prompt = buildColdStartPrompt({
    persona: PERSONA,
    nickname: '大肥鱼',
    personName: '小明',
    taskIntro: '建立',
    totalLabel: '好感度',
    defaultScore: 5,
    scaleMin: 0,
    scaleMax: 10,
    dimensions,
    personIdentities: '以下昵称、号码、群名片等均指同一人「小明」：\n- 平台昵称：小明',
    memoryBlock: '  - 喜欢吃白米饭',
    recentChat: '小明：今天也想吃白米饭',
    refreshGuidance: '',
    existingBlock: '',
    sizeLimit: 256,
  })
  assert.match(prompt, /贪吃又爱睡/)
  assert.match(prompt, /大肥鱼/)
  assert.match(prompt, /小明/)
  assert.match(prompt, /喜欢吃白米饭/)
  assert.match(prompt, /最近的聊天记录/)
  assert.match(prompt, /欢乐向/)
  assert.match(prompt, /不是\*\*上面各维度的总和/)
  assert.equal(dimensions.length, 22)
  for (const dim of dimensions) {
    assert.ok(prompt.includes('"' + dim.key + '": 数字'), dim.key)
    assert.ok(prompt.includes('- ' + dim.key + '（' + dim.label + '）'), dim.key)
  }
  assertNoPlaceholders(prompt)
})

test('刷新提示词：插入刷新指引与旧档案', () => {
  const prompt = buildColdStartPrompt({
    persona: PERSONA,
    nickname: '大肥鱼',
    personName: '小明',
    taskIntro: '重新评估并更新',
    dimensions: defaultDimensions(),
    refreshGuidance: DEFAULT_PROMPTS.refreshGuidance,
    existingBlock: '你之前对 ta 的档案（仅供参考）：\n- 好感度：4',
    sizeLimit: 256,
  })
  assert.match(prompt, /【刷新评估】/)
  assert.match(prompt, /不是微调旧分/)
  assert.match(prompt, /之前对 ta 的档案/)
  assertNoPlaceholders(prompt)
})

test('微调提示词：当前档案、笔记策略、聊天与 deltas 格式都在', () => {
  const prompt = buildNudgePrompt({
    persona: PERSONA,
    nickname: '大肥鱼',
    personName: '小明',
    totalLabel: '好感度',
    scaleMin: 0,
    scaleMax: 10,
    defaultScore: 5,
    dimensions: defaultDimensions(),
    currentScoresBlock: '好感度: 5\n欢乐: 3',
    currentNote: '一个爱吃白米饭的群友',
    notePolicy: '【笔记策略】可以返回微调后的完整笔记，或省略以保留。',
    personIdentities: '以下均指同一人「小明」',
    recentChat: '小明：晚上好',
    sizeLimit: 256,
  })
  assert.match(prompt, /小幅微调/)
  assert.match(prompt, /好感度: 5/)
  assert.match(prompt, /一个爱吃白米饭的群友/)
  assert.match(prompt, /【笔记策略】/)
  assert.match(prompt, /小明：晚上好/)
  assert.match(prompt, /"deltas"/)
  assert.match(prompt, /可以毒舌/)
  assertNoPlaceholders(prompt)
})

test('精简提示词：字数、上限与原文都在', () => {
  const prompt = buildCompactPrompt({
    persona: PERSONA,
    nickname: '大肥鱼',
    personName: '小明',
    used: '300 字符',
    limitLabel: limitLabel(256, 'chars'),
    description: '一段很长的小明简介',
  })
  assert.match(prompt, /当前 300 字符/)
  assert.match(prompt, /256 字符/)
  assert.match(prompt, /一段很长的小明简介/)
  assert.match(prompt, /只输出精简后的简介正文/)
  assertNoPlaceholders(prompt)
})

test('提示词构造对空输入也不抛异常，且不残留占位符', () => {
  const prompts = [
    buildColdStartPrompt(),
    buildColdStartPrompt(null),
    buildNudgePrompt(),
    buildCompactPrompt(),
  ]
  for (const prompt of prompts) {
    assert.equal(typeof prompt, 'string')
    assertNoPlaceholders(prompt)
  }
})

test('extractJsonObject：纯 JSON、围栏、前后闲话', () => {
  assert.deepEqual(extractJsonObject('{"total": 3, "scores": {"joy": 1}}'), { total: 3, scores: { joy: 1 } })
  assert.deepEqual(extractJsonObject('```json\n{"total": 4, "scores": {"trust": 2}}\n```'), { total: 4, scores: { trust: 2 } })
  assert.deepEqual(extractJsonObject('好的，分析完了：\n```JSON\n{"total": 5}\n```\n以上。'), { total: 5 })
  assert.deepEqual(extractJsonObject('前文 {"total": 6} 后文'), { total: 6 })
  assert.deepEqual(extractJsonObject('{"a": 1} 然后 {"b": 2}'), { a: 1 })
  assert.deepEqual(extractJsonObject('废话 {不是 JSON} 然后 {"total": 7}'), { total: 7 })
})

test('extractJsonObject：坏 JSON / 空串 / 数组返回 null', () => {
  assert.equal(extractJsonObject(''), null)
  assert.equal(extractJsonObject(null), null)
  assert.equal(extractJsonObject('没有 JSON 对象'), null)
  assert.equal(extractJsonObject('{"total": '), null)
  assert.equal(extractJsonObject('{"a": 1'), null)
  assert.equal(extractJsonObject('[1, 2, 3]'), null)
  assert.equal(extractJsonObject('```json\n{"total":\n```'), null)
})

test('coerceFloat：只接受有限数字，支持数字字符串', () => {
  assert.equal(coerceFloat('3.5', 0), 3.5)
  assert.equal(coerceFloat(0, 7), 0)
  assert.equal(coerceFloat('', 7), 7)
  assert.equal(coerceFloat('   ', 7), 7)
  assert.equal(coerceFloat('abc', 7), 7)
  assert.equal(coerceFloat(Infinity, 7), 7)
  assert.equal(coerceFloat(NaN, 7), 7)
  assert.equal(coerceFloat(null, 7), 7)
})

test('parseNudgePayload：过滤未知 key / 非数字，按 maxAbsDelta 截断', () => {
  const allowedKeys = ['total', 'joy', 'trust', 'peace']
  const parsed = {
    deltas: { total: '9', joy: -8, trust: 'abc', familiarity: 5, peace: 0 },
    description: '  新笔记  ',
  }
  const result = parseNudgePayload(parsed, { allowedKeys, maxAbsDelta: 2 })
  assert.deepEqual(result.deltas, { total: 2, joy: -2 })
  assert.equal(result.description, '新笔记')
})

test('parseNudgePayload：无上限时保留原值，空描述为 null', () => {
  const result = parseNudgePayload(
    { deltas: { total: 9 } },
    { allowedKeys: new Set(['total']), maxAbsDelta: 0 },
  )
  assert.deepEqual(result.deltas, { total: 9 })
  assert.equal(result.description, null)
})

test('parseNudgePayload：非对象 / 无 deltas 返回空结果', () => {
  const empty = { deltas: {}, description: null }
  assert.deepEqual(parseNudgePayload(null, { allowedKeys: ['total'] }), empty)
  assert.deepEqual(parseNudgePayload('x', { allowedKeys: ['total'] }), empty)
  assert.deepEqual(parseNudgePayload({ description: '  ' }, { allowedKeys: ['total'] }), empty)
})

test('applyNudge：写 total 与维度，补默认分，记录 applied 与 noteChanged', () => {
  const record = { total: 5, scores: { joy: 4 }, description: '旧笔记' }
  const outcome = applyNudge(record, { total: 1.5, joy: -2, trust: 1 }, '新笔记', {
    ignoreDescription: false,
    defaultScore: 5,
  })
  assert.equal(outcome.record, record)
  assert.equal(record.total, 6.5)
  assert.equal(record.scores.joy, 2)
  assert.equal(record.scores.trust, 6)
  assert.equal(record.description, '新笔记')
  assert.equal(outcome.noteChanged, true)
  assert.deepEqual(outcome.applied, [
    { key: 'total', delta: 1.5 },
    { key: 'joy', delta: -2 },
    { key: 'trust', delta: 1 },
  ])
})

test('applyNudge：ignoreDescription 时不动笔记，noteChanged 反映真实变化', () => {
  const ignored = applyNudge(
    { total: 5, scores: {}, description: '旧笔记' },
    { joy: 1 },
    '新笔记',
    { ignoreDescription: true, defaultScore: 5 },
  )
  assert.equal(ignored.record.description, '旧笔记')
  assert.equal(ignored.noteChanged, false)
  assert.deepEqual(ignored.applied, [{ key: 'joy', delta: 1 }])

  const same = applyNudge(
    { total: 5, scores: {}, description: '一样' },
    {},
    ' 一样 ',
    { defaultScore: 5 },
  )
  assert.equal(same.noteChanged, false)
  assert.equal(same.record.description, '一样')
})

test('applyNudge：脏输入不抛异常', () => {
  assert.deepEqual(applyNudge(null, { total: 1 }, null, {}), {
    record: null,
    applied: [],
    noteChanged: false,
  })
  const record = { total: '5', scores: { joy: '2' }, description: null }
  const outcome = applyNudge(record, { total: '1.5', joy: 'x', trust: 2 }, null, { defaultScore: 5 })
  assert.equal(record.total, 6.5)
  assert.equal(record.scores.joy, '2')
  assert.equal(record.scores.trust, 7)
  assert.deepEqual(outcome.applied, [
    { key: 'total', delta: 1.5 },
    { key: 'trust', delta: 2 },
  ])
})

test('applyGeneration：写回 total / scores / description，缺分保持或补默认', () => {
  const record = { total: 5, scores: { joy: 5, trust: 4 }, description: '旧简介' }
  const returned = applyGeneration(
    record,
    { total: '8.5', scores: { joy: 7 }, description: ' 新简介 ' },
    { dimensions: DIMS, defaultScore: 5 },
  )
  assert.equal(returned, record)
  assert.equal(record.total, 8.5)
  assert.equal(record.scores.joy, 7)
  assert.equal(record.scores.trust, 4)
  assert.equal(record.scores.hope, 5)
  assert.equal(record.description, '新简介')
})

test('applyGeneration：description 为空不改，坏分数用默认 / 原值兜底', () => {
  const record = { total: 6, scores: { joy: 2 }, description: '保留' }
  applyGeneration(
    record,
    { total: 'nope', scores: { trust: 'bad' }, description: '   ' },
    { dimensions: DIMS, defaultScore: 5 },
  )
  assert.equal(record.total, 6)
  assert.equal(record.scores.joy, 2)
  assert.equal(record.scores.trust, 5)
  assert.equal(record.scores.hope, 5)
  assert.equal(record.description, '保留')
})

test('applyGeneration：parsed 为 null 时补齐维度并保住旧分', () => {
  const record = { scores: { joy: 3 }, description: '' }
  const returned = applyGeneration(record, null, { dimensions: DIMS, defaultScore: 5 })
  assert.equal(returned, record)
  assert.equal(record.total, 5)
  assert.deepEqual(record.scores, { joy: 3, trust: 5, hope: 5 })
})

test('buildCurrentScores：好感度一行 + 各维度一行，缺分用默认值', () => {
  const text = buildCurrentScores(
    { total: 4.5, scores: { joy: -1, trust: 5 } },
    { dimensions: DIMS, totalLabel: '好感度', defaultScore: 5 },
  )
  assert.equal(text, '好感度: 4.5\n欢乐: -1\n信赖: 5\n希望: 5')
})

test('shouldIgnoreNudgeDescription：只在持久化且超限时忽略', () => {
  assert.equal(shouldIgnoreNudgeDescription({ persistentImpression: false, description: 'x'.repeat(100), sizeLimit: 10 }), false)
  assert.equal(shouldIgnoreNudgeDescription({ persistentImpression: true, description: 'x'.repeat(100), sizeLimit: 10 }), true)
  assert.equal(shouldIgnoreNudgeDescription({ persistentImpression: true, description: '短笔记', sizeLimit: 10 }), false)
  assert.equal(shouldIgnoreNudgeDescription({ persistentImpression: true, description: null, sizeLimit: 10 }), false)
  assert.equal(shouldIgnoreNudgeDescription(), false)
})

test('textByteLength / textWithinLimit / limitLabel', () => {
  assert.equal(textByteLength('abc'), 3)
  assert.equal(textByteLength('中文'), 6)
  assert.equal(textByteLength(null), 0)
  assert.equal(textWithinLimit('中文', 6, 'bytes'), true)
  assert.equal(textWithinLimit('中文', 5, 'bytes'), false)
  assert.equal(textWithinLimit('中文', 2, 'chars'), true)
  assert.equal(textWithinLimit('中文', 1, 'chars'), false)
  assert.equal(limitLabel(256, 'chars'), '256 字符')
  assert.equal(limitLabel(81920, 'bytes'), '81920 字节')
})

test('truncateText：按字符 / UTF-8 字节截断且不超限', () => {
  assert.equal(truncateText('你好世界', 10, 'bytes'), '你好…')
  assert.equal(truncateText('你好世界', 3, 'chars'), '你好…')
  assert.equal(truncateText('abcdef', 4, 'bytes'), 'a…')
  assert.equal(truncateText('中文', 3, 'bytes'), '中')
  assert.equal(truncateText('短', 5, 'chars'), '短')
  assert.equal(truncateText('', 0, 'chars'), '')
  for (const limit of [4, 5, 6, 7, 8, 9, 10, 11]) {
    const clipped = truncateText('你好世界', limit, 'bytes')
    assert.ok(textWithinLimit(clipped, limit, 'bytes'), String(limit))
    assert.ok(!clipped.includes('\ufffd'), String(limit))
  }
})

test('renderTemplate 与 fillTemplate 行为一致', () => {
  assert.equal(renderTemplate('{name}', { name: '小明' }), '小明')
  assert.equal(renderTemplate('{{name}}', { name: '小明' }), '{小明}')
  assert.equal(renderTemplate('{unknown}', {}), '{unknown}')
})
