# Triage Labels

技能用五个固定的分诊角色说话。本文件把这些角色映射到本仓库 issue tracker 里实际使用的标签字符串。本仓库 tracker 是 GitHub Issues（见 `docs/agents/issue-tracker.md`），标签字符串与角色名**完全相同**（初始化时确认保留默认）。

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

技能提到某个角色时（例如"打上 AFK-ready 分诊标签"），用这张表右列对应的标签字符串。

## 使用纪律

- 一张票同时只承担一个分诊角色；换角色是**摘掉旧标签 + 打上新标签**，不是叠着挂。
- 只按技能规则打标签：分诊五角色用上面这五个，wayfinder 的票用 `wayfinder:*`（见 `docs/agents/issue-tracker.md`）。**不额外发明或强加别的标签。**
- 上表右列改成你实际用的标签名即可（例如仓库已经在用 `bug:triage` 表示 `needs-triage` 时）；改完技能就打既有标签，不会再建重复标签。
