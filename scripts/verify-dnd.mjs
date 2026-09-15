// CDP 验证：泳道看板拖拽（dnd-kit + 合成 PointerEvent——PointerSensor 监听 pointer 事件流，不校验 isTrusted）
// 覆盖：跨泳道 / 落到泳道空白区 / 泳道内精确重排 / 按钮点击不误触拖拽 / 窗口 resize 后落点仍正确
// 前置：dev server 运行在 :1420，Chrome 以远程调试端口打开该页面（默认 9222，可用 CDP_PORT 覆盖）
// 用法：CDP_PORT=9222 node scripts/verify-dnd.mjs
const PORT = process.env.CDP_PORT || "9222";
const HTTP = `http://127.0.0.1:${PORT}`;
const BOARD = "#/project/demo-project";

let seq = 0;
const pending = new Map();

// 单条请求超时：页面 reload / 目标被替换时 CDP 可能不再回包，没有超时脚本会永久挂住
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

/** 页面偶发不回包（reload 与 HMR/轮询重叠时）→ 超时重试一次，仍失败才算真失败 */
async function evalJs(ws, expression) {
  let r;
  try {
    r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  } catch (error) {
    if (!String(error.message).includes("超时")) throw error;
    await sleep(1000);
    r = await send(ws, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  }
  if (r.exceptionDetails) throw new Error("JS 异常: " + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** VERBOSE=1 时输出阶段进度：卡住时能看出停在哪一步 */
const VERBOSE = process.env.VERBOSE === "1";
const step = (message) => { if (VERBOSE) console.error(`[verify-dnd] ${message}`); };

/** 干净状态 + 无未捕获错误钩子：浏览器预览的数据在 sessionStorage 里，清掉才能回到初始 demoState */
async function openBoard(ws) {
  await evalJs(ws, `sessionStorage.clear()`);
  await send(ws, "Page.reload", { ignoreCache: true });
  await sleep(2500);
  await evalJs(ws, `(() => { window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message))); window.addEventListener('unhandledrejection', e => window.__errs.push(String(e.reason))); return 'ok'; })()`);
  // 真实点击导航：直接赋 location.hash 会被 react-router 记成 POP 阻断（测试假象）
  await evalJs(ws, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const press = el => { if (!el) throw new Error("导航元素缺失"); for (const t of ["pointerdown","pointerup"]) el.dispatchEvent(new PointerEvent(t,{bubbles:true,cancelable:true,button:0,pointerType:"mouse",isPrimary:true})); el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,button:0})); };
    if (!location.hash.includes("project/")) {
      press(document.querySelector("a[href='#/projects']")); await sleep(900);
      const project = document.querySelector("a[href='${BOARD}']");
      if (!project) throw new Error("项目入口缺失");
      press(project); await sleep(1100);
    }
    return location.hash;
  })()`);
  // 等布局稳定：冷启动时泳道宽度会随滚动条/字体加载变化，此时量到的落点会偏一列
  await evalJs(ws, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const sample = () => [...document.querySelectorAll("section[data-lane-id]")].map(s => Math.round(s.getBoundingClientRect().x * 10) / 10).join(",");
    let previous = sample();
    for (let i = 0; i < 12; i++) {
      await sleep(120);
      const current = sample();
      if (current === previous && document.querySelectorAll("section[data-lane-id] [data-task-id]").length > 0) return current;
      previous = current;
    }
    return "unstable:" + previous;
  })()`);
  await sleep(200);
}

const scenarioErrors = async (ws) => (await evalJs(ws, `window.__errs`)) ?? [];

