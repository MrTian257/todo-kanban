// 验证：窗口从小变大后，跨泳道拖拽落点是否正确（用户报告的 bug 场景）
// 流程：900x600 加载 → CDP resize 到 1600x1000 → 从「待办」拖到「进行中」
// 落点选目标泳道下半部空白区（大窗口下 closestCorners 最易误判的区域）
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
  await send(ws, "Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 600,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await send(ws, "Page.reload", { ignoreCache: true });
  await sleep(3000);
  await evalJs(ws, `location.hash = '#/project/demo-project'`);
  await sleep(1500);

  // ── 窗口变大（用户场景）──
  await send(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1000,
    deviceScaleFactor: 0,
    mobile: false,
  });
  await sleep(1200);

  const measure = await evalJs(ws, `(() => {
    const cols = [...document.querySelectorAll('div.rounded-lg.border')].filter(c => c.querySelectorAll('div.cursor-grab').length > 0);
    const laneTitle = (c) => c.querySelector('span.text-sm, span.font-medium')?.textContent?.trim();
    return { lanes: cols.map(laneTitle), viewport: [innerWidth, innerHeight] };
  })()`);
  console.log("resize 后:", JSON.stringify(measure));

  // ── 拖拽：从「待办」第一张卡 → 「进行中」泳道下半部空白区 ──
  const result = await evalJs(ws, `(async () => {
    const cols = [...document.querySelectorAll('div.rounded-lg.border')].filter(c => c.querySelectorAll('div.cursor-grab').length > 0);
    const laneTitle = (c) => c.querySelector('span.text-sm, span.font-medium')?.textContent?.trim();
    const fromCol = cols.find(c => laneTitle(c) === '待办');
    const toCol = cols.find(c => laneTitle(c) === '进行中');
    if (!fromCol || !toCol) return { ok: false, reason: 'lanes=' + cols.map(laneTitle).join('/') };
    const card = fromCol.querySelector('div.group');
    const cardTitle = card.textContent.slice(0, 20);
    const g = card.getBoundingClientRect();
    const t = toCol.getBoundingClientRect();
    // 起点卡片中心；落点 = 目标泳道下半部空白（大窗口下最近角误判高发区）
    const x0 = g.x + g.width / 2, y0 = g.y + g.height / 2;
    const x1 = t.x + t.width / 2, y1 = t.y + t.height * 0.75;
    const fire = (type, x, y, extra = {}) => {
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 9, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: 1, ...extra,
      });
      card.dispatchEvent(ev);
    };
    fire('pointerdown', x0, y0);
    await new Promise(r => setTimeout(r, 60));
    let overLog = [];
    for (let i = 1; i <= 16; i++) {
      const x = x0 + (x1 - x0) * i / 16, y = y0 + (y1 - y0) * i / 16;
      fire('pointermove', x, y);
      if (i === 16) overLog.push({ i, x: Math.round(x), y: Math.round(y) });
      await new Promise(r => setTimeout(r, 35));
    }
    const midDrag = { overlay: !!document.querySelector('.w-80.opacity-90'), ghost: !!document.querySelector('.opacity-50') };
    fire('pointerup', x1, y1, { buttons: 0 });
    await new Promise(r => setTimeout(r, 900));
    const cols2 = [...document.querySelectorAll('div.rounded-lg.border')].filter(c => c.querySelectorAll('div.cursor-grab').length > 0);
    const cardAfter = [...document.querySelectorAll('div.group')].find(c => c.textContent.includes(cardTitle));
    if (!cardAfter) return { ok: false, reason: 'card gone' };
    const landed = laneTitle(cardAfter.closest('div.rounded-lg.border'));
    return { ok: true, cardTitle, landed, midDrag, dropAt: [Math.round(x1), Math.round(y1)] };
  })()`);
  const ok = result.ok && result.landed === "进行中";
  console.log(`大窗口拖拽（落点=目标泳道下部 75% 处）: ${ok ? "✅" : "❌"} ${JSON.stringify(result)}`);

  ws.close();
  console.log(ok ? "\n🎉 通过" : "\n❌ 失败");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
