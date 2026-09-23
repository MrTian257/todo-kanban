//! Git 报告（日报 / 周报 / 月报）：从 GitLab API 拉取时间窗内的提交，按「开发人员归类」聚合。
//!
//! 定位：**纯查询视图**——不写库、不进 db_save_state 写链；报告配置（归类表）存 workflow_state 的
//! `Workflow.gitReportDevs`。数据源是 GitLab REST API（复用 svc/gitlab.rs + svc/http_cache.rs），
//! 不读本地 git 目录。
//!
//! 设计取舍：
//! - **单仓库失败不影响整体**：某个仓库缺 Token / 网络失败 / Token 失效时，只把该仓库标成 error，
//!   其余仓库照常出报告，界面按仓库展示错误。
//! - **合并提交**：`parent_ids.len() > 1` 精确判定，默认排除出统计（合并提交没有 diff 行数，会计虚提交数）。
//! - **模块分布**：GitLab 提交列表接口不返回文件路径，必须逐提交再调 diff 接口，属重操作；
//!   默认关闭，开启时限制条数（200）、并发（4 路）与时间预算（20s），超限只标注截断而不报错。
//! - **活跃天数**：提交时间是 UTC，按请求携带的客户端时区偏移换算回本地日再按天去重，
//!   与用户看到的「今天/本周」一致。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::svc::forge::{self, CommitStats, Forge, ForgeCommit};

// ── 上限与预算（全部为「宁可标注截断也不让界面卡死」的保护值）────────────────
/// 单次报告最多统计的仓库数（当前项目只有前端/后端两个，留出余量）
const MAX_REPOS: usize = 8;
/// 返回给前端的提交明细上限（按时间倒序截取）
const MAX_REPORT_COMMITS: usize = 500;
/// 未归类提交人最多返回条数
const MAX_UNMATCHED: usize = 50;
/// 详情补全（行数 / 文件路径）最多逐提交拉取的条数：
/// GitHub 的行数只能逐提交拿，GitLab 仅在「按模块分布」开启时才需要，两边共用同一限额
const MAX_DETAIL_COMMITS: usize = 300;
/// 详情补全并发线程数
const DETAIL_WORKERS: usize = 4;
/// 详情补全总时间预算（秒）
const DETAIL_TIME_BUDGET_SECS: u64 = 20;
/// 模块分布最多保留的目录数（其余合并为「其它」）
const TOP_MODULES: usize = 8;

/// 开发人员归类：把一个实际开发人员对应的多个提交人姓名/邮箱归到一起。
/// 每个项目一份（projectId 归属），由工作流配置持久化。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDeveloper {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub name: String,
    /// 别名：含 `@` 视为邮箱匹配，否则视为姓名匹配；支持 `*` 通配
    #[serde(default)]
    pub aliases: Vec<String>,
}

/// 提交类型规则（每个项目一份，可自定义）：命中即归类，全部未命中落 `other`。
/// key 同时作为 conventional 前缀词的匹配值（`feat(ui)!: x` → feat）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitKindRule {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    /// 稳定标识（报告里提交的 kind 就是它）；也是前缀词匹配值
    pub key: String,
    #[serde(default)]
    pub label: String,
    /// 图表颜色（#rrggbb）
    #[serde(default)]
    pub color: String,
    /// 匹配关键词：纯 ASCII 词按词边界匹配，含中文的关键词按子串匹配
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// 未命中任何规则时的兜底类型 key（前端映射为「其它」）
pub const OTHER_KIND: &str = "other";

/// 内置默认类型规则（项目未配置时使用；与前端 DEFAULT_KIND_RULES 同规则，后端为准）。
/// 顺序即匹配优先级：先按 conventional 前缀命中，再按此顺序扫关键词。
pub fn default_kind_rules() -> Vec<GitKindRule> {
    const TABLE: [(&str, &str, &str, &[&str]); 13] = [
        ("feat", "新增功能", "#3b82f6", &["新增", "添加", "实现", "支持", "feat", "feature"]),
        ("fix", "缺陷修复", "#ef4444", &["修复", "解决", "bug", "fix", "hotfix"]),
        ("refactor", "重构优化", "#8b5cf6", &["重构", "优化", "抽取", "整理", "统一", "refactor"]),
        ("merge", "合并", "#78716c", &["合并", "merge"]),
        ("revert", "回滚", "#78716c", &["回滚", "revert"]),
        ("reapply", "重新应用", "#78716c", &["重新应用", "reapply"]),
        ("style", "样式", "#a855f7", &["样式", "style", "格式化"]),
        ("docs", "文档", "#10b981", &["文档", "docs", "doc"]),
        ("test", "测试", "#14b8a6", &["测试", "test"]),
        ("perf", "性能", "#f59e0b", &["性能", "perf"]),
        ("build", "构建", "#0ea5e9", &["构建", "build"]),
        ("ci", "CI", "#6366f1", &["ci", "pipeline"]),
        ("chore", "杂项", "#64748b", &["杂项", "chore"]),
    ];
    TABLE
        .iter()
        .map(|(key, label, color, keywords)| GitKindRule {
            id: format!("kind-{key}"),
            project_id: String::new(),
            key: (*key).to_string(),
            label: (*label).to_string(),
            color: (*color).to_string(),
            keywords: keywords.iter().map(|item| (*item).to_string()).collect(),
            enabled: true,
        })
        .collect()
}

/// 单个仓库的请求参数（URL + Token 由前端从项目配置里取，Token 是凭据引用，后端 resolve）
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRepoRequest {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub token: String,
}

/// 报告请求（since/until 为 UTC ISO 8601，由前端按本地日历边界换算）
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest {
    #[serde(default)]
    pub project_id: String,
    pub since: String,
    pub until: String,
    /// 客户端时区偏移（分钟，东八区 = 480）：UTC 提交时间 → 本地日
    #[serde(default)]
    pub tz_offset_minutes: i32,
    #[serde(default)]
    pub repos: Vec<ReportRepoRequest>,
    #[serde(default)]
    pub developers: Vec<GitDeveloper>,
    /// 提交类型规则（每项目一份）；为空时后端用 default_kind_rules()
    #[serde(default)]
    pub kinds: Vec<GitKindRule>,
    /// 是否把合并提交计入统计（默认排除）
    #[serde(default)]
    pub include_merges: bool,
    /// 是否逐提交拉取文件明细做「按模块分布」（默认关闭）
    #[serde(default)]
    pub module_stats: bool,
}

