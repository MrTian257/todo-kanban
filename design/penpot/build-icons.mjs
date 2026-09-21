// 从本地 lucide-react 提取图标 path，生成 Penpot 可用的 SVG 片段表
import fs from "node:fs";
import path from "node:path";

const names = ["panel-left-close","search","minus","square","x","folder-kanban","git-branch","square-kanban","calendar-days","list-todo","book-open","moon","settings","plus","grip-vertical","circle","circle-dot","circle-check","git-commit-horizontal","play","bot","chevron-down","refresh-cw","pencil","circle-check-big"];
const dir = path.join(process.cwd(), "node_modules", "lucide-react", "dist", "esm", "icons");
const out = {};
for (const n of names) {
  const p = path.join(dir, n + ".js");
  if (!fs.existsSync(p)) { console.error("MISSING " + n); continue; }
  const src = fs.readFileSync(p, "utf8");
  const m = src.match(/createLucideIcon\(\s*"[^"]+"\s*,\s*(\[[\s\S]*?\])\s*\)/);
  if (!m) { console.error("PARSE FAIL " + n); continue; }
  const arr = Function("return " + m[1])();
  out[n] = arr.map(function (e) {
    const tag = e[0], attrs = e[1] || {};
    return "<" + tag + " " + Object.keys(attrs).map(function (k) { return k + '="' + attrs[k] + '"'; }).join(" ") + "/>";
  }).join("");
}
fs.writeFileSync(path.join("design", "penpot", "icons.generated.js"), "var ICONS = " + JSON.stringify(out) + ";\n");
console.log("icons generated: " + Object.keys(out).length + " -> " + Object.keys(out).join(","));
