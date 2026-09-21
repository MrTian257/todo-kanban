// ── todo-kanban 看板页 → Penpot 画布生成 ────────────────────────────
// 颜色取自项目 src/index.css 的真实主题令牌（oklch 已换算为 sRGB）
// 由 design/penpot/run.mjs 通过 Penpot MCP 的 execute_code 送入画布执行

var THEMES = {
  light: { bg: "#f8f9fc", card: "#ffffff", fg: "#26292e", muted: "#eef0f3", mutedFg: "#656970", border: "#dde0e4", primary: "#555bdd", primaryFg: "#fafaf9", sidebar: "#fcfcfe", laneBg: "#f0f2f5", rail: "#d2d4d8", todo: "#4a71b1", doing: "#b67700", done: "#3a8357", danger: "#c0392b", blue: "#3b82f6", green: "#10b981" },
  dark: { bg: "#111419", card: "#1a1d24", fg: "#e6e8ea", muted: "#252930", mutedFg: "#95989f", border: "#34383f", primary: "#8ca4d8", primaryFg: "#111419", sidebar: "#0b0d13", laneBg: "#1e2128", rail: "#34383f", todo: "#7a9fdd", doing: "#daa24f", done: "#69a980", danger: "#e0736a", blue: "#60a5fa", green: "#34d399" }
};

var MODE_ = (typeof MODE === "string") ? MODE : "light";
var T = THEMES[MODE_];
var LOG = [];
var page = penpot.currentPage;
var root = page.root;
var W = 1440, H = 900, TOOLBAR_H = 40, SIDEBAR_W = 224;
var PAD_X = 14;
var CX = SIDEBAR_W + 4 + PAD_X;
var CW = W - CX - PAD_X;
var BOARD_NAME = "todo-kanban 看板 · " + (MODE_ === "dark" ? "深色" : "浅色");
var FRAME_X = (MODE_ === "dark") ? 1560 : 0;

// ── 字体：优先选可显示中文的字体 ──────────────────────────────
function pickFont() {
  var prefer = ["Noto Sans SC", "Source Han Sans SC", "Source Han Sans", "Noto Sans JP", "M PLUS 2", "Ma Shan Zheng"];
  var all = penpot.fonts.all || [];
  for (var i = 0; i < prefer.length; i++) {
    for (var j = 0; j < all.length; j++) { if (all[j].name === prefer[i]) return all[j]; }
  }
  for (var k = 0; k < all.length; k++) {
    var n = all[k].name || "";
    if (n.indexOf("Noto") === 0 || n.indexOf("M PLUS") === 0) return all[k];
  }
  return null;
}
var FONT = pickFont();

// ── 基础绘制helper ───────────────────────────────────────────
function setFill(s, color, opacity) {
  try { s.fills = [{ fillColor: color, fillOpacity: (opacity === undefined ? 1 : opacity) }]; }
  catch (e) { LOG.push("fill:" + e.message); }
}
function setStroke(s, color, w) {
  try { s.strokes = [{ strokeColor: color, strokeOpacity: 1, strokeStyle: "solid", strokeWidth: (w || 1), strokeAlignment: "inner" }]; }
  catch (e) { LOG.push("stroke:" + e.message); }
}
function attach(parent, shape) {
  try { parent.appendChild(shape); } catch (e) { LOG.push("append:" + e.message); }
}
function rect(parent, x, y, w, h, o) {
  var r = penpot.createRectangle();
  r.name = (o && o.name) ? o.name : "rect";
  attach(parent, r);
  try { r.resize(w, h); } catch (e) { LOG.push("resize:" + e.message); }
  r.x = x; r.y = y;
  if (o && o.radius) { try { r.borderRadius = o.radius; } catch (e) { LOG.push("radius:" + e.message); } }
  if (o && o.fill) setFill(r, o.fill, o.fillOpacity); else try { r.fills = []; } catch (e) {}
  if (o && o.stroke) setStroke(r, o.stroke, o.strokeW || 1);
  if (o && o.opacity !== undefined) { try { r.opacity = o.opacity; } catch (e) {} }
  return r;
}
function text(parent, x, y, content, o) {
  var t = null;
  try { t = penpot.createText(content); } catch (e) { LOG.push("text:" + e.message); }
  if (!t) return null;
  t.name = "text/" + String(content).slice(0, 24);
  attach(parent, t);
  if (FONT) { try { FONT.applyToText(t); } catch (e) { LOG.push("applyFont:" + e.message); } }
  try { t.growType = o.fixed ? "fixed" : "auto-width"; } catch (e) { LOG.push("growType:" + e.message); }
  if (o.fixed) { try { t.resize(o.w, o.h); } catch (e) { LOG.push("textResize:" + e.message); } }
  try { t.fontSize = String(o.size); } catch (e) { LOG.push("fontSize:" + e.message); }
  if (o.weight) { try { t.fontWeight = String(o.weight); } catch (e) { LOG.push("fontWeight:" + e.message); } }
  if (o.lh) { try { t.lineHeight = String(o.lh); } catch (e) { LOG.push("lineHeight:" + e.message); } }
  if (o.ls) { try { t.letterSpacing = String(o.ls); } catch (e) { LOG.push("letterSpacing:" + e.message); } }
  if (o.align) { try { t.align = o.align; } catch (e) {} }
  if (o.valign) { try { t.verticalAlign = o.valign; } catch (e) {} }
  setFill(t, o.color, o.opacity);
  t.x = x; t.y = y;
  return t;
}
function icon(parent, name, x, y, size, color) {
  var body = ICONS[name];
  if (!body) { LOG.push("icon missing:" + name); return null; }
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>";
  var g = null;
  try { g = penpot.createShapeFromSvg(svg); } catch (e) { LOG.push("svg " + name + ":" + e.message); }
  if (!g) return null;
  g.name = "icon/" + name;
  attach(parent, g);
  g.x = x; g.y = y;
  return g;
}
// 粗略文字宽度（中文按字号、西文按 0.55 字号），仅用于排布
function tw(s, size) {
  var n = 0;
  for (var i = 0; i < s.length; i++) { n += (s.charCodeAt(i) > 0x2e80) ? size : size * 0.55; }
  return n;
}
function statusColor(st) { return st === "done" ? T.done : (st === "doing" ? T.doing : T.todo); }
function statusIcon(st) { return st === "done" ? "circle-check" : (st === "doing" ? "circle-dot" : "circle"); }

