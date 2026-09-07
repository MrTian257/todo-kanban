//! 分支规则校验（保存前兜底，与前端 zod 同规则）。

use crate::error::{AppError, AppResult};
use crate::models::DbBranchRule;

const ROLES: [&str; 5] = ["production", "develop", "test", "preview", "custom"];
const ACTIONS: [&str; 2] = ["checkout", "merge"];

pub fn validate(rule: &Option<DbBranchRule>) -> AppResult<()> {
    if let Some(r) = rule {
        if !r.enabled {
            return Ok(());
        }
        // 分支定义校验：role 枚举 + 不重复 + 启用时名称与编码必填
        let mut defined: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (i, b) in r.branches.iter().enumerate() {
            if !ROLES.contains(&b.role.as_str()) {
                return Err(AppError::invalid(format!(
                    "第 {} 个分支定义：未知角色「{}」",
                    i + 1,
                    b.role
                )));
            }
            if !defined.insert(b.role.as_str()) {
                return Err(AppError::invalid(format!(
                    "第 {} 个分支定义：角色「{}」重复",
                    i + 1,
                    b.role
                )));
            }
            if b.name.trim().is_empty() {
                return Err(AppError::invalid(format!(
                    "第 {} 个分支定义：名称必填",
                    i + 1
                )));
            }
            if b.code.trim().is_empty() {
                return Err(AppError::invalid(format!(
                    "第 {} 个分支定义：分支编码必填",
                    i + 1
                )));
            }
        }
        let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (i, s) in r.steps.iter().enumerate() {
            if !ROLES.contains(&s.from.as_str()) {
                return Err(AppError::invalid(format!(
                    "第 {} 步：未知来源角色「{}」",
                    i + 1,
                    s.from
                )));
            }
            if !ROLES.contains(&s.to.as_str()) {
                return Err(AppError::invalid(format!(
                    "第 {} 步：未知目标角色「{}」",
                    i + 1,
                    s.to
                )));
            }
            if !ACTIONS.contains(&s.action.as_str()) {
                return Err(AppError::invalid(format!(
                    "第 {} 步：未知动作「{}」",
                    i + 1,
                    s.action
                )));
            }
            if s.from == s.to {
                return Err(AppError::invalid(format!(
                    "第 {} 步：来源与目标角色相同（自环步骤）",
                    i + 1
                )));
            }
            if !defined.is_empty() && !defined.contains(&s.from.as_str()) {
                return Err(AppError::invalid(format!(
                    "第 {} 步：来源角色「{}」缺少分支定义",
                    i + 1,
                    s.from
                )));
            }
            if !defined.is_empty() && !defined.contains(&s.to.as_str()) {
                return Err(AppError::invalid(format!(
                    "第 {} 步：目标角色「{}」缺少分支定义",
                    i + 1,
                    s.to
                )));
            }
            if !seen.insert(s.id.as_str()) {
                return Err(AppError::invalid(format!("第 {} 步：步骤 id 重复", i + 1)));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DbBranchRule, DbBranchRuleStep};

    fn step(id: &str, from: &str, action: &str, to: &str) -> DbBranchRuleStep {
        DbBranchRuleStep {
            id: id.into(),
            from: from.into(),
            action: action.into(),
            to: to.into(),
            note: String::new(),
        }
    }

    fn defs(pairs: &[(&str, &str)]) -> Vec<crate::models::DbBranchDef> {
        pairs
            .iter()
            .map(|(role, code)| crate::models::DbBranchDef {
                role: (*role).into(),
                name: (*role).into(),
                code: (*code).into(),
            })
            .collect()
    }

    #[test]
    fn valid_rule_passes() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![
                step("1", "production", "checkout", "develop"),
                step("2", "develop", "merge", "production"),
            ],
            branches: defs(&[("production", "main"), ("develop", "dev")]),
        };
        assert!(validate(&Some(rule)).is_ok());
    }

    #[test]
    fn self_loop_rejected() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![step("1", "production", "checkout", "production")],
            branches: defs(&[("production", "main")]),
        };
        assert!(validate(&Some(rule)).is_err());
    }

    #[test]
    fn unknown_role_rejected() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![step("1", "weird", "checkout", "develop")],
            branches: vec![],
        };
        assert!(validate(&Some(rule)).is_err());
    }

    #[test]
    fn disabled_skip() {
        let rule = DbBranchRule {
            enabled: false,
            steps: vec![step("1", "weird", "checkout", "develop")],
            branches: vec![],
        };
        assert!(validate(&Some(rule)).is_ok());
    }

    #[test]
    fn legacy_rule_without_branches_passes() {
        // 旧数据：无 branches 定义，steps 引用任意角色仍合法（向后兼容）
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![step("1", "production", "checkout", "develop")],
            branches: vec![],
        };
        assert!(validate(&Some(rule)).is_ok());
    }

    #[test]
    fn branch_def_missing_code_rejected() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![],
            branches: vec![crate::models::DbBranchDef {
                role: "production".into(),
                name: "生产".into(),
                code: "  ".into(),
            }],
        };
        assert!(validate(&Some(rule)).is_err());
    }

    #[test]
    fn branch_def_duplicate_role_rejected() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![],
            branches: defs(&[("production", "main"), ("production", "master")]),
        };
        assert!(validate(&Some(rule)).is_err());
    }

    #[test]
    fn step_role_without_def_rejected() {
        // 有定义列表时，steps 引用未定义角色 → 拒绝
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![step("1", "production", "checkout", "test")],
            branches: defs(&[("production", "main")]),
        };
        assert!(validate(&Some(rule)).is_err());
    }
}
