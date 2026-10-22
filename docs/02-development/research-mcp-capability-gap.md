# MCP 能力差距清单（票 #4 调研盘点）

> **落点理由**：本仓没有 research 笔记惯例——`docs/02-development/` 现有 4 份（`mcp-access.md`、`directory-map.md`、`quick-start.md`、`tag-manual-edit-plan.md`），开发侧笔记都归这里。与同目录的 `mcp-access.md`（面向**使用者/AI** 的 how-to）分工不同：本文面向**做取舍的人**，只盘点不决策。
> **同目录分工**：另一份 `research-mcp-spec-capabilities.md`（同一批调研）回答的是「MCP 规范怎么说、本端缺哪些协议能力」；本文回答的是「app 的 61 个能力里哪些该有 MCP 出口而没有」，两份互补、口径不重叠。
> **基准**：`main` @ `4ba0991`。工作区另有 3 处未提交改动（`README.md`、`scripts/setup-github-cli.sh`、`docs/agents/issue-tracker.md`），均与 MCP 无关。
> **可复查性**：每条论断后面都跟 `文件:行号`；§3 的单测结论来自真实执行 `cargo test -p todo-kanban-core mcp::`（结果见该节）。二手总结（`docs/` 与 `AGENTS.md`/`CLAUDE.md` 里的数字）一律不作为依据——`AGENTS.md` NOTES 与 `CLAUDE.md` 开头自己就写了「文档有漂移，以源码为准」。

## 一句话结论

**app 侧 61 个 handler，MCP 侧只有 11 个工具 + 7 个资源，覆盖 61 个里的 14 个（10 个工具直连 + 4 个只有只读资源的半边）；剩下 47 个里 18 个是刻意不给（管理员面 + 人工批准边界 + 已写理由的番茄写入）、13 个结构上只有桌面进程能做，真正「该有出口但没有」的是 16 个**，其中体量最大的一族是「工作流配置写入（提醒 / 任务关系 / 模板 / 报告归类）」「变更历史与备份」「附件」「纯查询的 git 报告」；与此同时，已有的 `db_load_state` / `db_save_state` 是**全量快照粒度**——单条待办空值地板 320 B、一条内嵌贴图备注可达 MB 级，并发校验是**整库逐字段比较**（一处变动即 `STATE_CONFLICT`），并且 `payload` 缺失的行会被差异写删掉，这既是最大的一次性成本，也是最危险的误用面；`docs/` 与三份 `AGENTS.md`/`CLAUDE.md` 及登记 skill 里共 **47 处**计数/事实与代码不符（分类见 §3），其中 `protocol.rs` 的一条单测断言已经**实际跑红**；表现层（宠物）的偏好与心情输入**完全不在 SQLite 与 MCP 快照里**，外部 AI 只能通过全量写库间接影响其中 2 个输入，缺的是「把呈现意图送进正在运行的 WebView」这一段通道（详见 §4）。

### 先给核实结果（对得起点里的四个数）

| 项目 | 起点说法 | 代码实际 | 结论 |
| --- | --- | --- | --- |
| app handler 总数 | 61（37+6+11+4+3） | 61：`commands.rs` 37（`src-tauri/src/commands.rs:33-352`）、`native_workflow.rs` 6（`:45-117`）、`desktop.rs` 3（`:31-50`）、`lan_server.rs` 4（`:531-563`）、`mcp_http.rs` 11（`:728-840`）；注册表 `src-tauri/src/lib.rs:164-226` 逐条 61 项 | ✅ 一致（但 `lib.rs:1` 注释自己写的是 59） |
| MCP tools | 11 | 11（`src-tauri/core/src/mcp/bridge.rs:571-583` 数组 11 项；单测 `bridge.rs:750-775` 断言 11，实测通过） | ✅ 一致 |
| MCP resources | 7 | 7（`bridge.rs:20-37`，声明类型就是 `[(&str, &str); 7]`） | ✅ 一致（但全仓 20 处文档写 6/5/4，见 §3） |
| WRITE_TOOLS | 4 | 4（`bridge.rs:46-51`；`db_preview_state` 刻意排除，理由 `bridge.rs:42-45`） | ✅ 一致（`CLAUDE.md:114-116` 与 ADR-022:31-32 仍写 5） |

---

## 1 逐项对照表

**读法**：`出口` 列四类含义——
`工具 `+`名` = 有同名 MCP 工具；`资源(半边)` = 只有只读资源覆盖它的一部分；`无·刻意` = 明确决定不暴露（附出处）；`无·GUI` = 结构上只有桌面进程能做；`无·缺口` = 该有出口但没有。
**判据** 三列用字母压缩：`G` = 是否只有 GUI 才成立；`N` = 是否有外部 AI 的真实需求（有直接证据才标 ✅）；`B` = 是否触碰只读取严 / 人工批准 / 审计边界。

### 1.1 `src-tauri/src/commands.rs`（37 个）