// ── 数据：泳道与卡片 ─────────────────────────────────────────
var LANES = [
  { name: "待办", status: "todo", cards: [
    { title: "工作流页支持自动脚本批量启用/停用", tag: "todo-118", branch: "feature/workflow-bulk", commits: 2, ai: true, due: "2026-09-22 截止", lines: 2 },
    { title: "MCP 工具补充 resources/fields 的 schema 校验", tag: "todo-121", commits: 0, lines: 2 },
    { title: "附件图片超过 5MB 时给出中文错误提示", tag: "todo-124", commits: 0, lines: 1 }
  ] },
  { name: "进行中", status: "doing", cards: [
    { title: "泳道拖拽在缩放窗口后落点偏移", tag: "todo-109", branch: "fix/lane-drop", commits: 4, due: "今天截止", lines: 1 },
    { title: "自定义字段取值强转与后端规则不一致", tag: "todo-113", branch: "fix/custom-field-cast", commits: 2, ai: true, aiLabel: "AI 协助", lines: 2 }
  ] },
  { name: "已完成", status: "done", cards: [
    { title: "数据版本 v11 迁移：custom_fields 列", tag: "todo-102", commits: 3, done: true, lines: 1 },
    { title: "右键菜单支持一级子菜单", tag: "todo-96", commits: 1, done: true, lines: 1 }
  ] }
];

// ── 组件：任务卡片 ───────────────────────────────────────────
function card(b, x, y, w, c, laneStatus) {
  var pad = 17, fx = x + pad, fw = w - pad * 2;
  var titleH = (c.lines || 1) * 25;
  var h = pad + titleH + 14 + 20 + (c.branch ? 30 : 0) + 12 + 20 + pad;
  rect(b, x, y, w, h, { fill: T.card, stroke: T.border, radius: 12, name: "card/" + c.tag });
  text(b, fx, y + pad - 4, c.title, { size: 15, weight: 600, color: T.fg, lh: 1.65, fixed: true, w: fw, h: titleH });
  var cy = y + pad + titleH + 14;
  var mx = fx;
  if (c.ai) {
    rect(b, mx, cy, 78, 20, { fill: T.primary, fillOpacity: 0.08, stroke: T.primary, radius: 6, name: "badge/ai" });
    icon(b, "bot", mx + 7, cy + 4, 12, T.primary);
    text(b, mx + 23, cy + 2, c.aiLabel || "AI 创建", { size: 11, color: T.primary });
    mx += 86;
  }
  text(b, mx, cy + 2, c.tag, { size: 12, color: T.fg, opacity: 0.75 });
  cy += 20;
  if (c.branch) {
    cy += 10;
    icon(b, "git-branch", fx, cy + 3, 13, T.mutedFg);
    text(b, fx + 20, cy + 1, c.branch, { size: 12, color: T.mutedFg });
    cy += 20;
  }
  cy += 12;
  var bx = fx;
  if (c.due) {
    icon(b, "calendar-days", fx, cy + 3, 13, c.overdue ? T.danger : T.mutedFg);
    text(b, fx + 20, cy + 1, c.due, { size: 12, color: c.overdue ? T.danger : T.mutedFg });
    bx = fx + 20 + tw(c.due, 12) + 18;
  }
  if (c.done) {
    icon(b, "circle-check", bx, cy + 3, 13, T.done);
    text(b, bx + 20, cy + 1, "已完成", { size: 12, color: T.done });
    bx += 20 + tw("已完成", 12) + 18;
  }
  if (c.commits) {
    icon(b, "git-commit-horizontal", bx, cy + 3, 13, T.mutedFg);
    text(b, bx + 20, cy + 1, c.commits + " 条提交", { size: 12, color: T.mutedFg });
  }
  var ax = x + w - pad - 16;
  if (laneStatus !== "done") icon(b, "circle-check-big", ax, cy + 1, 16, T.green);
  if (laneStatus === "todo") icon(b, "play", ax - 26, cy + 1, 16, T.blue);
  return h;
}

