import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import type { PluggableList } from "unified";
// 原生 MathML 使用系统字形，不打包 KaTeX 的数学字体。
export const remark: PluggableList = [remarkMath];
export const rehype: PluggableList = [[rehypeKatex, { trust: false, strict: "ignore", output: "mathml" }]];