/** 页面内完成一次拖拽：源 = 指定卡片，目标 = 指定泳道的滚动区（mode 决定落点） */
function dragScript(taskId, laneId, mode) {
  const srcSelector = `[data-task-id="${taskId}"]`;
  const orderSelector = `section[data-lane-id="${laneId}"] [data-task-id]`;
  return `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const SRC = ${JSON.stringify(srcSelector)}, LANE = ${JSON.stringify(`section[data-lane-id="${laneId}"]`)}, ORD = ${JSON.stringify(orderSelector)}, MODE = ${JSON.stringify(mode)};
    const src = document.querySelector(SRC);
    if (!src) return { ok: false, reason: '找不到拖拽源' };
    const from = src.closest('[data-lane-id]')?.dataset.laneId ?? null;
    const body = document.querySelector(LANE)?.querySelector('.tk-lane-scroll');
    if (!body) return { ok: false, reason: '找不到目标泳道' };
    const others = [...body.querySelectorAll('[data-task-id]')].filter(el => el !== src);
    const grab = src.querySelector('.tk-task-title') || src;
    const g = grab.getBoundingClientRect(), t = body.getBoundingClientRect();
    const x0 = g.x + g.width / 2, y0 = g.y + g.height / 2, x1 = t.x + t.width / 2;
    // empty = 最后一张卡下方的空白区；before-first = 第一张卡上沿；center = 泳道中部
    const y1 = MODE === 'empty'
      ? Math.min(t.bottom - 10, (others.length ? others[others.length - 1].getBoundingClientRect().bottom : t.top) + 24)
      : MODE === 'before-first'
        ? (others.length ? others[0].getBoundingClientRect().top + 8 : t.top + 10)
        : t.y + t.height / 2;
    const fire = (type, x, y, buttons) => src.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, button: 0, buttons,
    }));
    // 应用自己的落点判定（泳道体高亮 / 落点线）与几何位置必须一致，否则说明用到了过期的 droppable 尺寸
    const appTarget = () => {
      for (const s of document.querySelectorAll('section[data-lane-id]')) {
        const b = s.querySelector('.tk-lane-scroll');
        if (b.className.includes('bg-primary') || b.querySelector('.tk-drop-line')) return s.dataset.laneId;
      }
      return null;
    };
    const geometric = (x, y) => {
      for (const s of document.querySelectorAll('section[data-lane-id]')) {
        const b = s.querySelector('.tk-lane-scroll').getBoundingClientRect();
        if (x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) return s.dataset.laneId;
      }
      return null;
    };
    let mismatch = null;
    fire('pointerdown', x0, y0, 1);
    await sleep(60);
    // 必须越过 6px 激活距离并分多步移动，否则 dnd-kit 不会进入拖拽态
    for (let i = 1; i <= 16; i++) {
      const x = x0 + (x1 - x0) * i / 16, y = y0 + (y1 - y0) * i / 16;
      fire('pointermove', x, y, 1);
      await sleep(28);
      const app = appTarget(), geo = geometric(x, y);
      if (!mismatch && app && geo && app !== geo) mismatch = { step: i, app, geo };
    }
    await sleep(150);
    const board = document.querySelector('[data-testid=kanban]');
    const mid = { overlay: !!document.querySelector('[data-drag-overlay]'), dragging: src.getAttribute('data-dragging') === 'true', appTarget: appTarget(), geometric: geometric(x1, y1), mismatch, scrollLeft: board?.scrollLeft ?? null };
    fire('pointerup', x1, y1, 0);
    await sleep(700);
    const after = document.querySelector(SRC);
    return { ok: true, from, mid, to: after ? after.closest('[data-lane-id]')?.dataset.laneId ?? null : null, order: [...document.querySelectorAll(ORD)].map(el => el.dataset.taskId) };
  })()`;
}

// 总超时看门狗：CDP 卡住时（页面 reload 中目标被替换等）给出明确失败而不是永久挂住
const WATCHDOG_MS = 240_000;