// ── 组件：泳道 ───────────────────────────────────────────────
function lane(b, x, y, w, h, L) {
  rect(b, x, y, w, h, { fill: T.laneBg, radius: 14, name: "lane/" + L.name });
  var hx = x + 12, hy = y + 16;
  icon(b, "grip-vertical", hx, hy, 16, T.mutedFg);
  icon(b, statusIcon(L.status), hx + 22, hy, 16, statusColor(L.status));
  text(b, hx + 46, hy - 3, L.name, { size: 14, weight: 600, color: T.fg });
  var px = x + w - 12 - 28;
  icon(b, "plus", px + 6, hy + 2, 16, T.mutedFg);
  var chipW = 30, chipX = px - 10 - chipW;
  rect(b, chipX, hy + 1, chipW, 22, { fill: T.bg, stroke: T.border, radius: 6, name: "chip/count" });
  text(b, chipX, hy + 3, String(L.cards.length), { size: 12, color: T.mutedFg, align: "center", fixed: true, w: chipW, h: 18 });
  var cy = y + 50;
  for (var i = 0; i < L.cards.length; i++) { cy += card(b, x + 10, cy, w - 20, L.cards[i], L.status) + 12; }
  var fy = y + h - 41;
  rect(b, x + 12, fy, w - 24, 1, { fill: T.border, name: "rule" });
  var pad2 = tw("添加任务", 12);
  icon(b, "plus", x + (w - pad2 - 20) / 2, fy + 13, 13, T.mutedFg);
  text(b, x + (w - pad2 - 20) / 2 + 19, fy + 11, "添加任务", { size: 12, color: T.mutedFg });
}

