// 自定义字段与自动脚本纯逻辑测试（esbuild + node assert，无测试框架）：
// 词表镜像、取值规范化 / 强转、内置属性求值、默认值、卡片展示与配置校验。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = await mkdtemp(path.join(tmpdir(), 'tk-fields-'));
try {
  await build({ entryPoints: ['src/lib/customFields.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir, 'fields.mjs') });
  const cf = await import(pathToFileURL(path.join(dir, 'fields.mjs')));

  const field = (over = {}) => ({
    id: 'f1', label: '字段', type: 'text', source: 'manual', builtin: '',
    options: [], defaultValue: null, required: false, showOnCard: false,
    description: '', projectId: null, sortOrder: 0, ...over,
  });
  const project = {
    id: 'p1', name: '项目甲',
    swimlanes: [{ id: 'swim-doing', name: '进行中', status: 'doing', sortOrder: 1 }],
  };
  const todo = {
    id: 't1', projectId: 'p1', title: '任务一', status: 'doing', swimlaneId: 'swim-doing',
    branch: 'feature/x', tag: 'todo-3', seq: 3, blocker: '', startDate: null, endDate: null,
    startedAt: 1000, doneAt: null, createdAt: 500, updatedAt: 900,
    commits: [{ hash: 'a' }, { hash: 'b' }],
    customFields: [{ fieldId: 'f-a', value: '存值' }],
  };

  // 1. 规范化：排序、去空、去重、裁剪（必须与 Rust canonicalize_custom_fields 一致）
  const canonical = cf.canonicalizeCustomFields([
    { fieldId: 'f-b', value: '  值  ' },
    { fieldId: 'f-a', value: '' },
    { fieldId: 'f-c', value: ['x', 'x', ' '] },
    { fieldId: 'f-d', value: null },
    { fieldId: 'f-b', value: '重复' },
    { fieldId: '', value: 'x' },
    { fieldId: 'f-e', value: 0 },
    { fieldId: 'f-f', value: false },
  ]);
  assert.deepEqual(canonical.map((item) => item.fieldId), ['f-b', 'f-c', 'f-e', 'f-f']);
  assert.equal(canonical[0].value, '值');
  assert.deepEqual(canonical[1].value, ['x']);
  assert.equal(canonical[2].value, 0, '数字 0 不是空值');
  assert.equal(canonical[3].value, false, '布尔 false 不是空值');
  assert.deepEqual(cf.canonicalizeCustomFields(undefined), []);

  // 2. 取值强转：与后端同规则，不兼容返回 null（动作被跳过）
  assert.equal(cf.coerceFieldValue(field({ type: 'text' }), 12), '12');
  assert.equal(cf.coerceFieldValue(field({ type: 'number' }), ' 3.5 '), 3.5);
  assert.equal(cf.coerceFieldValue(field({ type: 'number' }), 'abc'), null);
  assert.equal(cf.coerceFieldValue(field({ type: 'date' }), '2026-02-03'), '2026-02-03');
  assert.equal(cf.coerceFieldValue(field({ type: 'date' }), '2026-2-3'), null);
  assert.equal(cf.coerceFieldValue(field({ type: 'date' }), '2026-02-30'), null, '不存在的日期不通过');
  assert.equal(cf.coerceFieldValue(field({ type: 'checkbox' }), '是'), true);
  assert.equal(cf.coerceFieldValue(field({ type: 'select', options: ['高', '低'] }), '中'), null);
  assert.equal(cf.coerceFieldValue(field({ type: 'select', options: ['高', '低'] }), '高'), '高');
  assert.deepEqual(cf.coerceFieldValue(field({ type: 'multiselect', options: ['甲', '乙'] }), '甲, 乙'), ['甲', '乙']);
  assert.equal(cf.coerceFieldValue(field({ type: 'multiselect', options: ['甲'] }), ['丙']), null);
  const ms = new Date(2026, 0, 2, 9, 30).getTime();
  assert.equal(cf.coerceFieldValue(field({ type: 'datetime' }), '2026-01-02 09:30'), ms);
  assert.equal(cf.coerceFieldValue(field({ type: 'datetime' }), ms), ms);

  // 3. 表单校验：空值只在必填时提示；类型不匹配始终提示
  assert.equal(cf.validateFieldValue(field({ type: 'number' }), null), '');
  assert.equal(cf.validateFieldValue(field({ type: 'number', required: true, label: '预估' }), null), '「预估」不能为空');
  assert.equal(cf.validateFieldValue(field({ type: 'number', label: '预估' }), 'abc'), '「预估」需要数字类型的值');

  // 4. 展示格式化
  assert.equal(cf.formatCustomValue(field({ type: 'datetime' }), ms), '2026-01-02 09:30');
  assert.equal(cf.formatCustomValue(field({ type: 'checkbox' }), false), '否');
  assert.equal(cf.formatCustomValue(field({ type: 'multiselect' }), ['甲', '乙']), '甲、乙');
  assert.equal(cf.formatCustomValue(field({ type: 'text' }), null), '');

  // 5. 内置属性求值（值来源 = 任务内置属性，不落库）
  assert.equal(cf.builtinAttributeValue('swimlane', todo, project), '进行中');
  assert.equal(cf.builtinAttributeValue('project', todo, project), '项目甲');
  assert.equal(cf.builtinAttributeValue('status', todo, project), '进行中');
  assert.equal(cf.builtinAttributeValue('commitCount', todo, project), 2);
  assert.equal(cf.builtinAttributeValue('doneAt', todo, project), null);
  assert.equal(cf.builtinAttributeValue('未知', todo, project), null);
  assert.equal(cf.resolveFieldValue(field({ source: 'builtin', builtin: 'tag' }), todo, project), 'todo-3');
  assert.equal(cf.resolveFieldValue(field({ id: 'f-a' }), todo, project), '存值');

  // 6. 作用范围与卡片字段
  const defs = [field({ id: 'f2', label: '乙', sortOrder: 2, showOnCard: true }), field({ id: 'f1', label: '甲', sortOrder: 1, showOnCard: true }), field({ id: 'f3', label: '丙', projectId: 'p2' })];
  assert.deepEqual(cf.visibleFieldDefs(defs, 'p1').map((def) => def.id), ['f1', 'f2']);
  assert.deepEqual(cf.cardFieldDefs(defs, 'p1').map((def) => def.id), ['f1', 'f2']);
  assert.deepEqual(cf.visibleFieldDefs(defs, 'p2').map((def) => def.id), ['f1', 'f2', 'f3']);

  // 7. 新建默认值：仅 manual 且类型可强转
  const defaults = cf.applyFieldDefaults([
    field({ id: 'f1', defaultValue: '默认' }),
    field({ id: 'f2', defaultValue: 'x', source: 'rule' }),
    field({ id: 'f3', defaultValue: 'x', type: 'number' }),
    field({ id: 'f4', defaultValue: null }),
  ], 'p1');
  assert.deepEqual(defaults, { f1: '默认' });

  // 8. 配置校验（与后端同规则）
  assert.equal(cf.validateFieldDef(field({ label: '甲' }), []), '');
  assert.equal(cf.validateFieldDef(field({ label: '' }), []), '请填写字段名称');
  assert.equal(cf.validateFieldDef(field({ label: '甲' }), [field({ id: 'f9', label: '甲' })]), '同一范围内已有同名字段');
  assert.equal(cf.validateFieldDef(field({ label: '甲', type: 'select', options: [] }), []), '选择类字段至少需要一个候选项');
  assert.equal(cf.validateFieldDef(field({ label: '甲', type: 'select', options: ['x', ' x '] }), []), '候选项不能重复');
  assert.equal(cf.validateFieldDef(field({ label: '甲', source: 'builtin', builtin: '不存在' }), []), '请选择内置属性');
  assert.equal(cf.validateFieldDef(field({ label: '甲', source: 'rule', defaultValue: 'x' }), []), '由自动脚本维护的字段不能设置默认值');

  const rule = {
    id: 'a1', name: '进入泳道记时间', enabled: true,
    trigger: { kind: 'laneEntered', laneId: 'swim-doing', to: '', fieldId: '' },
    conditions: [],
    actions: [{ kind: 'setField', target: 'f1', value: { kind: 'now', value: null, name: '', fieldId: '', text: '' } }],
  };
  assert.equal(cf.validateRule(rule), '');
  assert.equal(cf.validateRule({ ...rule, name: '' }), '请填写规则名称');
  assert.equal(cf.validateRule({ ...rule, trigger: { ...rule.trigger, laneId: '' } }), '请选择触发泳道');
  assert.equal(cf.validateRule({ ...rule, actions: [] }), '至少需要 1 个动作');
  assert.equal(
    cf.validateRule({ ...rule, actions: [{ kind: 'setField', target: 'builtin:status', value: { kind: 'now', value: null, name: '', fieldId: '', text: '' } }] }).includes('不允许自动写入'),
    true,
    '内置目标白名单外必须被拒绝',
  );
  assert.equal(cf.validateRule({ ...rule, actions: [{ kind: 'setField', target: 'f1', value: { kind: 'template', value: null, name: '', fieldId: '', text: '' } }] }), '模板内容不能为空');

  // 9. 失效引用提示（保存不阻断，界面标注）
  assert.deepEqual(cf.ruleIssues(rule, [field({ id: 'f1' })], ['swim-doing']), []);
  assert.deepEqual(cf.ruleIssues(rule, [field({ id: 'f1' })], ['swim-todo']), ['触发泳道已不存在']);
  assert.deepEqual(cf.ruleIssues(rule, [], ['swim-doing']), ['目标字段已不存在']);
  assert.deepEqual(cf.ruleIssues({ ...rule, trigger: { kind: 'fieldChanged', laneId: '', to: '', fieldId: 'f-x' } }, [field({ id: 'f1' })], ['swim-doing']), ['触发字段已不存在']);

  // 10. 摘要文案
  assert.equal(cf.describeTrigger(rule, () => '进行中'), '拖入「进行中」');
  assert.equal(cf.describeAction(rule.actions[0], [field({ id: 'f1', label: '进入时间' })]), '设置 「进入时间」 = 当前时间');
  assert.equal(cf.describeAction({ kind: 'clearField', target: 'builtin:startedAt', value: null }, []), '清空 开始时间');

  console.log('PASS: 规范化 / 强转 / 校验 / 内置属性求值 / 作用范围 / 默认值 / 规则校验与失效提示。');
} finally {
  await rm(dir, { recursive: true, force: true });
}
