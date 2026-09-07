// 验证：整卡拖拽（用户真实手势 = 抓卡片主体）+ 按钮点击不受影响
// 前置: dev server 1420 + chrome --remote-debugging-port=9222
const HTTP = "http://127.0.0.1:9222";

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
  const list = await (await fetch(`${HTTP}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
  const ws = await connect(page.webSocketDebuggerUrl);
  await send(ws, "Runtime.enable");
  await send(ws, "Page.enable");

  let pass = true;

  // ── 场景1：从卡片主体（标题区域）拖到「进行中」泳道 ──
  await send(ws, "Page.reload", { ignoreCache: true });
  await sleep(3000);
  await evalJs(ws, `location.hash = '#/project/demo-project'`);
  await sleep(1500);

  const dragBody = await evalJs(ws, `(async () => {
    const grip = document.querySelector('div.cursor-grab');
    if (!grip) return { ok: false, reason: 'no grip' };
    const card = grip.closest('div.group');
    if (!card) return { ok: false, reason: 'no card' };
    const fromCol = card.closest('div.rounded-lg.border');
    const laneTitle = (c) => c.querySelector('span.text-sm, span.font-medium')?.textContent?.trim();
    const allCols = [...document.querySelectorAll('div.rounded-lg.border')].filter(c => [...c.querySelectorAll('div.cursor-grab')].length > 0);
    const toCol = allCols.find(c => c !== fromCol && laneTitle(c) === '进行中');
    if (!toCol) return { ok: false, reason: 'no toCol, lanes=' + allCols.map(laneTitle).join('/') };
    const title = card.querySelector('span.truncate');
    const g = title.getBoundingClientRect(); // 用户抓的是标题/卡片主体
    const t = toCol.getBoundingClientRect();
    const x0 = g.x + g.width/2, y0 = g.y + g.height/2;
    const x1 = t.x + t.width/2, y1 = t.y + Math.min(t.height/2, 220);
    const fire = (type, x, y, extra={}) => {
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 9, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: 1, ...extra,
      });
      card.dispatchEvent(ev);
    };
    fire('pointerdown', x0, y0);
    await new Promise(r=>setTimeout(r,60));
    for (let i = 1; i <= 14; i++) {
      fire('pointermove', x0 + (x1-x0)*i/14, y0 + (y1-y0)*i/14);
      await new Promise(r=>setTimeout(r,35));
    }
    const midDrag = { overlay: !!document.querySelector('.w-80.opacity-90'), ghost: !!document.querySelector('.opacity-50') };
    fire('pointerup', x1, y1, { buttons: 0 });
    await new Promise(r=>setTimeout(r,800));
    const cardAfter = [...document.querySelectorAll('div.group')].find(c => c.textContent.includes('泳道管理'));
    if (!cardAfter) return { ok: false, reason: 'card gone' };
    const landed = laneTitle(cardAfter.closest('div.rounded-lg.border'));
    return { ok: true, from: laneTitle(fromCol), landed, midDrag };
  })()`);
  const s1 = dragBody.ok && dragBody.landed === "进行中";
  console.log(`场景1 抓卡片主体拖拽: ${s1 ? "✅" : "❌"} ${JSON.stringify(dragBody)}`);
  if (!s1) pass = false;

  // ── 场景2：卡片上按钮点击（不移动）不误触拖拽、功能正常 ──
  await send(ws, "Page.reload", { ignoreCache: true });
  await sleep(3000);
  await evalJs(ws, `location.hash = '#/project/demo-project'`);
  await sleep(1500);

  const clickBtn = await evalJs(ws, `(async () => {
    const grip = document.querySelector('div.cursor-grab');
    const card = grip.closest('div.group');
    const btn = [...card.querySelectorAll('button')].find(b => /提交|无提交/.test(b.textContent));
    if (!btn) return { ok: false, reason: 'no commit btn' };
    const r = btn.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 11, pointerType: 'mouse', isPrimary: true,
      clientX: r.x + r.width/2, clientY: r.y + r.height/2, button: 0, buttons: 1,
    });
    card.dispatchEvent(ev);
    await new Promise(res=>setTimeout(res,80));
    // pointerup 原地（无位移 → 不构成拖拽）
    card.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, composed: true,
      pointerId: 11, pointerType: 'mouse', isPrimary: true,
      clientX: r.x + r.width/2, clientY: r.y + r.height/2, button: 0, buttons: 0,
    }));
    btn.click();
    await new Promise(res=>setTimeout(res,400));
    const overlay = !!document.querySelector('.w-80.opacity-90');
    const ghost = !!document.querySelector('.opacity-50');
    const expanded = card.textContent.includes('MCP') || card.querySelectorAll('div.mt-1.border-t, .border-t').length > 0;
    return { ok: true, noDrag: !overlay && !ghost, expanded };
  })()`);
  const s2 = clickBtn.ok && clickBtn.noDrag;
  console.log(`场景2 点击按钮无误触拖拽: ${s2 ? "✅" : "❌"} ${JSON.stringify(clickBtn)}`);
  if (!s2) pass = false;

  ws.close();
  console.log(pass ? "\n🎉 全部通过" : "\n❌ 存在失败");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
