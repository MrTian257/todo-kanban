/** 仅比较状态中的普通 JSON 数据；共享引用直接跳过，避免生成整份 JSON 字符串。 */
export function sameStateValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameStateValue(value, right[index]));
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  // JSON 对象中的 undefined 字段不会传到后端。
  const keys = Object.keys(a).filter(key => a[key] !== undefined);
  return keys.length === Object.keys(b).filter(key => b[key] !== undefined).length
    && keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameStateValue(a[key], b[key]));
}

function keepArray<T>(previous: T[], next: T[]): T[] {
  return previous.length === next.length && previous.every((item, index) => item === next[index]) ? previous : next;
}

/** 保存期间新增、删除或再次编辑的本地记录优先；未变记录才接收后端字段。 */
export function rebaseRecords<T extends { id: string }>(latest: T[], sent: T[], returned: T[]): T[] {
  const sentById = new Map(sent.map(item => [item.id, item]));
  const returnedById = new Map(returned.map(item => [item.id, item]));
  return keepArray(latest, latest.map(item => {
    if (!sameStateValue(item, sentById.get(item.id))) return item;
    const saved = returnedById.get(item.id);
    return saved && !sameStateValue(item, saved) ? saved : item;
  }));
}

/** 外部同步采用远端顺序及增删，同时保留所有未变记录的引用。 */
export function reconcileRecords<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  if (previous === incoming) return previous;
  const byId = new Map(previous.map(item => [item.id, item]));
  return keepArray(previous, incoming.map(item => {
    const existing = byId.get(item.id);
    return existing && sameStateValue(existing, item) ? existing : item;
  }));
}
