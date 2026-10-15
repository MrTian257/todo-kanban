# ADR-021：变更历史跳过纯排序变更 & Git 报告仓库维度同口径

## 状态

Accepted（2026-10-14 已实施）

## 日期

2026-10-14

## 背景

两处「计数口径」与实际数据规模撞车：

1. **变更历史被拖拽排序撑爆**。`history::record` 对每个「前后快照不同」的实体写入整实体 `before_json` + `after_json`。
   而泳道内拖拽（`commitLaneOrder`）会给整条泳道的任务重新分配 `sortOrder` 并刷新 `updatedAt` —— 一次拖拽 = N 行整实体快照。
   真实库（69 条待办 / 3 个项目）实测：`change_history` 745 行占 **17.19 MB / 20.5 MB（84%）**，
   单行最大 `before` 与 `after` 各 2,102,357 字节（备注里内嵌 base64 图片的任务），且相隔 6 秒的两行大小完全一致。
   `workflow::trim()` 已有 32 MB 字节上限，但排序噪声会持续把有用的历史挤出去。
2. **Git 报告「提交数」与「新增行」自相矛盾**。设计文档 §6.6 规定「只有已归类开发人员的提交进入 KPI / 成员统计 / 提交明细」，
   但 `RepoReport.commit_count` 在 `item.developer` 判定**之前**就自增，前端 KPI 又用 `Σ repo.commitCount` 算「提交数」，
   而未归类提交人（如外包、机器人）不进人员表 → 「提交数」把没归类的人算进去了，「新增行」没有。
   `stats_partial`（界面「≈」）的分母 `counted_total` 同样含未归类提交，而详情补全 `fetch_details` 明确跳过未归类提交 → 有未归类提交人时会误标「≈」。
   该回归已被 `git_report::tests::build_result_groups_by_developer_and_dedupes` 抓到（期望 3、实际 4），但测试一直没人跑红着。

## 决策

1. **纯排序变更不写历史**：`history::record` 增加 `only_order_noise()` —— 前后都是对象且差异字段**只有** `sortOrder` / `updatedAt` 时跳过。
   新建 / 删除 / 任何实质字段变化照旧记录。
2. **仓库维度与人员维度同口径**：`commit_count`、仓库 `additions/deletions`、以及 `counted_total` / `stats_count`
   全部移入「已归类开发人员」分支内。`fetched_count` 仍是原始拉取条数（含未归类与合并提交），用于「拉了多少 / 统计了多少」对照。
3. 两处都补了单测（`svc::history::tests` 4 条；`git_report` 原有断言恢复通过）。

## 备选方案

### 历史改存字段级 diff（只存变化字段）
- 否决（本轮）：`history::restore` 用 `after_json` 反序列化**整实体**回填，改 diff 要同时改恢复链与历史弹窗的对比渲染，风险大于收益；
  列为后续项：若仍不够，优先做「`before_json` 只存变化字段」——恢复只依赖 `after_json`，改动面更小。

### 把内嵌 base64 图片在写历史时替换成占位符
- 否决：恢复会把占位符写回 `note`，破坏数据保真。带图备注应走 v8 的 `attachment://` 协议（已有能力，属迁移而非绕过）。

### 降低 `HISTORY_BYTES` 上限
- 否决：只是把问题推迟，且会静默丢掉有用历史；排序噪声去掉后 32 MB 足够长期。

### 前端改用 `Σ developer.commits` 算「提交数」
- 否决：那样「按仓库分布」环形图与 KPI 会分叉（图仍读 `repo.commitCount`）；在后端一次定口径，前端两个消费点自然一致。

## 后果

- 拖拽排序不再进入变更历史：用户无法从历史里「恢复排序」——排序是视图状态，此前能恢复也属意外副作用；泳道顺序仍由 `todos.sort_order` 持久化（ADR-010）。
- Git 报告的「提交数 / 按仓库分布」数值会**变小**（去掉未归类提交人），与成员表、明细表首次严格自洽；未归类提交仍完整显示在「未归类提交人」卡片里，并有去归类入口。
- `fetched_count > commit_count` 从此有了明确含义：差额 = 未归类提交 + 被排除的合并提交。
- 历史体积增长速率显著下降，但**已存在的历史行不会被本改动清理**；需要收缩旧库时，走「按字节裁剪」或手工 `VACUUM`（`trim` 在下次保存时会按新规则逐步淘汰）。