| # | handler（文件:行） | 出口 | 缺口的实际后果（可复查） | G / N / B |
| --- | --- | --- | --- | --- |
| 1 | `git_info` (`commands.rs:33`) | 工具 `git_info`（`bridge.rs:122`） | 语义分叉：app 走 SQLite 持久缓存（`commands.rs:34` → `svc/repo_cache.rs:31,34`，TTL 30 s），MCP 走 `git_cmds::git_info_direct` 直读（`bridge.rs:123`）。同一个仓库两边可能给出不同分支列表 | G 否 / N ✅ / B 否 |
| 2 | `git_info_refresh` (`:39`) | 无·刻意 | `bridge.rs:6` 写明「app 专属不暴露」；AI 无法让 app 侧缓存失效（连带后果见 #4） | G 否 / N 低 / B 否 |
| 3 | `git_info_remote` (`:45`) | 无·刻意 | 同上 `bridge.rs:6`；参数含仓库 Token（`:48`），AI 侧要远端分支只能自己发 curl，无出口 | G 否 / N 中 / B 是（凭据） |
| 4 | `git_create_branch` (`:55`) | 工具（`bridge.rs:126`） | app 侧建分支后 `repo_cache::invalidate`（`commands.rs:59-61`），MCP 路径**不失效缓存**（`core/src/mcp/` 全目录对 `repo_cache`/`invalidate` 零引用）→ AI 建的分支在 GUI 分支下拉里最长 30 s 不可见 | G 否 / N ✅ / B 否 |
| 5 | `git_create_branch_from` (`:69`) | 工具（`bridge.rs:130`） | 同上（`commands.rs:76-79` 有失效，MCP 无） | G 否 / N ✅ / B 否 |
| 6 | `git_checkout_branch` (`:86`) | 工具（`bridge.rs:134`） | 同上（`commands.rs:89` 失效）；此工具 `destructiveHint: true`（`bridge.rs:575`），是唯一改工作区的出口 | G 否 / N ✅ / B 是 |
| 7 | `git_sync_commits` (`:97`) | 工具（`bridge.rs:138`） | 无缺口；与 app 同语义（`git_cmds::git_sync_commits`） | G 否 / N ✅ / B 否 |
| 8 | `git_commits_between` (`:113`) | 工具（`bridge.rs:152`） | 无缺口 | G 否 / N ✅ / B 否 |
| 9 | `git_commit_info` (`:130`) | 工具（`bridge.rs:157`） | 无缺口 | G 否 / N ✅ / B 否 |
| 10 | `db_load_state` (`:140`) | 工具（`bridge.rs:161`）+ 资源 `://state` | 有出口但粒度不匹配 → §2.1 | G 否 / N ✅ / B 否 |
| 11 | `db_save_state` (`:146`) | 工具（`bridge.rs:175`） | 同上 → §2.2；注意 app 侧写成功后 `after_write` 唤醒局域网推送（`commands.rs:24-29`），MCP 写路径不调它（`bridge.rs:84-105`）→ §4 | G 否 / N ✅ / B 是 |
| 12 | `mcp_get_config` (`:154`) | 无·刻意 | 权限自举：AI 不能读/改自己的开关（`db_cmds.rs:605,614`） | G 是（管理员面） / N 否 / B 是 |
| 13 | `mcp_set_config` (`:160`) | 无·刻意 | 同上（`db_cmds.rs:624`；只读只在这里决定，见 `models.rs:374-376`） | G 是 / N 否 / B 是 |
| 14 | `db_check_version` (`:167`) | 无·缺口 | MCP 侧只有硬拒：`db::open_existing` 见 `user_version` 不符就报「数据库版本为 vN，MCP 需要 vM」（`core/src/db/mod.rs:42-48`）；AI 拿不到 `VersionReport` 结构（状态/原因/依赖版本），只能读一句中文错误 | G 否 / N 中 / B 否 |
| 15 | `attachment_import` (`:181`) | 无·缺口 | 参数是 `bytes_base64`（`:184`）——不是 GUI 独占；AI 无法给备注配图或落文件，也无法经 MCP 建 `attachments` 关系（写链只对 note 里已有的 `attachment://` 引用补链） | G 否 / N 中 / B 否 |
| 16 | `attachment_migrate_inline` (`:192`) | 无·缺口 | 内嵌 data URL → 附件文件的治理动作只有 GUI 能触发（`core/src/svc/attachments.rs:26` 单张 5 MB 上限）；AI 既不能触发也不能得知结果 `MigrateSummary` | G 否 / N 低 / B 否 |
| 17 | `attachment_gc_orphans` (`:198`) | 无·缺口 | 同上（孤儿清理）；MCP 删任务时只把文件移 `attachments/trash/`（`bridge.rs:98-103`），永远不清空 trash | G 否 / N 低 / B 否 |
| 18 | `db_poll_state` (`:204`) | 无·缺口 | 增量读通道（`PRAGMA data_version`，`core/src/svc/state_poll.rs:56-65`）只给 app；AI 侧只能反复全量 `db_load_state` → §2.4 | G 否 / N ✅ / B 否 |
| 19 | `git_sync_commits_batch` (`:212`) | 工具（`bridge.rs:144`） | 无缺口（1~1000 项校验 `bridge.rs:517-553`） | G 否 / N ✅ / B 否 |
| 20 | `tool_paths` (`:220`) | 无·缺口 | `git_cmds::tool_paths()`（`:221`）是「git/curl 在不在 PATH」的诊断；MCP 无出口 → AI 分不清「仓库坏了」和「环境没 git」，只能猜 | G 否 / N 中 / B 否 |
| 21 | `workflow_load` (`:225`) | 资源(半边) `://fields` | 只回 `fieldDefs` + `automations` 两个字段（`bridge.rs:266-272`）；`Workflow` 里的 `links`（父子/依赖）、`templates`、`reminders`、`remindersEnabled`、`backupEnabled/hours/keep`、`gitReportDevs`、`gitReportKinds`（`core/src/svc/workflow.rs:52-80`）**对 MCP 完全不可见，连读都读不到** | G 否 / N ✅ / B 否 |
| 22 | `workflow_save` (`:229`) | 无·缺口 | AI 不能设提醒、不能声明「A 依赖 B」、不能建模板、不能配报告归类；写侧还有 `expected: i64` 乐观锁（`:231`）与 `DbState` 快照契约不同构 | G 否 / N ✅ / B 是（工作流配置不在业务快照里，审计 `audit_target` 对它无定义） |
| 23 | `history_list` (`:239`) | 无·缺口 | 变更历史（每行存 `before_json`/`after_json`，固定每页 100 条，`core/src/svc/history.rs:132`）无出口 → AI 无法自查「刚那次保存改了什么」；审计表又刻意只存元数据（`core/src/mcp/mod.rs:171-173`）→ 两头都看不见字段级真相 | G 否 / N 中 / B 是（单行可 4 MB，`history.rs:80`，直暴露会重演 ADR-021 膨胀） |
| 24 | `history_stats` (`:251`) | 无·缺口 | 库体积/历史体积统计（`svc/history.rs` 的 `StorageStats`）无出口 → AI 无法判断「该不该建议用户收缩历史」 | G 否 / N 低 / B 否 |
| 25 | `history_shrink` (`:262`) | 无·缺口 | 破坏性 + VACUUM，前端二次确认（`:259-260`）且入参钳制 50~20000（`:264`）→ 属于「能不能给 AI」的边界题 | G 否 / N 低 / B 是 |
| 26 | `history_restore` (`:274`) | 无·缺口 | 按历史 id 回滚一条记录（也要 `expected` 全量快照，`:276`）；MCP 里等价动作只能靠 `db_save_state` 手搓 | G 否 / N 中 / B 是 |
| 27 | `backup_list` (`:284`) | 无·缺口 | AI 写库前无法确认「有没有可回滚点」 | G 否 / N 中 / B 否 |
| 28 | `backup_create` (`:288`) | 无·缺口 | 同上：不可自保快照，是 §2 全量写风险的实际放大器 | G 否 / N ✅ / B 否 |
| 29 | `backup_restore` (`:293`) | 无·缺口 | 双条件确认（`expected` + `workflow_revision`，`:295-296`，任一变化即拒 `svc/backups.rs:432`）→ 典型人工动作 | G 否 / N 低 / B 是 |
| 30 | `proposal_list` (`:307`) | 资源(半边) `://proposals` | 只回 `id/状态/时间/LENGTH(payload)`，刻意不回 diff 正文（`bridge.rs:279-284`、`svc/proposals.rs:93-129`）；`history_list` 的 `before/after` 也读不到 → AI 提完案看不见「到底改成什么」 | G 否 / N ✅ / B 是（正文体积即边界） |
| 31 | `proposal_apply` (`:311`) | 无·刻意 | 「必须人工在工作流页面点批准」是 `db_preview_state` 被移出写工具的唯一理由（`bridge.rs:42-45`）；给了 apply 就把该理由抹平 | G 否 / N 中 / B **强** |
| 32 | `proposal_reject` (`:317`) | 无·刻意 | 同上 | G 否 / N 低 / B **强** |
| 33 | `automation_backfill` (`:322`) | 无·缺口 | 新自动化规则对**存量**任务不生效：MCP 写事务会自动跑脚本（`db/mod.rs:196` `automations: true`），但没有补写入口 → AI 只能读 `://fields` 看到规则，改不动历史数据 | G 否 / N ✅ / B 是（写 todos，绕过 `audit_target` 的 payload 语义） |
| 34 | `git_report_fetch` (`:329`) | 无·缺口 | 纯查询不写库（`:326-327` 注释与 `svc/git_report.rs` 一致，限额 `MAX_REPOS=8`/`MAX_REPORT_COMMITS=500` 见 `git_report.rs:28-32`）→ 没有权限或审计成本，AI 要日报只能自己重算聚合口径（类型归类、别名匹配、合并提交判定） | G 否 / N ✅ / B 否 |
| 35 | `pomodoro_record` (`:338`) | 无·刻意 | ADR-017:114 写了理由：「番茄会话由桌面端产生，AI 没有理由替用户记一笔专注」；只有 `pomodoroStore.ts:357` 一处调用 | G 是 / N 否 / B 否 |
| 36 | `pomodoro_recent` (`:346`) | 资源(半边) `://pomodoro` | 资源里写死 `recent_from_conn(&tx, 20)`（`bridge.rs:276`）→ AI 只能拿最近 20 条，无法指定 limit | G 否 / N 低 / B 否 |
| 37 | `pomodoro_stats` (`:352`) | 资源(半边) `://pomodoro` | 资源里写死 `stats_from_conn(&tx, 7)`（`bridge.rs:275`）→ 窗口固定 7 天，AI 要周报/月报只能拿 7 天自己外推，且 `days` 参数无出口 | G 否 / N 中 / B 否 |

### 1.2 `src-tauri/src/native_workflow.rs`（6 个）/ `desktop.rs`（3 个）/ `lan_server.rs`（4 个）

