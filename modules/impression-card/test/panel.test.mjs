import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../panel.js', import.meta.url), 'utf8');

const HELP_TEXT = ['【大肥鱼的印象卡片】', '/卡片 —— 看自己的印象卡', '/刷新印象 [名字] —— 重新评估'].join('\n');

const STATE = {
  ok: true,
  enabled: true,
  version: '1.0.0',
  stats: { persons: 2, avgTotal: 7.3, described: 1 },
  persons: [
    {
      id: 'qq:10001', userId: '10001', name: '小明', total: 12.345, updatedAt: Date.UTC(2026, 0, 2, 3, 4),
      described: true, noteChars: 34,
      dims: [{ key: 'humor', label: '幽默', value: 9.876 }, { key: 'trust', label: '信任', value: 3 }],
    },
    { id: 'qq:10002', userId: '10002', name: '小红', total: 2, updatedAt: 0, described: false, noteChars: 0, dims: [] },
  ],
  recent: [
    { at: Date.UTC(2026, 0, 2, 3, 4), name: '小明', dimension: 'humor', delta: 1.5, value: 9.876, reason: '讲了个冷笑话' },
    { at: 0, name: '小红', dimension: 'total', delta: -2, value: 2, reason: '' },
  ],
  settings: {
    theme: 'parchment', themeLabel: '羊皮纸', radarTopN: 5, totalLabel: '好感度', defaultScore: 5,
    scaleMin: -10, scaleMax: 20, noteSizeLimit: 256, cardScale: 2, format: 'png', botName: '大肥鱼',
    dimensions: [{ key: 'humor', label: '幽默', description: '' }, { key: 'trust', label: '信任', description: '' }],
  },
  themes: [{ id: 'parchment', label: '羊皮纸' }, { id: 'holo', label: '全息科技' }],
  sharpReady: true,
  help: HELP_TEXT,
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// 和 Aurabot 面板加载 panel.js 的方式一致：一整段函数体丢给 new Function。
// React 用最小 stub：useState 返回 [值, setter]，useMemo 直接算，useCallback 原样返回；
// useEffect 由 mount() 手动跑一次（浏览器里等价于挂载 + 一次取数），测试里不碰 DOM。
function load (overrides) {
  const values = [];
  let index = 0;
  const calls = [];
  const messages = [];
  const effects = [];
  let mounted = false;
  const React = {
    useState: (initial) => {
      const i = index++;
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
      return [values[i], (v) => { values[i] = typeof v === 'function' ? v(values[i]) : v; }];
    },
    useEffect: (fn) => { effects.push(fn) },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };
  const h = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false),
  });
  const ui = Object.fromEntries(['Card', 'Row', 'Btn', 'Select', 'Empty'].map((k) => [k, k]));
  const call = async (path, body) => {
    calls.push({ path, body });
    if (overrides && typeof overrides[path] === 'function') return overrides[path](body);
    if (path === '/state') return JSON.parse(JSON.stringify(STATE));
    if (path === '/help') return { ok: true, text: HELP_TEXT };
    return { ok: true, message: '完成' };
  };
  const Panel = new Function('React', 'h', 'ui', 'call', SOURCE)(React, h, ui, call);
  const render = () => {
    index = 0;
    return Panel({ settings: {}, draftSettings: {}, setSettings: () => {}, save: async () => {}, toast: (m) => messages.push(m) });
  };
  // 挂载：先渲染一次（注册 effect，此时还没数据），再跑一次取数，最后重新渲染。
  const mount = async () => {
    render();
    if (!mounted) {
      mounted = true;
      for (const fn of effects.splice(0)) fn();
      await tick();
    }
    return render();
  };
  return { Panel, render, mount, calls, messages, values, setValue: (i, v) => { values[i] = v; } };
}

const walk = (node) => {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(walk);
  return [node, ...walk(node.children), ...walk(node.props && node.props.right)];
};
// 文案既可能来自 children，也可能来自 Card 的 title/desc、Empty 的 text。
const text = (node) => {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (!node || typeof node !== 'object') return '';
  const props = node.props || {};
  const head = [props.title, props.desc, props.text, props.label].filter((x) => typeof x === 'string');
  return head.join('') + (node.children || []).map(text).join('');
};
const find = (tree, pred) => walk(tree).find((n) => pred(n));
const buttons = (tree) => walk(tree).filter((n) => n.type === 'Btn');
const button = (tree, label) => buttons(tree).find((b) => text(b) === label);

test('panel.js 求值后返回一个 React 组件函数', () => {
  const h = load();
  assert.equal(typeof h.Panel, 'function');
  assert.equal(typeof h.render(), 'object');
});

