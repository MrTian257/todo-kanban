// CDP 协议级 UI 验证：Bug1（添加步骤不关弹窗）+ Bug2（分支/泳道回显）
// 用法: node scripts/verify-fixes.mjs  (需要 chrome --remote-debugging-port=9222 已打开 http://localhost:1420/)
// 使用 Node 22+ 原生 WebSocket，无外部依赖

const HTTP = "http://127.0.0.1:9222";

async function getTarget() {
  const res = await fetch(`${HTTP}/json`);
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
  if (!page) throw new Error("未找到 todo-kanban 标签页: " + JSON.stringify(list.map((t) => t.url)));
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error("WebSocket 连接失败: " + (e.message || e.type)));
  });
}

let seq = 0;
const pending = new Map();

function send(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function handle(buf) {
  const msg = typeof buf === "string" ? buf : new TextDecoder().decode(buf);
  const data = JSON.parse(msg);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(data.error.message));
    else resolve(data.result);
  }
}

async function evalJs(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 工具：模拟 React 事件（比 dispatchEvent 更真实） ───
async function clickByText(ws, selector, text) {
  return evalJs(ws, `(() => {
    const els = [...document.querySelectorAll('${selector}')];
    const el = els.find(e => (e.textContent || '').trim().includes('${text}'));
    if (!el) return { ok: false, reason: 'not found: ${text}' };
    el.scrollIntoView({ block: 'center' });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { ok: true };
  })()`);
}

async function textOf(ws, expression) {
  return evalJs(ws, expression);
}

const results = [];

function report(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

// ═══ Bug 1：项目弹窗「添加步骤」不应提交/关闭 ═══
async function testBug1(ws) {
  // 导航到项目列表页（HashRouter）
  await evalJs(ws, `location.hash = '#/projects'`);
  await sleep(600);

  // 打开新建项目弹窗
  let r = await clickByText(ws, "button", "新建项目");
  if (!r.ok) return report("Bug1 打开新建项目弹窗", false, r.reason);
  await sleep(600);

  // 填项目名称
  await evalJs(ws, `(() => {
    const input = document.querySelector('input[id="name"]');
    if (!input) return 'no name input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '验证项目');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);

  // 统计当前步骤行数（每行有序号 span 1..n）
  const before = await textOf(ws, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return -1;
    return [...dialog.querySelectorAll('select,button')].length > 0 ? 
      [...dialog.querySelectorAll('button')].filter(b => b.textContent.includes('添加步骤')).length : -1;
  })()`);
  if (before !== 1) return report("Bug1 前置：弹窗已打开且有添加步骤按钮", false, `before=${before}`);

  // 点击「添加步骤」
  r = await clickByText(ws, "button", "添加步骤");
  if (!r.ok) return report("Bug1 点击添加步骤", false, r.reason);
  await sleep(400);

  // 验证：弹窗仍然打开 + 步骤数 +1
  const state = await textOf(ws, `(() => {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return { open: false, rows: 0 };
    // 步骤行 = 含「切出/合并」combo 的行；直接数「上移」按钮 + 1 也行
    const rows = [...dialog.querySelectorAll('button')].filter(b => b.textContent.trim() === '上移').length + 1;
    const nameVal = dialog.querySelector('input[id="name"]')?.value ?? '';
    return { open: true, rows, nameVal };
  })()`);
  const pass = state.open === true && state.rows === 4 && state.nameVal === "验证项目";
  report("Bug1 添加步骤后弹窗保持打开且步骤+1（名称保留）", pass, JSON.stringify(state));

  // 再点「创建」应真正提交并关闭
  r = await clickByText(ws, "button", "创建");
  if (!r.ok) return report("Bug1 点击创建", false, r.reason);
  await sleep(700);
  const after = await textOf(ws, `(() => {
    // 只认「新建项目」标题的弹窗（排除 toast 等其它 role=dialog 节点）
    const dlg = [...document.querySelectorAll('[role="dialog"]')].find(d => d.textContent.includes('新建项目'));
    const card = [...document.querySelectorAll('h3,div,span')].some(e => e.textContent === '验证项目');
    return { open: !!dlg, saved: card };
  })()`);
  report("Bug1 点创建后弹窗关闭且项目保存", after.open === false && after.saved === true, JSON.stringify(after));
}

// ═══ Bug 2：新建 todo 选中分支/泳道后回显 ═══
async function testBug2(ws) {
  // 进入演示项目看板
  await evalJs(ws, `location.hash = '#/projects'`);
  await sleep(400);
  let r = await evalJs(ws, `(() => {
    // 项目卡片双击进入 / 点编辑进入看板 —— 直接找路由：项目卡片点击进看板
    const links = [...document.querySelectorAll('a')];
    return links.map(a => a.getAttribute('href')).slice(0, 20);
  })()`);
  console.log("  链接列表:", JSON.stringify(r));

  // 演示项目看板直接 hash 进（demo-project）
  await evalJs(ws, `location.hash = '#/project/demo-project/todo/new'`);
  await sleep(800);

  // 页面应有「新建待办」标题 + 泳道下拉（默认值 待办）
  const init = await textOf(ws, `(() => {
    const h1 = document.querySelector('h1');
    return { title: h1?.textContent ?? '', url: location.hash };
  })()`);
  if (init.title !== "新建待办") return report("Bug2 前置：进入新建待办页", false, JSON.stringify(init));

  // 泳道 Select：通过「所属泳道」label 定位其容器内的 trigger（避免与 BranchSelect 混淆）
  const lane = await evalJs(ws, `(async () => {
    const label = [...document.querySelectorAll('label')].find(l => l.textContent.includes('所属泳道'));
    if (!label) return { ok: false, reason: 'no label' };
    const container = label.parentElement;
    const trigger = container.querySelector('[role="combobox"]');
    if (!trigger) return { ok: false, reason: 'no trigger' };
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 400));
    const opts = [...document.querySelectorAll('[role="option"]')];
    const target = opts.find(o => o.textContent.includes('进行中'));
    if (!target) return { ok: false, reason: 'options=' + opts.map(o=>o.textContent).join('|') };
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const t2 = label.parentElement.querySelector('[role="combobox"]');
    return { ok: true, echo: t2.textContent.trim() };
  })()`);
  report("Bug2 泳道选择后回显（应为 进行中）", lane.ok && lane.echo?.includes("进行中"), JSON.stringify(lane));

  // 分支 BranchSelect：浏览器模式无 git 能力（branches 空），验证初始 value 渲染链路
  // 默认 branch = project.productionBranch = "main" → trigger 应显示 main
  const branch = await evalJs(ws, `(() => {
    const btns = [...document.querySelectorAll('button[role="combobox"]')];
    const branchBtn = btns.find(b => b.textContent.includes('main')) || btns[0];
    if (!branchBtn) return { ok: false, reason: 'no branch trigger' };
    return { ok: true, echo: branchBtn.textContent.trim() };
  })()`);
  report("Bug2 分支 trigger 渲染 watch 值（应含 main）", branch.ok && branch.echo?.includes("main"), JSON.stringify(branch));
}

async function main() {
  const target = await getTarget();
  console.log("目标标签页:", target.url);
  const ws = await connect(target.webSocketDebuggerUrl);
  ws.addEventListener("message", (ev) => handle(ev.data));
  await send(ws, "Runtime.enable");

  await testBug1(ws);
  await testBug2(ws);

  ws.close();
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${failed === 0 ? "🎉 全部通过" : "⚠️ " + failed + " 项失败"} (${results.length} 项)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
