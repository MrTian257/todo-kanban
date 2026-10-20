// CDP 验证：全局快捷键真的能触发对应动作（dnd/浮层之外最容易静默失效的一类）。
// 为什么需要它：快捷键链路里「为保留键先 preventDefault」和「defaultPrevented 表示已被别人消化」
// 两条规则写在同一个函数里，顺序写反就会让 Ctrl+S / Ctrl+N / Ctrl+/ 全部静默失效——
// 编译、类型检查、纯逻辑断言都发现不了（resolveShortcut 的单元测试传的是假事件）。
// 前置：dev server 运行在 :1420，Chrome 以远程调试端口打开该页面（默认 9222，可用 CDP_PORT 覆盖）
// 用法：CDP_PORT=9222 node scripts/verify-shortcuts.mjs
const PORT = process.env.CDP_PORT || "9222";
const HTTP = `http://127.0.0.1:${PORT}`;
const BASE = "http://localhost:1420";
const DETAIL = "#/project/demo-project/todo/new";

let seq = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WS 连接失败"));
    ws.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data);
      const entry = data.id && pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      clearTimeout(entry.timer);
      if (data.error) entry.reject(new Error(data.error.message));
      else entry.resolve(data.result);
    });
  });
}

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(ws, expression) {
  const result = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error("页面异常: " + (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  return result.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实按键（必须走 CDP：合成 KeyboardEvent 不会触发浏览器的默认行为，也就测不出「先 preventDefault」这类顺序问题）
const KEYS = {
  "s": { key: "s", code: "KeyS", vk: 83 },
  "n": { key: "n", code: "KeyN", vk: 78 },
  "/": { key: "/", code: "Slash", vk: 191 },
  "f": { key: "f", code: "KeyF", vk: 70 },
  "l": { key: "l", code: "KeyL", vk: 76 },
  "Escape": { key: "Escape", code: "Escape", vk: 27 },
};
const MOD = { ctrl: 2, shift: 8, ctrlShift: 2 | 8 };

async function press(ws, name, modifiers = MOD.ctrl) {
  const spec = KEYS[name];
  if (!spec) throw new Error("未登记的按键：" + name);
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, modifiers };
  await send(ws, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...base, text: spec.key.length === 1 ? spec.key : undefined });
  await send(ws, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await sleep(700);
}

async function openPage(ws, hash) {
  // 清预览数据后必须**真重载**：只改 hash 不触发文档重载，store 里的 expected 快照
  // 会与被清空的 sessionStorage 不一致，保存必然 STATE_CONFLICT（那是测试假象，不是产品缺陷）。
  await evalJs(ws, `sessionStorage.removeItem('todo-kanban-preview-v1'); 1`);
  await send(ws, "Page.navigate", { url: `${BASE}/${hash}` });
  await sleep(300);
  await send(ws, "Page.reload", { ignoreCache: true });
  await sleep(2600);
}

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? "✅" : "❌"} ${name}${detail === undefined ? "" : " " + JSON.stringify(detail)}`);
}

const targets = await (await fetch(HTTP + "/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
if (!page) {
  console.error("找不到已打开 todo-kanban 的页面，请先在 Chrome 里打开 " + BASE);
  process.exit(2);
}
const ws = await connect(page.webSocketDebuggerUrl);
await send(ws, "Runtime.enable");
await send(ws, "Page.enable");
await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send(ws, "Page.bringToFront");

// ── 1. Ctrl+S 在详情页触发保存（回归：保留键自己被 preventDefault 后误判为「已被消化」）──
await openPage(ws, DETAIL);
await evalJs(ws, `(async () => {
  const input = document.querySelector('[aria-label="任务标题"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus(); set.call(input, '快捷键保存验证'); input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  return input.value;
})()`);
await press(ws, "s");
const savedByShortcut = await evalJs(ws, `({
  hash: location.hash,
  persisted: (sessionStorage.getItem('todo-kanban-preview-v1') || '').includes('快捷键保存验证'),
  toast: [...document.querySelectorAll('[data-sonner-toast]')].map(t => t.innerText.replace(/\\s+/g,' ').trim()).join('|'),
})`);
check("Ctrl+S 保存待办", savedByShortcut.persisted && savedByShortcut.hash === "#/project/demo-project", savedByShortcut);

// ── 2. Ctrl+S 在备注编辑器内也必须生效（guard=always，不能因为焦点在 contenteditable 就失效）──
await openPage(ws, DETAIL);
await evalJs(ws, `(async () => {
  const input = document.querySelector('[aria-label="任务标题"]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus(); set.call(input, '编辑器内保存验证'); input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  return input.value;
})()`);
const editorFound = await evalJs(ws, `(async () => {
  // Vditor 会同时留一个隐藏的 .vditor-sv 与一个可见的 .vditor-reset：必须挑**可见**的那个，
  // 对隐藏元素 focus() 不会改变 activeElement，会得到「没聚焦到编辑器」的假象。
  const ed = [...document.querySelectorAll('.vditor-reset[contenteditable="true"], [contenteditable="true"]')]
    .find(x => x.getBoundingClientRect().width > 0 && x.getBoundingClientRect().height > 0);
  if (!ed) return 'no-visible-editor';
  ed.focus();
  const set = ed.tagName === 'TEXTAREA' ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set : null;
  if (set) { set.call(ed, '编辑器内保存验证'); ed.dispatchEvent(new Event('input', { bubbles: true })); }
  else { ed.textContent = '编辑器内保存验证'; ed.dispatchEvent(new Event('input', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 400));
  return document.activeElement === ed ? 'focused' : 'not-focused';
})()`);
await press(ws, "s");
const savedInEditor = await evalJs(ws, `({
  hash: location.hash,
  persisted: (sessionStorage.getItem('todo-kanban-preview-v1') || '').includes('编辑器内保存验证'),
})`);
check("Ctrl+S 在备注编辑器内生效", savedInEditor.persisted && savedInEditor.hash === "#/project/demo-project", { editorFound, ...savedInEditor });

// ── 3. Ctrl+N 新建待办（同一个 preventDefault 顺序 bug 也会打死它）──
await openPage(ws, "#/project/demo-project");
// Ctrl+N 用合成事件：Chrome 会把真实 Ctrl+N 当成**浏览器快捷键**开新窗口，页面根本收不到
// （实测会多出一个 chrome://newtab 目标）。这里要验的是我们自己的 JS 链路——
// 尤其是「先 preventDefault 再判 defaultPrevented」这个顺序 bug，合成事件同样能暴露。
await evalJs(ws, `(() => { window.dispatchEvent(new KeyboardEvent('keydown', {
  key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true, cancelable: true })); return 1; })()`);
await sleep(700);
const newTodo = await evalJs(ws, `({ hash: location.hash })`);
check("Ctrl+N 跳到新建待办", /\/todo\/new$/.test(newTodo.hash), newTodo);

// ── 4. Ctrl+/ 打开快捷键速查，Escape 关闭 ──
await openPage(ws, "#/project/demo-project");
await press(ws, "/");
const cheatOpen = await evalJs(ws, `(() => {
  const dlg = document.querySelector('[role=dialog]');
  return { open: !!dlg, rows: dlg ? dlg.innerText.split('\\n').filter(Boolean).length : 0 };
})()`);
check("Ctrl+/ 打开快捷键速查", cheatOpen.open && cheatOpen.rows > 5, cheatOpen);
await press(ws, "Escape", 0);
const cheatClosed = await evalJs(ws, `!document.querySelector('[role=dialog]')`);
check("Escape 关闭速查", cheatClosed === true, { cheatClosed });

// ── 5. Ctrl+Shift+F 聚焦全局搜索；Ctrl+Shift+L 切换侧栏 ──
await openPage(ws, "#/project/demo-project");
await press(ws, "f", MOD.ctrlShift);
const searchFocused = await evalJs(ws, `document.activeElement?.getAttribute?.('aria-label') || document.activeElement?.tagName`);
check("Ctrl+Shift+F 聚焦全局搜索", searchFocused === "全局搜索", searchFocused);
const sidebarBefore = await evalJs(ws, `localStorage.getItem('tk-sidebar-collapsed')`);
await press(ws, "l", MOD.ctrlShift);
const sidebarAfter = await evalJs(ws, `localStorage.getItem('tk-sidebar-collapsed')`);
check("Ctrl+Shift+L 切换侧栏", sidebarBefore !== sidebarAfter, { sidebarBefore, sidebarAfter });

// ── 6. 有浮层时不抢键：Dialog 打开状态下 Ctrl+N 不应跳走 ──
await openPage(ws, "#/project/demo-project");
await evalJs(ws, `(async () => {
  const btn = [...document.querySelectorAll('button')].find(b => /管理泳道/.test(b.innerText));
  btn.click(); await new Promise(r => setTimeout(r, 600));
  return !!document.querySelector('[role=dialog]');
})()`);
const dialogOpen = await evalJs(ws, `!!document.querySelector('[role=dialog]')`);
await press(ws, "n");
const blockedByOverlay = await evalJs(ws, `({ hash: location.hash, dialog: !!document.querySelector('[role=dialog]') })`);
check("浮层打开时 Ctrl+N 不抢键", dialogOpen && blockedByOverlay.hash.includes("project/demo-project") && !/\/todo\/new$/.test(blockedByOverlay.hash), blockedByOverlay);

ws.close();
const failed = results.filter((ok) => !ok).length;
console.log(failed === 0 ? "\n🎉 全部通过" : `\n❌ 失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