test('面板文本里包含用到的全部接口路径', () => {
  for (const path of ['/card.png', '/render', '/refresh', '/adjust', '/delete', '/send', '/help']) {
    assert.ok(SOURCE.includes("'" + path + "'"), '缺少接口路径 ' + path);
  }
  assert.ok(SOURCE.includes("'/state'"), '缺少接口路径 /state');
  // 卡片图拼在同源相对路径上：/aurabot/api/ext/impression-card/card.png
  assert.ok(SOURCE.includes("'/aurabot/api/ext/impression-card'"), '缺少卡片接口前缀');
});

test('面板文本里包含空状态与搜不到的文案', () => {
  assert.ok(SOURCE.includes('还没有任何档案'), '缺少空状态文案');
  assert.ok(SOURCE.includes('没有匹配的档案'), '缺少搜不到文案');
  assert.ok(SOURCE.includes('去 QQ 里发 /卡片'), '缺少去 QQ 里发卡片的引导');
});

test('首屏还没拿到 state 时显示加载中，不显示空列表', () => {
  const h = load();
  const tree = h.render();
  assert.match(text(tree), /正在读取档案/);
  assert.doesNotMatch(text(tree), /没有匹配的档案/);
  assert.doesNotMatch(text(tree), /去 QQ 里发/);
  assert.equal(button(tree, '刷新列表'), undefined);
  // 渲染过程中不发请求（取数在 effect 里）
  assert.deepEqual(h.calls, []);
});

test('挂载后只拉一次 /state，顶部统计、列表、选中详情与预览图都在', async () => {
  const h = load();
  const tree = await h.mount();
  assert.deepEqual(h.calls.map((c) => c.path), ['/state']);
  const body = text(tree);
  assert.match(body, /档案数/);
  assert.match(body, /平均好感度/);
  assert.match(body, /7\.3/);
  assert.match(body, /有笔记/);
  assert.match(body, /小明/);
  assert.match(body, /小红/);
  // 数字收敛到一位小数
  assert.ok(body.includes('12.3'));
  assert.ok(!body.includes('12.345'));
  const img = find(tree, (n) => n.type === 'img');
  assert.ok(img, '缺少卡片预览图');
  assert.match(img.props.src, /\/aurabot\/api\/ext\/impression-card\/card\.png\?person=qq%3A10001&radar=5&t=\d+/);
  for (const label of ['刷新列表', '重新渲染卡片', '刷新印象', '加减分', '删除档案']) {
    assert.ok(button(tree, label), '缺少按钮 ' + label);
  }
});

test('列表为空时给出「去 QQ 里发 /卡片」的空状态', async () => {
  const h = load({ '/state': () => ({ ok: true, ...STATE, persons: [], stats: { persons: 0, avgTotal: 0, described: 0 }, recent: [] }) });
  const tree = await h.mount();
  assert.match(text(tree), /还没有任何档案/);
  assert.match(text(tree), /去 QQ 里发 \/卡片/);
  assert.equal(find(tree, (n) => n.type === 'img'), undefined);
  assert.equal(button(tree, '刷新印象'), undefined);
});

test('搜索无匹配时显示「没有匹配的档案」而不是空库提示', async () => {
  const h = load();
  const tree = await h.mount();
  const input = find(tree, (n) => n.type === 'input' && n.props.type === 'search');
  assert.ok(input, '缺少搜索框');
  input.props.onChange({ target: { value: '查无此人' } });
  const next = h.render();
  assert.match(text(next), /没有匹配的档案/);
  assert.doesNotMatch(text(next), /去 QQ 里发/);
});

test('sharpReady=false 时明确说渲染不可用，不放预览图', async () => {
  const h = load({ '/state': () => ({ ok: true, ...STATE, sharpReady: false }) });
  const tree = await h.mount();
  assert.match(text(tree), /卡片图渲染不出来/);
  assert.equal(find(tree, (n) => n.type === 'img'), undefined);
  assert.equal(button(tree, '重新渲染卡片').props.disabled, true);
  assert.equal(button(tree, '安装 sharp'), undefined, '不应该再提供运行时安装按钮');
  assert.match(text(tree), /只用 DSH 自带的 sharp/);
});

test('重新渲染 / 刷新 / 加减分 / 删除各自调对应接口', async () => {
  const h = load();
  await h.mount();

  // 成功后会顺带重新拉一次 /state，所以按路径找那次操作本身
  const lastCall = (path) => h.calls.filter((c) => c.path === path).at(-1);

  await button(h.render(), '重新渲染卡片').props.onClick();
  assert.deepEqual(lastCall('/render'), { path: '/render', body: { personId: 'qq:10001', radarTopN: 5 } });

  await button(h.render(), '刷新印象').props.onClick();
  assert.deepEqual(lastCall('/refresh'), { path: '/refresh', body: { personId: 'qq:10001' } });

  await button(h.render(), '加减分').props.onClick();
  assert.deepEqual(lastCall('/adjust'), { path: '/adjust', body: { personId: 'qq:10001', dimension: 'total', value: 1, mode: 'add', reason: '' } });

  // 删除要二次确认：第一次点只出确认框
  const before = h.calls.length;
  await button(h.render(), '删除档案').props.onClick();
  assert.equal(h.calls.length, before, '点删除不应该立刻发请求');
  await button(h.render(), '确认删除').props.onClick();
  assert.deepEqual(lastCall('/delete'), { path: '/delete', body: { personId: 'qq:10001' } });
});

