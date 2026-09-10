import rehypeHighlight from "rehype-highlight";
import type { PluggableList } from "unified";
export const rehype: PluggableList = [[rehypeHighlight, { detect: false }]];
