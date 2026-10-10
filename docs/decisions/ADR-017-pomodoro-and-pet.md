# ADR-017：番茄钟（独立计时器）与 GrokBot 桌面宠物

- 状态：已实施
- 日期：2026-09
- 相关：ADR-008（单 store 写链）、ADR-011（数据版本升级框架）、ADR-012（固定数据源）、ADR-014（配置与业务数据分离）
- 关联文档：AGENTS.md、CLAUDE.md、src-tauri/AGENTS.md、docs/软件设计文档.md

## 背景

两个诉求同时提出：

1. **番茄钟**：需要在应用里有一个能真正用的专注计时器（专注 / 短休 / 长休），并且能回看「今天专注了几轮、这一周投入了多少」；
2. **GrokBot 小表情宠物**：一个会做表情的小机器人，随专注与任务状态变化，给工作过程一点陪伴感。

约束来自既有架构：唯一业务写入口是 `db_save_state`（ADR-008）；数据版本升级必须五处同步（ADR-011）；
数据源固定为运行目录 `todo-kanban.db`（ADR-012）；配置类数据不进业务快照（ADR-014 的既有结论）。

需求澄清（本轮已确认）：

- 宠物形态选**应用内浮层**，不做独立置顶桌面窗口；
- 番茄记录**落库 + 统计**，接受数据版本升级；
- 番茄钟是**独立计时器**，不绑定待办；
- 宠物只做**表情陪伴 + 事件反应**，不做等级 / 成就 / 成长系统。

## 决策

### D1 番茄会话落库为独立表，升级到数据版本 v14

新增 `pomodoro_sessions`（`id / kind / started_at / ended_at / planned_ms / actual_ms / completed / interruptions`），
**不属于 `DbState`**：它不进 `db_save_state` 差异写链，也不会被 MCP 的 `db_save_state` 覆盖。
SELECT/INSERT 全部收在 `core/src/svc/pomodoro.rs`，与 `workflow_state` 同模式，因此**不需要**动 `row.rs` 与 `db/mod.rs` 的行映射。

版本同步按 ADR-011 五处落地：`config`（`CURRENT_DATA_VERSION=14` / `MIGRATION_STEPS` / `CHANGELOG`）、
`schema.rs`（DDL + `USER_VERSION`）、`upgrade/src/migration.rs`（v13→v14 仅推进版本，表由 core 幂等建表）、
前端 `lib/version.ts`（预览报告）、`db/mod.rs::is_pristine`（把新表算作「用户已有数据」）。

**为什么不放进 `workflow_state` 的 JSON**：会话是持续追加的日志（每天可能几十条），
放 JSON 会让每次配置保存与 15s 轮询都搬运整份历史，且无法做 SQL 聚合；独立表 + 索引才有正确的增长曲线。

### D2 只记录「已结束」的会话，运行态留在本机

运行中的计时是纯前端状态：`lib/pomodoroStore.ts` 用 `useSyncExternalStore` 持有阶段与剩余时间，
剩余时间**恒由绝对结束时间戳换算**（`endsAt - Date.now()`），250ms tick 只负责刷新界面。
这样窗口后台节流、系统休眠都不会让倒计时漂移。

- 运行态快照写 localStorage（`todo-kanban.pomodoro.runtime.v1`）：12h 内重启按剩余时间恢复；
  结束时刻已过则**补记一次**（按计划时长计），超过 12h 直接丢弃，避免几天后打开应用突然弹一堆通知。
- 落库只发生在阶段结束时，因此表里不存在 `ended_at IS NULL` 的行，也就没有「悬挂会话清理」这条路径。
- 不足 1 分钟的中断不落库（`shouldRecord`）：误触「跳过 / 重置」不该在统计里留垃圾。
- **阶段结束的应用内提醒是 GrokBot 表情弹窗**（`components/pomodoro/PomodoroAlert.tsx`）：GrokBot 的 SVG
  表情渲染不了进系统通知，所以自己实现弹窗承载「表情 + 文案 + 操作（开始下一轮 / 知道了）」，
  15s 自动收起；系统通知（`desktop_notify`）保留为窗口不在前台时的兜底，浏览器预览下退回 Web Notification
  （仅在已授权时发送，不主动弹权限请求）。提醒数据放在 `lib/pomodoroStore.ts` 的 `alert` 字段——
  结束动作发生在非 React 的计时回调与启动恢复路径里。