| handler（文件:行） | 出口 | 缺口的实际后果 | G / N / B |
| --- | --- | --- | --- |
| `desktop_ready` (`native_workflow.rs:45`) | 无·GUI | 前端 ↔ 原生壳的启动握手（`:48` 记录状态），外部无意义 | G 是 / N 否 / B 否 |
| `desktop_quick_done` (`:53`) | 无·GUI | 托盘/快捷键的「完成当前任务」动作，直接改 WebView 状态 | G 是 / N 低 / B 否 |
| `desktop_enable_notifications` (`:75`) | 无·GUI | 系统通知权限申请只能由桌面进程发起 | G 是 / N 否 / B 否 |
| `desktop_notify` (`:89`) | 无·缺口（表现层） | **这是仓里唯一「往正在运行的 app 推一句人话」的现成通道**（`pomodoroStore.ts:323,605` 在用），但没有 MCP 出口 → 外部 AI 无法让 app 出声/出通知；`desktop_status` (`:99`) 同理只回给 GUI | G 是 / N ✅（表现层，见 §4） / B 否 |
| `desktop_status` (`:99`) | 无·GUI | 托盘/菜单栏错误文本（`BACKGROUND_ERROR`），只给设置页看 | G 是 / N 否 / B 否 |
| `desktop_update_tasks` (`:117`) | 无·GUI | 托盘菜单的任务清单由 WebView 单向推送（入参 `Vec<TrayTask>`），不是数据源 | G 是 / N 否 / B 否 |
| `finish_quit` / `cancel_quit` / `arm_quit_protection` (`desktop.rs:31,41,50`) | 无·GUI | 退出保护（保存前不许关窗）依赖 WebView 生命周期与 `emit` 事件（`desktop.rs:24,91`） | G 是 / N 否 / B 否 |
| `lan_get_settings` / `lan_set_settings` / `lan_status` / `lan_stop` (`lan_server.rs:531,538,557,563`) | 无·GUI | 起停 axum 服务需要 `AppHandle`（`lan_server.rs:335`），结构上只有桌面进程能做；**副作用见 §4**：共享开着时它顺带成为 MCP 写入的即时唤醒源 | G 是 / N 否 / B 是（改绑定面 0.0.0.0） |

### 1.3 `src-tauri/src/mcp_http.rs`（11 个，全部「MCP 不能管自己」）

`mcp_http_get_settings`(`:728`) / `mcp_http_set_settings`(`:734`) / `mcp_http_status`(`:747`) / `mcp_http_stop`(`:753`) / `mcp_tokens_list`(`:760`) / `mcp_token_issue`(`:777`) / `mcp_tokens_save`(`:783`) / `mcp_tokens_remove`(`:789`) / `mcp_audit_list`(`:814`) / `mcp_audit_actors`(`:833`) / `mcp_audit_clear`(`:840`)。

- 出口：全部无（`G` 是——需要 `SERVER` 进程内状态与 `AppHandle` 之外的 tokio shutdown 通道，`mcp_http.rs:67`、`:63`；`B` 强——Token 与只读是权限面，审计是追责面，AI 自助即自举权限）。
- 可量化的后果：**AI 读不到自己那把 Key 的痕迹**。Token 上限 50 把（`db_cmds.rs:640-641` `MCP_TOKEN_LIMIT`）、审计保留 20 000 行且每 200 次写裁剪（`core/src/mcp/audit.rs:23,25`）、错误文本截 400 字（`audit.rs:21`），这些治理参数只有 GUI 能看；`notifications/*` 不记（`audit.rs`/`main.rs:142-148`）→ AI 连「我这次握手有没有被记」都无法确认。
- Token 只能靠 `mcp_token_issue`（`db_cmds.rs:743`）在 GUI 里生成；stdio 侧配错 Token 是「启动即退出」（`mcp-server/src/main.rs:49-51`），无 MCP 出口可诊断，只能读 stderr（`main.rs:28`）。

### 1.4 MCP 侧独有（无对应 Tauri 命令）

| 项 | 出处 | 事实 |
| --- | --- | --- |
| 工具 `db_preview_state` | `bridge.rs:165-174` → `svc/proposals.rs:26` | GUI 侧只有 `proposal_list/apply/reject` 三个消费者，**没有「新建提案」命令**：提案是 AI 专属入口 |
| 资源 `://proposals` | `bridge.rs:33-36,281-284` | HEAD 提交 `4ba0991` 才加的（`git log -S 'todo-kanban://proposals'` 只命中该提交），也是 §3 里 20 处计数漂移的共同源头 |
| 资源 `://fields` | `bridge.rs:26-28,266-272` | 是 `workflow_load` 返回值的两字段投影，不是新能力 |

### 1.5 覆盖账（一眼看出「app 专属」与「该有出口但没有」）

```
61 个 app handler
├─ 10  有同名 MCP 工具            #1 #4 #5 #6 #7 #8 #9 #10 #11 #19
├─  4  只有只读资源的半边         #21 workflow_load、#30 proposal_list、#36 #37 pomodoro_recent/stats
├─ 16  无·缺口（该有但没有）      #14 #15 #16 #17 #18 #20 #22 #23 #24 #25 #26 #27 #28 #29 #33 #34
├─ 18  无·刻意（管理员面 / 人工批准 / 已写理由）  #2 #3 #12 #13 #31 #32 #35 + mcp_http 11
└─ 13  无·GUI（结构上只有桌面进程能做）           native_workflow 6 + desktop 3 + lan_server 4
```
16 个缺口里，成族的只有四族：**工作流写入族**（#22 #33，另有 #21 的只读半边）、**历史与备份族**（#23-#29）、**附件族**（#15 #16 #17）、**读效率/诊断族**（#14 #18 #20 #34）。
另外 `61` 个全部有 GUI 调用方（对 `src/**.ts(x)` 逐名检索，43 个直接 `invoke("…")`、其余经封装调用，零命中仅 `desktop::finish_quit` 这一个重复项）→ 表里没有任何「注册了但没人用」的假缺口。

---

## 2 已有工具的粒度缺口（可量化）

### 2.1 `db_load_state`：一次回全量，体积从哪来

快照形状 = `DbState { projects, todos, resources }`（`core/src/models.rs:316-323`），三张表的**全部列**逐行序列化（`core/src/db/row.rs:130` `PROJECT_SELECT`、`:271` `load_state_from_conn`）；`bridge.rs:73-82` 直接 `db::load_state`，**没有任何脱敏或投影**（对比：局域网路径有 `svc/lan.rs:27-45` 的 `redact_project/redact_todo`）。

体积构成（按 `models.rs` 的 serde camelCase 字段名逐条合成 JSON 实测字符数，可复算）：

| 记录 | 字段数 | 空值地板 | 带 1 条提交的典型待办 |
| --- | --- | --- | --- |
| `todos` | 24（`models.rs:241-290`） | **320 B/条** | **610 B/条** |
| `projects` | 17（`models.rs:131-163`） | **283 B/条** | — |
| `resources` | 9（`models.rs:295-311`） | **107 B/条** | — |

→ 500 条待办的裸快照 ≈ 0.15 MB（全空值）~ 0.29 MB（典型值）；这一部分是**每次读都必须进 AI 上下文**的固定成本，与本次要看的那一条无关。

三个乘数让它变大：

1. **备注里的内嵌图片**：`todos.note` 是整段文本；旧数据里的 data URL 图片「继续兼容，不强制迁移」（`svc/attachments.rs:26` 定 5 MB 单张上限，base64 后约 6.7 MB 文本；治理命令 `attachment_migrate_inline` 无 MCP 出口 = §1 #16）。仓内自己的实测口径写在 `core/src/svc/history.rs:77-80`：含内嵌 base64 图片的备注「**实测单行可达 4 MB**」。→ 1 条这样的待办就把 `db_load_state` 从 0.3 MB 推到 MB 级。
2. **响应被序列化两遍**：`bridge.rs:363` 把结果 `to_string()` 塞进 `content[0].text`，`bridge.rs:364-366` 又对 JSON 对象结果原样挂一份 `structuredContent` → **同一个对象在一次 `tools/call` 响应里出现两次**。对 `db_load_state` 意味着全量快照文本 ×2。
3. **审计再数一遍**：`core/src/mcp/mod.rs:174` 用 `value.to_string().len()` 求 `bytes` → 同一份响应**第三次**整体序列化（只是不落正文，但要完整走一遍序列化）。
   合计：一次 `db_load_state` 大约产出 **4 倍快照体积**的文本工作量（text 1 + envelope 序列化 2 + 审计 2 的口径下，写出与统计合计 4-5 次），而帧上限是 stdio 64 MiB（`mcp-server/src/main.rs:15`）/ HTTP 64 MiB body（`src-tauri/src/mcp_http.rs:40-41`）。

### 2.2 `db_save_state`：必须带修改前的全量 `expected`

- 缺失即 `-32602`：`bridge.rs:179-182`（「保存必须携带 db_load_state 返回的 expected 原始快照」）。
- 校验面 = **整库逐字段**：`core/src/db/mod.rs:149-165` `same_state` 把 `projects/todos/resources` 三个数组各自按 id 排序后**逐记录 PartialEq**，`mod.rs:256-262` 不等就 `STATE_CONFLICT: 数据已被其他窗口或 MCP 修改`。
  → 可量化后果：**并发冲突面是整个数据库，不是本次改的那几行**。参与方 = 1 个 GUI 写链（`src/lib/store.ts:428-435` 订阅即 `flushPersistence`）+ 最多 50 把 Token 的 AI（`svc/db_cmds.rs:641`）；任一 AI 或人在 AI-A 读快照之后动了**任意一行**（哪怕只是拖一次排序，`store.ts:343-350` 会给整条泳道重排 `sortOrder`），AI-A 的这次保存就整批作废，必须重读全量（再付 §2.1 的 4 倍体积）再来一遍。
  `payload`/`expected` 的字段完整性还被 `bridge.rs:490-516` 强制（已有记录缺任一字段即报错），所以 AI 也不能靠「只发我改的那条」来缩体积。