/// 计数项：key 由前端映射为展示名（类型词表 / 仓库标签 / 模块路径）
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountItem {
    pub key: String,
    pub count: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoReport {
    pub key: String,
    pub label: String,
    pub url: String,
    /// 平台标识：gitlab | github（前端据此显示数据来源与「仅默认分支」提示）
    pub forge: String,
    /// 是否只统计了默认分支（GitHub 列表接口不带 sha 时的固有语义；GitLab 为 false）
    pub default_branch_only: bool,
    /// ok | error
    pub status: String,
    pub error: String,
    /// 原始拉取条数（含合并提交）
    pub fetched_count: usize,
    /// 纳入统计的提交数（按 includeMerges 规则过滤后）
    pub commit_count: usize,
    /// 合并提交条数（includeMerges=false 时它们不进人员统计，但仍在仓库维度计数）
    pub merge_count: usize,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeveloperReport {
    pub id: String,
    pub name: String,
    pub commits: usize,
    /// 其中合并提交条数（合并提交无 diff 行数，单独展示避免误解）
    pub merge_commits: usize,
    pub additions: u64,
    pub deletions: u64,
    /// 活跃天数（按客户端时区的自然日去重）
    pub active_days: usize,
    pub by_type: Vec<CountItem>,
    pub by_repo: Vec<CountItem>,
    pub by_module: Vec<CountItem>,
    /// 每日提交数（本地日期 YYYY-MM-DD，升序）：周报/月报的成员图与月历热力图
    pub by_day: Vec<CountItem>,
    /// 每小时提交数（本地 00-23，升序）：日报的成员图
    pub by_hour: Vec<CountItem>,
    /// 最早 / 最近提交时间（原始 ISO 串，空串=无）
    pub first_at: String,
    pub last_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportCommit {
    pub repo_key: String,
    pub repo_label: String,
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    pub committer_name: String,
    pub date: String,
    pub developer_id: String,
    pub developer_name: String,
    pub kind: String,
    pub is_merge: bool,
    /// None = 服务端未返回行数统计（旧版本 GitLab 忽略 with_stats）
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
    pub modules: Vec<String>,
    pub web_url: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmatchedAuthor {
    pub name: String,
    pub email: String,
    pub commits: usize,
    pub last_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportResult {
    pub generated_at: i64,
    pub since: String,
    pub until: String,
    pub repos: Vec<RepoReport>,
    pub developers: Vec<DeveloperReport>,
    /// 本次生效的类型规则（前端据此上色与命名；未配置时为内置默认）
    pub kinds: Vec<GitKindRule>,
    pub unmatched: Vec<UnmatchedAuthor>,
    /// 未归类提交人总数（unmatched 只返回前 MAX_UNMATCHED 条）
    pub unmatched_total: usize,
    /// 团队活跃天数：已归类开发人员的提交按本地自然日去重后的天数
    pub active_days: usize,
    /// 是否拿到了行数统计（GitLab 由列表接口返回；GitHub 由逐提交详情补）
    pub stats_available: bool,
    /// 行数统计是否只覆盖了部分提交（GitHub 超限 / 个别详情失败）→ 前端按「≈」展示并加警告
    pub stats_partial: bool,
    pub module_stats: bool,
    pub module_stats_truncated: bool,
    pub commits_truncated: bool,
    /// 任一仓库被分页/时间预算截断
    pub truncated: bool,
    pub warnings: Vec<String>,
    pub commits: Vec<ReportCommit>,
}

// ── 纯函数：别名匹配 / 类型分类 / 本地日 / 模块归类 ───────────────────────────

/// 别名匹配：大小写不敏感、首尾空白忽略；含 `@` 的别名只匹配邮箱，否则只匹配姓名；
/// 支持 `*` 通配（`*@corp.com`、`张*`）。空别名/空目标不匹配。
pub fn matches_alias(alias: &str, name: &str, email: &str) -> bool {
    let alias = alias.trim().to_lowercase();
    if alias.is_empty() {
        return false;
    }
    let target = if alias.contains('@') {
        email.trim().to_lowercase()
    } else {
        name.trim().to_lowercase()
    };
    if target.is_empty() {
        return false;
    }
    glob_match(&alias, &target)
}

/// 极简通配：仅 `*` 有意义（匹配任意长度），其余字符字面量比较。
/// 双指针 + 回溯标记，线性空间；模式串来自用户配置且长度受限。
fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut mark = 0usize;
    while ti < t.len() {
        if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            pi += 1;
            mark = ti;
        } else if let Some(index) = star {
            pi = index + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// 内置默认规则的提交类型分类（等价于 `classify_kind_with(&default_kind_rules(), ...)`）
pub fn classify_kind(subject: &str, message: &str) -> String {
    classify_kind_with(&default_kind_rules(), subject, message)
}

/// 按项目规则归类提交类型（后端为权威，前端 `KindRuleDialog` 编辑同一套语义）：
/// 1. **conventional 前缀优先**：标题冒号前的 ASCII 词（`feat(ui)!: x` → `feat`）等于某规则 key 或关键词 → 该规则；
/// 2. 否则按规则顺序扫关键词：先只看标题（信息量最大），标题没命中再看「标题 + 完整信息」；
/// 3. 都没命中 → `other`（前端显示「其它」）。禁用规则直接跳过。
///
/// **所有比较都忽略大小写与首尾空白**（`FEAT:`、`Feat`、` feat ` 等价），统一走 `same_ignore_case`；
/// 返回值是规则 key 的 trim 形态（保留配置里的大小写，供前端按 key 上色）。
pub fn classify_kind_with(rules: &[GitKindRule], subject: &str, message: &str) -> String {
    let subject = subject.trim();
    let prefix = conventional_prefix(subject);
    if !prefix.is_empty() {
        if let Some(rule) = rules.iter().find(|rule| {
            rule.enabled
                && (same_ignore_case(&rule.key, &prefix)
                    || rule
                        .keywords
                        .iter()
                        .any(|keyword| same_ignore_case(keyword, &prefix)))
        }) {
            return rule.key.trim().to_string();
        }
    }
    if let Some(rule) = match_rule(rules, subject) {
        return rule.key.trim().to_string();
    }
    if !message.trim().is_empty() {
        if let Some(rule) = match_rule(rules, &format!("{subject} {message}")) {
            return rule.key.trim().to_string();
        }
    }
    OTHER_KIND.to_string()
}

/// 忽略大小写与首尾空白的相等比较（Unicode 折叠）：前缀、规则 key、关键词三处比较统一走这里，
/// 保证 `FEAT:` / `Feat` / ` feat ` 等价。中文没有大小写，折叠是幂等的空操作。
fn same_ignore_case(left: &str, right: &str) -> bool {
    left.trim().to_lowercase() == right.trim().to_lowercase()
}

/// 首个关键词命中的启用规则（顺序即优先级）
fn match_rule<'a>(rules: &'a [GitKindRule], text: &str) -> Option<&'a GitKindRule> {
    rules.iter().find(|rule| {
        rule.enabled
            && rule
                .keywords
                .iter()
                .any(|keyword| contains_keyword(text, keyword))
    })
}

/// 标题的 conventional 前缀词：`feat(ui)!: x` → `feat`；`修复：x`（非 ASCII）与无冒号 → 空串。
/// 限制为 ASCII 单词，避免把中文标题里的「修复」当成类型前缀。
fn conventional_prefix(subject: &str) -> String {
    let head = match subject.split_once(':').or_else(|| subject.split_once('：')) {
        Some((head, _)) => head,
        None => return String::new(),
    };
    let word = head.split(['(', '（', '!']).next().unwrap_or("").trim();
    if word.is_empty()
        || !word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return String::new();
    }
    word.to_lowercase()
}

/// 关键词匹配（**忽略大小写**，两侧都先折叠）：纯 ASCII 关键词按**词边界**匹配（字母数字为词字符），
/// 避免 `ci` 命中 `special`（大小写不影响词边界判定）；含非 ASCII 的关键词按子串匹配（中文没有词边界概念）。
fn contains_keyword(text: &str, keyword: &str) -> bool {
    let keyword = keyword.trim();
    if keyword.is_empty() {
        return false;
    }
    let lower = text.to_lowercase();
    let needle = keyword.to_lowercase();
    if !needle.is_ascii() {
        return lower.contains(&needle);
    }
    let bytes = lower.as_bytes();
    let mut start = 0usize;
    while let Some(offset) = lower[start..].find(&needle) {
        // needle 全 ASCII → 命中位置必然落在字符边界上，index + 1 安全
        let index = start + offset;
        let before_ok = index == 0 || !bytes[index - 1].is_ascii_alphanumeric();
        let end = index + needle.len();
        let after_ok = end >= bytes.len() || !bytes[end].is_ascii_alphanumeric();
        if before_ok && after_ok {
            return true;
        }
        start = index + 1;
    }
    false
}

/// 把 ISO 8601 提交时间按客户端时区偏移归到本地自然日（YYYY-MM-DD）。
/// 解析失败时退化为取前 10 个字符（ISO 的日期部分），不抛错——报告不应因一条脏时间整页失败。
pub fn local_day(iso: &str, tz_offset_minutes: i32) -> String {
    match parse_iso_to_epoch_secs(iso) {
        Some(secs) => civil_from_days(
            (secs + i64::from(tz_offset_minutes) * 60).div_euclid(86_400),
        ),
        None => iso.trim().chars().take(10).collect(),
    }
}

/// 把 ISO 8601 提交时间按客户端时区偏移归到本地小时（00-23，两位补零）。
/// 解析失败返回 "00"（脏数据不报错）。
pub fn local_hour(iso: &str, tz_offset_minutes: i32) -> String {
    let hour = match parse_iso_to_epoch_secs(iso) {
        Some(secs) => (secs + i64::from(tz_offset_minutes) * 60).rem_euclid(86_400) / 3600,
        None => 0,
    };
    format!("{hour:02}")
}

/// ISO 8601 → Unix 秒（支持 `Z` / `+HH:MM` / `-HH:MM`；无时区后缀按 UTC）。
fn parse_iso_to_epoch_secs(iso: &str) -> Option<i64> {
    let s = iso.trim();
    if s.len() < 19 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: i64 = s.get(5..7)?.parse().ok()?;
    let day: i64 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }
    let mut secs = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
    let rest = s.get(19..).unwrap_or("");
    let sign = if rest.starts_with('+') {
        1
    } else if rest.starts_with('-') {
        -1
    } else {
        0
    };
    if sign != 0 {
        let body = &rest[1..];
        let (h, m) = match body.split_once(':') {
            Some((h, m)) => (h.trim().parse::<i64>().ok()?, m.trim().parse::<i64>().ok()?),
            None => (
                body.get(0..2).and_then(|v| v.parse().ok()).unwrap_or(0),
                body.get(2..4).and_then(|v| v.parse().ok()).unwrap_or(0),
            ),
        };
        secs -= sign * (h * 3600 + m * 60);
    }
    Some(secs)
}

/// Howard Hinnant 的 civil 日期算法：日期 → 距 1970-01-01 的天数（纯整数，避免引入时间库）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// 距 1970-01-01 的天数 → YYYY-MM-DD
fn civil_from_days(z: i64) -> String {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// 文件路径 → 模块分布：取一级目录（根目录下的文件归「根目录」），
/// 按出现次数降序取前 TOP_MODULES 项，其余合并为「其它」。
pub fn top_modules(paths: &[String]) -> Vec<CountItem> {
    let mut counter: BTreeMap<String, usize> = BTreeMap::new();
    for path in paths {
        let normalized = path.trim().replace('\\', "/");
        if normalized.is_empty() {
            continue;
        }
        let module = match normalized.split_once('/') {
            Some((first, _)) if !first.is_empty() => first.to_string(),
            _ => "根目录".to_string(),
        };
        *counter.entry(module).or_default() += 1;
    }
    let mut items: Vec<CountItem> = counter
        .into_iter()
        .map(|(key, count)| CountItem { key, count })
        .collect();
    // 次数降序、同次数按 key 升序，保证结果稳定可测
    items.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    if items.len() <= TOP_MODULES {
        return items;
    }
    let rest: usize = items[TOP_MODULES..].iter().map(|item| item.count).sum();
    items.truncate(TOP_MODULES);
    items.push(CountItem {
        key: "其它".to_string(),
        count: rest,
    });
    items
}

// ── 编排 ────────────────────────────────────────────────────────────────────

/// 单仓库拉取结果（失败也保留一条，供界面按仓库展示错误）。
/// 注意：地址为空的仓库会被跳过，因此**不能**用下标去索引原始请求的 repos —— 凭据随结构一起带。
struct RepoFetch {
    key: String,
    label: String,
    url: String,
    /// 凭据引用（逐提交拉详情时要用）
    token: String,
    /// 平台（决定详情补全要不要拿行数、以及网页地址与「仅默认分支」标注）
    forge: Forge,
    status: String,
    error: String,
    commits: Vec<ForgeCommit>,
    truncated: bool,
}

/// 归类后的提交（build_result 的输入，便于脱网单测）
struct Classified {
    repo_index: usize,
    commit: ForgeCommit,
    developer: Option<usize>,
    kind: String,
    is_merge: bool,
    /// 是否纳入统计（合并提交按 includeMerges 决定）
    counted: bool,
    modules: Vec<String>,
}

/// 报告主入口：拉取 → 归类 → （可选）模块统计 → 聚合。
pub fn fetch(request: ReportRequest) -> AppResult<ReportResult> {
    if request.since.trim().is_empty() || request.until.trim().is_empty() {
        return Err(AppError::invalid("报告时间窗不能为空"));
    }
    if request.repos.len() > MAX_REPOS {
        return Err(AppError::invalid("单次报告最多统计 8 个仓库"));
    }
    let developers = normalize_developers(&request.project_id, &request.developers);
    let kinds = normalize_kinds(&request.project_id, &request.kinds);
    let mut warnings: Vec<String> = Vec::new();
    let repos = fetch_repos(&request, &mut warnings);
    let mut classified = classify(&request, &repos, &developers, &kinds, &mut warnings);

    // 详情补全：GitHub 的行数只能逐提交拿（列表接口不返回 stats）；GitLab 仅在「按模块分布」开启时才需要。
    // 两个平台共用同一份限额（条数 / 并发 / 时间预算），超限只标注部分结果，不让界面卡死。
    let mut detail_jobs: Vec<(usize, Forge, String, String, String)> = Vec::new();
    for (index, item) in classified.iter().enumerate() {
        if !item.counted || item.developer.is_none() {
            continue;
        }
        let Some(repo) = repos.get(item.repo_index) else {
            continue;
        };
        if repo.status != "ok" {
            continue;
        }
        let needs_detail = if repo.forge == Forge::Github {
            // GitHub 列表没有行数统计 → 必须逐提交补
            item.commit.stats.is_none()
        } else {
            // GitLab 行数来自列表，只有要模块分布时才拉 diff
            request.module_stats
        };
        if !needs_detail {
            continue;
        }
        detail_jobs.push((
            index,
            repo.forge,
            repo.url.clone(),
            repo.token.clone(),
            item.commit.hash.clone(),
        ));
    }
    let detail_total = detail_jobs.len();
    detail_jobs.truncate(MAX_DETAIL_COMMITS);
    let (details, budget_truncated) = if detail_jobs.is_empty() {
        (HashMap::new(), false)
    } else {
        fetch_details(&detail_jobs)
    };
    if detail_total > MAX_DETAIL_COMMITS {
        warnings.push(format!(
            "详情补全只覆盖最近 {} 条提交，行数与模块统计可能不完整",
            MAX_DETAIL_COMMITS
        ));
    }
    if budget_truncated {
        warnings.push("详情补全超出时间预算，已返回已获取的部分结果".to_string());
    }
    for (index, (stats, paths)) in details {
        if let Some(item) = classified.get_mut(index) {
            // 列表已带行数（GitLab）时不覆盖，只补缺失的那部分
            if item.commit.stats.is_none() {
                item.commit.stats = stats;
            }
            item.modules = paths;
        }
    }
    let details_truncated = detail_total > MAX_DETAIL_COMMITS || budget_truncated;

    Ok(build_result(
        &request,
        &repos,
        classified,
        developers,
        kinds,
        details_truncated,
        warnings,
    ))
}

/// 逐仓库拉取；单仓库失败只记录错误，不中断整体
fn fetch_repos(request: &ReportRequest, warnings: &mut Vec<String>) -> Vec<RepoFetch> {
    let mut out = Vec::with_capacity(request.repos.len());
    for repo in &request.repos {
        let key = repo.key.trim().to_string();
        let label = if repo.label.trim().is_empty() {
            key.clone()
        } else {
            repo.label.trim().to_string()
        };
        let url = repo.url.trim().to_string();
        if url.is_empty() {
            // 未配置地址的仓库直接跳过（前端通常不会传，兜底防御）
            continue;
        }
        // 平台按域名识别（未知域名由 forge 在 404 时兜底探测并缓存判定）
        let platform = forge::detect_cached(&url);
        let token = repo.token.trim().to_string();
        if token.is_empty() {
            let error = format!("缺少 {} Token，已跳过该仓库", platform.label());
            warnings.push(format!("{label}：{error}"));
            out.push(RepoFetch {
                key,
                label,
                url,
                token,
                forge: platform,
                status: "error".into(),
                error,
                commits: Vec::new(),
                truncated: false,
            });
            continue;
        }
        match forge::report_window(
            platform,
            &url,
            &token,
            request.since.trim(),
            request.until.trim(),
        ) {
            Ok((commits, truncated)) => {
                if truncated {
                    warnings.push(format!(
                        "{label}：提交超过 {} 条上限或超出时间预算，结果可能不完整",
                        forge::MAX_WINDOW_PAGES as usize * 100
                    ));
                }
                out.push(RepoFetch {
                    key,
                    label,
                    url,
                    token,
                    forge: platform,
                    status: "ok".into(),
                    error: String::new(),
                    commits,
                    truncated,
                });
            }
            Err(error) => {
                let error = error.to_string();
                warnings.push(format!("{label}：{error}"));
                out.push(RepoFetch {
                    key,
                    label,
                    url,
                    token,
                    forge: platform,
                    status: "error".into(),
                    error,
                    commits: Vec::new(),
                    truncated: false,
                });
            }
        }
    }
    out
}

/// 归类：判定合并提交 / 类型 / 归属开发人员，并按 (仓库, hash) 去重
fn classify(
    request: &ReportRequest,
    repos: &[RepoFetch],
    developers: &[GitDeveloper],
    kinds: &[GitKindRule],
    warnings: &mut Vec<String>,
) -> Vec<Classified> {
    let mut seen: HashSet<(usize, String)> = HashSet::new();
    let mut out: Vec<Classified> = Vec::new();
    for (repo_index, repo) in repos.iter().enumerate() {
        for commit in &repo.commits {
            if !seen.insert((repo_index, commit.hash.clone())) {
                continue;
            }
            let is_merge = commit.is_merge();
            let matched = developers.iter().position(|developer| {
                developer
                    .aliases
                    .iter()
                    .any(|alias| matches_alias(alias, &commit.author_name, &commit.author_email))
            });
            // 命中多个开发人员：按配置顺序取首个（确定性优于「智能」分配）
            if matched.is_some() && developers.len() > 1 {
                let hits = developers
                    .iter()
                    .filter(|developer| {
                        developer.aliases.iter().any(|alias| {
                            matches_alias(alias, &commit.author_name, &commit.author_email)
                        })
                    })
                    .count();
                if hits > 1 {
                    let key = format!("{}/{}", repo.key, commit.hash);
                    let message = format!("提交 {key} 同时命中多个开发人员，已按配置顺序取首个");
                    if !warnings.contains(&message) {
                        warnings.push(message);
                    }
                }
            }
            let counted = request.include_merges || !is_merge;
            out.push(Classified {
                repo_index,
                kind: classify_kind_with(kinds, &commit.subject, &commit.message),
                is_merge,
                counted,
                developer: if counted { matched } else { None },
                modules: Vec::new(),
                commit: commit.clone(),
            });
        }
    }
    out
}

/// 详情补全：逐提交拉行数与文件路径（GitHub 一次调用两者都拿；GitLab 只拿路径，行数来自列表）。
/// 多线程限流 + 时间预算；单条失败只告警不中断。
/// 返回 (提交下标 → (行数, 模块路径), 是否因时间预算截断)
fn fetch_details(
    jobs: &[(usize, Forge, String, String, String)],
) -> (HashMap<usize, (Option<CommitStats>, Vec<String>)>, bool) {
    let next = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let results: Mutex<HashMap<usize, (Option<CommitStats>, Vec<String>)>> =
        Mutex::new(HashMap::new());
    let started = Instant::now();
    let workers = DETAIL_WORKERS.min(jobs.len()).max(1);
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= jobs.len() {
                    break;
                }
                if started.elapsed() >= Duration::from_secs(DETAIL_TIME_BUDGET_SECS) {
                    truncated.store(true, Ordering::Relaxed);
                    break;
                }
                let (position, platform, url, token, hash) = &jobs[index];
                match forge::commit_detail(*platform, url, token, hash) {
                    Ok(detail) => {
                        if let Ok(mut map) = results.lock() {
                            map.insert(*position, detail);
                        }
                    }
                    Err(error) => {
                        log::warn!("提交 {hash} 详情拉取失败，按无行数/无模块处理：{error}")
                    }
                }
            });
        }
    });
    (
        results.into_inner().unwrap_or_default(),
        truncated.load(Ordering::Relaxed),
    )
}
/// 聚合（纯函数，脱网可测）：把归类结果组装成前端需要的报告结构
fn build_result(
    request: &ReportRequest,
    repos: &[RepoFetch],
    classified: Vec<Classified>,
    developers: Vec<GitDeveloper>,
    kinds: Vec<GitKindRule>,
    module_truncated: bool,
    mut warnings: Vec<String>,
) -> ReportResult {
    #[derive(Default)]
    struct Acc {
        commits: usize,
        additions: u64,
        deletions: u64,
        merge_commits: usize,
        days: HashSet<String>,
        by_type: HashMap<String, usize>,
        by_repo: HashMap<String, usize>,
        by_module: HashMap<String, usize>,
        /// 本地日期 → 提交数（BTreeMap 保证按日期升序）
        by_day: BTreeMap<String, usize>,
        /// 本地小时 "00".."23" → 提交数
        by_hour: BTreeMap<String, usize>,
        first: Option<(i64, String)>,
        last: Option<(i64, String)>,
    }

    let mut repo_reports: Vec<RepoReport> = repos
        .iter()
        .map(|repo| RepoReport {
            key: repo.key.clone(),
            label: repo.label.clone(),
            url: repo.url.clone(),
            forge: repo.forge.key().to_string(),
            // GitHub 列表接口不带 sha 时只覆盖默认分支，界面需要如实标注
            default_branch_only: repo.forge == Forge::Github,
            status: repo.status.clone(),
            error: repo.error.clone(),
            fetched_count: repo.commits.len(),
            ..Default::default()
        })
        .collect();

    let mut accounts: Vec<Acc> = (0..developers.len()).map(|_| Acc::default()).collect();
    // 未归类提交人：按「姓名 + 邮箱」聚合
    let mut unmatched: HashMap<(String, String), (usize, String)> = HashMap::new();
    // 团队活跃天数：按本地自然日去重（个人活跃天数不能相加，会重复计同一天）
    let mut team_days: HashSet<String> = HashSet::new();
    // 行数统计覆盖度：全部有 → available；部分有 → partial（GitHub 超限或个别详情失败）
    let mut stats_count = 0usize;
    let mut counted_total = 0usize;
    let mut commits: Vec<ReportCommit> = Vec::new();
    let mut truncated_repo = false;

    for repo in repos {
        truncated_repo |= repo.truncated;
    }

    for item in classified {
        // 先克隆仓库标识：后面要对 repo_reports 做 get_mut，不能再持有它的不可变借用
        let (repo_key, repo_label, repo_url, repo_forge) = {
            let repo = &repo_reports[item.repo_index];
            let platform = if repo.forge == Forge::Github.key() {
                Forge::Github
            } else {
                Forge::Gitlab
            };
            (repo.key.clone(), repo.label.clone(), repo.url.clone(), platform)
        };
        let stats = item.commit.stats;
        if !item.counted {
            // 合并提交仍计入仓库维度的「合并提交数」，但不进人员统计
            if let Some(target) = repo_reports.get_mut(item.repo_index) {
                target.merge_count += 1;
            }
            continue;
        }
        counted_total += 1;
        if stats.is_some() {
            stats_count += 1;
        }
        if let Some(target) = repo_reports.get_mut(item.repo_index) {
            target.commit_count += 1;
            if item.is_merge {
                target.merge_count += 1;
            }
            if let Some(stats) = &stats {
                target.additions += stats.additions;
                target.deletions += stats.deletions;
            }
        }
        let secs = parse_iso_to_epoch_secs(&item.commit.date).unwrap_or(0);
        match item.developer {
            Some(index) => {
                let acc = &mut accounts[index];
                acc.commits += 1;
                if item.is_merge {
                    acc.merge_commits += 1;
                }
                if let Some(stats) = &stats {
                    acc.additions += stats.additions;
                    acc.deletions += stats.deletions;
                }
                let day = local_day(&item.commit.date, request.tz_offset_minutes);
                team_days.insert(day.clone());
                acc.days.insert(day.clone());
                *acc.by_day.entry(day).or_default() += 1;
                *acc.by_hour
                    .entry(local_hour(&item.commit.date, request.tz_offset_minutes))
                    .or_default() += 1;
                *acc.by_type.entry(item.kind.clone()).or_default() += 1;
                *acc.by_repo.entry(repo_key.clone()).or_default() += 1;
                for module in &item.modules {
                    let normalized = module.trim().replace('\\', "/");
                    let key = match normalized.split_once('/') {
                        Some((first, _)) if !first.is_empty() => first.to_string(),
                        _ => "根目录".to_string(),
                    };
                    *acc.by_module.entry(key).or_default() += 1;
                }
                if acc.first.as_ref().is_none_or(|(at, _)| secs < *at) {
                    acc.first = Some((secs, item.commit.date.clone()));
                }
                if acc.last.as_ref().is_none_or(|(at, _)| secs > *at) {
                    acc.last = Some((secs, item.commit.date.clone()));
                }
                commits.push(ReportCommit {
                    repo_key: repo_key.clone(),
                    repo_label: repo_label.clone(),
                    hash: item.commit.hash.clone(),
                    short_hash: short_hash(&item.commit.hash),
                    subject: if item.commit.subject.trim().is_empty() {
                        item.commit.message.lines().next().unwrap_or("").to_string()
                    } else {
                        item.commit.subject.clone()
                    },
                    author_name: item.commit.author_name.clone(),
                    author_email: item.commit.author_email.clone(),
                    committer_name: item.commit.committer_name.clone(),
                    date: item.commit.date.clone(),
                    developer_id: developers[index].id.clone(),
                    developer_name: developers[index].name.clone(),
                    kind: item.kind.clone(),
                    is_merge: item.is_merge,
                    additions: stats.map(|value| value.additions),
                    deletions: stats.map(|value| value.deletions),
                    modules: item.modules.clone(),
                    web_url: web_url_for(repo_forge, &repo_url, &item.commit),
                });
            }
            None => {
                let key = (
                    item.commit.author_name.trim().to_string(),
                    item.commit.author_email.trim().to_string(),
                );
                let entry = unmatched
                    .entry(key)
                    .or_insert_with(|| (0, item.commit.date.clone()));
                entry.0 += 1;
                if secs > parse_iso_to_epoch_secs(&entry.1).unwrap_or(0) {
                    entry.1 = item.commit.date.clone();
                }
            }
        }
    }

    let unmatched_total = unmatched.len();
    let mut unmatched_list: Vec<UnmatchedAuthor> = unmatched
        .into_iter()
        .map(|((name, email), (commits, last_at))| UnmatchedAuthor {
            name,
            email,
            commits,
            last_at,
        })
        .collect();
    unmatched_list.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.email.cmp(&b.email)));
    unmatched_list.truncate(MAX_UNMATCHED);

    // 明细按提交时间倒序；超出上限时截断并告警
    commits.sort_by(|a, b| b.date.cmp(&a.date).then_with(|| b.hash.cmp(&a.hash)));
    let commits_truncated = commits.len() > MAX_REPORT_COMMITS;
    if commits_truncated {
        warnings.push(format!(
            "提交明细只展示最近 {} 条，完整统计仍按全部提交计算",
            MAX_REPORT_COMMITS
        ));
        commits.truncate(MAX_REPORT_COMMITS);
    }

    let developers_out: Vec<DeveloperReport> = developers
        .iter()
        .zip(accounts)
        .map(|(developer, acc)| DeveloperReport {
            id: developer.id.clone(),
            name: developer.name.clone(),
            commits: acc.commits,
            merge_commits: acc.merge_commits,
            additions: acc.additions,
            deletions: acc.deletions,
            active_days: acc.days.len(),
            by_type: count_items(acc.by_type),
            by_repo: count_items(acc.by_repo),
            by_module: count_items(acc.by_module),
            by_day: count_items_sorted(acc.by_day),
            by_hour: count_items_sorted(acc.by_hour),
            first_at: acc.first.map(|(_, at)| at).unwrap_or_default(),
            last_at: acc.last.map(|(_, at)| at).unwrap_or_default(),
        })
        .collect();

    ReportResult {
        generated_at: now_ms(),
        since: request.since.clone(),
        until: request.until.clone(),
        repos: repo_reports,
        developers: developers_out,
        kinds,
        unmatched: unmatched_list,
        unmatched_total,
        active_days: team_days.len(),
        stats_available: stats_count > 0,
        stats_partial: stats_count > 0 && stats_count < counted_total,
        module_stats: request.module_stats,
        module_stats_truncated: request.module_stats && module_truncated,
        commits_truncated,
        truncated: truncated_repo,
        warnings,
        commits,
    }
}