test('刷新印象时按钮进入 loading 并被禁用', async () => {
  let release = null;
  const h = load({ '/refresh': () => new Promise((resolve) => { release = () => resolve({ ok: true, message: '已刷新' }) }) });
  await h.mount();
  const pending = button(h.render(), '刷新印象').props.onClick();
  await tick();
  const tree = h.render();
  const loading = buttons(tree).find((b) => /刷新中/.test(text(b)));
  assert.ok(loading, '刷新时按钮应显示正在刷新');
  assert.equal(loading.props.disabled, true);
  release();
  await pending;
  assert.ok(button(h.render(), '刷新印象'), '刷新结束后按钮恢复');
  assert.equal(button(h.render(), '刷新印象').props.disabled, false);
});

test('接口返回 ok:false 时显示明确原因，不假装成功', async () => {
  const h = load({ '/refresh': () => ({ ok: false, message: '模型没有返回 JSON' }) });
  await h.mount();
  await button(h.render(), '刷新印象').props.onClick();
  assert.match(text(h.render()), /刷新印象失败：模型没有返回 JSON/);
  assert.ok(h.messages.some((m) => m === '模型没有返回 JSON'));
});

test('渲染失败时显示原因，不换预览图', async () => {
  const h = load({ '/render': () => ({ ok: false, message: 'sharp 不可用' }) });
  const before = await h.mount();
  const srcBefore = find(before, (n) => n.type === 'img').props.src;
  await button(h.render(), '重新渲染卡片').props.onClick();
  const tree = h.render();
  assert.match(text(tree), /重新渲染失败：sharp 不可用/);
  assert.equal(find(tree, (n) => n.type === 'img').props.src, srcBefore);
});

test('接口抛异常时 toast 报错，界面不崩', async () => {
  const h = load({ '/adjust': () => { throw new Error('网络断了') } });
  await h.mount();
  await button(h.render(), '加减分').props.onClick();
  assert.ok(h.messages.some((m) => /网络断了/.test(m)));
  assert.match(text(h.render()), /调整失败：网络断了/);
});

test('加减分输入为空或不是数字时按钮禁用，不发请求', async () => {
  const h = load();
  await h.mount();
  h.setValue(16, '');
  assert.equal(button(h.render(), '加减分').props.disabled, true);

  h.setValue(16, 'abc');
  const btn = button(h.render(), '加减分');
  assert.equal(btn.props.disabled, true);
  const before = h.calls.length;
  await btn.props.onClick();
  assert.equal(h.calls.length, before);
});

test('最近变动与命令说明来自 state 与 help', async () => {
  const h = load();
  const tree = await h.mount();
  const body = text(tree);
  assert.match(body, /最近变动/);
  assert.match(body, /讲了个冷笑话/);
  assert.match(body, /幽默/);
  assert.match(body, /在 QQ 里能用的命令/);
  assert.match(body, /看自己的印象卡/);
  // 不重复原生设置表单，只给一句只读提示
  assert.match(body, /在这个页面下方/);
  assert.doesNotMatch(body, /保存设置/);
});

test('state 没带 help 时，展开命令说明才去调 /help', async () => {
  const h = load({ '/state': () => ({ ok: true, ...STATE, help: '' }) });
  const tree = await h.mount();
  const details = find(tree, (n) => n.type === 'details');
  assert.ok(details, '缺少命令说明的折叠区');
  assert.equal(h.calls.some((c) => c.path === '/help'), false);
  await details.props.onToggle({ target: { open: true } });
  assert.equal(h.calls.filter((c) => c.path === '/help').length, 1);
  assert.match(text(h.render()), /看自己的印象卡/);
});

test('面板不写死配色、不放渐变、不打 console.log、不 import', () => {
  assert.doesNotMatch(SOURCE, /linear-gradient|radial-gradient/);
  assert.doesNotMatch(SOURCE, /console\.(log|warn|error|debug)/);
  assert.doesNotMatch(SOURCE, /TODO|FIXME/);
  assert.doesNotMatch(SOURCE, /#[0-9a-fA-F]{6}\b/);
  assert.doesNotMatch(SOURCE, /^\s*import\s/m);
  assert.doesNotMatch(SOURCE, /require\(/);
  assert.match(SOURCE, /^return function Panel/m);
});