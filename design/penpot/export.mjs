import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
const url = cfg.mcpServers.penpot.url;
const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const unSse = (t) => t.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n") || t;
let sid;
async function post(body, extra = {}, attempt = 1) {
  try {
    const res = await fetch(url, { method: "POST", headers: { ...base, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const raw = await res.text();
    if (res.headers.get("mcp-session-id")) sid = res.headers.get("mcp-session-id");
    return unSse(raw);
  } catch (e) {
    if (attempt >= 5) throw e;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh", version: "1" } } }, {}, attempt);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid }, attempt);
    return post(body, extra, attempt + 1);
  }
}
async function call(name, args, id) {
  const b = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, { "mcp-session-id": sid });
  try { return JSON.parse(b); } catch { return { raw: b }; }
}
await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh", version: "1" } } });
await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
const name = process.argv[2];
const outFile = process.argv[3];
const found = await call("execute_code", { code: 'var s = penpot.currentPage.root.children.filter(function(x){return x.name === ' + JSON.stringify(name) + ';})[0]; return s ? s.id : null;' }, 2);
const id = JSON.parse(found.result.content[0].text).result;
if (!id) { console.log("BOARD NOT FOUND: " + name); process.exit(2); }
let img = null;
for (let i = 0; i < 4 && !img; i++) {
  const r = await call("export_shape", { shapeId: id, format: "png" }, 3);
  img = (r.result && r.result.content || []).find((c) => c.type === "image");
  if (!img) { console.log("attempt " + (i + 1) + " no image: " + JSON.stringify(r).slice(0, 200)); await new Promise((x) => setTimeout(x, 1500)); }
}
if (!img) process.exit(3);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const buf = Buffer.from(img.data, "base64");
fs.writeFileSync(outFile, buf);
console.log("saved " + outFile + " (" + buf.length + " bytes)");