- **静默删除面**：差异写「快照之外的行会被删」（`db/mod.rs:178-180` 注释 + 本仓 skill 的告警 `SKILL.md:87`「不要只提交新增行，否则差异写会把快照之外的行删除」）。→ 一次被上下文截断的 `db_load_state` 输出，就足以让 AI 在下一次 `db_save_state` 里删掉整段项目/待办；现有兜底只有 `audit_target` 记「碰到哪些 id」且只取前 4 个（`bridge.rs:322-343`），删了多少行不在审计里（`mod.rs:135-181` 只存元数据）。
- 返回 `{ok, state}` 权威快照（`bridge.rs:186`）→ 好消息是它可直接当下次 `expected`；坏消息是这又一份全量，同样是双写（text + structuredContent）。
- 只读门禁的粒度：`WRITE_TOOLS` 4 个（`bridge.rs:46-51`），生效只读 = 全局 `mcp_readonly` || 该 Token `readonly`（`core/src/mcp/tokens.rs:58`，取严；单测 `tokens.rs:111-131`），且每请求重读 app_meta（`mcp/mod.rs:77-81`、`protocol.rs:69-75`）→ **只读是「工具级」而不是「字段级/表级」**：要么全给写，要么一点不给，没有「只能改某几个字段」的中间态。

### 2.3 `db_preview_state`：同样吃全量快照

`bridge.rs:165-174` 要求 `payload` + `expected` 两份，落库前还要 `same_state` 比对（`svc/proposals.rs:39-42` → 过期报 `STATE_CONFLICT: 提案快照已过期`）；两份快照存进 `change_proposals`，硬上限 **8 MB/条**、**待批准 200 条**（`proposals.rs:20-24,43-60`）。→ 提案通道也没能绕开全量粒度，只是把膨胀挡在 8 MB 外；AI 想「改 3 条待办」必须搬运整库两遍。

### 2.4 读侧粒度：没有增量、没有投影

- `state_poll` 的 `revision`（`svc/state_poll.rs:56-65`：`PRAGMA data_version` 未变则 `state: None`）**只有 app 命令 `db_poll_state` 用**（`commands.rs:204-209`），MCP 无对应工具 → AI 侧的「等一下有没有变」只能反复全量读，或被 64 MiB 帧上限硬拒（`main.rs:73-79` 直接关连接）。
- 7 个资源全是**整表 JSON 文本**（`bridge.rs:285-288`），无过滤、无分页、无字段投影；`://pomodoro` 的两个窗口写死 7 天 / 20 条（`bridge.rs:275-276`），`://proposals` 写死 200/50 条摘要（`proposals.rs:101-120`）。
- `git_info` 的粒度是「语义分叉」而非体积：MCP 直读（`bridge.rs:123`）不看 app 的 30 s TTL 缓存（`svc/repo_cache.rs:11,34`），而 MCP 的建/切分支又**不失效**那份缓存（`core/src/mcp/` 对 `invalidate` 零引用；app 路径 `commands.rs:59,77,89` 都有）→ 同一仓库 GUI 与 AI 看到的分支列表可以相差 30 s 且方向不可控。

---

## 3 文档与代码的计数/事实漂移（47 处）

按「会不会被下一个 AI 当成事实」分四类。「实际值」全部来自 §6 的代码出处；同一处重复计数只算一次。

### 3.1 代码内注释与单测（4 处）——影响最大，是「改代码时第一眼看到的」

| 编号 | 文件:行号 | 现写的值 | 代码实际值 |
| --- | --- | --- | --- |
| A1 | `src-tauri/src/lib.rs:1` | 「注册 59 个 handler（commands 37 + native_workflow 6 + desktop 3 + lan 4 + **mcp_http 9**）」 | **61**；mcp_http 是 **11**（注册项 `lib.rs:215-225`，实现在 `src-tauri/src/mcp_http.rs:728-840`）；同行的 commands 37 / nw 6 / desktop 3 / lan 4 都对 |
| A2 | `src-tauri/src/commands.rs:1` | 「**35** 个 Tauri 命令薄壳」 | **37** 个 tauri::command（标记行 `commands.rs:32-351`）；文件内编号注释只写到 17（`:200-201`），18-37 无编号 |
| A3 | `src-tauri/core/src/mcp/bridge.rs:1` | 「11 tools + **6** resources」 | 同文件 `bridge.rs:20` 的声明就是 RESOURCES 7 元组，第 7 项是 `todo-kanban://proposals`（`bridge.rs:33-36`） |
| A4 | `src-tauri/core/src/mcp/protocol.rs:209-214` | 单测名 `resources_list_has_6` 断言长度 = **6** | 实际 **7**。**这条单测现在是红的**：`cargo test -p todo-kanban-core mcp::` 报 protocol.rs:214 断言失败（left 7，right 6），结果 27 passed / 1 failed。同文件 `bridge.rs:741-747` 的 `resources_list_has_seven_including_proposals` 断言 7 并通过 → **两份单测对同一件事互相矛盾**；`bridge.rs:750-775` 的 `schemas_count_ok`（断言 11 tools）通过 |

A4 的成因可复查：`git log -S 'todo-kanban://proposals'` 只命中 HEAD 提交 `4ba0991`；该提交把 RESOURCES 从 6 改 7（同时把 WRITE_TOOLS 从 5 改 4），但 `git show --stat 4ba0991` 的 15 个文件里**没有 `docs/`，也没有 `protocol.rs`** → 断言、注释、使用者文档三处同时落后。

### 3.2 现行导航层（14 处）——AGENTS / CLAUDE / mcp-access / 登记 skill，AI 动手前必读

| 编号 | 文件:行号 | 现写的值 | 代码实际值 |
| --- | --- | --- | --- |
| B1 | `AGENTS.md:57` | 「commands.rs **35** 命令 + … = **59** handler」 | commands.rs **37**、总 **61**（见 A1/A2） |
| B2 | `AGENTS.md:62` | 「11 tools + **6** resources 的唯一调度」 | **7** resources |
| B3 | `CLAUDE.md:49` | 「Tauri invoke（**59** 个 handler）」 | **61** |
| B4 | `CLAUDE.md:112-113` | 「11 tools + **6** resources」并只列举 state、projects、todos、resources、fields、pomodoro 六个 uri | **7**，漏 `://proposals` |
| B5 | `CLAUDE.md:114-116` | 「写工具共 **5** 个（含 db_preview_state）…只读模式下这 **5** 个既从 tools/list 隐藏、调用也被拒」 | WRITE_TOOLS **4** 个（`bridge.rs:46-51`）；db_preview_state **刻意不在内**（`bridge.rs:42-45`），只读模式仍可用（`protocol.rs:146-156`；单测 `bridge.rs:615-633`） |
| B6 | `CLAUDE.md:36` | 「cargo test -p mcp-server # MCP 单测（**握手 / 工具清单 / 映射 / 只读门禁**）」 | mcp-server 里只剩 **4 个命令行解析测试**（`src-tauri/mcp-server/src/config.rs:88-125`）；那四组测试已随 ADR-023 搬进 core（`core/src/mcp/protocol.rs:189-236`、`bridge.rs:683-776`）。对照 `AGENTS.md:79` 写的是「stdio 传输单测」——这条是对的 |
| B7 | `src-tauri/AGENTS.md:9` | 「生命周期 + invoke 注册（**44** 命令）」 | **61** |
| B8 | `src-tauri/AGENTS.md:12` | 「CURRENT_DATA_VERSION=**13**」 | **15**（`src-tauri/config/src/lib.rs:8`；MIGRATION_STEPS 14 步到 v15，`:17-56`） |
| B9 | `src-tauri/AGENTS.md:13` | 「mcp-server：独立 stdio JSON-RPC 进程（**11 tools + 6 resources**）」 | 7 resources；且**工具表不在 mcp-server**——`mcp-server/src/main.rs:1-2` 自述「工具表与业务逻辑都不在这里」，表在 `core/src/mcp/bridge.rs`，由 `core/src/mcp/mod.rs:23` re-export |
| B10 | `src-tauri/AGENTS.md:22` | 「MCP 工具/资源 → `mcp-server/src/bridge.rs`（工具映射 + RESOURCES）+ protocol.rs」 | 这两个文件在 `mcp-server/src/` 下**不存在**（该目录只有 `main.rs`、`config.rs`）；实际 `core/src/mcp/bridge.rs` + `core/src/mcp/protocol.rs` |
| B11 | `src-tauri/core/src/AGENTS.md:3` 与 `:5-16` | barrel 只写 db / error / models / svc / tool；STRUCTURE 里没有 mcp 子目录 | core 还有 `mcp/` 五个文件（`core/src/mcp/mod.rs:12-15`），且 `core/src/lib.rs:9` 已 pub mod mcp → 导航层漏掉整个 MCP 调度面 |
| B12 | `docs/02-development/mcp-access.md:164-167` | §7 标题「资源（**6** 个，全部只读）」+ 只列 6 个 uri | **7** 个，缺 `://proposals`。同节工具表（`:141-153`）11 行与 `bridge.rs:572-582` 一致，是对的 |
| B13 | `docs/02-development/mcp-access.md:196-200` | §9「已知不支持」只列**协议层**缺项（服务端 SSE 与重放、OAuth 2.1、prompts、resources/subscribe、completion/complete、logging/setLevel、按项目授权范围、TLS） | 未列任何 **app 侧能力缺口**：47 个无出口 handler / 16 个缺口（§1.5）在使用者视角完全不可见，也没说明「11 个工具只是 61 个 app 能力的子集」。§9 那份协议清单本身与代码一致（`protocol.rs:158-176` 未声明方法一律 -32601；`protocol.rs:12` 三个协议版本；`mcp_http.rs:654` GET → 405） |
| B14 | `.agents/skills/todo-kanban-register/SKILL.md:34` | 「开启后 **5** 个写工具（建/切分支、db_save_state、db_preview_state）从 tools/list 隐藏且调用被拒」 | 4 个（同 B5）。这条是会被 AI 直接转述给用户的话术，B 类里最容易被执行的一处 |

