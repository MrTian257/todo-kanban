//! todo-kanban-core：纯逻辑库（无 tauri 依赖），可独立单测、可被 MCP server 复用。

pub mod db;
pub mod error;
pub mod models;
pub mod svc;
pub mod tool;
