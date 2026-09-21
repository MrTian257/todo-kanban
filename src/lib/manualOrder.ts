/** 手工拖拽排序的通用纯逻辑：资料库（resources）与项目列表（projects）共用同一套语义。 */

export interface ManuallyOrdered {
  id: string;
  sortOrder: number;
  updatedAt: number;
}

/** 展示顺序：手工 sortOrder 升序；同序号（并发新建 / 旧数据）按更新时间新的在前。 */
export function compareManualOrder<T extends ManuallyOrdered>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/** 新增项排在最前：取当前最小 sortOrder - 1，任何筛选视图下都在最前。 */
export function frontSortOrder(items: { sortOrder: number }[]): number {
  if (!items.length) return 0;
  return Math.min(...items.map(item => item.sortOrder)) - 1;
}

/**
 * 拖拽排序：可见项在「原有槽位」之间重排，未显示的项位置不动。
 * 槽位 = 可见项原来的 sortOrder 升序值，按新顺序重新分配；
 * 因此「按标签 / 项目 / 归档状态筛选后拖拽」不会打乱当前筛选之外的项。
 * 只有真正换了槽位的项才刷新 updatedAt（触发后端差异写）。
 */
export function reorderManual<T extends ManuallyOrdered>(
  items: T[],
  orderedVisibleIds: string[],
  now = Date.now(),
): T[] {
  const byId = new Map(items.map(item => [item.id, item]));
  const visible = orderedVisibleIds
    .map(id => byId.get(id))
    .filter((item): item is T => !!item);
  const slots = visible.map(item => item.sortOrder).sort((a, b) => a - b);
  const changes = new Map<string, T>();
  visible.forEach((item, index) => {
    const sortOrder = slots[index];
    if (sortOrder === undefined || item.sortOrder === sortOrder) return;
    changes.set(item.id, { ...item, sortOrder, updatedAt: now });
  });
  if (!changes.size) return items;
  return items.map(item => changes.get(item.id) ?? item);
}
