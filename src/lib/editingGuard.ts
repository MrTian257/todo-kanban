import { useEffect, useRef } from "react";
import { useAppStore } from "@/lib/store";

const editors = new Set<symbol>();
/** 多个编辑器共享离开保护，关闭弹窗不会误清除其他页面的脏状态。 */
export function useEditingGuard(dirty: boolean) {
  const id = useRef(Symbol("editor"));
  useEffect(() => {
    const key = id.current;
    if (dirty) editors.add(key); else editors.delete(key);
    useAppStore.setState({ editingDirty: editors.size > 0 });
    return () => { editors.delete(key); useAppStore.setState({ editingDirty: editors.size > 0 }); };
  }, [dirty]);
}
