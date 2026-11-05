// 安装验证：按模块市场的发布包文件列表复制到临时目录，再按插件加载模块的方式导入入口。
// 防止入口依赖的文件没进发布包，或测试/安装脚本混进用户安装目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { filesOf, readManifest, smokeTest } from '../../../scripts/lib.mjs'

const modDir = fileURLToPath(new URL('..', import.meta.url))

test('发布包文件能装进干净目录并加载入口', () => {
  const manifest = readManifest(modDir)
  const names = filesOf(modDir)
  const files = new Map(names.map((name) => [name, readFileSync(join(modDir, name))]))
  for (const required of ['module.json', 'index.mjs', 'README.md', 'LICENSE']) {
    assert.ok(files.has(required), '发布包缺少 ' + required)
  }
  assert.ok(names.every((name) => !/(^test\/|\.test\.|^scripts\/|^package-lock\.json$)/.test(name)), '发布包不应包含测试、锁文件或安装脚本')
  assert.deepEqual(smokeTest(files, manifest), [])
})
