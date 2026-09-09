/** 桌面平台展示约定；不依赖异步原生调用，浏览器预览同样适用。 */
export const isMacOS = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
export const primaryModifier = isMacOS ? "⌘" : "Ctrl";
export const shortcutLabel = (key: string) => `${primaryModifier}+${key}`;