### 3.3 背景与汇总文档（23 处）——AGENTS.md NOTES 已声明它们漂移，但里面恰好有 MCP 计数

| 编号 | 文件:行号 | 现写 | 实际 |
| --- | --- | --- | --- |
| C1 | `docs/软件设计文档.md:3` | 校数「59 个 Tauri handler / MCP 11 tools + **6** resources / 数据版本 v15」 | 61 / **7**（v15 这条对） |
| C2 | `docs/软件设计文档.md:102` | 11 tools + **6** resources | 7 |
| C3 | `docs/软件设计文档.md:110` | Tauri invoke（**48** 命令） | 61 |
| C4 | `docs/软件设计文档.md:117` | bridge(**11 tools + 6** resources ↔ core::svc) | 11 + **7**；且 bridge 不在 mcp-server（B9） |
| C5 | `docs/软件设计文档.md:246` | 「…**与同名 Tauri 命令同构**；refresh/remote 为 app 专属不暴露」 | 11 个工具里 db_preview_state **没有同名 Tauri 命令**（GUI 只有 proposal_list/apply/reject，`commands.rs:307-317`）→ 「同构」只对 10/11 成立 |
| C6 | `docs/软件设计文档.md:247` | 「**6 resources**：state / projects / todos / resources / fields / pomodoro」 | 7，缺 proposals |
| C7 | `docs/软件设计文档.md:434` | 壳注册 **59** 个 handler（commands **35** + mcp_http 11 + …） | 61 / commands **37**（mcp_http 11 这次是对的） |
| C8 | `docs/软件设计文档.md:436` | 「mcp-server：stdio 手写 JSON-RPC，11 tools + **6** resources；**31 项 stdio 端到端检查通过**」 | 7；「31 项端到端检查」在仓内已无可执行载体（`scripts/` 无对应脚本，mcp-server 只剩 4 个参数测试，见 B6） |
| C9 | `docs/软件设计文档.md:442` | backend-contract.md「当前 **48** 命令」 | 61（该文件仍不存在，见 C10） |
| C10 | `docs/README.md:23` | 「Tauri 命令硬契约（当前 **39** 个…）+ **MCP 11 tools / 5 resources**」 | commands.rs **37**、注册 **61**、resources **7**；且指向的 `02-development/backend-contract.md` 不存在（该目录只有 4 份文件） |
| C11 | `docs/README.md:44` | 「`src-tauri/mcp-server`（stdio MCP server）：11 tools + **6** resources」 | 7；调度层归属错（B9） |
| C12 | `docs/README.md:53` | 「当前为 8 个页面组件 / **38 命令** / schema **v10**」 | 61 命令；schema v15 |
| C13 | `docs/01-design/architecture.md:14` | Tauri invoke（**38** 命令） | 61 |
| C14 | `docs/01-design/architecture.md:52` | invoke_handler 注册全部 **38 命令** | 61 |
| C15 | `docs/01-design/architecture.md:75` | 命令注册（**11 个**） | `lib.rs:164-226` 注册 61 |
| C16 | `docs/01-design/architecture.md:30` | bridge(11 tools + **4** resources) | 7 |
| C17 | `docs/01-design/architecture.md:81` | 以 11 tools + **4** resources 暴露 | 7 |
| C18 | `docs/02-development/directory-map.md:57` | lib.rs 注册 **38 命令** | 61 |
| C19 | `docs/02-development/directory-map.md:58` | commands.rs **11 个命令薄壳** | 37 |
| C20 | `README.md:35` | Tauri invoke（**48** 个命令）… schema **v14** … stdio MCP（11 tools + **6** resources） | 61 / v15 / 7（该文件当前有未提交改动，但与这些数字无关） |
| C21 | `docs/MCP逻辑优化说明.md:31` | 「**现为 11 tools + 6 resources**」 | 7 |
| C22 | `开发续接.md:15` | 「lib.rs（**39** 个 handler）、commands.rs（**30** 条命令）、bridge.rs（11 tools + **4** resources）」 | 61 / 37 / 7（该条本身是历史待办清单，已过期） |
| C23 | `开发续接.md:99` | 「需要与 bridge.rs（**11 tools/4 resources**）、commands.rs（**30 命令**）对齐」 | 11/7、37 |

### 3.4 ADR 决策记录（6 处）——按「历史快照」读是对的，但 ADR-022 有一条已被代码反转为现行事实

| 编号 | 文件:行号 | 现写 | 实际 |
| --- | --- | --- | --- |
| D1 | `docs/decisions/ADR-007-mcp-handwritten-protocol.md:17` | bridge.rs 映射 11 tools + **4** resources | 7（当时的值，属历史） |
| D2 | `docs/decisions/ADR-017-pomodoro-and-pet.md:130` | 壳共 **44** 个 handler | 61（历史） |
| D3 | `docs/decisions/ADR-017-pomodoro-and-pet.md:131` | todo-kanban://pomodoro（5 → **6** resources） | 现 7（历史） |
| D4 | `docs/decisions/ADR-022-mcp-readonly-from-settings.md:31-32` | 「写工具集合为 **5 个**：… 含 db_preview_state」 | 4（`bridge.rs:46-51`） |
| D5 | `docs/decisions/ADR-022-mcp-readonly-from-settings.md:45-46` | 「只读模式下允许 db_preview_state —— **暂不**：…若要放开，只需把它移出 WRITE_TOOLS 并补一条单测（本 ADR 记录该取舍点）」 | 该取舍点**已被执行**：HEAD `4ba0991` 把它移出 WRITE_TOOLS（新理由写在 `bridge.rs:42-45`）并补了单测（`bridge.rs:621-623`、`protocol.rs:194-197`）；ADR 正文没追加「已采纳」，读者会以为还是「暂不」 |
| D6 | `docs/decisions/ADR-023-mcp-http-tokens-and-audit.md:25` | bridge.rs（11 tools + **6** resources ↔ svc） | 7（搬家当时是 6，proposals 是搬家之后加的） |

**漂移小结（按错误类型）**：resources 计数错 **20** 处（写 6/5/4，实际 7）；handler/命令计数错 **21** 处（写 59/48/44/39/38/35/30/17，实际 commands.rs 37、注册 61）；写工具数错 **4** 处（写 5，实际 4）；数据版本错 **1** 处（13 → 15）；测试归属错 **1** 处（B6）。47 处里**没有一处是「文档声称有、代码里没有」的能力**——全部是数量、归属或口径落后于 `4ba0991` 与 ADR-023 这两次改动；真正的「文档说有其实没有」只有 C8/C10 的「31 项端到端检查」与 `backend-contract.md` 这类**载体缺失**。