// ── 组件：顶栏 / 侧栏 / 页头 ─────────────────────────────────
function toolbar(f) {
  rect(f, 0, 0, W, TOOLBAR_H, { fill: T.bg, name: "toolbar" });
  rect(f, 0, TOOLBAR_H - 1, W, 1, { fill: T.border, name: "toolbar/rule" });
  icon(f, "panel-left-close", 14, 12, 16, T.mutedFg);
  rect(f, 48, 6, 288, 28, { fill: T.bg, stroke: T.border, radius: 8, name: "toolbar/search" });
  text(f, 58, 12, "搜索任务 · Ctrl K", { size: 12, color: T.mutedFg });
  icon(f, "search", 344, 13, 14, T.mutedFg);
  icon(f, "minus", 1348, 12, 16, T.mutedFg);
  icon(f, "square", 1380, 12, 15, T.mutedFg);
  icon(f, "x", 1412, 12, 16, T.mutedFg);
}
function sidebar(f) {
  rect(f, 0, TOOLBAR_H, SIDEBAR_W, H - TOOLBAR_H, { fill: T.sidebar, name: "sidebar" });
  rect(f, SIDEBAR_W - 1, TOOLBAR_H, 1, H - TOOLBAR_H, { fill: T.border, name: "sidebar/border" });
  rect(f, SIDEBAR_W, TOOLBAR_H, 4, H - TOOLBAR_H, { fill: T.rail, name: "sidebar/resize-handle" });
  // 项目上下文
  rect(f, 12, 50, 28, 28, { fill: T.primary, radius: 10, name: "project/icon" });
  icon(f, "folder-kanban", 18, 56, 16, T.primaryFg);
  text(f, 48, 51, "todo-kanban", { size: 14, weight: 600, color: T.fg });
  icon(f, "git-branch", 48, 73, 12, T.mutedFg);
  text(f, 63, 70, "main", { size: 11, color: T.mutedFg });
  // 主导航
  var nav = [
    { label: "工作流", icon: "square-kanban" },
    { label: "今日焦点", icon: "calendar-days" },
    { label: "全部待办", icon: "list-todo" },
    { label: "项目资料", icon: "folder-kanban", active: true },
    { label: "资料库", icon: "book-open" }
  ];
  var ny = TOOLBAR_H + 48 + 8;
  for (var i = 0; i < nav.length; i++) {
    var it = nav[i];
    if (it.active) rect(f, 8, ny, SIDEBAR_W - 16, 44, { fill: T.primary, fillOpacity: 0.08, radius: 10, name: "nav/" + it.label });
    icon(f, it.icon, 20, ny + 14, 16, it.active ? T.primary : T.mutedFg);
    text(f, 44, ny + 11, it.label, { size: 14, weight: it.active ? 600 : 400, color: it.active ? T.primary : T.fg });
    ny += 52;
  }
  // 底部
  rect(f, 0, H - 56, SIDEBAR_W, 1, { fill: T.border, name: "sidebar/rule" });
  icon(f, "moon", 20, 864, 16, T.mutedFg);
  icon(f, "settings", 56, 864, 16, T.mutedFg);
}
function button(f, x, y, w, label, iconName, primary, iconColor) {
  var h = 40;
  rect(f, x, y, w, h, primary ? { fill: T.primary, radius: 10, name: "btn/" + label } : { fill: T.card, stroke: T.border, radius: 10, name: "btn/" + label });
  if (iconName) icon(f, iconName, x + 14, y + 12, 16, primary ? T.primaryFg : (iconColor || T.mutedFg));
  text(f, x + 36, y + 11, label, { size: 14, color: primary ? T.primaryFg : T.fg, weight: primary ? 500 : 400 });
}
function pageHead(f) {
  text(f, CX, 54, "项目资料  /  项目看板", { size: 12, color: T.mutedFg });
  var dir = "C:/workspace/desktop/todo-kanban";
  text(f, W - PAD_X - tw(dir, 12), 54, dir, { size: 12, color: T.mutedFg });
  text(f, CX, 74, "todo-kanban", { size: 26, weight: 600, color: T.fg, ls: -0.9 });
  // 生产分支
  rect(f, 400, 74, 98, 30, { fill: T.card, stroke: T.border, radius: 8, name: "chip/branch" });
  icon(f, "git-branch", 410, 82, 14, T.mutedFg);
  text(f, 430, 81, "main", { size: 12, color: T.fg });
  // 搜索
  rect(f, 512, 74, 260, 40, { fill: T.card, stroke: T.border, radius: 12, name: "input/search" });
  icon(f, "search", 526, 86, 16, T.mutedFg);
  text(f, 550, 84, "搜索待办标题或编号…", { size: 14, color: T.mutedFg });
  // 分支筛选
  rect(f, 784, 74, 140, 40, { fill: T.card, stroke: T.border, radius: 12, name: "select/branch" });
  text(f, 798, 84, "全部分支", { size: 14, color: T.fg });
  icon(f, "chevron-down", 898, 86, 16, T.mutedFg);
  // 操作区
  button(f, 954, 74, 104, "同步提交", "refresh-cw", false);
  button(f, 1066, 74, 112, "管理泳道", "settings", false);
  button(f, 1186, 74, 112, "编辑项目", "pencil", false);
  button(f, 1306, 74, 120, "新建待办", "plus", true);
}

// ── 组装 ────────────────────────────────────────────────────
(function () {
  var old = (page.root.children || []).filter(function (s) { return s.name === BOARD_NAME; });
  for (var i = 0; i < old.length; i++) { try { old[i].remove(); } catch (e) {} }
  var f = penpot.createBoard();
  f.name = BOARD_NAME;
  attach(root, f);
  try { f.resize(W, H); } catch (e) { LOG.push("boardResize:" + e.message); }
  f.x = FRAME_X; f.y = 0;
  setFill(f, T.bg);
  toolbar(f);
  sidebar(f);
  pageHead(f);
  var laneW = 380, laneGap = 20, laneY = 142, laneH = H - laneY - 12;
  for (var j = 0; j < LANES.length; j++) { lane(f, CX + j * (laneW + laneGap), laneY, laneW, laneH, LANES[j]); }
})();

return {
  mode: MODE_,
  board: BOARD_NAME,
  font: FONT ? FONT.name : "(默认字体)",
  shapes: (page.root.children || []).filter(function (s) { return s.name === BOARD_NAME; }).map(function (s) { return s.children.length; })[0],
  errorCount: LOG.length,
  errors: LOG.slice(0, 15)
};