async function main() {
  step("启动");
  const watchdog = setTimeout(() => {
    console.error(`FATAL: 验证超过 ${WATCHDOG_MS / 1000}s 未完成，已中断`);
    process.exit(2);
  }, WATCHDOG_MS);
  const list = await (await fetch(`${HTTP}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
  if (!page) throw new Error(`未找到 localhost:1420 页面（调试端口 ${PORT}）`);
  const ws = await connect(page.webSocketDebuggerUrl);
  step(`找到页面 ${page.url}`);
  await send(ws, "Runtime.enable");
  await send(ws, "Page.enable");

  step("CDP 已就绪");
  const results = [];
  const check = (name, ok, detail, errors = []) => {
    results.push(ok && errors.length === 0);
    console.log(`${ok && errors.length === 0 ? "✅" : "❌"} ${name} ${JSON.stringify(detail)}${errors.length ? " 未捕获错误=" + JSON.stringify(errors) : ""}`);
  };

  step("场景1 开始");
  // 场景1：整卡（抓标题）跨泳道 → 目标泳道中部
  await openBoard(ws);
  const s1 = await evalJs(ws, dragScript("demo-1", "swim-doing", "center"));
  check("场景1 跨泳道拖拽", s1.ok && s1.from === "swim-todo" && s1.to === "swim-doing" && s1.mid.overlay && s1.mid.dragging, s1, await scenarioErrors(ws));

  step("场景2 开始");
  // 场景2：拖到目标泳道最后一张卡下方的空白区（最容易失败的落点）
  await openBoard(ws);
  const s2 = await evalJs(ws, dragScript("demo-1", "swim-release", "empty"));
  check("场景2 落到泳道空白区", s2.ok && s2.to === "swim-release" && s2.order[s2.order.length - 1] === "demo-1", s2, await scenarioErrors(ws));

  step("场景3 开始");
  // 场景3：泳道内精确重排（第二张拖到第一张之前）
  await openBoard(ws);
  const s3 = await evalJs(ws, dragScript("demo-2", "swim-todo", "before-first"));
  check("场景3 泳道内精确重排", s3.ok && JSON.stringify(s3.order) === JSON.stringify(["demo-2", "demo-1", "demo-3"]), s3, await scenarioErrors(ws));

  step("场景4 开始");
  // 场景4：卡片上的按钮点击不得激活整卡拖拽（点提交展开按钮）
  await openBoard(ws);
  const s4 = await evalJs(ws, `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const card = document.querySelector('[data-task-id="demo-1"]');
    if (!card) return { ok: false, reason: '找不到卡片' };
    const btn = card.querySelector('button[aria-expanded]');
    if (!btn) return { ok: false, reason: '找不到展开按钮' };
    const r = btn.getBoundingClientRect();
    const fire = (type, buttons) => btn.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, pointerId: 11, pointerType: 'mouse', isPrimary: true,
      clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, buttons,
    }));
    fire('pointerdown', 1);
    await sleep(80);
    fire('pointerup', 0); // 原地抬起：无位移，不构成拖拽
    await sleep(400);
    return { ok: true, overlay: !!document.querySelector('[data-drag-overlay]'), dragging: card.getAttribute('data-dragging') === 'true', expanded: btn.getAttribute('aria-expanded') === 'true' };
  })()`);
  check("场景4 按钮点击不误触拖拽", s4.ok && !s4.overlay && !s4.dragging && s4.expanded, s4, await scenarioErrors(ws));

  step("场景5 开始");
  // 场景5：小窗口加载 → 放大窗口再拖到泳道空白区（落点必须按新布局计算）
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
  await openBoard(ws);
  await send(ws, "Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const s5 = await evalJs(ws, dragScript("demo-3", "swim-doing", "empty"));
  check("场景5 resize 后落点", s5.ok && s5.to === "swim-doing" && s5.order[s5.order.length - 1] === "demo-3", s5, await scenarioErrors(ws));
  await send(ws, "Emulation.clearDeviceMetricsOverride");
  ws.close();

  step("全部场景结束");
  clearTimeout(watchdog);
  const pass = results.every(Boolean);
  console.log(pass ? "\n🎉 全部通过" : "\n❌ 存在失败");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(2);
});
