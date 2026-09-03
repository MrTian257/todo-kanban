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

    #[test]
    fn valid_rule_passes() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![
                step("1", "production", "checkout", "develop"),
                step("2", "develop", "merge", "production"),
            ],
        };
        assert!(validate(&Some(rule)).is_ok());
    }

    #[test]
    fn self_loop_rejected() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![step("1", "production", "checkout", "production")],
        };
        assert!(validate(&Some(rule)).is_err());
    }

    #[test]
    fn unknown_role_rejected() {
        let rule = DbBranchRule {
            enabled: true,
            steps: vec![step("1", "weird", "checkout", "develop")],
        };
        assert!(validate(&Some(rule)).is_err());
    }

    #[test]
    fn disabled_skip() {
        let rule = DbBranchRule {
            enabled: false,
            steps: vec![step("1", "weird", "checkout", "develop")],
        };
        assert!(validate(&Some(rule)).is_ok());
    }
}