---

## 4 表现层（宠物）在 MCP 里的可见性

### 4.1 偏好确实只在 localStorage，没有任何路径进 SQLite 或 MCP 快照

| 事实 | 出处 |
| --- | --- |
| 宠物偏好键 `todo-kanban.pet.v1`，读写只用 `localStorage.getItem/setItem` | `src/lib/petState.ts:158`、`:246-253`（loadPetPrefs）、`:255-260`（savePetPrefs，失败静默忽略） |
| 偏好字段 = enabled / x / y / scale / bubbleEnabled / float / themePreset / theme | `src/lib/petState.ts:164-180`（PetPrefs）、`:182-191`（默认值） |
| 设计意图写死在注释里：偏好「属本机界面偏好，存 localStorage，**不进 SQLite 与 MCP 快照**」 | `src/lib/petState.ts:10` |
| 偏好单例只在内存 + localStorage，全程无 invoke | `src/lib/petStore.ts:14-31`、`:41-43`、`:57-81` |
| 消费方全在前端 | `src/pages/SettingsPage.tsx:31,54`、`src/components/pet/GrokBot.tsx:15,48`、`src/components/pomodoro/PomodoroAlert.tsx:11,36` |

反向核实「有没有旁路进库」：写库唯一入口 `db_save_state` 的形状是 `DbState { projects, todos, resources }`（`src-tauri/core/src/models.rs:316-323`）；`app_meta` 里出现过的键只有 `mcp_enabled`/`mcp_readonly`/`mcp_token`（`src-tauri/core/src/svc/db_cmds.rs:564-566`）、`mcp_http_settings`/`mcp_tokens`（`:637-639`）、`lan_share_settings`（`:796`）、`seeded`/`next_seq`（`:180`、`src-tauri/core/src/db/mod.rs:22`）；`workflow_state` 的形状是 `Workflow`（`src-tauri/core/src/svc/workflow.rs:52-80`，含 links/templates/reminders/fieldDefs/automations/gitReport*，**无宠物字段**）。→ 宠物偏好在数据库里没有任何落点，MCP 侧不可能读到也不可能写。

两个传输都碰不到 WebView：stdio 是独立进程、只 import core 并读写 SQLite（`src-tauri/mcp-server/src/main.rs:11-13,20-25`，全文件无 tauri 依赖）；HTTP 虽「在桌面进程内」（`src-tauri/src/mcp_http.rs:5-7` 写了这个选择的理由），但它调的是同一份 `core::mcp` → SQLite 路径（`src-tauri/core/src/mcp/bridge.rs:73-105`），`AppHandle` 只用于服务启停（`mcp_http.rs:166-226`）→ **进程内 ≠ 能操作 UI**。

### 4.2 MCP 现在能不能读写「宠物状态 / 表情 / 气泡」

- 工具 11 项（`bridge.rs:107-192` + `:571-583`）与资源 7 项（`bridge.rs:20-37`）里都没有宠物项。
- 最接近的两条只是**数据副作用**：`db_save_state` 能改 `todos[].blocker`（`models.rs:267`）与 `status`/`archived`（`models.rs:250,268`），而心情判定恰好消费它们（4.3）；`://pomodoro` 是只读统计（`bridge.rs:274-277`），写会话的 `pomodoro_record` 无出口（`src-tauri/src/commands.rs:338`，理由 ADR-017:114）。
- **没有任何通道能让外部指定「说什么」**：气泡文案是前端写死的候选表（`src/lib/petState.ts:105-141`），`bubbleFor` 按时间 seed 挑（`:143-154`），`engine.say` 只在组件里被调（`src/components/pet/GrokBot.tsx:139,196`），`prefs.bubbleEnabled` 关掉时连 cheer/happy 都不弹（`GrokBot.tsx:137`）。
- 反证「能力其实存在、只是没出口」：`desktop_notify` 走系统通知（`src-tauri/src/native_workflow.rs:88-96`）、`desktop_update_tasks` 能改托盘任务清单（`:116-129`），两者都是 Tauri 命令，MCP 工具表里没有对应项（§1.2）。

### 4.3 心情 6 项输入里，只有 2 项在 MCP 的可写范围内

`PetInput`（`src/lib/petState.ts:71-85`）与优先级规则（`:88-95`：事件 > 阻塞 > 番茄阶段 > 打盹 > 待机）逐项定位：

| 输入 | 真实来源 | 在库 / 快照里？ |
| --- | --- | --- |
| `blockedCount` | `todos[].blocker` 非空计数（`src/components/pet/GrokBot.tsx:113-123`，判据 `:120`） | ✅ 在 → AI 经 `db_save_state` 可间接让它变 worried |
| `events`（task_done） | 「已完成数增加」的边沿（`GrokBot.tsx:99-110`），由 `status`/`archived` 驱动 | ✅ 数据在、事件不在（事件是 React 内存态 `GrokBot.tsx:59`，TTL 8 s `petState.ts:52`，上限 8 条 `:56`）→ AI 把某条改 done 能触发 happy |
| `doingCount` | `status === doing` 计数（`GrokBot.tsx:119`） | ✅ 在 |
| `phase` / `running` | 番茄运行态，崩溃恢复快照存 localStorage（`src/lib/pomodoroStore.ts:33`、`:199-224`） | ❌ 不在库，只在 WebView |
| focus_done（`completedFocusCount`） | 番茄轮数（`GrokBot.tsx:90-97`）源自 pomodoroStore | ❌ 会话表在库（v14 `pomodoro_sessions`）但只有前端会写（`pomodoroStore.ts:357`），MCP 无写出口 → AI 触发不了 cheer |
| `lastActivityAt` | 组件内 `activityRef`（`GrokBot.tsx:62,93,106`） | ❌ 纯内存 |

番茄配置也在 localStorage（`src/lib/pomodoro.ts:75`、`:107-116`）→ 「AI 替用户改专注时长」同样没有落点。

### 4.4 实时事件对外通道盘点（事实）

原生侧一共 emit 6 个事件名（9 个调用点）：`app-quit-requested`（`src-tauri/src/desktop.rs:24,290`）、`app-close-requested`（`desktop.rs:91`）、`quick-add`（`native_workflow.rs:39`，带一个布尔 background）、`app-menu`（`native_workflow.rs:168`、`menu.rs:83`，带菜单 id）、`workflow-tick`（`native_workflow.rs:249`，空载荷）、`lan-state-changed`（`lan_server.rs:161`，空载荷）。前端监听点：`src/components/layout/DesktopLifecycle.tsx:58,64`、`src/components/workflow/WorkflowLifecycle.tsx:60,69`、`src/components/layout/SidebarLayout.tsx:148,201`、`src/lib/store.ts:474`。

- 载荷只有两个，且都是 **UI 指令而非内容**（「打开快捷新增」「执行某菜单项」）；没有任何事件携带「宠物该说什么 / 什么表情」这类语义。
- 数据变化的唯一感知通道是轮询：`startExternalSync`（`src/lib/store.ts:438-468`）→ `pollState` → `db_poll_state`（`src-tauri/src/commands.rs:204-209`）→ `PRAGMA data_version`（`src-tauri/core/src/svc/state_poll.rs:56-65`：版本没变就 `state: null`，不重序列化全量）。四条约束是事实：
  1. **周期 2 s**：`src/lib/store.ts:468`。
  2. **带 `document.hidden` 闸门**：同一行 `if (!document.hidden) void sync()` → 窗口不可见时不轮询，只有重新聚焦补一次（`:469-470`）。
  3. **MCP 写不触发即时唤醒**：`after_write` → `notify_changed()` 只包在 Tauri 命令里（`src-tauri/src/commands.rs:24-29`），MCP 的保存走 `bridge.rs:84-105` 不调它。
  4. 快路径依赖无关功能：LAN watcher 确实独立覆盖了 MCP 写入（`src-tauri/src/lan_server.rs:164-186`，注释自述「覆盖桌面端与 MCP 的写入」，400 ms 内部轮询），并发出 `lan-state-changed`（`lan_server.rs:161`）→ 但整套只在局域网共享 `enabled` 时存在（`lan_server.rs:431-433`；默认 `enabled: false`，`src-tauri/core/src/models.rs:487`）。→ 「AI 写完 app 立刻看到」现在**取决于一个无关功能是否开着**；关掉时只剩第 1-2 条。

