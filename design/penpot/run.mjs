// 把 draw-board.js 通过 Penpot MCP (execute_code) 送到画布执行
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let mode = "light";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--mode") mode = argv[i + 1];
  else if (argv[i].startsWith("--mode=")) mode = argv[i].split("=")[1];
}
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
const url = cfg.mcpServers.penpot.url;
const code = 'var MODE = "' + mode + '";\n' + fs.readFileSync(path.join(here, "icons.generated.js"), "utf8") + "\n" + fs.readFileSync(path.join(here, "draw-board.js"), "utf8");

const base = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const unSse = (t) => t.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n") || t;
let sid;

async function post(body, extra = {}, attempt = 1) {
  try {
    const res = await fetch(url, { method: "POST", headers: { ...base, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
    const raw = await res.text();
    if (res.headers.get("mcp-session-id")) sid = res.headers.get("mcp-session-id");
    return { status: res.status, body: unSse(raw) };
  } catch (err) {
    if (attempt >= 4) throw err;
    console.error("[retry " + attempt + "] " + (err && err.message));
    await new Promise((r) => setTimeout(r, 1200 * attempt));
    if (body.method !== "initialize") {
      await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh-penpot-draw", version: "1" } } });
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid }, 2);
    }
    return post(body, extra, attempt + 1);
  }
}

await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh-penpot-draw", version: "1" } } });
await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-session-id": sid });
const r = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "execute_code", arguments: { code } } }, { "mcp-session-id": sid });
console.log("HTTP " + r.status + " (mode=" + mode + ", payload=" + code.length + " bytes)");
console.log(r.body.slice(0, 4000));
