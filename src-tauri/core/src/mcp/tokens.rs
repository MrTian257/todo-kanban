//! MCP 鉴权：全局管理 Key + 多 AI Token，只读权限**取严**。
//!
//! 纯函数（不碰数据库），所以传输层与单测都能直接复用同一套判定规则。

use crate::models::{McpSettings, McpToken};

/// 一次成功鉴权的结果。
#[derive(Debug, Clone, PartialEq)]
pub struct Authenticated {
    /// 审计与 change_history.actor 用的主体名（Token 名称 / 「管理 Key」）
    pub actor: String,
    /// 关联的 `McpToken.id`；管理 Key 为空串
    pub token_id: String,
    /// 本次请求生效的只读标记
    pub readonly: bool,
    /// 是否命中的是多 AI Token（管理 Key 为 false）
    pub per_ai_token: bool,
}

/// 校验一次 MCP 请求的授权。
///
/// 规则（顺序即优先级）：
/// 1. 总开关 `enabled=false` → 拒绝（管理 Key 也不能绕过，否则设置页的「禁用」形同虚设）。
/// 2. 未携带 Token → 拒绝并提示怎么传。
/// 3. 命中全局管理 Key → 以管理 Key 身份放行，只读=全局只读。
/// 4. 命中某个**启用**的 AI Token → 以该 AI 身份放行，只读 = 全局只读 **或** 该 Token 只读。
/// 5. 命中但已停用 → 明确提示「已禁用」，方便定位（不降级成「不匹配」）。
/// 6. 都不命中 → 拒绝。
///
/// 只读之所以取严而不是取任一侧：ADR-022 之前的 env/CLI 双来源就是因为
/// 「谁覆盖谁」说不清才出的坑，这里从设计上不给它留歧义空间。
pub fn authenticate(
    settings: &McpSettings,
    tokens: &[McpToken],
    provided: Option<&str>,
) -> Result<Authenticated, String> {
    if !settings.enabled {
        return Err("MCP 已在 todo-kanban 设置页中被禁用，请先在应用中启用".into());
    }
    let Some(candidate) = provided.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(
            "缺少授权 Token：HTTP 用 Authorization: Bearer <token>，stdio 用 --token 或 MCP_TODO_TOKEN"
                .into(),
        );
    };
    if candidate == crate::models::DEFAULT_MCP_TOKEN {
        return Err("旧版默认 Token 已停用，请在 MCP 设置中生成并保存新的随机 Token".into());
    }
    if !settings.token.trim().is_empty() && candidate == settings.token.trim() {
        return Ok(Authenticated {
            actor: "管理 Key".into(),
            token_id: String::new(),
            readonly: settings.readonly,
            per_ai_token: false,
        });
    }
    match tokens.iter().find(|item| item.token == candidate) {
        Some(token) if token.enabled => Ok(Authenticated {
            actor: token.name.clone(),
            token_id: token.id.clone(),
            readonly: settings.readonly || token.readonly,
            per_ai_token: true,
        }),
        Some(token) => Err(format!(
            "Token「{}」已被禁用，请在 todo-kanban 设置 → MCP 集成里重新启用",
            token.name
        )),
        None => Err("授权 Token 不匹配，请在 todo-kanban 设置 → MCP 集成里核对或新建接入 Token".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> McpSettings {
        McpSettings {
            enabled: true,
            readonly: false,
            token: "sk-admin".into(),
        }
    }

    fn token(id: &str, name: &str, readonly: bool, enabled: bool) -> McpToken {
        McpToken {
            id: id.into(),
            name: name.into(),
            token: format!("sk-{id}"),
            readonly,
            enabled,
            created_at: 0,
        }
    }

    #[test]
    fn admin_key_matches_and_reports_actor() {
        let tokens = vec![token("mt-a", "Claude", false, true)];
        let done = authenticate(&settings(), &tokens, Some("sk-admin")).unwrap();
        assert_eq!(done.actor, "管理 Key");
        assert!(done.token_id.is_empty());
        assert!(!done.per_ai_token);
    }

    #[test]
    fn per_ai_token_attributes_actor() {
        let tokens = vec![token("mt-a", "Claude", false, true), token("mt-b", "Cursor", true, true)];
        let done = authenticate(&settings(), &tokens, Some("sk-mt-b")).unwrap();
        assert_eq!(done.actor, "Cursor");
        assert_eq!(done.token_id, "mt-b");
        assert!(done.readonly, "Token 自带只读必须生效");
    }

    #[test]
    fn readonly_is_the_stricter_of_two() {
        let tokens = vec![token("mt-a", "Claude", false, true)];
        // 全局只读 + Token 可写 → 只读
        let global_readonly = McpSettings {
            enabled: true,
            readonly: true,
            token: "sk-admin".into(),
        };
        assert!(authenticate(&global_readonly, &tokens, Some("sk-mt-a"))
            .unwrap()
            .readonly);
        // 全局可写 + Token 只读 → 只读
        let per_token = McpSettings {
            readonly: false,
            ..settings()
        };
        assert!(
            !authenticate(&per_token, &tokens, Some("sk-mt-a"))
                .unwrap()
                .readonly,
            "全局可写 + Token 可写 → 可写"
        );
        let ro_token = vec![token("mt-a", "Claude", true, true)];
        assert!(authenticate(&per_token, &ro_token, Some("sk-mt-a"))
            .unwrap()
            .readonly);
    }

    #[test]
    fn disabled_switch_blocks_everyone_including_admin_key() {
        let off = McpSettings {
            enabled: false,
            ..settings()
        };
        let err = authenticate(&off, &[], Some("sk-admin")).unwrap_err();
        assert!(err.contains("禁用"), "{err}");
    }

    #[test]
    fn missing_blank_and_unknown_tokens_are_rejected() {
        let tokens = vec![token("mt-a", "Claude", false, true)];
        assert!(authenticate(&settings(), &tokens, None)
            .unwrap_err()
            .contains("缺少"));
        assert!(authenticate(&settings(), &tokens, Some("   "))
            .unwrap_err()
            .contains("缺少"));
        assert!(authenticate(&settings(), &tokens, Some("sk-nope"))
            .unwrap_err()
            .contains("不匹配"));
    }

    #[test]
    fn revoked_token_says_revoked_not_mismatch() {
        let tokens = vec![token("mt-a", "Claude", false, false)];
        let err = authenticate(&settings(), &tokens, Some("sk-mt-a")).unwrap_err();
        assert!(err.contains("已被禁用") && err.contains("Claude"), "{err}");
    }

    #[test]
    fn empty_admin_key_does_not_accept_empty_candidate() {
        // 管理 Key 被清空时不能变成「空 Token 即放行」
        let blank = McpSettings {
            token: "  ".into(),
            ..settings()
        };
        assert!(authenticate(&blank, &[], Some("")).is_err());
        assert!(authenticate(&blank, &[], None).is_err());
    }
}
