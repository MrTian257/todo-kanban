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
    if (attempt >= 5) return "NET_FAIL:" + (e && e.cause ? e.cause.code : e.message);
    await new Promise((r) => setTimeout(r, 1500 * attempt));
    await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh", version: "1" } } }, {}, attempt);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid }, attempt);
    return post(body, extra, attempt + 1);
  }
}
await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh", version: "1" } } });
await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
const code = fs.readFileSync(process.argv[2], "utf8");
const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute_code", arguments: { code } } }, { "mcp-session-id": sid });
let out = r;
try { out = JSON.parse(r).result.content[0].text; } catch (e) {}
console.log(typeof out === "string" ? out.slice(0, 4000) : JSON.stringify(out).slice(0, 2000));
