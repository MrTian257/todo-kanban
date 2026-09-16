# ADR-014：自定义字段（值来源）与声明式自动脚本

- 状态：已实施（数据版本 v11）
- 日期：2026-09
- 相关：ADR-008（单 store 写链）、ADR-011（数据版本升级）、ADR-012（固定数据源）
- 关联文档：docs/01-design/data-model.md、docs/软件设计文档.md

## 背景

内置字段（标题 / 备注 / 泳道 / 分支 / 计划日期 / 卡点 / 提交标记 / 创建者…）由固定列承载，无法覆盖「进入开发时间」
「评审人」「预估工时」「环境」这类随团队变化的属性。用户诉求是：

1. 能**全局定义新的字段属性**（类型、候选项、默认值、是否必填、是否显示在卡片、作用范围）；
2. 能配置每个字段的**值来源**——手动填写 / 直接引用任务已有的内置属性 / 由脚本自动写入；
3. 能配置**简单的自动脚本**，例如「把卡片拖入『进行中』后自动记录进入时间」；
4. 方案**可扩展**：以后加新的触发时机或动作不需要推倒重来。

同时必须守住既有约束：后端为权威（前端 zod 同规则、后端兜底）、唯一业务写入口是 `db_save_state`
（MCP 复用）、快照比较依赖读写对称、恢复类操作必须忠实。

## 决策

### D1 字段定义与自动脚本放在工作流配置（workflow_state），不放 todos 行

`Workflow`（`core/src/svc/workflow.rs`，存 `workflow_state` 单行 JSON）新增 `fieldDefs` 与 `automations` 两段，
沿用既有 revision 乐观锁（`workflow_save` 携带 expected）、`validate` 与 `prune` 机制。
理由：与 templates / reminders / backup 同源；配置是全局的，不属于任何一条任务；避免把定义重复写进每条任务快照。

### D2 字段值放在 todos.custom_fields（schema v11）

`todos` 新增 `custom_fields TEXT NOT NULL DEFAULT '[]'`，JSON 数组 `[{ fieldId, value }]`，
随 `DbState` 快照流动。理由：唯一写入口 `db_save_state`、MCP 读写、变更历史、提案预览、撤销与前端 rebase
全部自动生效，无需新通道；代价是一次数据版本升级（自带硬备份与逐级迁移，见 ADR-011）。

**规范化是硬要求**：读（`row_to_todo`）、写（`todo_params`）、比较（`normalize_todo_for_compare`）、
前端（`normalizeTodo` → `canonicalizeCustomFields`）四处必须做同一件事——丢弃空值（null / 空串 / 空数组）、
文本去首尾空白、列表去空项与重复项、按 fieldId 升序、同 id 保留首个。任何一处不一致都会制造永远无法通过的
`STATE_CONFLICT`（历史上已因读写不对称踩过一次）。

### D3 自动脚本由后端在保存事务内执行（前端只渲染结果）

执行点在 `db::save_state_inner`：先做 seq/tag 收敛与泳道回退，再对**保存前库中快照 → 待写快照**做 diff 触发规则，
最后统一 upsert。因此看板拖拽、右键「移动到泳道」、详情页改泳道、MCP 改 `swimlaneId` 四条路径行为完全一致。
代价：自动写入的值要推进 `updated_at = max(now, old+1)`，否则会被 `WHERE excluded.updated_at >= todos.updated_at`
守卫吞掉；收益：不需要为每条 UI 路径各写一份规则。

浏览器预览模式（无后端）不执行脚本，UI 明确说明。

### D4 用声明式词表而不是脚本运行时

触发器：`created` / `laneEntered` / `statusChanged` / `fieldChanged` / `commitAdded`；
条件（且）：`project` / `lane` / `status` / `field`（equals / notEmpty / empty）；
动作：`setField` / `clearField`；取值表达式：`now` / `today` / `constant` / `attribute` / `field` / `template`。

理由：不引入 JS/Lua 运行时（体积、沙箱、确定性都很贵）；规则是纯函数，可在内存库上单测；
扩展 = 在词表里加一个分支 + 一处 UI 表单。前端 `src/lib/customFields.ts` 与后端 `svc/fields.rs`、`svc/automation.rs`
维护同一张词表（双兜底，后端为准）。

### D5 动作只写自定义字段 + 白名单内置属性

可写内置目标：`startedAt` / `doneAt` / `startDate` / `endDate` / `blocker`。
刻意**不**允许写 `status` / `swimlaneId` / `archived` / `tag` / `seq` / `title`：写这些会让规则互相触发
（进入泳道 → 改状态 → 再次进入泳道），无法收敛。即便有白名单，仍保留两道收敛兜底：每条规则对每个任务每次保存
至多触发一次；单次保存最多 3 轮；单次保存动作总数上限 5000（泳道批量迁移时的爆炸兜底）。

### D6 删除字段定义不自动清理历史值

`workflow::read` 在配置行缺失时返回 `Workflow::default()`（`fieldDefs` 为空）。若保存路径按定义自动清理，
一次配置读取失败就会抹掉全部字段值。因此值保留在库中、只是不再展示，另设**显式**入口
「清理未定义字段值」（工作流页，二次确认，写入变更历史可回滚）。

### D7 required 只在界面提示，后端不阻断

后端强校验必填会让 MCP / 自动脚本创建的任务永久保存失败，而字段定义是用户自己的约束。
前端在提交前用 `validateFieldValue` 给出中文提示；后端只做类型强转与长度裁剪。

### D8 本地时间用 chrono（clock）而非手写 UTC

`today`（YYYY-MM-DD）、模板 `{{date}}` / `{{datetime}}`、datetime 文本解析都按**本地时区**求值；
手写 UTC 换算会在 UTC+8 的凌晨错一天。锁文件里已有 `chrono 0.4.45` 与 `iana-time-zone`，无新增下载。

## 运行矩阵

| 路径 | 补默认值 / 执行自动脚本 |
| --- | --- |
| UI 保存（`db_save_state`）、MCP `db_save_state`、提案应用（`proposal_apply`） | 是 |
| 备份恢复（`backup_restore`）、历史恢复（`history_restore`） | 否（还原必须忠实） |
| 种子数据、数据迁移、内部批量写（`db::save_state`） | 否 |

## 后果

- 正面：属性可扩展且随任务一起流动（读写、历史、MCP、撤销全部复用既有链路）；规则行为与写入来源无关；
  纯函数实现便于单测与后续扩展。
- 负面：数据版本 +1（v10 → v11，升级前自动硬备份）；每次保存多一次工作流配置读取（无规则时走零成本路径直接跳过）；
  自动写入会让正在编辑该任务的用户看到「任务已被…自动脚本修改」提示（本地编辑仍然保留，下次保存补齐）。
- 已知边界：规则引用已删除的泳道 / 字段不阻断配置保存，界面标注「失效」且不参与运行；
  泳道批量迁移会一次性触发大量 `laneEntered`，由轮次与动作总量上限约束。

## 未做（后续可加）

字段驱动的看板筛选 / 排序 / 统计；条件分组（或 / 非）；定时触发（如「结束日期前一天的提醒」）；
真正受限的表达式语言；字段定义随项目导出导入。