/// 提交网页地址：优先用接口返回的 web_url（GitHub 的 html_url 同字段），缺失时按平台兜底拼装
fn web_url_for(platform: Forge, repo_url: &str, commit: &ForgeCommit) -> String {
    if !commit.web_url.trim().is_empty() {
        return commit.web_url.trim().to_string();
    }
    forge::commit_web_url(platform, repo_url, &commit.hash)
}

/// BTreeMap（已按 key 升序）→ 计数项列表，保持升序（日期 / 小时）
fn count_items_sorted(counter: BTreeMap<String, usize>) -> Vec<CountItem> {
    counter
        .into_iter()
        .map(|(key, count)| CountItem { key, count })
        .collect()
}

fn count_items(counter: HashMap<String, usize>) -> Vec<CountItem> {
    let mut items: Vec<CountItem> = counter
        .into_iter()
        .map(|(key, count)| CountItem { key, count })
        .collect();
    items.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.key.cmp(&b.key)));
    items
}

/// 归类表归一化：只取当前项目的记录、别名去空白去重去空项；空 id 的记录直接丢弃。
fn normalize_developers(project_id: &str, developers: &[GitDeveloper]) -> Vec<GitDeveloper> {
    let project = project_id.trim();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for developer in developers {
        let id = developer.id.trim().to_string();
        if id.is_empty() || !seen_ids.insert(id.clone()) {
            continue;
        }
        // projectId 为空视为全局（兼容手工构造的请求）；非空且不匹配则跳过
        let owner = developer.project_id.trim();
        if !project.is_empty() && !owner.is_empty() && owner != project {
            continue;
        }
        let mut seen_alias: HashSet<String> = HashSet::new();
        let mut aliases = Vec::new();
        for alias in &developer.aliases {
            let value = alias.trim().to_string();
            if value.is_empty() || !seen_alias.insert(value.to_lowercase()) {
                continue;
            }
            aliases.push(value);
        }
        out.push(GitDeveloper {
            id,
            project_id: owner.to_string(),
            name: if developer.name.trim().is_empty() {
                "未命名".to_string()
            } else {
                developer.name.trim().to_string()
            },
            aliases,
        });
    }
    out
}

