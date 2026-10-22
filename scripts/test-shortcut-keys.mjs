import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// 快捷键纯逻辑：组合键匹配、平台化展示、命中策略（输入法/浮层/富文本）。
// 匹配写宽会让 Mod+S 抢到 Mod+Shift+S，写窄则快捷键"时灵时不灵"，都必须靠断言锁住。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-shortcut-'));
try {
  await build({ entryPoints: ['src/lib/shortcutKeys.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'keys.mjs') });
  const {
    SHORTCUTS, OVERLAY_SELECTOR, POPPER_SELECTOR,
    matchesCombo, matchedCombo, combosFor, formatCombo, formatShortcut,
    isRichTextTarget, hasBlockingOverlay, resolveShortcut, shouldPreventDefault,
  } = await import(pathToFileURL(path.join(dir, 'keys.mjs')));

  // 构造假事件：只带我们真正读的字段
  const ev = (over) => ({ key: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, defaultPrevented: false, ...over });
  // 构造假节点：closest 命中 kinds 里任意一个子串即视为匹配（够了，测的是判定逻辑）
  const node = (kinds) => ({ closest: (selector) => (kinds.some((kind) => selector.includes(kind)) ? { nodeName: 'DIV' } : null) });
  const INPUT = node(['input']);
  // 富文本命中面：contenteditable 与块编辑器容器属性（旧实现这里是 .vditor，Vditor 已摘）
  const RICH = node(['[contenteditable="true" i]', '[data-block-editor="on"]']);

  const comboOf = (id) => SHORTCUTS.find((item) => item.id === id).combos[0];
  const ids = SHORTCUTS.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, '快捷键 id 不能重复');
  for (const def of SHORTCUTS) {
    assert.ok(def.combos.length > 0, def.id + ' 至少要有一个组合键');
    assert.ok(['always', 'notInRichText'].includes(def.guard), def.id + ' 的 guard 取值非法');
    assert.ok(['通用', '页面', '系统'].includes(def.group), def.id + ' 的分组非法');
  }

  // ── 1. 修饰键必须精确匹配 ────────────────────────────────
  const save = comboOf('save');
  assert.ok(matchesCombo(ev({ key: 's', ctrlKey: true }), save, false), '非 mac：Ctrl+S 命中');
  assert.ok(matchesCombo(ev({ key: 's', metaKey: true }), save, true), 'mac：⌘+S 命中');
  assert.ok(!matchesCombo(ev({ key: 's', metaKey: true }), save, false), '非 mac 的 ⌘+S 不算命中');
  assert.ok(!matchesCombo(ev({ key: 's', ctrlKey: true }), save, true), 'mac 的 Ctrl+S 不算命中');
  assert.ok(!matchesCombo(ev({ key: 's' }), save, false), '无修饰键不命中');
  assert.ok(!matchesCombo(ev({ key: 's', ctrlKey: true, shiftKey: true }), save, false), '多按 Shift 不命中');
  assert.ok(!matchesCombo(ev({ key: 's', ctrlKey: true, altKey: true }), save, false), '多按 Alt 不命中');
  assert.ok(!matchesCombo(ev({ key: 's', ctrlKey: true, metaKey: true }), save, false), '双主修饰键不命中');
  assert.ok(!matchesCombo(ev({ key: 'x', ctrlKey: true }), save, false), '按键不符不命中');

  // 搜索：mac 只有 ⌘⇧F；非 mac 额外保留 Ctrl+K
  assert.deepEqual(combosFor('search', true).length, 1, 'mac 上搜索只有 1 个组合');
  assert.deepEqual(combosFor('search', false).length, 2, '非 mac 保留 Ctrl+K');
  assert.ok(matchesCombo(ev({ key: 'f', ctrlKey: true, shiftKey: true }), comboOf('search'), false));
  assert.ok(matchesCombo(ev({ key: 'k', ctrlKey: true }), combosFor('search', false)[1], false));
  assert.ok(!matchesCombo(ev({ key: 'k', ctrlKey: true }), combosFor('search', false)[1], true), 'mac 上不抢 Ctrl+K');
  assert.ok(!matchesCombo(ev({ key: 'f', ctrlKey: true }), comboOf('search'), false), 'Mod+F 不应命中 Mod+Shift+F');

  // 无修饰键的组合（Esc）：带修饰键反而不能命中
  const close = comboOf('close-detail');
  assert.ok(matchesCombo(ev({ key: 'Escape' }), close, false), 'Esc 命中且大小写不敏感');
  assert.ok(!matchesCombo(ev({ key: 'Escape', ctrlKey: true }), close, false), 'Ctrl+Esc 不算关闭详情');

  // 同一动作的别名要能被区分出来（分发时要把命中的组合键交给 handler）
  const searchDef = SHORTCUTS.find((item) => item.id === 'search');
  assert.equal(matchedCombo(ev({ key: 'k', ctrlKey: true }), searchDef, false)?.key, 'k');
  assert.equal(matchedCombo(ev({ key: 'f', ctrlKey: true, shiftKey: true }), searchDef, false)?.key, 'f');
  assert.equal(matchedCombo(ev({ key: 'q', ctrlKey: true }), searchDef, false), undefined, '未命中返回 undefined');
  assert.equal(matchedCombo(ev({ key: 'k', ctrlKey: true }), searchDef, true), undefined, 'mac 上 Ctrl+K 别名被排除');

  // 物理键位兜底：输入法把 event.key 变成 Process 时靠 code 命中
  assert.ok(matchesCombo(ev({ key: 'Process', code: 'KeyS', ctrlKey: true }), save, false));
  assert.ok(!matchesCombo(ev({ key: 'Process', code: 'KeyX', ctrlKey: true }), save, false));

  // ── 2. 展示文案按平台切换 ────────────────────────────────
  assert.equal(formatCombo(comboOf('save'), true), '⌘S');
  assert.equal(formatCombo(comboOf('save'), false), 'Ctrl+S');
  assert.equal(formatCombo(comboOf('search'), true), '⌘⇧F');
  assert.equal(formatCombo(comboOf('search'), false), 'Ctrl+Shift+F');
  assert.equal(formatCombo(comboOf('close-detail'), false), 'Esc');
  assert.equal(formatCombo(comboOf('help'), false), 'Ctrl+/');
  assert.equal(formatShortcut('new-todo', false), 'Ctrl+N');
  assert.equal(formatShortcut('search', true), '⌘⇧F', 'tooltip 用平台首选组合');
  assert.equal(formatShortcut('nope', false), '', '未知 id 返回空串而不是抛错');

  // ── 3. guard：富文本内 Esc 不生效，普通输入框内照常 ──────
  assert.ok(isRichTextTarget(RICH), '富文本目标应被识别');
  assert.ok(!isRichTextTarget(INPUT), '普通 input 不算富文本');
  assert.ok(!isRichTextTarget(null));
  // 块编辑器（票 05 §7）：抑制规则按容器属性判定，换引擎不用改键位表
  // 块编辑器（票 05 §7）：抑制规则按容器属性判定，换底座不用回来改键位表
  assert.ok(isRichTextTarget(node(['[data-block-editor="on"]'])), '块编辑器内部必须让 Esc 留给编辑器');
  assert.ok(!isRichTextTarget(node(['textarea'])), '普通 textarea 不算富文本，Esc 照常退页');

  const registered = new Set(['save', 'close-detail', 'new-todo', 'search', 'toggle-sidebar', 'help']);
  const ctx = (over = {}) => ({ isMac: false, blockingOverlay: false, registered, ...over });
  assert.equal(resolveShortcut(ev({ key: 's', ctrlKey: true, target: INPUT }), ctx())?.id, 'save', '输入框内也能保存');
  assert.equal(resolveShortcut(ev({ key: 's', ctrlKey: true, target: RICH }), ctx())?.id, 'save', '富文本内也能保存');
  assert.equal(resolveShortcut(ev({ key: 'Escape', target: INPUT }), ctx())?.id, 'close-detail', '普通输入框内 Esc 可退页');
  assert.equal(resolveShortcut(ev({ key: 'Escape', target: RICH }), ctx()), null, '富文本内 Esc 留给编辑器');
  assert.equal(resolveShortcut(ev({ key: 'Escape' }), ctx())?.id, 'close-detail');

  // ── 4. 抑制规则：输入法 / 已被处理 / 有浮层 / 未注册 ──────
  assert.equal(resolveShortcut(ev({ key: 's', ctrlKey: true, isComposing: true }), ctx()), null, '拼字中不触发');
  assert.equal(resolveShortcut(ev({ key: 's', ctrlKey: true, defaultPrevented: true }), ctx()), null, '已被消费不重复处理');
  assert.equal(resolveShortcut(ev({ key: 's', ctrlKey: true }), ctx({ blockingOverlay: true })), null, '有浮层时整体抑制');
  assert.equal(resolveShortcut(ev({ key: 'Escape' }), ctx({ blockingOverlay: true })), null, '有浮层时 Esc 交给浮层');
  assert.equal(resolveShortcut(ev({ key: 's', ctrlKey: true }), ctx({ registered: new Set() })), null, '未注册的快捷键不触发');
  assert.equal(resolveShortcut(ev({ key: 'q', ctrlKey: true }), ctx()), null, '未定义组合返回 null');
  // 页面级（save/close-detail）未注册时，其余仍然可用
  assert.equal(resolveShortcut(ev({ key: 'n', ctrlKey: true }), ctx({ registered: new Set(['new-todo']) }))?.id, 'new-todo');

  // ── 5. 保留键无条件 preventDefault ────────────────────────
  assert.ok(shouldPreventDefault(ev({ key: 's', ctrlKey: true }), false), 'Ctrl+S 必须拦');
  assert.ok(shouldPreventDefault(ev({ key: 'n', ctrlKey: true }), false), 'Ctrl+N 必须拦');
  assert.ok(shouldPreventDefault(ev({ key: '/', ctrlKey: true }), false), 'Ctrl+/ 必须拦');
  assert.ok(shouldPreventDefault(ev({ key: 's', metaKey: true }), true), 'mac 的 ⌘S 必须拦');
  assert.ok(!shouldPreventDefault(ev({ key: 'k', ctrlKey: true }), false), 'Ctrl+K 不强制拦（它只是聚焦搜索）');
  assert.ok(!shouldPreventDefault(ev({ key: 'Escape' }), false), 'Esc 不在这里拦');

  // ── 6. 浮层判定：Tooltip 不算浮层（否则悬停按钮时 Esc 永久失效） ──
  for (const token of ['[role="dialog"][data-state="open"]', '[role="alertdialog"][data-state="open"]', '[role="menu"]', '[role="listbox"]']) {
    assert.ok(OVERLAY_SELECTOR.includes(token), '浮层选择器必须包含 ' + token);
  }
  assert.equal(POPPER_SELECTOR, '[data-radix-popper-content-wrapper]');
  const fakeDoc = (modals, wrappers) => ({
    querySelector: () => (modals ? { nodeName: 'DIV' } : null),
    querySelectorAll: () => wrappers,
  });
  const wrapper = (hasTooltip) => ({ querySelector: () => (hasTooltip ? { nodeName: 'DIV' } : null) });
  assert.ok(hasBlockingOverlay(fakeDoc(true, [])), '模态弹层算浮层');
  assert.ok(!hasBlockingOverlay(fakeDoc(false, [])), '什么都没开就不算');
  assert.ok(hasBlockingOverlay(fakeDoc(false, [wrapper(false)])), 'Popover/Select 的 popper 算浮层');
  assert.ok(!hasBlockingOverlay(fakeDoc(false, [wrapper(true)])), 'Tooltip 不算浮层');
  assert.ok(hasBlockingOverlay(fakeDoc(false, [wrapper(true), wrapper(false)])), '只要有一个非 Tooltip 浮层就算');
  assert.ok(!hasBlockingOverlay(fakeDoc(false, [wrapper(true), wrapper(true)])), '全是 Tooltip 不算浮层');

  console.log('PASS: 组合键精确匹配（含双主修饰键/物理键位兜底）、平台化展示、富文本与浮层抑制、Tooltip 排除、保留键拦截均正确。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