### D3 配置与宠物偏好是**本机界面偏好**，不进 SQLite / MCP

番茄配置（时长 / 长休节奏 / 自动接续 / 通知 / 提示音）存 `todo-kanban.pomodoro.config.v1`，
宠物偏好（显隐 / 坐标 / 缩放 / 气泡）存 `todo-kanban.pet.v1`，与主题皮肤、侧栏宽度的既有策略一致。

理由：这些是「这台机器上这个人怎么看界面」，不是团队共享的项目数据；
放进 `workflow_state` 会让每次调时长都推进 revision，进而干扰备份恢复与 MCP 提案的乐观锁校验。
两者都做**归一化兜底**（`normalizeConfig` / `normalizePetPrefs`）：localStorage 被写坏也只会回退默认值。

### D4 番茄钟与待办解耦

`pomodoro_sessions` 不含 `todo_id`，番茄页也不提供「从任务启动专注」。
专注是个人节奏，待办是项目状态；强行绑定会把「计时」变成「改任务状态」的副作用，
并让删除任务 / 恢复备份与专注历史产生不必要的耦合。后续若要按任务归属，应作为独立特性重新评估。

### D5 备份恢复**不回滚**番茄历史

备份用 `Connection::backup` 复制整库，因此会话天然进快照；但 `restore_snapshot` 只回写
业务表 + workflow + 附件索引。番茄历史被视为**本机追加日志**，恢复旧备份后不会回退。
这与 D4 的「解耦」一致：不存在「任务状态回滚了但专注历史还在」的不一致，因为两者本就不相关。
该行为是显式决定，不是遗漏。

### D6 宠物是应用内浮层，渲染交给可迁移的 grokbot 模块包

不新增 Tauri 窗口：跨平台一致、不需要额外的 window 配置与 capabilities，
也不会在用户不想要的时候霸占桌面；代价是随主窗口一起最小化（接受）。

- 心情优先级（`lib/petState.ts::moodOf`，纯函数）：
  **完成事件（TTL 8s）> 有阻塞任务 > 番茄阶段 > 打盹（空闲 10 分钟且无进行中任务）> 待机**。
  事件排最前是因为「刚发生的事」比持续状态更值得反馈；阻塞排阶段前是因为它更需要被注意。
- 渲染交给自研模块包 `src/grokbot/`（见 D6.1）：SVG 果冻球 + 两根眼睛轮廓做**弹簧形变**，
  表情 = 轮廓点集、动作 = 可注册的关键帧、颜色 = CSS 变量；**不引入任何图片或品牌素材**。
- 拖拽用 Pointer Events + `setPointerCapture`（与侧栏拖宽同模式），松手吸附左右边缘；
  坐标、缩放、显隐经 `lib/petStore.ts` 单例共享（设置页与浮层同一份状态）。
- 无障碍：本体是带 `aria-label` 的按钮，气泡是 `role="status"` 区域，方向键微调位置，Esc 收起气泡；
  动画与过渡全部包在 `@media (prefers-reduced-motion: reduce)` 的关闭分支内。

### D6.1 宠物渲染做成可迁移的模块包（`src/grokbot/`）

需求是「方便未来迁移到其他项目」且要支持**颜色 / 动作 / 表情自定义**，因此把渲染与业务策略彻底分开：

- **包内**只认识「表情 / 状态 / 动作 / 主题」四类数据：不 import 应用代码、不依赖 React、不碰 zustand 与 Tauri；
  React 只出现在可选的 `react.tsx` 适配层，核心入口 `index.ts` 不导出它，保证核心零框架依赖。
- **应用侧**保留业务策略：`lib/petState.ts` 的 `moodOf`（心情判定）与 `GROKBOT_STATE_BY_MOOD`（心情 → 状态）、
  `lib/petStore.ts`（配色与显示偏好）、`components/pet/GrokBot.tsx`（浮层定位、拖拽吸附、键盘可达）。
  换项目时整目录拷走 `src/grokbot/`，业务侧重写几十行映射即可复用。
