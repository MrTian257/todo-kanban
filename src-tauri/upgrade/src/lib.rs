//! todo-kanban 数据版本升级链路（独立分包，不依赖 core）。
//! 职责：数据版本常量与判定、逐级迁移执行（事务化）、迁移前硬备份（复制到备份目录）、版本报告。
//! 调用方（core）负责打开连接与建表，本 crate 只做"版本 → 备份 → 迁移 → 报告"的升级编排。

pub mod backup;
pub mod error;
pub mod migration;
pub mod upgrade;
pub mod version;