/// 颜色回退调色板（规则颜色非法时按序号轮转）
const KIND_FALLBACK_COLORS: [&str; 8] = [
    "#3b82f6", "#ef4444", "#8b5cf6", "#10b981", "#f59e0b", "#0ea5e9", "#ec4899", "#64748b",
];

/// 类型规则归一化：只取当前项目的规则；一条都没有时用内置默认（并归属到该项目，
/// 便于前端直接把生效规则拿来编辑）。key 去重去空，label/color 兜底，关键词去空白去重。
fn normalize_kinds(project_id: &str, rules: &[GitKindRule]) -> Vec<GitKindRule> {
    let project = project_id.trim();
    let scoped: Vec<&GitKindRule> = rules
        .iter()
        .filter(|rule| {
            let owner = rule.project_id.trim();
            project.is_empty() || owner.is_empty() || owner == project
        })
        .collect();
    if scoped.is_empty() {
        return default_kind_rules()
            .into_iter()
            .map(|mut rule| {
                rule.project_id = project.to_string();
                rule
            })
            .collect();
    }
    let mut seen_keys: HashSet<String> = HashSet::new();
    let mut out: Vec<GitKindRule> = Vec::new();
    for (index, rule) in scoped.iter().enumerate() {
        let key = rule.key.trim().to_string();
        if key.is_empty() || !seen_keys.insert(key.to_lowercase()) {
            continue;
        }
        let mut seen_keywords: HashSet<String> = HashSet::new();
        let mut keywords = Vec::new();
        for keyword in &rule.keywords {
            let value = keyword.trim().to_string();
            if value.is_empty() || !seen_keywords.insert(value.to_lowercase()) {
                continue;
            }
            keywords.push(value);
        }
        out.push(GitKindRule {
            id: if rule.id.trim().is_empty() {
                format!("kind-{key}")
            } else {
                rule.id.trim().to_string()
            },
            project_id: project.to_string(),
            key,
            label: if rule.label.trim().is_empty() {
                rule.key.trim().to_string()
            } else {
                rule.label.trim().to_string()
            },
            color: normalize_kind_color(&rule.color, index),
            keywords,
            enabled: rule.enabled,
        });
    }
    // 所有规则的 key 都为空时回退默认，避免整页类型都变成「其它」
    if out.is_empty() {
        return default_kind_rules()
            .into_iter()
            .map(|mut rule| {
                rule.project_id = project.to_string();
                rule
            })
            .collect();
    }
    out
}

