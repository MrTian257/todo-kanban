import React from "react";
import ReactDOM from "react-dom/client";
// 仅打包编程等宽字体常用拉丁字符；中文由系统中文字体提供。
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./index.css";
import App from "./App";
import { isMacOS } from "@/lib/platform";

document.documentElement.dataset.platform = isMacOS ? "macos" : "other";
import { installContextMenuSystem, registerEditableContextMenu } from "@/lib/context-menu";
import { installInputSuggestionControl } from "@/lib/input-suggestions";
import { installShortcutSystem } from "@/lib/shortcuts";

// 全局接管（渲染前安装；MutationObserver 自动覆盖后续动态节点）：
// 1. 右键菜单：拦截 WebView/Tauri 默认菜单，只有显式注册的区域才弹自定义菜单。
//    内置注册了可编辑字段菜单（剪切/复制/粘贴/全选），不需要时删除下一行即可。
// 2. 输入建议：默认关闭 autocomplete / spellcheck，程序可经 JSX 属性
//    或 data-autocomplete="on" / data-spellcheck="on" 容器属性显式开启（见 lib/input-suggestions.ts）。
// 3. 快捷键：全应用共用一个 window keydown 监听（页面/组件用 useShortcut 注册，
//    见 lib/shortcuts.ts；键位表与抑制规则在 lib/shortcutKeys.ts）。
installContextMenuSystem();
registerEditableContextMenu();
installInputSuggestionControl();
installShortcutSystem();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);