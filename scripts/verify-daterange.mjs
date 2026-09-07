// CDP 验证：日期范围选择器必须选两个值后才关闭
// 前置: chrome --remote-debugging-port=9222 已打开 http://localhost:1420/，dev server 运行中
const HTTP = "http://127.0.0.1:9222";

async function getTarget() {
  const list = await (await fetch(`${HTTP}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
  if (!page) throw new Error("未找到 todo-kanban 标签页");
  return page;
}

let seq = 0;
const pending = new Map();

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("WS 连接失败"));
    ws.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data);
      if (data.id && pending.has(data.id)) {
        const { resolve: r } = pending.get(data.id);
        pending.delete(data.id);
        r(data.result);
      }
    });
  });
}

function send(ws, method, params = {}) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, { resolve });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalJs(ws, expression) {
  const r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const target = await getTarget();
  console.log("目标:", target.url);
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, "Runtime.enable");
  await send(ws, "Page.enable");
  await send(ws, "Page.reload");
  await sleep(2500);

  // 进新建待办页并打开日期弹层
  const open = await evalJs(ws, `(async () => {
    location.hash = '#/project/demo-project/todo/new';
    await new Promise(r=>setTimeout(r,1200));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('选择日期范围'));
    if (!btn) return { ok: false, reason: 'no trigger', hash: location.hash };
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise(r=>setTimeout(r,600));
    return { ok: true };
  })()`);
  if (!open.ok) throw new Error("打开弹层失败: " + open.reason + " hash=" + open.hash);
  console.log("弹层已打开");

  const visible = `(el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }`;

  // 点击第 idx 个可选日期，返回点击后弹层开闭状态
  const clickDay = (idx) =>
    evalJs(ws, `(async () => {
      const wrap = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find((el)=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
      if (!wrap) return { ok: false, reason: 'no popover' };
      const days = [...wrap.querySelectorAll('button.rdp-day_button')].filter(b => !b.disabled && !b.className.includes('rdp-day_disabled'));
      if (days.length <= ${idx}) return { ok: false, reason: 'days=' + days.length };
      const picked = days[${idx}].textContent.trim();
      days[${idx}].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise(r=>setTimeout(r,700));
      // 以 Radix 的 data-state 为准（退出动画期间 wrapper 仍占位，尺寸判断会误报 open）
      const content = document.querySelector('[data-radix-popper-content-wrapper] [data-state]');
      const state = content ? content.getAttribute('data-state') : 'gone';
      return { ok: true, state, picked };
    })()`);

  const first = await clickDay(10);
  console.log("第一击:", JSON.stringify(first));
  const pass1 = first.ok && first.state === "open";

  const second = await clickDay(15);
  console.log("第二击:", JSON.stringify(second));
  const pass2 = second.ok && (second.state === "closed" || second.state === "gone");

  // 验证 trigger 回显范围（形如 9/14 - 9/19）
  const echo = await evalJs(ws, `(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.match(/\\d+\\/\\d+\\s*-\\s*\\d+\\/\\d+/));
    return btn ? btn.textContent.trim() : null;
  })()`);
  console.log("回显:", echo);
  const pass3 = !!echo && echo.includes("-");

  ws.close();
  console.log(`\n${pass1 && pass2 && pass3 ? "🎉 全部通过" : "❌ 失败"} (第一击保持打开:${pass1} / 第二击后关闭:${pass2} / 回显:${pass3})`);
  process.exit(pass1 && pass2 && pass3 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