### 4.5 现有架构缺的是哪一段（事实描述）

缺两段，都不在权限或传输上：

1. **缺落点**：宠物的状态与偏好没有任何持久化位置——`DbState` 只有三张业务表（`core/src/models.rs:316-323`），`app_meta` 现有键里没有宠物项（`svc/db_cmds.rs:564-566,637-639,796`），`Workflow` 无宠物字段（`svc/workflow.rs:52-80`）→ 「给宠物加 MCP 出口」在数据层没有可对齐的对象；要加必须先决定落点（app_meta / workflow_state / 新表，新表 = 新数据版本，三处同步见 ADR-011 与 `src-tauri/config/src/lib.rs:17-56`）。
2. **缺入向呈现通道**：外部进程能把意图送进正在运行的 WebView 的现成机制只有两样，且都承载不了呈现语义——改 SQLite 后等轮询（2 s 且窗口未隐藏），或无内容载荷的 poke 事件（4.4）。仓里**已经有一条能让人看见一句话的通道** `desktop_notify`（`native_workflow.rs:88-96`），它只是没有 MCP 出口。
3. 追加限制：心情 6 项输入里 4 项不在库里（4.3）→ 即使前两段补齐，外部 AI 也只能影响「阻塞 / 完成」两类由数据派生的心情，说不了话、换不了表情、开不了气泡。

---

## 5 排序的事实依据（只给判据，不给结论）

**J1 结构可行性——是否「只有 GUI 才成立」**
- 需要 `AppHandle` / 窗口 / 托盘 / 系统通知 → 只有桌面进程能做：`native_workflow.rs:45,53,75,89,99,117`（6）、`desktop.rs:31,41,50`（3）、`lan_server.rs:531,538,557,563`（4，起停服务需 app，`lan_server.rs:335`）= 13 个。
- 属权限自举（交给 AI 等于让它自己解只读）：`commands.rs:154,160` + `mcp_http.rs:728-840`（11）；只读每请求重读 app_meta（`protocol.rs:69-75` + `tokens.rs:58`）→ 13 个。
- 剩下真正可讨论的集合 = `commands.rs` 里 23 个无出口项 = §1.5 的 16 缺口 + 7 刻意。

**J2 外部 AI 的真实需求证据**（有证据才算，不靠推测）
- 本仓唯一真实 AI 使用面是登记 skill：只用 `db_load_state` / `db_save_state` / `git_info`（`.agents/skills/todo-kanban-register/SKILL.md:20,41-42`），按目录匹配项目（`:52`），并自述「全量快照、别只提交新增行」（`:87,101`）→ 需求压力现在落在 §2 的粒度上，不在新出口。
- 有动机证据的缺口：#21/#22（登记流程表达不了「A 依赖 B」，而 `Workflow.links`/`reminders` 已存在，`svc/workflow.rs:52-60`）、#18（机制现成，`svc/state_poll.rs:56-65`）、#34（纯查询、结果有硬上限，`svc/git_report.rs:28-32`）、#28（全量写风险的自保兜底）、#33（读得到规则改不动存量）、#4-#6（缓存失效导致 GUI 30 s 盲区）。
- 无动机证据（只能推测）：#16 #17 #24 #25 #29。

**J3 只读取严与审计边界的相容性**
- 人工批准边界本体：#31 #32（给出即作废 `bridge.rs:42-45` 关于 `db_preview_state` 的全部理由；防过期校验 `svc/proposals.rs:165-169`）。
- 正文体积就是边界：#23 #30（历史单行实测可达 4 MB，`svc/history.rs:77-80`；提案两份快照上限 8 MB，`svc/proposals.rs:24,56`；帧上限 64 MiB，`mcp-server/src/main.rs:15`、`mcp_http.rs:41`；审计刻意只存元数据，`core/src/mcp/mod.rs:171-173`）。
- 审计可见性本身是缺项：大批量写的 `audit_target` 只留前 4 个 id（`bridge.rs:322-343`），被删行数不进审计 → 任何新增「能删数据」的出口都要先回答「审计看得见吗」。
- 字段级权限不存在：门禁是工具级（`bridge.rs:46-51` + `protocol.rs:146-156`）→ 「只让 AI 改某几个字段」这类排序诉求在现架构里没有落点。
- 读面上的既有不对称：`db_load_state` / `://state` 不过脱敏（`bridge.rs:73-82`），而局域网路径有 `redact_project`/`redact_todo`（`core/src/svc/lan.rs:26-36`），项目行里带 `frontendRepoToken`/`backendRepoToken`（`models.rs:145,147`）→ 「先扩读面还是先补脱敏/按项目授权」是判据，不是结论（`mcp-access.md:196-200` §9 把「按项目授权范围」列为未支持）。

**J4 与既有快照契约的相容性（改造成本）**
- 11 个工具全部复用 `core::svc`（`bridge.rs:107-192`）→ 同构新增的成本主要在 `audit_target` 与 inputSchema（`bridge.rs:322-343`、`:571-583`）两处。
- 但 #22 `workflow_save` 的并发控制是 revision 整数（`commands.rs:234`、`svc/workflow.rs:53`），不是 `same_state` 全量比较（`db/mod.rs:149-165`）；#29 `backup_restore` 要 expected + workflow_revision 双条件（`commands.rs:295-296`、`svc/backups.rs:432`）→ 这两类要改 MCP 侧契约形状，不是「加一行 match」。
- 8 个 git 类工具直接跑系统 git（`bridge.rs:122-160`），**不在 `DB_RW_LOCK` 内**（该锁只覆盖 db 读写编排，`svc/db_cmds.rs:18,65,94`）→ 「AI 的 git 操作与 GUI 并发」是另一条独立判据。

**J5 粒度成本是否被继承**
- 继承全量成本：#22（写入要与业务快照原子）、#26 #29（恢复类同样吃 expected 全量）。
- 不继承全量成本：#18（增量，天生省）、#21 的读扩展（`Workflow` 远小于业务快照）、#34（截断到 500 条，`svc/git_report.rs:30`）、#14 #20（几十字节的诊断）。
- 任何新增「全量读」都撞同一条乘数链：`content.text` + `structuredContent` 双写（`bridge.rs:363-366`）+ 审计再序列化一次（`core/src/mcp/mod.rs:174`）。

**J6 门禁与文档义务（排序前必须知道的状态）**
- `cargo test -p todo-kanban-core` 现在是红的（§3.1 A4），而它被列为放行条件（`CLAUDE.md` Rust 门禁段、`AGENTS.md:75-81`）；同一事实在 `bridge.rs:741-747`（断言 7，通过）与 `protocol.rs:209-214`（断言 6，失败）之间互相矛盾 → 任何后续票的第一步都会撞上「先修 gate 还是先改表」。
- `mcp-access.md` 是被 `AGENTS.md:39` 与 `CLAUDE.md` 明文要求「对外行为变了必须同步」的文件，其 §7/§9 已与代码不符（B12/B13）→ 排序要区分「补文档」与「补能力」是两件事。
- ADR-022 记录的取舍点已被执行（D5）→ 「决策记录跟上」是第三种动作，与补出口、补文档都不同。

---

## 6 代码事实出处（文件:行号）

### 6.1 handler 计数（61）

| 事实 | 出处 |
| --- | --- |
| 注册表 61 项：native_workflow 6、desktop 3、commands 37、lan 4、mcp_http 11 | `src-tauri/src/lib.rs:164-226`（分组 `:165-170`、`:171-173`、`:174-210`、`:211-214`、`:215-225`） |
| commands.rs 37 个 tauri::command | `src-tauri/src/commands.rs:33,39,45,55,69,86,97,113,130,140,146,154,160,167,181,192,198,204,212,220,225,229,239,251,262,274,284,288,293,307,311,317,322,329,338,346,352` |
| native_workflow 6 / desktop 3 / lan 4 / mcp_http 11 | `src-tauri/src/native_workflow.rs:45,53,75,89,99,117`；`src-tauri/src/desktop.rs:31,41,50`；`src-tauri/src/lan_server.rs:531,538,557,563`；`src-tauri/src/mcp_http.rs:728,734,747,753,760,777,783,789,814,833,840` |
| 全部 61 个都有 GUI 调用方（43 处直接 invoke，其余经封装） | `src/lib/git.ts:36,41,46`、`src/lib/mcp.ts:36`、`src/lib/storage.ts:29`、`src/lib/pomodoroStore.ts:323,357,370,371,604,605` 等 |

