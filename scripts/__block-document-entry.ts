// 测试专用入口：把块文档桥与 remark 解析器打进同一个 bundle，
// 这样 scripts/test-block-document.mjs 从临时目录 import 一次就够，不必再解析 node_modules。
export { markdownToEditorJson, editorJsonToMarkdown, emptyEditorNodes, blockToLexicalNodes, lexicalNodesToMarkdown, docToEditorState } from "../src/lib/blockDocument";
export { default as unified } from "unified";
export { default as parsePlugin } from "remark-parse";
export { default as gfm } from "remark-gfm";
export { default as math } from "remark-math";