/// 颜色归一化：只有 `#rrggbb` 保留，其余回退调色板（按规则序号轮转）
fn normalize_kind_color(value: &str, index: usize) -> String {
    let color = value.trim();
    let valid = color.len() == 7
        && color.starts_with('#')
        && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if valid {
        color.to_string()
    } else {
        KIND_FALLBACK_COLORS[index % KIND_FALLBACK_COLORS.len()].to_string()
    }
}

fn short_hash(hash: &str) -> String {
    hash.chars().take(7).collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(id: &str, title: &str, date: &str, name: &str, email: &str) -> ForgeCommit {
        ForgeCommit {
            hash: id.to_string(),
            subject: title.to_string(),
            message: title.to_string(),
            author_name: name.to_string(),
            author_email: email.to_string(),
            committer_name: name.to_string(),
            committer_email: email.to_string(),
            date: date.to_string(),
            parent_ids: vec!["p1".to_string()],
            web_url: format!("https://gitlab.test/group/proj/-/commit/{id}"),
            stats: Some(CommitStats {
                additions: 10,
                deletions: 2,
            }),
        }
    }

    fn developer(id: &str, name: &str, aliases: &[&str]) -> GitDeveloper {
        GitDeveloper {
            id: id.to_string(),
            project_id: "p1".to_string(),
            name: name.to_string(),
            aliases: aliases.iter().map(|value| value.to_string()).collect(),
        }
    }

    fn request() -> ReportRequest {
        ReportRequest {
            project_id: "p1".into(),
            since: "2026-08-01T00:00:00Z".into(),
            until: "2026-08-31T23:59:59Z".into(),
            tz_offset_minutes: 480,
            repos: vec![
                ReportRepoRequest {
                    key: "frontend".into(),
                    label: "前端".into(),
                    url: "https://gitlab.test/group/web".into(),
                    token: "t".into(),
                },
                ReportRepoRequest {
                    key: "backend".into(),
                    label: "后端".into(),
                    url: "https://gitlab.test/group/server".into(),
                    token: "t".into(),
                },
            ],
            developers: vec![],
            kinds: vec![],
            include_merges: false,
            module_stats: false,
        }
    }

    fn repo_fetch(key: &str, label: &str, commits: Vec<ForgeCommit>) -> RepoFetch {
        RepoFetch {
            key: key.into(),
            label: label.into(),
            url: format!("https://gitlab.test/group/{key}"),
            token: "t".into(),
            forge: Forge::Gitlab,
            status: "ok".into(),
            error: String::new(),
            commits,
            truncated: false,
        }
    }

    #[test]
    fn alias_matching_email_name_glob_and_case() {
        // 邮箱别名：只匹配邮箱，大小写不敏感
        assert!(matches_alias("Dev@Corp.com", "张三", "dev@corp.com"));
        assert!(!matches_alias("dev@corp.com", "dev@corp.com", "other@corp.com"));
        // 姓名别名：只匹配姓名
        assert!(matches_alias("  张三  ", "张三", "z@corp.com"));
        assert!(!matches_alias("张三", "李四", "zhang@corp.com"));
        // 通配
        assert!(matches_alias("*@corp.com", "任意", "a@corp.com"));
        assert!(matches_alias("张*", "张三丰", "z@corp.com"));
        assert!(!matches_alias("张*", "李三丰", "z@corp.com"));
        // 空值不匹配
        assert!(!matches_alias("", "张三", "z@corp.com"));
        assert!(!matches_alias("张三", "", ""));
    }

    #[test]
    fn classify_kind_conventional_chinese_and_fallback() {
        assert_eq!(classify_kind("feat(ui): 新增日期选择器", ""), "feat");
        assert_eq!(classify_kind("fix!: 修复登录死循环", ""), "fix");
        assert_eq!(classify_kind("refactor: 抽取校验逻辑", ""), "refactor");
        assert_eq!(classify_kind("docs: 使用说明", ""), "docs");
        assert_eq!(classify_kind("chore(deps): bump vite", ""), "chore");
        assert_eq!(classify_kind("revert: 回滚发布", ""), "revert");
        // 无前缀：中文关键词
        assert_eq!(classify_kind("修复看板筛选条件丢失", ""), "fix");
        assert_eq!(classify_kind("新增导出能力", ""), "feat");
        assert_eq!(classify_kind("统一请求拦截器", ""), "refactor");
        // 标题无信息 → 看正文
        assert_eq!(classify_kind("update", "修复若干问题"), "fix");
        // 都没有 → 兜底 other（前端显示「其它」）
        assert_eq!(classify_kind("update", "misc"), OTHER_KIND);
        // 非 ASCII 前缀（中文标题里的「修复：」）不算 conventional 前缀，走关键词
        assert_eq!(classify_kind("修复：登录死循环", ""), "fix");
    }

    /// 自定义类型规则：顺序即优先级、可改关键词、可禁用、前缀优先于关键词
    #[test]
    fn classify_kind_with_project_rules() {
        let rules = vec![
            GitKindRule {
                id: "k1".into(),
                project_id: "p1".into(),
                key: "perf".into(),
                label: "性能".into(),
                color: "#f59e0b".into(),
                keywords: vec!["卡顿".into(), "perf".into()],
                enabled: true,
            },
            GitKindRule {
                id: "k2".into(),
                project_id: "p1".into(),
                key: "feat".into(),
                label: "需求".into(),
                color: "#3b82f6".into(),
                keywords: vec!["需求".into()],
                enabled: true,
            },
            GitKindRule {
                id: "k3".into(),
                project_id: "p1".into(),
                key: "legacy".into(),
                label: "历史".into(),
                color: "#64748b".into(),
                keywords: vec!["legacy".into()],
                enabled: false,
            },
        ];
        // 自定义关键词命中
        assert_eq!(classify_kind_with(&rules, "解决列表卡顿问题", ""), "perf");
        assert_eq!(classify_kind_with(&rules, "需求：新增导出", ""), "feat");
        // conventional 前缀优先于关键词：标题写 feat，即使正文含「卡顿」也算 feat
        assert_eq!(classify_kind_with(&rules, "feat: 列表优化", "修复卡顿"), "feat");
        // 前缀词命中规则 key（大小写不敏感）
        assert_eq!(classify_kind_with(&rules, "PERF: 提速", ""), "perf");
        // 禁用规则不参与匹配
        assert_eq!(classify_kind_with(&rules, "legacy 代码清理", ""), OTHER_KIND);
        // 未配置规则 → 全部 other
        assert_eq!(classify_kind_with(&[], "feat: 新增", ""), OTHER_KIND);
    }

    /// 类型匹配忽略大小写：前缀、规则 key、关键词三条路径，且不影响词边界判定
    #[test]
    fn kind_matching_ignores_case() {
        // 默认词表：前缀大小写混写都命中
        assert_eq!(classify_kind("FEAT: 新增导出", ""), "feat");
        assert_eq!(classify_kind("Feat(ui)!: 组件", ""), "feat");
        assert_eq!(classify_kind("FIX: 修复", ""), "fix");
        // 关键词大小写混写都命中
        assert_eq!(classify_kind("修复 BUG 列表", ""), "fix");
        assert_eq!(classify_kind("CI PIPELINE 失败", ""), "ci");
        // 词边界不受大小写影响："SPECIAL" 里的 "ci" 仍不算命中
        assert_eq!(classify_kind("SPECIAL 处理", ""), OTHER_KIND);
        // 自定义规则：key 带首尾空白 + 大小写混写、关键词大写，都能命中；返回值 trim 但保留配置大小写
        let rules = vec![GitKindRule {
            id: "k".into(),
            project_id: "p1".into(),
            key: "  Feat  ".into(),
            label: "需求".into(),
            color: "#3b82f6".into(),
            keywords: vec!["新增".into(), "FEATURE".into()],
            enabled: true,
        }];
        assert_eq!(classify_kind_with(&rules, "feat: x", ""), "Feat");
        assert_eq!(classify_kind_with(&rules, "FEAT(ui): x", ""), "Feat");
        assert_eq!(classify_kind_with(&rules, "新增导出", ""), "Feat");
        assert_eq!(classify_kind_with(&rules, "feature 支持", ""), "Feat");
        assert_eq!(classify_kind_with(&rules, "FEATURE 支持", ""), "Feat");
        assert_eq!(classify_kind_with(&rules, "无关内容", ""), OTHER_KIND);
    }

    /// ASCII 关键词按词边界匹配，避免 "ci" 命中 "special"；中文关键词按子串
    #[test]
    fn keyword_matching_uses_word_boundary_for_ascii() {
        let rules = vec![ci_rule()];
        assert_eq!(classify_kind_with(&rules, "ci: 修复流水线", ""), "ci");
        assert_eq!(classify_kind_with(&rules, "add CI pipeline", ""), "ci");
        // "special" 里的 "ci" 不算命中
        assert_eq!(classify_kind_with(&rules, "special 处理", ""), OTHER_KIND);
        // 中文关键词子串匹配
        let rules = vec![GitKindRule {
            id: "k".into(),
            project_id: "p1".into(),
            key: "fix".into(),
            label: "修复".into(),
            color: "#ef4444".into(),
            keywords: vec!["修复".into()],
            enabled: true,
        }];
        assert_eq!(classify_kind_with(&rules, "紧急修复线上问题", ""), "fix");
        assert!(contains_keyword("修复登录", "修复"));
        assert!(!contains_keyword("special", "ci"));
        assert!(contains_keyword("add ci pipeline", "ci"));
        assert!(contains_keyword("CI", "ci"));
        assert!(!contains_keyword("", "ci"));
    }

    fn ci_rule() -> GitKindRule {
        GitKindRule {
            id: "k-ci".into(),
            project_id: "p1".into(),
            key: "ci".into(),
            label: "CI".into(),
            color: "#6366f1".into(),
            keywords: vec!["ci".into(), "pipeline".into()],
            enabled: true,
        }
    }

    /// 生效规则归一化：项目隔离、key 去重、颜色兜底、空配置回默认
    #[test]
    fn normalize_kinds_scopes_dedupes_and_falls_back() {
        let defaults = normalize_kinds("p1", &[]);
        assert_eq!(defaults.len(), default_kind_rules().len());
        assert!(defaults.iter().all(|rule| rule.project_id == "p1"));

        let rules = vec![
            GitKindRule {
                id: "k1".into(),
                project_id: "p1".into(),
                key: " feat ".into(),
                label: " 需求 ".into(),
                color: "not-a-color".into(),
                keywords: vec![" 新增 ".into(), "新增".into(), "".into()],
                enabled: true,
            },
            GitKindRule {
                id: "k2".into(),
                project_id: "p1".into(),
                key: "FEAT".into(),
                label: "重复 key".into(),
                color: "#123456".into(),
                keywords: vec![],
                enabled: true,
            },
            GitKindRule {
                id: "k3".into(),
                project_id: "p2".into(),
                key: "other-project".into(),
                label: "别的项目".into(),
                color: "#abcdef".into(),
                keywords: vec![],
                enabled: true,
            },
        ];
        let out = normalize_kinds("p1", &rules);
        assert_eq!(out.len(), 1, "重复 key 与其它项目的规则被剔除");
        assert_eq!(out[0].key, "feat");
        assert_eq!(out[0].label, "需求");
        assert_eq!(out[0].color, KIND_FALLBACK_COLORS[0], "非法颜色回退调色板");
        assert_eq!(out[0].keywords, vec!["新增".to_string()]);
    }

    /// 本地小时分桶（东八区）与每日分桶
    #[test]
    fn local_hour_and_day_buckets() {
        assert_eq!(local_hour("2026-08-05T02:30:00Z", 480), "10");
        assert_eq!(local_hour("2026-08-05T16:30:00Z", 480), "00", "跨日归零");
        assert_eq!(local_hour("not-a-date", 480), "00");
        assert_eq!(local_hour("2026-08-05T23:30:00Z", -480), "15");
    }

    #[test]
    fn local_day_uses_client_offset() {
        // UTC 16:30 在东八区已是次日
        assert_eq!(local_day("2026-08-04T16:30:00Z", 480), "2026-08-05");
        assert_eq!(local_day("2026-08-04T16:30:00Z", 0), "2026-08-04");
        // 带偏移后缀的写法等价于换算到 UTC
        assert_eq!(local_day("2026-08-05T00:30:00+08:00", 480), "2026-08-05");
        // 跨月 / 跨年
        assert_eq!(local_day("2026-12-31T20:00:00Z", 480), "2027-01-01");
        assert_eq!(local_day("2028-02-29T12:00:00Z", 0), "2028-02-29");
        // 脏数据退化：取前 10 位而不是报错
        assert_eq!(local_day("not-a-date", 480), "not-a-date");
    }

    #[test]
    fn top_modules_aggregates_and_folds_rest() {
        let paths: Vec<String> = (0..9)
            .map(|index| format!("mod{index}/a.ts"))
            .chain(["README.md".to_string()])
            .collect();
        let items = top_modules(&paths);
        // 9 个模块 + 根目录 = 10 项 → 截断为 8 项 + 「其它」
        assert_eq!(items.len(), TOP_MODULES + 1);
        assert_eq!(items.last().unwrap().key, "其它");
        assert_eq!(items.last().unwrap().count, 2);
        assert_eq!(
            top_modules(&["src/a.ts".into(), "src/b.ts".into(), "docs/x.md".into()]),
            vec![
                CountItem { key: "src".into(), count: 2 },
                CountItem { key: "docs".into(), count: 1 },
            ]
        );
    }

    #[test]
    fn build_result_groups_by_developer_and_dedupes() {
        let request = ReportRequest {
            developers: vec![
                developer("d1", "田旭东", &["tian@corp.com", "田*"]),
                developer("d2", "杨国超", &["yang@corp.com"]),
            ],
            ..request()
        };
        let repos = vec![
            repo_fetch(
                "frontend",
                "前端",
                vec![
                    commit("a1", "feat: 组件", "2026-08-03T02:00:00Z", "田旭东", "tian@corp.com"),
                    commit("a2", "fix: 修复", "2026-08-03T10:00:00Z", "田旭东", "old@corp.com"),
                    commit("a3", "chore: 清理", "2026-08-04T02:00:00Z", "杨国超", "yang@corp.com"),
                    commit("a4", "feat: 未知人", "2026-08-04T03:00:00Z", "路人甲", "passer@corp.com"),
                ],
            ),
            repo_fetch(
                "backend",
                "后端",
                vec![commit("b1", "feat: 接口", "2026-08-05T02:00:00Z", "田旭东", "tian@corp.com")],
            ),
        ];
        let developers = normalize_developers("p1", &request.developers);
        let mut warnings = Vec::new();
        let kinds = normalize_kinds("p1", &request.kinds);
        let classified = classify(&request, &repos, &developers, &kinds, &mut warnings);
        let result = build_result(&request, &repos, classified, developers, kinds, false, warnings);

        assert_eq!(result.developers.len(), 2);
        let tian = &result.developers[0];
        // 姓名通配「田*」把 old@corp.com 也算到田旭东名下
        assert_eq!(tian.commits, 3);
        assert_eq!(tian.additions, 30);
        assert_eq!(tian.active_days, 2);
        assert_eq!(tian.by_repo.len(), 2);
        // 每日 / 每小时分桶（东八区）：a1 08-03 10:00、a2 08-03 18:00、b1 08-05 10:00
        assert_eq!(
            tian.by_day,
            vec![
                CountItem { key: "2026-08-03".into(), count: 2 },
                CountItem { key: "2026-08-05".into(), count: 1 },
            ]
        );
        assert_eq!(
            tian.by_hour,
            vec![
                CountItem { key: "10".into(), count: 2 },
                CountItem { key: "18".into(), count: 1 },
            ]
        );
        let yang = &result.developers[1];
        assert_eq!(yang.commits, 1);
        // 未归类提交人单独聚合
        assert_eq!(result.unmatched_total, 1);
        assert_eq!(result.unmatched[0].name, "路人甲");
        assert_eq!(result.unmatched[0].commits, 1);
        // 明细只含已归类提交，按时间倒序
        assert_eq!(result.commits.len(), 4);
        assert_eq!(result.commits[0].hash, "b1");
        assert_eq!(result.commits[0].developer_name, "田旭东");
        assert!(result.commits[0].web_url.contains("/-/commit/b1"));
        assert!(result.stats_available);
        // 仓库维度统计
        assert_eq!(result.repos[0].commit_count, 3);
        assert_eq!(result.repos[0].fetched_count, 4);
        assert_eq!(result.repos[1].commit_count, 1);
    }

    #[test]
    fn build_result_excludes_merges_by_default_and_can_include() {
        let mut merge = commit("m1", "Merge branch 'feature'", "2026-08-06T02:00:00Z", "田旭东", "tian@corp.com");
        merge.parent_ids = vec!["p1".into(), "p2".into()];
        let repos = vec![repo_fetch(
            "frontend",
            "前端",
            vec![
                commit("c1", "feat: 组件", "2026-08-05T02:00:00Z", "田旭东", "tian@corp.com"),
                merge.clone(),
            ],
        )];
        let request = ReportRequest {
            developers: vec![developer("d1", "田旭东", &["tian@corp.com"])],
            ..request()
        };
        let developers = normalize_developers("p1", &request.developers);

        let mut warnings = Vec::new();
        let kinds = normalize_kinds("p1", &request.kinds);
        let classified = classify(&request, &repos, &developers, &kinds, &mut warnings);
        let excluded = build_result(
            &request,
            &repos,
            classified,
            developers.clone(),
            kinds.clone(),
            false,
            warnings,
        );
        assert_eq!(excluded.developers[0].commits, 1, "默认排除合并提交");
        assert_eq!(excluded.repos[0].merge_count, 1, "仓库维度仍记录合并提交数");
        assert_eq!(excluded.repos[0].commit_count, 1);

        let with_merges = ReportRequest {
            include_merges: true,
            developers: vec![developer("d1", "田旭东", &["tian@corp.com"])],
            ..request
        };
        let mut warnings = Vec::new();
        let classified = classify(&with_merges, &repos, &developers, &kinds, &mut warnings);
        let included = build_result(&with_merges, &repos, classified, developers, kinds, false, warnings);
        assert_eq!(included.developers[0].commits, 2, "开关打开后合并提交计入");
        assert_eq!(included.repos[0].commit_count, 2);
    }

    #[test]
    fn build_result_survives_repo_error_and_missing_stats() {
        let mut plain = commit("c1", "feat: 组件", "2026-08-05T02:00:00Z", "田旭东", "tian@corp.com");
        plain.stats = None;
        let repos = vec![
            repo_fetch("frontend", "前端", vec![plain]),
            RepoFetch {
                key: "backend".into(),
                label: "后端".into(),
                url: "https://gitlab.test/group/server".into(),
                token: "t".into(),
                forge: Forge::Gitlab,
                status: "error".into(),
                error: "GitLab 请求失败".into(),
                commits: Vec::new(),
                truncated: false,
            },
        ];
        let request = ReportRequest {
            developers: vec![developer("d1", "田旭东", &["tian@corp.com"])],
            ..request()
        };
        let developers = normalize_developers("p1", &request.developers);
        let mut warnings = Vec::new();
        let kinds = normalize_kinds("p1", &request.kinds);
        let classified = classify(&request, &repos, &developers, &kinds, &mut warnings);
        let result = build_result(&request, &repos, classified, developers, kinds, false, warnings);
        // 一个仓库失败不影响另一个仓库出报告
        assert_eq!(result.repos[1].status, "error");
        assert_eq!(result.repos[0].commit_count, 1);
        assert_eq!(result.developers[0].commits, 1);
        // 服务端未返回行数统计：置 false 且明细为 None（前端显示「—」）
        assert!(!result.stats_available);
        assert_eq!(result.commits[0].additions, None);
    }

    /// 平台字段：GitLab 仓库 defaultBranchOnly=false；GitHub 仓库为 true 且 forge 标识正确
    #[test]
    fn build_result_marks_forge_and_default_branch_only() {
        let repos = vec![
            repo_fetch(
                "frontend",
                "前端",
                vec![commit("a1", "feat: x", "2026-08-05T02:00:00Z", "田旭东", "tian@corp.com")],
            ),
            RepoFetch {
                key: "backend".into(),
                label: "后端".into(),
                url: "https://github.test/owner/repo".into(),
                token: "t".into(),
                forge: Forge::Github,
                status: "ok".into(),
                error: String::new(),
                commits: vec![commit("b1", "fix: y", "2026-08-06T02:00:00Z", "田旭东", "tian@corp.com")],
                truncated: false,
            },
        ];
        let request = ReportRequest {
            developers: vec![developer("d1", "田旭东", &["tian@corp.com"])],
            ..request()
        };
        let developers = normalize_developers("p1", &request.developers);
        let kinds = normalize_kinds("p1", &request.kinds);
        let mut warnings = Vec::new();
        let classified = classify(&request, &repos, &developers, &kinds, &mut warnings);
        let result = build_result(&request, &repos, classified, developers, kinds, false, warnings);
        assert_eq!(result.repos[0].forge, "gitlab");
        assert!(!result.repos[0].default_branch_only);
        assert_eq!(result.repos[1].forge, "github");
        assert!(result.repos[1].default_branch_only, "GitHub 只统计默认分支");
        // 两条提交都有行数 → 不标 partial
        assert!(result.stats_available);
        assert!(!result.stats_partial);
    }

    /// 行数只覆盖部分提交（GitHub 逐提交补时超限/失败）→ statsPartial 置位，供前端按「≈」展示
    #[test]
    fn build_result_flags_partial_stats() {
        let mut without_stats = commit("a2", "fix: 缺行数", "2026-08-06T02:00:00Z", "田旭东", "tian@corp.com");
        without_stats.stats = None;
        let repos = vec![repo_fetch(
            "frontend",
            "前端",
            vec![
                commit("a1", "feat: 有行数", "2026-08-05T02:00:00Z", "田旭东", "tian@corp.com"),
                without_stats,
            ],
        )];
        let request = ReportRequest {
            developers: vec![developer("d1", "田旭东", &["tian@corp.com"])],
            ..request()
        };
        let developers = normalize_developers("p1", &request.developers);
        let kinds = normalize_kinds("p1", &request.kinds);
        let mut warnings = Vec::new();
        let classified = classify(&request, &repos, &developers, &kinds, &mut warnings);
        let result = build_result(&request, &repos, classified, developers, kinds, false, warnings);
        assert!(result.stats_available, "至少一条有行数");
        assert!(result.stats_partial, "部分提交缺行数应标注 partial");
        // 缺行数的那条明细为 None（前端显示「—」）
        let missing = result.commits.iter().find(|item| item.hash == "a2").unwrap();
        assert_eq!(missing.additions, None);
    }

    #[test]
    fn build_result_caps_commit_detail_and_unmatched() {
        let mut commits = Vec::new();
        for index in 0..(MAX_REPORT_COMMITS + 10) {
            commits.push(commit(
                &format!("c{index:04}"),
                "feat: 批量",
                &format!("2026-08-05T02:{:02}:00Z", index % 60),
                "田旭东",
                "tian@corp.com",
            ));
        }
        for index in 0..(MAX_UNMATCHED + 5) {
            commits.push(commit(
                &format!("u{index:04}"),
                "chore: 未知",
                "2026-08-06T02:00:00Z",
                &format!("路人{index}"),
                &format!("p{index}@corp.com"),
            ));
        }
        let repos = vec![repo_fetch("frontend", "前端", commits)];
        let request = ReportRequest {
            developers: vec![developer("d1", "田旭东", &["tian@corp.com"])],
            ..request()
        };
        let developers = normalize_developers("p1", &request.developers);
        let mut warnings = Vec::new();
        let kinds = normalize_kinds("p1", &request.kinds);
        let classified = classify(&request, &repos, &developers, &kinds, &mut warnings);
        let result = build_result(&request, &repos, classified, developers, kinds, false, warnings);
        assert_eq!(result.commits.len(), MAX_REPORT_COMMITS);
        assert!(result.commits_truncated);
        assert_eq!(result.developers[0].commits, MAX_REPORT_COMMITS + 10);
        assert_eq!(result.unmatched.len(), MAX_UNMATCHED);
        assert_eq!(result.unmatched_total, MAX_UNMATCHED + 5);
        assert!(result.warnings.iter().any(|item| item.contains("提交明细")));
    }

    #[test]
    fn normalize_developers_scopes_project_and_dedupes_aliases() {
        let list = vec![
            GitDeveloper {
                id: " d1 ".into(),
                project_id: "p1".into(),
                name: " 张三 ".into(),
                aliases: vec![" A@x.com ".into(), "a@x.com".into(), "".into(), "张三".into()],
            },
            GitDeveloper {
                id: "d2".into(),
                project_id: "p2".into(),
                name: "别的项目".into(),
                aliases: vec!["b@x.com".into()],
            },
            GitDeveloper {
                id: "".into(),
                project_id: "p1".into(),
                name: "空 id".into(),
                aliases: vec![],
            },
        ];
        let out = normalize_developers("p1", &list);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "张三");
        // 别名去空白、大小写去重、去空项
        assert_eq!(out[0].aliases, vec!["A@x.com", "张三"]);
    }

    #[test]
    fn fetch_rejects_empty_window_and_too_many_repos() {
        let mut bad = request();
        bad.since = "  ".into();
        assert!(fetch(bad).is_err());

        let mut many = request();
        many.repos = (0..(MAX_REPOS + 1))
            .map(|index| ReportRepoRequest {
                key: format!("r{index}"),
                label: String::new(),
                url: "https://gitlab.test/g/r".into(),
                token: "t".into(),
            })
            .collect();
        assert!(fetch(many).is_err());
    }

    /// 无 Token 的仓库只标记错误，不影响其他仓库（不发起任何网络请求）
    #[test]
    fn fetch_marks_missing_token_repo_as_error() {
        let request = ReportRequest {
            repos: vec![
                ReportRepoRequest {
                    key: "frontend".into(),
                    label: "前端".into(),
                    url: "https://gitlab.test/group/web".into(),
                    token: String::new(),
                },
                ReportRepoRequest {
                    key: "backend".into(),
                    label: "后端".into(),
                    url: String::new(),
                    token: "t".into(),
                },
            ],
            developers: vec![],
            ..request()
        };
        let result = fetch(request).expect("缺 Token 不应整体失败");
        assert_eq!(result.repos.len(), 1, "未配置 URL 的仓库直接跳过");
        assert_eq!(result.repos[0].status, "error");
        assert!(result.repos[0].error.contains("缺少 GitLab Token"));
        assert!(result.warnings.iter().any(|item| item.contains("前端")));
    }
}
