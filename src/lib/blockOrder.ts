// 块重排的**纯下标运算**（ADR-0001 §6：拖拽只在顶层块序列上发生）。
//
// 与 src/lib/boardOrder.ts 的 reorderLanes 同语义、同写法，理由有两个：
// ① 看板那套「原地放开不改序」的行为已被 scripts/verify-dnd.mjs 场景 6 钉成铁律，块拖拽必须一致；
// ② 把「算下标」和「改源文」分开，前者可以逐条 node 断言（test-block-order.mjs），
//    后者只要保证「未碰块逐字」即可，两件事互不污染。

export interface MoveResult {
  /** 重排后的块下标序列（长度恒等于 count）。 */
  indexes: number[];
  /** 是否真的改变了顺序。false 时调用方**不得**置 dirty、不得发 onChange。 */
  changed: boolean;
}

/**
 * 把第 from 个块移到第 to 个位置（to 以「移除后的目标序列」为准，与 dnd-kit 的 over 索引一致）。
 *
 * 越界一律钳制到 [0, count-1]；count<=1、from 越界、from===to 都返回原序且 changed=false。
 */
export function moveTopLevelIndex(count: number, from: number, to: number): MoveResult {
  const identity = Array.from({ length: Math.max(0, count) }, (_, i) => i);
  if (count <= 1) return { indexes: identity, changed: false };
  if (from < 0 || from >= count) return { indexes: identity, changed: false };
  const target = Math.max(0, Math.min(to, count - 1));
  if (target === from) return { indexes: identity, changed: false };
  const next = [...identity];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return { indexes: next, changed: next.some((value, i) => value !== identity[i]) };
}

/**
 * 落点合法性：ADR-0001 §6 只允许「顶层块与块之间的间隙」，不存在拖进列表项/表格单元格/代码块内部。
 * 列表树、表格、代码块、公式、透明块都**不可分隔**——拖到它们内部时吸附到其前或后边界。
 *
 * 返回吸附后的顶层下标（0..count 表示插在第几个块之前）。
 */
export function snapToTopLevelGap(count: number, rawIndex: number): number {
  return Math.max(0, Math.min(rawIndex, count));
}
