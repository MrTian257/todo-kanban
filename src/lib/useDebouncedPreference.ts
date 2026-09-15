import { useEffect, useRef } from "react";

/** 连续输入合并写入，离开页面或组件卸载时保存最后一次筛选。 */
export function useDebouncedPreference(key: string, value: unknown) {
  const serialized = JSON.stringify(value);
  const pending = useRef(serialized);
  useEffect(() => {
    pending.current = serialized;
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(key, serialized); } catch { /* 界面偏好存储可选。 */ }
    }, 300);
    return () => clearTimeout(timer);
  }, [key, serialized]);
  useEffect(() => {
    const flush = () => {
      try { localStorage.setItem(key, pending.current); } catch { /* 界面偏好存储可选。 */ }
    };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, [key]);
}
