// sharp-plan.mjs 的纯函数测试：只回答「sharp 从哪来」，不联网、不执行安装。

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bundledSharpPaths, localSharpPaths, firstExisting, sharpStatus,
} from '../lib/sharp-plan.mjs'

const dir = 'C:/plugins/impression-card'
const existsIn = (set) => (p) => set.includes(p)

test('搜索路径：DSH 自带 / 扩展自己放的', () => {
  const bundled = bundledSharpPaths('C:/ds')
  assert.ok(bundled.some((p) => p.includes('app.asar')))
  assert.ok(bundled.some((p) => p.includes('vendor')))
  assert.deepEqual(bundledSharpPaths(''), [])
  const local = localSharpPaths(dir)
  assert.ok(local.some((p) => p.replace(/\\/g, '/').endsWith('node_modules/sharp/dist/index.mjs')))
  assert.deepEqual(localSharpPaths(''), [])
})

test('firstExisting：按顺序取第一个存在的', () => {
  assert.equal(firstExisting(['a', 'b', 'c'], existsIn(['b', 'c'])), 'b')
  assert.equal(firstExisting([], existsIn([])), '')
  assert.equal(firstExisting(['a'], () => { throw new Error('x') }), '')
})

test('status：扩展目录里有 → local', () => {
  const local = localSharpPaths(dir)[0]
  const status = sharpStatus({ moduleDir: dir, resourcesPath: 'C:/ds', exists: existsIn([local]) })
  assert.equal(status.action, 'local')
  assert.equal(status.path, local)
})

test('status：DSH 自带 → bundled', () => {
  const bundled = bundledSharpPaths('C:/ds')[7]
  const status = sharpStatus({ moduleDir: dir, resourcesPath: 'C:/ds', exists: existsIn([bundled]) })
  assert.equal(status.action, 'bundled')
  assert.match(status.message, /DSH 自带/)
})

test('status：都没有 → missing，文案说明降级文字卡', () => {
  const status = sharpStatus({ moduleDir: dir, resourcesPath: '', exists: () => false })
  assert.equal(status.action, 'missing')
  assert.equal(status.path, '')
  assert.match(status.message, /文字版/)
})