- **三类自定义能力**（都有 API，且设置页有对应 UI）：`theme`（9 个颜色令牌 + 6 套预设 + 取色器）、
  `registerAction`（关键帧 + 作用目标 body/eyes + 时长）、`registerExpression`（48 点轮廓，按同索引插值）、
  `registerState`（表情池 + 动作 + 换表情节奏 + 眨眼）。
- **样式隔离**：所有选择器与 `@keyframes` 都带实例作用域前缀（`gb-xxxxxx`），同页多实例或宿主同名类/动画都不冲突；
  包自注入 `<style>`，迁移时不需要额外引 CSS。
- **形变数学独立成纯函数**（`core/morph.ts`）：弹簧积分、眨眼曲线、拟 3D 球面投影都可单测，
  避免「看起来不对但也不报错」的静默退化。

### D7 MCP 只暴露只读统计

新增资源 `todo-kanban://pomodoro`，返回近 7 天分日汇总 + 连续天数 + 最近会话（复用
`svc::pomodoro::stats_from_conn` / `recent_from_conn`，与资源读取共用同一只读事务）。
不新增 MCP 写工具：番茄会话由桌面端产生，AI 没有理由替用户「记一笔专注」。

### D8 统计口径（本地日历）

分日桶与连续天数一律按**本地日历**（Rust 侧 `chrono::Local`，前端 `dayKeyOf`），与 `todayStr` 同口径。
用 UTC 会把晚间专注偏移到次日，与用户认知不符。

- 分日桶：只统计 `kind = focus`；休息段不参与专注时长与完成率，但仍出现在最近会话列表。
- 完成率 = 完成的专注轮数 / 专注总轮数（中断计入分母）。
- 连续天数：从今天（今天无记录则从昨天）往前数「至少完成 1 轮专注」的连续自然日，断档即止；
  Rust 侧用固定 365 天回溯窗口计算，与图表窗口（默认 30 天）解耦。
- 表容量有界：每次写入顺带 prune（保留 3 年，且最多 20000 条）。

## 影响

- **数据版本**：v13 → v14（老库仅建表推进版本，无存量回填；升级前硬备份由既有 upgrade 流程负责）。
- **新增命令**：`pomodoro_record` / `pomodoro_recent` / `pomodoro_stats` / `desktop_notify`（壳共 44 个 handler）。
- **新增 MCP 资源**：`todo-kanban://pomodoro`（5 → 6 resources；工具数不变）。
- **新增前端**：`lib/pomodoro.ts`（纯逻辑）、`lib/pomodoroStore.ts`（运行态）、`lib/petState.ts`（纯逻辑）、
  `lib/petStore.ts`（偏好）、`pages/PomodoroPage.tsx`、`components/pomodoro/*`、`components/pet/GrokBot.tsx`。
- **新增模块包**：`src/grokbot/`（自包含、零框架依赖，可整目录迁移；含 README 与三类自定义 API），
  数据来源为 GrokBot 参考实现：25 组表情点集、39 个状态、6 个动作、6 套配色（见包内 README「出处」）。
- **导航**：侧栏新增「番茄钟」（`/pomodoro`），顶栏新增紧凑指示器。
- **测试**：`scripts/test-pomodoro.mjs`、`scripts/test-pet-state.mjs`、`scripts/test-grokbot.mjs`
  （已并入 `npm run test:logic`；后者校验点集/状态/动作数据自洽、形变纯函数、样式作用域隔离，
  以及「心情 → GrokBot 状态」映射指向真实存在的状态——引擎对未知状态是静默忽略的）；
  Rust 内联单测覆盖 `svc/pomodoro.rs`（7 例）、`db/schema.rs`（v13→v14）、`upgrade` 全链路、MCP 资源数。

## 未采纳的方案

- **独立置顶桌面窗口的宠物**：更「桌面宠物」，但需要新的窗口配置、透明与置顶权限、
  跨平台差异处理；本轮按用户选择先做应用内浮层。
- **会话存 workflow_state JSON**：见 D1 的增长与聚合理由。
- **备份恢复回滚番茄历史**：见 D5。
- **宠物成长 / 等级 / 成就**：本轮明确不做；若要做，应基于 `pomodoro_sessions` 的聚合单独设计，
  而不是把成长状态塞进宠物偏好。
