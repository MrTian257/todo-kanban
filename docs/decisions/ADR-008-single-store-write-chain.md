# ADR-008：前端单一 zustand store + writeChain 串行写 + 外部变更磁盘优先

## 状态
Accepted（重构基线）

## 日期
2026-09-03（todo-git 基线核实）

## 背景
前端状态（projects / todos）面临并发变更源：用户操作（拖拽 / 编辑）、外部变更（MCP 改库、多窗口保存、手动改库）、定时同步（2s 轮询）。曾因并发写乱序与双通道（localStorage + SQLite）漂移产生数据问题。

## 决策
- zustand v5 唯一 useAppStore（9 action + loaded）；视图与数据解耦：页面不直接读 storage / 调 invoke，一切经 store action
- 写链：action 改 state → subscribe → writeChain 串行队列逐个 saveState（桌面 invoke db_save_state；浏览器直接返回）
- 外部感知：startExternalSync 每 2000ms + window focus 立即同步 → 全量重读（后端指纹缓存命中零开销）→ 与内存 JSON 对比 → 不同则磁盘优先整体覆盖
- 拖拽落库必须经 commitOrder / patchTodo action，禁止只改本地状态

## 备选方案

### 多 store / 组件局部状态承载业务数据
- 否决：一致性无全局保障，外部整体覆盖语义无法实现

### react-query 等服务端状态库
- 否决：数据源是本地 SQLite invoke 而非 HTTP，缓存 / 失效语义不匹配

### 内存优先（外部变更提示后合并）
- 否决：合并冲突逻辑复杂；磁盘优先保证外部变更永不丢失（取舍：未保存的本地编辑可能被覆盖）

## 后果
- 组件不得绕过 store 直改状态；评审需守住该边界
- zustand v5 选择器若每次返回新数组（filter() / 无详情时的空数组兜底），React 视为快照恒变会无限重渲染——组件侧须 useShallow（zustand/react/shallow），同栈项目实测教训
- 磁盘优先覆盖只作用于已提交进 store 的状态；编辑中的表单是局部态，提交后才进写链
