import React from "react";
import ReactDOM from "react-dom/client";
// IBM Plex 双声部：sans 讲人话，mono 唱数据（tag/hash/日期/计数）
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
import App from "./App";
import { installContextMenuSystem, registerEditableContextMenu } from "@/lib/context-menu";
import { installInputSuggestionControl } from "@/lib/input-suggestions";

// 全局接管（渲染前安装；MutationObserver 自动覆盖后续动态节点）：
// 1. 右键菜单：拦截 WebView/Tauri 默认菜单，只有显式注册的区域才弹自定义菜单。
//    内置注册了可编辑字段菜单（剪切/复制/粘贴/全选），不需要时删除下一行即可。
// 2. 输入建议：默认关闭 autocomplete / spellcheck，程序可经 JSX 属性
//    或 data-autocomplete="on" / data-spellcheck="on" 容器属性显式开启（见 lib/input-suggestions.ts）。
installContextMenuSystem();
registerEditableContextMenu();
installInputSuggestionControl();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);