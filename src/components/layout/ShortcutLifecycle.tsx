// 全局快捷键注册与速查弹层挂载。
// 与 WorkflowLifecycle 同级挂在 Router 内（要用到 useNavigate）。
import { useNavigate } from "react-router-dom";
import { useAppStore } from "@/lib/store";
import { openShortcutCheatSheet, useShortcut } from "@/lib/shortcuts";
import { ShortcutCheatSheet } from "@/components/layout/ShortcutCheatSheet";

export function ShortcutLifecycle() {
  const navigate = useNavigate();

  // 新建待办：与「全部待办 → 快捷创建」完全同一套项目选择规则。
  // 处理器里现取 store（useShortcut 内部走 ref），避免把项目列表塞进依赖导致频繁重注册。
  useShortcut("new-todo", () => {
    const { projects, activeProjectId } = useAppStore.getState();
    const target =
      projects.find((project) => project.id === activeProjectId && !project.archived) ??
      projects.find((project) => !project.archived) ??
      projects[0];
    navigate(target ? "/project/" + target.id + "/todo/new" : "/projects");
  });

  // 速查弹层：侧栏按钮与这个快捷键共用 lib/shortcuts 里的开关
  useShortcut("help", () => openShortcutCheatSheet());

  return <ShortcutCheatSheet />;
}
