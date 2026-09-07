// CDP 验证：待办跨泳道拖拽（合成 PointerEvent——dnd-kit PointerSensor 监听 pointer 事件流，不校验 isTrusted）
// 前置: chrome --remote-debugging-port=9222 已打开 http://localhost:1420/，dev server 运行中
// 把手 = git-graph 状态节点 div.cursor-grab（TodoRow git-graph 版）
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
  if (r.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const target = await getTarget();
  console.log("目标:", target.url);
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, "Runtime.enable");
  await send(ws, "Page.enable");
  await send(ws, "Page.reload", { ignoreCache: true });
  await sleep(3000);

  await evalJs(ws, `location.hash = '#/project/demo-project'`);
  await sleep(1500);

  // 定位把手/卡片/泳道列（git-graph 版 DOM）
  const info = await evalJs(ws, `(() => {
    const grip = document.querySelector('div.cursor-grab');
    if (!grip) return { ok: false, reason: 'no grip div' };
    const card = grip.closest('div.group');
    if (!card) return { ok: false, reason: 'no card' };
    const fromCol = card.closest('div.rounded-lg.border');
    if (!fromCol) return { ok: false, reason: 'no fromCol' };
    const allCols = [...document.querySelectorAll('div.rounded-lg.border')].filter(c => c.querySelector('div.cursor-grab') || [...c.querySelectorAll('div.group')].length);
    const toCol = allCols.find(c => c !== fromCol);
    if (!toCol) return { ok: false, reason: 'no toCol' };
    const g = grip.getBoundingClientRect();
    const t = toCol.getBoundingClientRect();
    const laneName = (col) => col.querySelector('span.text-sm, span.font-medium')?.textContent?.trim();
    return { ok: true,
      grip: { x: g.x + g.width/2, y: g.y + g.height/2 },
      fromTitle: laneName(fromCol),
      toTitle: laneName(toCol),
      toMid: { x: t.x + t.width/2, y: t.y + Math.min(t.height/2, 220) },
      cardTitle: card.querySelector('span.truncate')?.textContent };
  })()`);
  if (!info.ok) throw new Error("定位失败: " + info.reason);
  console.log("拖拽:", JSON.stringify(info));

  // 页面内合成 PointerEvent 拖拽
  const r = await evalJs(ws, `(async () => {
    const x0 = ${info.grip.x}, y0 = ${info.grip.y};
    const x1 = ${info.toMid.x}, y1 = ${info.toMid.y};
    const grip = document.querySelector('div.cursor-grab');
    const fire = (type, x, y, extra={}) => {
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 7, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: 1, ...extra,
      });
      grip.dispatchEvent(ev);
    };
    fire('pointerdown', x0, y0);
    await new Promise(r=>setTimeout(r,60));
    const steps = 16;
    for (let i = 1; i <= steps; i++) {
      fire('pointermove', x0 + (x1-x0)*i/steps, y0 + (y1-y0)*i/steps);
      await new Promise(r=>setTimeout(r,35));
    }
    const midDrag = { overlay: !!document.querySelector('.w-80.opacity-90'), ghost: !!document.querySelector('.opacity-50') };
    fire('pointerup', x1, y1, { buttons: 0 });
    await new Promise(r=>setTimeout(r,800));

    const cardAfter = [...document.querySelectorAll('div.group')].find(c => c.textContent.includes(${JSON.stringify(info.cardTitle)}));
    if (!cardAfter) return { ok: false, reason: 'card gone' };
    const landed = cardAfter.closest('div.rounded-lg.border')?.querySelector('span.text-sm, span.font-medium')?.textContent?.trim();
    const allCols = [...document.querySelectorAll('div.rounded-lg.border')];
    return { ok: true, landed, midDrag,
      counts: allCols.map(c => ({ lane: c.querySelector('span.text-sm, span.font-medium')?.textContent?.trim(), n: [...c.querySelectorAll('div.group')].length })) };
  })()`);
  console.log("结果:", JSON.stringify(r, null, 1));

  ws.close();
  const pass = r.ok && r.landed === info.toTitle;
  console.log(`\n${pass ? "🎉 跨泳道拖拽成功" : "❌ 失败"} (从「${info.fromTitle}」→「${info.toTitle}」，落定「${r.landed}」)`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
