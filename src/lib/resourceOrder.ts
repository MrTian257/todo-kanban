import type { LibraryResource } from "./types";

/** 资料展示顺序：手工 sortOrder 升序；同序号（并发新建 / 旧数据）按更新时间新的在前。 */
export function compareResources(a: LibraryResource, b: LibraryResource): number {
  return a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
}

/** 新增资料排在最前：取当前最小 sortOrder - 1，任何筛选视图下都在最前。 */
export function frontSortOrder(resources: LibraryResource[]): number {
  if (!resources.length) return 0;
  return Math.min(...resources.map(resource => resource.sortOrder)) - 1;
}

/**
 * 拖拽排序：可见项在「原有槽位」之间重排，未显示的项位置不动。
 * 槽位 = 可见项原来的 sortOrder 升序值，按新顺序重新分配；
 * 因此「按项目 / 标签筛选后拖拽」不会打乱当前筛选之外的资料。
 * 只有真正换了槽位的项才刷新 updatedAt（触发后端差异写）。
 */
export function reorderResources(
  resources: LibraryResource[],
  orderedVisibleIds: string[],
  now = Date.now(),
): LibraryResource[] {
  const byId = new Map(resources.map(resource => [resource.id, resource]));
  const visible = orderedVisibleIds
    .map(id => byId.get(id))
    .filter((resource): resource is LibraryResource => !!resource);
  const slots = visible.map(resource => resource.sortOrder).sort((a, b) => a - b);
  const changes = new Map<string, LibraryResource>();
  visible.forEach((resource, index) => {
    const sortOrder = slots[index];
    if (sortOrder === undefined || resource.sortOrder === sortOrder) return;
    changes.set(resource.id, { ...resource, sortOrder, updatedAt: now });
  });
  if (!changes.size) return resources;
  return resources.map(resource => changes.get(resource.id) ?? resource);
}
