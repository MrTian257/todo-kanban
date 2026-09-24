import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// GrokBot 模块包：数据完整性 + 形变纯函数 + 样式生成 + 与应用侧的状态映射一致性。
// 形变数学算错不会抛异常，只会让表情"看起来不对"，因此必须靠断言锁住关键不变式。
const dir = await mkdtemp(path.join(tmpdir(), 'tk-grokbot-'));
try {
  await build({
    entryPoints: ['src/grokbot/index.ts'],
    bundle: true, platform: 'node', format: 'esm',
    outfile: path.join(dir, 'grokbot.mjs'),
  });
  const gb = await import(pathToFileURL(path.join(dir, 'grokbot.mjs')));

  // ── 1. 数据完整性 ─────────────────────────────────────────
  assert.equal(gb.BUILTIN_EXPRESSIONS.length, 25, '内置表情数量');
  const expressionIds = new Set(gb.BUILTIN_EXPRESSIONS.map((e) => e.id));
  assert.equal(expressionIds.size, gb.BUILTIN_EXPRESSIONS.length, '表情 id 不能重复');
  for (const expression of gb.BUILTIN_EXPRESSIONS) {
    assert.equal(expression.eyes.length, 2, expression.id + ' 必须是左右两眼');
    assert.equal(expression.eyes[0].length, expression.eyes[1].length, expression.id + ' 两眼点数必须一致');
    for (const ring of expression.eyes) {
      assert.equal(ring.length, 48, expression.id + ' 每圈应为 48 点（与形变插值约定一致）');
      for (const point of ring) {
        assert.ok(Number.isFinite(point[0]) && Number.isFinite(point[1]), expression.id + ' 存在非法坐标');
      }
    }
  }

  const stateIds = new Set(gb.BUILTIN_STATES.map((s) => s.id));
  const actionIds = new Set(gb.BUILTIN_ACTIONS.map((a) => a.id));
  assert.ok(stateIds.size >= 39, '内置状态数量');
  for (const state of gb.BUILTIN_STATES) {
    for (const id of state.expressions) {
      assert.ok(expressionIds.has(id), state.id + ' 引用了不存在的表情 ' + id);
    }
    if (state.action) assert.ok(actionIds.has(state.action), state.id + ' 引用了不存在的动作 ' + state.action);
    if (state.cadence) assert.ok(state.cadence[0] > 0 && state.cadence[1] >= state.cadence[0], state.id + ' 节奏区间非法');
    if (state.blink) assert.ok(state.blink[0] > 0 && state.blink[1] >= state.blink[0], state.id + ' 眨眼区间非法');
  }
  for (const group of gb.BUILTIN_GROUPS) {
    for (const id of group.states) assert.ok(stateIds.has(id), group.id + ' 引用了不存在的状态 ' + id);
  }
  for (const action of gb.BUILTIN_ACTIONS) {
    assert.ok(action.keyframes, action.id + ' 应自带关键帧');
    assert.ok(action.durationMs > 0, action.id + ' 应有正的时长');
    assert.ok(['body', 'eyes'].includes(action.target), action.id + ' 目标非法');
  }

  // ── 2. 配色令牌 ───────────────────────────────────────────
  const themeKeys = Object.keys(gb.BUILTIN_THEME);
  assert.equal(themeKeys.length, 9, '主题令牌数量变了要同步设置页与文档');
  for (const preset of gb.THEME_PRESETS) {
    for (const key of themeKeys) {
      assert.ok(typeof preset.theme[key] === 'string' && preset.theme[key].length > 0, preset.id + '.' + key + ' 缺失');
    }
  }

  // ── 3. 形变纯函数 ─────────────────────────────────────────
  const { ringToPath, interpolateRings, blinkScale, stepSpring, renderEye, centroid, pickOther, randomBetween } = gb;
  const ring = [[0, 0], [10, 0], [10, 10]];
  assert.equal(ringToPath(ring), 'M0.00 0.00L10.00 0.00L10.00 10.00Z', 'path 必须是闭合的 M…L…Z');
  assert.equal(ringToPath([]), '', '空圈返回空串而不是抛错');
  assert.deepEqual(centroid(ring), [20 / 3, 10 / 3]);
  assert.deepEqual(centroid([]), [0, 0], '空圈形心兜底为 0，避免 NaN 传染');

  const from = [[[0, 0]], [[10, 10]]];
  const to = [[[10, 20]], [[30, 40]]];
  assert.deepEqual(interpolateRings(from, to, 0), from, 't=0 应等于起点');
  assert.deepEqual(interpolateRings(from, to, 1), to, 't=1 应等于终点');
  assert.deepEqual(interpolateRings(from, to, 0.5), [[[5, 10]], [[20, 25]]], 't=0.5 应取中点');
  assert.deepEqual(interpolateRings(from, to, 5), to, 't 超过 1 应被钳制');
  assert.deepEqual(interpolateRings(from, to, -1), from, 't 小于 0 应被钳制');

  assert.equal(blinkScale(0), 1, '0ms 处于睁眼态');
  assert.ok(blinkScale(160) < 0.1, '半程应接近闭合');
  assert.equal(blinkScale(320), 1, '到点即视为睁眼');
  assert.equal(blinkScale(-1), 1, '负耗时按睁眼处理');
  assert.ok(gb.BLINK_DURATION_MS > 0, '眨眼时长必须是正数');
  for (const t of [0, 40, 80, 160, 240, 319]) {
    const value = blinkScale(t);
    assert.ok(value >= 0.04 && value <= 1, '眨眼缩放必须落在 [0.04, 1]');
  }

  // 弹簧：从 0 收敛到 1，且不会发散；NaN 输入要被兜底成目标值
  let spring = { value: 0, velocity: 0 };
  for (let i = 0; i < 200; i += 1) spring = stepSpring(spring, 1, 1 / 60);
  assert.equal(spring.value, 1, '弹簧应收敛到目标值');
  assert.equal(spring.velocity, 0, '收敛后速度应归零');
  assert.deepEqual(stepSpring({ value: Number.NaN, velocity: 0 }, 1, 0.016), { value: 1, velocity: 0 });
  // 超大 dt 必须被钳制（标签页切回来时不会把弹簧打飞）
  const clamped = stepSpring({ value: 0, velocity: 0 }, 1, 10);
  assert.ok(Number.isFinite(clamped.value) && Math.abs(clamped.value) <= 2, 'dt 必须被钳制');

  // 投影：正视可见、转到背面隐藏且横向压扁
  const front = renderEye([[100, 100], [110, 110]], {});
  const back = renderEye([[100, 100], [110, 110]], { turnDeg: 180 });
  assert.ok(front.visible && !back.visible, '转到背面应隐藏');
  assert.match(front.d, /^M/);
  assert.match(front.transform, /^translate\(/, 'transform 必须以 translate 开头（缩放再平移回去）');
  assert.notEqual(front.transform, back.transform);
  const blinking = renderEye([[100, 100]], { blink: 0.04 });
  assert.match(blinking.transform, /0\.0400/, '眨眼缩放应进入 transform 的 y 分量');
  assert.deepEqual(renderEye([[100, 100]], { turnDeg: -180 }).visible, false);

  assert.equal(randomBetween(null, 7), 7, '缺区间时回落 fallback');
  assert.equal(randomBetween([10, 10], 7), 7, '空区间（max<=min）应回落 fallback');
  for (let i = 0; i < 20; i += 1) {
    const value = randomBetween([5, 8], 0);
    assert.ok(value >= 5 && value < 8);
  }
  assert.equal(pickOther([], 'a'), null);
  assert.equal(pickOther(['only'], 'only'), 'only', '池子只有一项时只能返回它');
  for (let i = 0; i < 20; i += 1) assert.notEqual(pickOther(['a', 'b'], 'a'), 'a', '应尽量避免与当前相同');

  // ── 4. 样式生成：作用域隔离 + 动作关键帧按实例命名 ─────────
  const actions = gb.resolveActions(gb.BUILTIN_ACTIONS);
  const css = gb.buildStyles('gb-test', gb.BUILTIN_THEME, actions);
  assert.ok(css.includes('.gb-test '), '选择器必须带实例作用域');
  assert.ok(css.includes('@keyframes gb-test-bounce'), '关键帧名必须带实例前缀');
  assert.ok(css.includes('--gb-body:'), '主题以 CSS 变量下发');
  assert.ok(css.includes('.gb-test .gb-svg.gb-act-scan .gb-eyes'), '扫视动作应作用在眼睛层');
  assert.ok(css.includes('.gb-test .gb-svg.gb-act-bounce {'), '弹跳动作应作用在整体');
  assert.ok(css.includes('prefers-reduced-motion'), '必须提供减少动态效果的降级');
  const vars = gb.themeVariables({ ...gb.BUILTIN_THEME, body: '#123456' });
  assert.ok(vars.includes('--gb-body: #123456;'));

  // ── 5. 与应用侧的约定：心情映射必须指向真实存在的状态 ──────
  // 引擎对未知状态 id 是静默忽略的，映射写错只会"没反应"，不会报错——所以要在这里拦住。
  const petStateSource = await readFile(path.resolve('src/lib/petState.ts'), 'utf8');
  const mapping = petStateSource.match(/GROKBOT_STATE_BY_MOOD[^{]*\{([^}]*)\}/);
  assert.ok(mapping, '未找到 GROKBOT_STATE_BY_MOOD 映射表');
  const targets = [...mapping[1].matchAll(/:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(targets.length, 7, '心情映射应覆盖 7 档心情');
  for (const target of targets) {
    assert.ok(stateIds.has(target), '心情映射指向了不存在的 GrokBot 状态：' + target);
  }

  console.log('PASS: 表情/状态/动作数据自洽、形变纯函数（path/插值/眨眼/弹簧/投影）、样式作用域隔离与主题变量、心情→状态映射均正确。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
