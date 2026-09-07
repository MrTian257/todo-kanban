// 探测日期弹层 DOM 结构（辅助 verify-daterange）
const HTTP = "http://127.0.0.1:9222";

async function main() {
  const list = await (await fetch(`${HTTP}/json`)).json();
  const page = list.find((t) => t.type === "page" && t.url.includes("localhost:1420"));
  if (!page) throw new Error("no page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pend = new Map();
  ws.addEventListener("message", (ev) => {
    const d = JSON.parse(ev.data);
    if (d.id && pend.has(d.id)) {
      pend.get(d.id)(d.result);
      pend.delete(d.id);
    }
  });
  await new Promise((r) => (ws.onopen = r));
  const send = (m, p = {}) =>
    new Promise((r) => {
      const id = ++seq;
      pend.set(id, r);
      ws.send(JSON.stringify({ id, method: m, params: p }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.reload");
  await new Promise((r) => setTimeout(r, 2500));

  const r = await send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => {
      location.hash = '#/project/demo-project/todo/new';
      await new Promise(r=>setTimeout(r,1200));
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('选择日期范围'));
      if (!btn) return {step:'find-trigger', ok:false, url: location.hash};
      btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
      await new Promise(r=>setTimeout(r,600));
      // 可见性判断：rect 尺寸 > 0（fixed 定位元素 offsetParent 为 null，不可用）
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const wrap = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find(visible)
        || (document.querySelector('[role="dialog"]') && visible(document.querySelector('[role="dialog"]')) ? document.querySelector('[role="dialog"]') : null);
      if (!wrap) {
        const anyWrap = document.querySelectorAll('[data-radix-popper-content-wrapper]').length;
        const grid = document.querySelectorAll('[role="grid"]').length;
        return {step:'popover', ok:false, wraps:anyWrap, grids:grid, hash: location.hash};
      }
      const btns = [...wrap.querySelectorAll('button')];
      return {step:'ok', ok:true,
        sample: btns.slice(0,10).map(b=>({name:b.getAttribute('name'),txt:b.textContent.trim().slice(0,8),cls:(b.className||'').slice(0,50)})),
        total: btns.length};
    })()`,
  });
  console.log(JSON.stringify(r.result.value, null, 1));
  ws.close();
}

main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
