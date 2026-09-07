# ADR-010：泳道内排序持久化（todos.sort_order，schema v6）

## 状态
Accepted（v2.1 已实施，提交 695d414）

## 日期
2026-09-03

## 背景
泳道内拖拽排序（v2.0.0）初始只改内存渲染顺序、未落库——重载后顺序回到默认（按创建时间），用户手动排列的优先级丢失。

## 决策
todos 新增 sort_order INTEGER NOT NULL DEFAULT 0（schema v5→v6，幂等 ALTER）；泳道内拖拽后按位置分配 0..n 并刷新 updatedAt 落库；加载按 sortOrder 还原，同序按 createdAt 兜底；存量数据按插入顺序（rowid）回填。

## 备选方案

### 前端 localStorage 存排序
- 否决：与「桌面 SQLite 唯一存储」冲突（ADR-003），多窗口 / MCP 视图不一致

### 用 createdAt 编码顺序
- 否决：创建时间是不可变事实，改排序要改写历史时间戳，语义污染

### 分数索引（fractional indexing）
- 否决：单机单用户无并发插队需求，整数重排 0..n 足够且可读

## 后果
- 泳道内每次拖拽触发该泳道待办批量 sortOrder 重写（差异写只更新受影响行，成本可接受）
- sort_order 语义限定「泳道内」：跨泳道移动后按落点位置重新分配
- 与 2s 外部同步协同：外部改库后重载顺序同样按 sortOrder 还原
