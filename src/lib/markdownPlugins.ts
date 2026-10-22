// 本仓库「支持的 Markdown 语法子集」的**唯一定义处**（ADR-0003 决策 3 / 票 07）。
//
// 为什么要有这个文件：编辑期的块解析（markdownBlocks.ts）与只读渲染
// （components/todo/MarkdownRenderer.tsx）必须是**同一套 remark 扩展**，
// 否则会出现「编辑器能造出来、看板显示不出来」的裂口——那是票 07 整张表要防的事。
// 分叉过一次就再也对不齐（与 ADR-023「MCP 工具表只允许一份」是同一类问题）。
//
// 因此：任何一侧要加/减语法，只改这里；两侧都从这里 import。
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";

/**
 * 只读渲染的基础扩展：CommonMark + GFM（表格含对齐、删除线、任务列表、自动链接、脚注）。
 * remark-gfm@4 已内置 footnote，**不要再单叠 micromark-extension-gfm-footnote**——
 * 重复注册会双写 handler（票 07 §1 点名的易错处）。
 */
export const baseRemarkPlugins: PluggableList = [remarkGfm];

/** 数学扩展实例。只读侧经 MarkdownMath.ts 懒加载它（为的是把 KaTeX 分片出去），块解析侧直接全量用。 */
export const remarkMathPlugin = remarkMath;

/**
 * 块源文层的解析扩展：必须**一次到位**，不能懒加载。
 * 理由：块切分依赖完整 AST，缺 remarkMath 会把美元号包裹的公式块误判成 verbatim 透明块，
 * 用户就拖不动它了（ADR-0001 §5 第 8 类要求块级公式是正式块类型）。
 */
export const blockRemarkPlugins: PluggableList = [remarkGfm, remarkMath];
