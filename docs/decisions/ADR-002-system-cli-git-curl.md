# ADR-002：git / GitLab 集成走系统 CLI（git + curl）

## 状态
Accepted（重构基线）

## 日期
2026-09-03（todo-git 基线核实）

## 背景
核心能力依赖：分支列表/新建/检出、按时间窗与标记检索提交（git log）、GitLab 内网自建实例的远端分支拉取（含自签证书）。后端依赖最小化是基线原则；目标机器 git 必在 PATH，Windows 10+ 自带 curl；release 包为 Windows GUI 子系统（无控制台窗口）。

## 决策
- git 一律走系统 CLI，统一注入隔离参数：git -C <repo> --no-pager -c color.ui=false -c core.quotepath=false（防用户全局 gitconfig 彩色输出 / 中文路径转义污染 %x1f 解析）；机器可读输出统一格式 %H%x1f%s%x1f%cI（parse_commit_lines 解析，≤200 行）
- 启动时检测 git 版本 ≥ 2.20（不足中文提示、不阻塞）；外部子进程统一超时：git 30s / curl 10s（防网络挂起卡死写操作）
- GitLab API 走系统 curl：PRIVATE-TOKEN 头 + -k（兼容内网自签证书）+ 分页拉取（5×100）
- 所有子进程经 quiet_command 构造：Windows 附加 CREATE_NO_WINDOW（0x08000000），防止 GUI 壳下闪控制台黑框

## 备选方案

### git2-rs（libgit2 绑定）
- 优点：无外部进程、API 类型安全
- 否决：依赖树庞大；行为与系统 git 存在差异；绑定层维护成本高

### reqwest / hyper 等 HTTP crate
- 优点：纯 Rust、异步生态成熟
- 否决：新增 TLS 依赖与配置面；内网自签场景 curl -k 已覆盖；零新增依赖原则优先

## 后果
- 运行环境硬依赖 PATH 中的 git（curl 可选：仅 GitLab 远端增强需要）
- 输出解析集中在 tool/git_cli.rs 并有单元测试兜底；git 版本差异风险低
- CREATE_NO_WINDOW 必须全路径覆盖——任何绕过 quiet_command 的 spawn 都会在 release 下闪黑框（已知坑）
- API 失败静默回退本地分支（不打断用户操作）
