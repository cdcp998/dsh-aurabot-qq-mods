// 找 sharp 的「状态层」：只有纯函数，测试不联网、不执行安装。
//
// 扩展渲染卡片需要 sharp，只使用 DSH 自带的那份（正常 import 或 resourcesPath 下的
// 安装位置），缺了就让面板提示、QQ 里降级成文字卡。模块不下载、不安装任何依赖。

import { join } from 'node:path'

/** DSH 安装目录下可能放着 sharp 的位置（相对 resourcesPath）。 */
export function bundledSharpPaths (resourcesPath) {
  if (!resourcesPath) return []
  return [
    join(resourcesPath, 'app.asar', 'dsh', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'dsh', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'app', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'app.asar', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'vendor', 'dsh-im', 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(resourcesPath, 'vendor', 'deepseek-harness', 'node_modules', 'sharp', 'dist', 'index.mjs'),
  ]
}

/** 用户自己放进扩展目录的 sharp（只读探测，不安装）。 */
export function localSharpPaths (moduleDir) {
  if (!moduleDir) return []
  return [
    join(moduleDir, 'node_modules', 'sharp', 'dist', 'index.mjs'),
    join(moduleDir, 'node_modules', 'sharp', 'dist', 'index.cjs'),
  ]
}

export function firstExisting (list, exists) {
  for (const item of list || []) {
    try {
      if (exists(item)) return item
    } catch (error) {}
  }
  return ''
}

/**
 * 当前机器上 sharp 的来源：
 *   local   → 扩展目录里有
 *   bundled → DSH 自带
 *   missing → 都没有，只能降级文字卡
 */
export function sharpStatus (options) {
  const o = options || {}
  const exists = typeof o.exists === 'function' ? o.exists : () => false
  const local = firstExisting(localSharpPaths(o.moduleDir), exists)
  if (local) return { action: 'local', path: local, message: '用扩展目录里的 sharp：' + local }
  const bundled = firstExisting(bundledSharpPaths(o.resourcesPath), exists)
  if (bundled) return { action: 'bundled', path: bundled, message: '用 DSH 自带的 sharp：' + bundled }
  return {
    action: 'missing',
    path: '',
    message: '这台机器上没有可用的 sharp（DSH 版本较老或精简安装）。卡片图渲染不出来，QQ 里发 /卡片 会自动改成文字版。',
  }
}