### 6.2 MCP 调度层（11 tools / 7 resources / 4 写工具）

| 事实 | 出处 |
| --- | --- |
| RESOURCES 7 元组（含 `://proposals`）；WRITE_TOOLS 4 项与「db_preview_state 刻意不在内」的理由 | `src-tauri/core/src/mcp/bridge.rs:20-37`、`:33-36`、`:42-45`、`:46-51` |
| 11 个工具的分发与 schema（`db_save_state` 必填 payload+expected） | `bridge.rs:107-192`、`:186-192`、`:571-583` |
| 只读分支：写工具隐藏 + 调用被拒；`db_preview_state` 只读可用 | `bridge.rs:194-229`（`:202-211`）、`protocol.rs:119-131`、`:146-156` |
| 结果封套 text + structuredContent 双份；`audit_target` 取前 4 个 id | `bridge.rs:341-368`（`:363`、`:364-366`）、`:322-343` |
| 资源读取分支；fields 只投影两字段；pomodoro 写死 7 天/20 条；proposals 只给元数据 | `bridge.rs:277-312`（`:266-272`、`:274-277`、`:279-284`、`:285-288`） |
| `git_info` 直读；`git_info_refresh`/`git_info_remote` 不暴露 | `bridge.rs:6`、`:122-124` |
| STATE_CONFLICT → Conflict；`db_preview_state` → `proposals::create_at` | `bridge.rs:217-263`（`:242-247`、`:249-256`） |
| 无上下文 = 无数据源 + 只读；每请求鉴权；取严 | `bridge.rs:53-71`、`core/src/mcp/mod.rs:36-51,53-73,77-81`、`protocol.rs:69-75`、`core/src/mcp/tokens.rs:13-21,58`（单测 `:111-131`） |
| 审计 `bytes` 再序列化一次、不存正文；400 字 / 20000 行 / 每 200 次裁剪 | `core/src/mcp/mod.rs:154-187`（`:171-173`、`:174`）、`core/src/mcp/audit.rs:21,23,25,50` |
| 全局管理 Key、Token 上限 50、`issue()` 只由设置页调用 | `core/src/mcp/tokens.rs:8,83,124-143`、`core/src/svc/db_cmds.rs:640-641,705-707,755-757` |
| 协议版本协商 + 未声明方法一律 -32601 | `protocol.rs:12,105-191`（`:158-176`） |
| stdio：64 MiB 帧、超限 -32600 并断连、启动鉴权、逐帧重鉴权、审计落库、stdout 只走协议帧 | `src-tauri/mcp-server/src/main.rs:15,20-25,49-51,73-79,98-123,135-157` |
| HTTP：会话上限 64、64 MiB body、Origin 校验、GET 405、AppHandle 仅用于启停 | `src-tauri/src/mcp_http.rs:37,41,267,526-651,654,166-226` |
| 三份断言对同一件事给出两个结论 | `bridge.rs:741-747`（断言 7，过）、`bridge.rs:749-775`（断言 11 tools，过）、`protocol.rs:208-223`（断言 6，**失败行 :214**） |

### 6.3 快照粒度与并发（§2 的数字）

| 事实 | 出处 |
| --- | --- |
| `DbState` 三张表；行字段 24/17/9；项目行含两个 repo Token | `core/src/models.rs:316-323,158-211,129-155`（`:145,147`）、`:275-286` |
| 全量逐记录比较；不等即 STATE_CONFLICT；比较前归一化 | `core/src/db/mod.rs:148-165,237-262`（`:256-261`）、`core/src/db/row.rs:130,189-196,271,281` |
| 差异写「快照之外的行会被删」；`open_existing` 为 MCP 专用且硬拒版本不符；写事务跑 automations | `db/mod.rs:178-180,186-200`（`:196`）、`:34-50`（`:42-48`） |
| MCP 写路径：只读检查 → 开数据源 → `with_actor("mcp:…")` → `save_state_checked` → 附件进 trash | `bridge.rs:84-105`（`:98-103`） |
| app 写路径多一把 `DB_RW_LOCK`；`after_write` 唤醒 LAN 推送 | `core/src/svc/db_cmds.rs:18,60,92,108,149`、`src-tauri/src/commands.rs:24-29`、`src-tauri/src/lan_server.rs:161,422` |
| 历史行存 before/after、固定每页 100；单行实测可达 4 MB；`redact` 只清两个 Token 键 | `core/src/svc/history.rs:132,77-80,40-59,17-27` |
| 提案：pending 200 条、单条 8 MB、Token 不可经提案改、过期即拒、摘要只给元数据 | `core/src/svc/proposals.rs:22,24,28-34,40-42,56-60,93-129,165-176` |
| 附件：单张 5 MB、serve 20 MB、引用前缀 | `core/src/svc/attachments.rs:26,28,321` |
| 增量读机制（版本未变返回 null） | `core/src/svc/state_poll.rs:56-65,66-73` |
| git 缓存：命中即回 + 30 s 节流 + 失效 API | `core/src/svc/repo_cache.rs:1,11,31,34,52,61,86` |
| `Workflow` 结构与 revision | `core/src/svc/workflow.rs:52-80,105-120` |
| 报告限额 8 仓库 / 500 提交 / 300 条详情补全 | `core/src/svc/git_report.rs:28-40` |
| app_meta 键清单（MCP / LAN / seeded / next_seq） | `core/src/svc/db_cmds.rs:564-566,637-639,796,180`、`core/src/db/mod.rs:22` |
| 数据版本 15 与迁移表 | `src-tauri/config/src/lib.rs:8,17-56` |

### 6.4 表现层（§4）

| 事实 | 出处 |
| --- | --- |
| 宠物偏好键、字段、默认值、localStorage 读写、注释「不进 SQLite 与 MCP 快照」 | `src/lib/petState.ts:10,158,164-180,182-191,221-244,246-253,255-260` |
| 偏好单例（全程无 invoke）与配色解析 | `src/lib/petStore.ts:14-31,41-43,57-81` |
| 心情 6 项输入、优先级、事件 TTL/上限、气泡候选与选择 | `src/lib/petState.ts:16,52,54,56,71-85,88-95,105-141,143-154` |
| 心情消费点：blocker / doing / done / focus 边沿、`engine.say`、拖拽不写库 | `src/components/pet/GrokBot.tsx:48,59,62,90-97,99-110,113-123,125-133,137,139-141,163,196` |
| 番茄运行态与配置在 localStorage；会话只由前端写 | `src/lib/pomodoroStore.ts:33,199-224,250,323,357,370,371,604`、`src/lib/pomodoro.ts:75,107-116` |
| 外部同步：2 s + `document.hidden` 闸门 + focus 补拉 + LAN 事件补拉 | `src/lib/store.ts:428-435,438-468,469-470,474-476` |
| emit 的 6 个事件名与 9 个调用点 | `src-tauri/src/desktop.rs:24,91,290`、`src-tauri/src/native_workflow.rs:39,168,170,249`、`src-tauri/src/menu.rs:83`、`src-tauri/src/lan_server.rs:161` |
| 前端监听点 | `src/components/layout/DesktopLifecycle.tsx:58,64`、`src/components/workflow/WorkflowLifecycle.tsx:60,69`、`src/components/layout/SidebarLayout.tsx:148,201`、`src/lib/store.ts:474` |
| LAN watcher 独立覆盖 MCP 写入（400 ms）与默认关闭 | `src-tauri/src/lan_server.rs:164-186,431-433`、`src-tauri/core/src/models.rs:487` |

### 6.5 复核方式（本文可执行结论）

```bash
grep -c "#[tauri::command]" src-tauri/src/commands.rs                    # 37
grep -n "RESOURCES: \[(&str, &str); 7\]" src-tauri/core/src/mcp/bridge.rs  # 第 7 号资源
grep -n "assert_eq!(resources.len()" src-tauri/core/src/mcp/protocol.rs     # :214 断言 6
cargo test -p todo-kanban-core mcp::                                       # 27 passed / 1 failed
git log --oneline -S "todo-kanban://proposals" -- src-tauri/core/src/mcp/bridge.rs  # 4ba0991
```

§2.1 的体积地板复算方式：按 `core/src/models.rs` 的 serde camelCase 字段名，把一条记录的全空值序列化成 JSON 后数字符数（24 / 17 / 9 个键 → 320 / 283 / 107 B）；「典型待办 610 B」= 空值地板再加一个真实形态 id、12 字中文标题、一句备注与 1 条提交对象。



