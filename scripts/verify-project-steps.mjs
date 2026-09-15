// CDP 验证：新建项目弹窗的分支规则步骤编辑（添加步骤不关弹窗 / 名称保留 / 提交 / 重新打开后回显）
// 前置：dev server 运行在 :1420，Chrome 以远程调试端口打开该页面（默认 9222，可用 CDP_PORT 覆盖）
// 用法：CDP_PORT=9222 node scripts/verify-project-steps.mjs
const PORT = process.env.CDP_PORT || "9222";
const HTTP = `http://127.0.0.1:${PORT}`;
const PROJECT_NAME = "验证项目-步骤";

let seq = 0;
const pending = new Map();
const REPLY_TIMEOUT_MS = 30_000;

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
    ws.addEventListener("close", () => {
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP 连接已关闭"));
      }
    });
  });
}

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时（${REPLY_TIMEOUT_MS}ms 无响应）`));
    }, REPLY_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(ws, expression, retry = true) {
  let r;
  try {
    r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  } catch (error) {
    if (!retry || !String(error.message).includes("超时")) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return evalJs(ws, expression, false);
  }
  if (r.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 页面内工具（每次调用都重新注入，避免依赖上一次的闭包） */
const HELPERS = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const txt = el => (el.textContent || "").trim();
  const all = sel => [...document.querySelectorAll(sel)];
  const find = (sel, t) => all(sel).find(el => txt(el).includes(t));
  const press = el => { if (!el) throw new Error("元素缺失"); for (const t of ["pointerdown","pointerup"]) el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,button:0,pointerType:"mouse",isPrimary:true})); el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,button:0})); };
  const dialog = () => document.querySelector("[role=dialog]");
  // 步骤行数：每行有一个「上移」按钮（图标按钮，用 aria-label 判定；旧脚本按文本匹配会数成 0）
  const stepRows = () => { const d = dialog(); return d ? [...d.querySelectorAll("button")].filter(b => /上移/.test(b.getAttribute("aria-label") || "")).length : -1; };
  const setInput = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
`;

async function main() {
  const list = await (await fetch(`${HTTP}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
  if (!page) throw new Error(`未找到 localhost:1420 页面（调试端口 ${PORT}）`);
  const ws = await connect(page.webSocketDebuggerUrl);
  await send(ws, "Runtime.enable");
  await send(ws, "Page.reload", { ignoreCache: true });
  await sleep(2600);
  await evalJs(ws, `(() => { window.__errs = []; window.addEventListener("error", e => window.__errs.push(String(e.message))); window.addEventListener("unhandledrejection", e => window.__errs.push(String(e.reason))); return 'ok'; })()`);

  const results = [];
  const check = async (name, ok, detail) => {
    const errors = await evalJs(ws, `window.__errs`);
    const passed = ok && errors.length === 0;
    results.push(passed);
    console.log(`${passed ? "✅" : "❌"} ${name} ${JSON.stringify(detail)}${errors.length ? " 未捕获错误=" + JSON.stringify(errors) : ""}`);
  };

  // 打开新建项目弹窗 → 填名称 → 连点两次「添加步骤」
  const edited = await evalJs(ws, `(async () => { ${HELPERS}
    if (!location.hash.includes("projects")) { press(document.querySelector("a[href='#/projects']")); await sleep(900); }
    press(find("button", "新建项目")); await sleep(700);
    if (!dialog()) return { error: "弹窗未打开" };
    const nameInput = dialog().querySelector('input[id="name"]');
    if (!nameInput) return { error: "缺少项目名输入框" };
    setInput(nameInput, ${JSON.stringify(PROJECT_NAME)});
    const initial = stepRows();
    press(find("button", "添加步骤")); await sleep(400);
    const afterFirst = stepRows();
    press(find("button", "添加步骤")); await sleep(400);
    const afterSecond = stepRows();
    return { initial, afterFirst, afterSecond, open: !!dialog(), name: dialog().querySelector('input[id="name"]')?.value ?? "" };
  })()`, 60000);
  await check("添加步骤：弹窗保持打开、步骤递增、名称保留", edited.initial === 3 && edited.afterFirst === 4 && edited.afterSecond === 5 && edited.open && edited.name === PROJECT_NAME, edited);

  // 提交：弹窗关闭 + 新项目出现在列表
  const created = await evalJs(ws, `(async () => { ${HELPERS}
    press(find("button", "创建")); await sleep(1200);
    return { open: !!dialog(), listed: document.body.innerText.includes(${JSON.stringify(PROJECT_NAME)}) };
  })()`, 60000);
  await check("创建项目：弹窗关闭且出现在列表", created.open === false && created.listed, created);

  // 重新打开该项目 → 步骤配置已落库（5 步）
  const reopened = await evalJs(ws, `(async () => { ${HELPERS}
    const card = [...document.querySelectorAll("article, .tk-panel")].find(el => txt(el).includes(${JSON.stringify(PROJECT_NAME)}));
    if (!card) return { error: "找不到项目卡片" };
    const trigger = card.querySelector('button[aria-label^="管理项目"]');
    if (!trigger) return { error: "找不到项目管理按钮" };
    press(trigger); await sleep(600);
    const edit = all("[role=menuitem]").find(el => txt(el).startsWith("编辑"));
    if (!edit) return { error: "找不到编辑菜单项：" + JSON.stringify(all("[role=menuitem]").map(txt)) };
    press(edit); await sleep(900);
    return { open: !!dialog(), rows: stepRows(), name: dialog()?.querySelector('input[id="name"]')?.value ?? "" };
  })()`, 60000);
  await check("重新打开：步骤配置回显（5 步）", reopened.open === true && reopened.rows === 5 && reopened.name === PROJECT_NAME, reopened);

  ws.close();
  const pass = results.every(Boolean);
  console.log(pass ? "\n🎉 全部通过" : "\n❌ 存在失败");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
