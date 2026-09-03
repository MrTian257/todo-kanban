// node_modules/electrobun/dist/api/shared/rpc.ts
var MAX_ID = 10000000000;
var DEFAULT_MAX_REQUEST_TIME = 1000;
function missingTransportMethodError(methods, action) {
  const methodsString = methods.map((m) => `"${m}"`).join(", ");
  return new Error(`This RPC instance cannot ${action} because the transport did not provide one or more of these methods: ${methodsString}`);
}
function createRPC(options = {}) {
  let debugHooks = {};
  let transport = {};
  let requestHandler = undefined;
  function setTransport(newTransport) {
    if (transport.unregisterHandler)
      transport.unregisterHandler();
    transport = newTransport;
    transport.registerHandler?.(handler);
  }
  function setRequestHandler(h) {
    if (typeof h === "function") {
      requestHandler = h;
      return;
    }
    requestHandler = (method, params) => {
      const handlerFn = h[method];
      if (handlerFn)
        return handlerFn(params);
      const fallbackHandler = h._;
      if (!fallbackHandler)
        throw new Error(`The requested method has no handler: ${String(method)}`);
      return fallbackHandler(method, params);
    };
  }
  const { maxRequestTime = DEFAULT_MAX_REQUEST_TIME } = options;
  if (options.transport)
    setTransport(options.transport);
  if (options.requestHandler)
    setRequestHandler(options.requestHandler);
  if (options._debugHooks)
    debugHooks = options._debugHooks;
  let lastRequestId = 0;
  function getRequestId() {
    if (lastRequestId <= MAX_ID)
      return ++lastRequestId;
    return lastRequestId = 0;
  }
  const requestListeners = new Map;
  const requestTimeouts = new Map;
  function requestFn(method, ...args) {
    const params = args[0];
    return new Promise((resolve, reject) => {
      if (!transport.send)
        throw missingTransportMethodError(["send"], "make requests");
      const requestId = getRequestId();
      const request2 = {
        type: "request",
        id: requestId,
        method,
        params
      };
      requestListeners.set(requestId, { resolve, reject });
      if (maxRequestTime !== Infinity)
        requestTimeouts.set(requestId, setTimeout(() => {
          requestTimeouts.delete(requestId);
          requestListeners.delete(requestId);
          reject(new Error("RPC request timed out."));
        }, maxRequestTime));
      debugHooks.onSend?.(request2);
      transport.send(request2);
    });
  }
  const request = new Proxy(requestFn, {
    get: (target, prop, receiver) => {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      return (params) => requestFn(prop, params);
    }
  });
  const requestProxy = request;
  function sendFn(message, ...args) {
    const payload = args[0];
    if (!transport.send)
      throw missingTransportMethodError(["send"], "send messages");
    const rpcMessage = {
      type: "message",
      id: message,
      payload
    };
    debugHooks.onSend?.(rpcMessage);
    transport.send(rpcMessage);
  }
  const send = new Proxy(sendFn, {
    get: (target, prop, receiver) => {
      if (prop in target)
        return Reflect.get(target, prop, receiver);
      return (payload) => sendFn(prop, payload);
    }
  });
  const sendProxy = send;
  const messageListeners = new Map;
  const wildcardMessageListeners = new Set;
  function addMessageListener(message, listener) {
    if (!transport.registerHandler)
      throw missingTransportMethodError(["registerHandler"], "register message listeners");
    if (message === "*") {
      wildcardMessageListeners.add(listener);
      return;
    }
    if (!messageListeners.has(message))
      messageListeners.set(message, new Set);
    messageListeners.get(message).add(listener);
  }
  function removeMessageListener(message, listener) {
    if (message === "*") {
      wildcardMessageListeners.delete(listener);
      return;
    }
    messageListeners.get(message)?.delete(listener);
    if (messageListeners.get(message)?.size === 0)
      messageListeners.delete(message);
  }
  async function handler(message) {
    debugHooks.onReceive?.(message);
    if (!("type" in message))
      throw new Error("Message does not contain a type.");
    if (message.type === "request") {
      if (!transport.send || !requestHandler)
        throw missingTransportMethodError(["send", "requestHandler"], "handle requests");
      const { id, method, params } = message;
      let response;
      try {
        response = {
          type: "response",
          id,
          success: true,
          payload: await requestHandler(method, params)
        };
      } catch (error) {
        if (!(error instanceof Error))
          throw error;
        response = {
          type: "response",
          id,
          success: false,
          error: error.message
        };
      }
      debugHooks.onSend?.(response);
      transport.send(response);
      return;
    }
    if (message.type === "response") {
      const timeout = requestTimeouts.get(message.id);
      if (timeout != null)
        clearTimeout(timeout);
      requestTimeouts.delete(message.id);
      const { resolve, reject } = requestListeners.get(message.id) ?? {};
      requestListeners.delete(message.id);
      if (!message.success)
        reject?.(new Error(message.error));
      else
        resolve?.(message.payload);
      return;
    }
    if (message.type === "message") {
      for (const listener of wildcardMessageListeners)
        listener(message.id, message.payload);
      const listeners = messageListeners.get(message.id);
      if (!listeners)
        return;
      for (const listener of listeners)
        listener(message.payload);
      return;
    }
    throw new Error(`Unexpected RPC message type: ${message.type}`);
  }
  const proxy = { send: sendProxy, request: requestProxy };
  return {
    setTransport,
    setRequestHandler,
    request,
    requestProxy,
    send,
    sendProxy,
    addMessageListener,
    removeMessageListener,
    proxy
  };
}
function defineElectrobunRPC(_side, config) {
  const rpcOptions = {
    maxRequestTime: config.maxRequestTime,
    requestHandler: {
      ...config.handlers.requests,
      ...config.extraRequestHandlers
    },
    transport: {
      registerHandler: () => {}
    }
  };
  const rpc = createRPC(rpcOptions);
  const messageHandlers = config.handlers.messages;
  if (messageHandlers) {
    rpc.addMessageListener("*", (messageName, payload) => {
      const globalHandler = messageHandlers["*"];
      if (globalHandler) {
        globalHandler(messageName, payload);
      }
      const messageHandler = messageHandlers[messageName];
      if (messageHandler) {
        messageHandler(payload);
      }
    });
  }
  return rpc;
}

// node_modules/electrobun/dist/api/browser/index.ts
var WEBVIEW_ID = window.__electrobunWebviewId;
var RPC_SOCKET_PORT = window.__electrobunRpcSocketPort;

class Electroview {
  bunSocket;
  rpc;
  rpcHandler;
  constructor(config) {
    this.rpc = config.rpc;
    this.init();
  }
  init() {
    this.initSocketToBun();
    window.__electrobun.receiveMessageFromBun = this.receiveMessageFromBun.bind(this);
    if (this.rpc) {
      this.rpc.setTransport(this.createTransport());
    }
  }
  initSocketToBun() {
    if (!RPC_SOCKET_PORT || !WEBVIEW_ID) {
      return;
    }
    const socket = new WebSocket(`ws://localhost:${RPC_SOCKET_PORT}/socket?webviewId=${WEBVIEW_ID}`);
    this.bunSocket = socket;
    socket.addEventListener("open", () => {});
    socket.addEventListener("message", async (event) => {
      const message = event.data;
      if (typeof message === "string") {
        try {
          const encryptedPacket = JSON.parse(message);
          const decrypted = await window.__electrobun_decrypt(encryptedPacket.encryptedData, encryptedPacket.iv, encryptedPacket.tag);
          this.rpcHandler?.(JSON.parse(decrypted));
        } catch (err) {
          console.error("Error parsing bun message:", err);
        }
      } else if (message instanceof Blob) {} else {
        console.error("UNKNOWN DATA TYPE RECEIVED:", event.data);
      }
    });
    socket.addEventListener("error", (event) => {
      console.error("Socket error:", event);
    });
    socket.addEventListener("close", (_event) => {});
  }
  createTransport() {
    const that = this;
    return {
      send(message) {
        try {
          const messageString = JSON.stringify(message);
          that.bunBridge(messageString);
        } catch (error) {
          console.error("bun: failed to serialize message to webview", error);
        }
      },
      registerHandler(handler) {
        that.rpcHandler = handler;
      }
    };
  }
  async bunBridge(msg) {
    if (this.bunSocket?.readyState === WebSocket.OPEN) {
      try {
        const { encryptedData, iv, tag } = await window.__electrobun_encrypt(msg);
        const encryptedPacket = {
          encryptedData,
          iv,
          tag
        };
        const encryptedPacketString = JSON.stringify(encryptedPacket);
        this.bunSocket.send(encryptedPacketString);
        return;
      } catch (error) {
        console.error("Error sending message to bun via socket:", error);
      }
    }
    window.__electrobunBunBridge?.postMessage(msg);
  }
  receiveMessageFromBun(msg) {
    if (this.rpcHandler) {
      this.rpcHandler(msg);
    }
  }
  static defineRPC(config) {
    return defineElectrobunRPC("webview", {
      ...config,
      extraRequestHandlers: {
        evaluateJavascriptWithResponse: ({ script }) => {
          return new Promise((resolve) => {
            try {
              const resultFunction = new Function(script);
              const result = resultFunction();
              if (result instanceof Promise) {
                result.then((resolvedResult) => {
                  resolve(resolvedResult);
                }).catch((error) => {
                  console.error("bun: async script execution failed", error);
                  resolve(String(error));
                });
              } else {
                resolve(result);
              }
            } catch (error) {
              console.error("bun: failed to eval script", error);
              resolve(String(error));
            }
          });
        }
      }
    });
  }
}
var Electrobun = {
  Electroview
};
var browser_default = Electrobun;

// src/mainview/index.ts
function createRpcApi() {
  const rpc = Electroview.defineRPC({
    maxRequestTime: 5000,
    handlers: {
      requests: {},
      messages: {
        dataChanged: (snap) => applySnapshot(snap)
      }
    }
  });
  const electrobun = new browser_default.Electroview({ rpc });
  const req = electrobun.rpc.request;
  return {
    getProjects: () => req.getProjects({}),
    createProject: (p) => req.createProject(p),
    updateProject: (p) => req.updateProject(p),
    deleteProject: (p) => req.deleteProject(p),
    getTasks: (p) => req.getTasks(p),
    getTask: (p) => req.getTask(p),
    createTask: (p) => req.createTask(p),
    updateTask: (p) => req.updateTask(p),
    setTaskStatus: (p) => req.setTaskStatus(p),
    moveTask: (p) => req.moveTask(p),
    deleteTask: (p) => req.deleteTask(p),
    getStats: (p) => req.getStats(p)
  };
}
var injected = window.__KANBAN_API__;
var api = injected ?? createRpcApi();
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function avatarColor(name) {
  const palette = ["#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];
  let h = 0;
  for (const ch of name || "?")
    h = h * 31 + ch.charCodeAt(0) >>> 0;
  return palette[h % palette.length];
}
function initial(name) {
  if (!name || !name.trim())
    return "?";
  return name.trim().charAt(0);
}
function shortPreview(md) {
  const t = md.replace(/```[\s\S]*?```/g, " ").replace(/[#>*`_~\[\]()!]/g, "").replace(/\s+/g, " ").trim();
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}
var FTOKEN = "\x00F";
var QTOKEN = "\x00Q";
function renderMarkdown(md) {
  return renderMd(md, { escaped: false, fenced: [], quotes: [] });
}
function renderMd(src, ctx) {
  let s = src.replace(/\r\n/g, `
`);
  if (!ctx.escaped) {
    s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
      const lines = code.trim().split(`
`);
      if (lines.length > 1 && /^[a-zA-Z0-9_+#.-]{1,20}$/.test(lines[0].trim()))
        lines.shift();
      ctx.fenced.push(esc(lines.join(`
`)));
      return FTOKEN + (ctx.fenced.length - 1) + "\x00";
    });
    s = extractQuotes(s, ctx);
    s = esc(s);
    ctx.escaped = true;
  }
  const out = [];
  for (const block of splitBlocks(s))
    out.push(renderBlock(block, ctx));
  let html = out.join("");
  html = html.replace(/\u0000F(\d+)\u0000/g, (_m, i) => `<pre><code>${ctx.fenced[Number(i)]}</code></pre>`);
  html = html.replace(/\u0000Q(\d+)\u0000/g, (_m, i) => `<blockquote>${renderMd(ctx.quotes[Number(i)], { escaped: false, fenced: ctx.fenced, quotes: ctx.quotes })}</blockquote>`);
  return html;
}
function extractQuotes(s, ctx) {
  const lines = s.split(`
`);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*>/.test(lines[i])) {
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        inner.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      ctx.quotes.push(inner.join(`
`));
      out.push(QTOKEN + (ctx.quotes.length - 1) + "\x00");
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join(`
`);
}
function splitBlocks(s) {
  const out = [];
  let cur = [];
  for (const line of s.split(`
`)) {
    if (/^\s*$/.test(line)) {
      if (cur.length) {
        out.push(cur.join(`
`));
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length)
    out.push(cur.join(`
`));
  return out;
}
function renderBlock(block, ctx) {
  const trimmed = block.trim();
  const token = /^\u0000([FQ])(\d+)\u0000$/.exec(trimmed);
  if (token)
    return token[1] === "F" ? `<pre><code>${ctx.fenced[Number(token[2])]}</code></pre>` : trimmed;
  const h = /^(#{1,6})\s+(.+)$/.exec(trimmed);
  if (h) {
    const n = h[1].length;
    return `<h${n}>${inline(h[2])}</h${n}>`;
  }
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed))
    return "<hr>";
  const lines = block.split(`
`);
  if (/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[0]))
    return renderList(lines);
  if (lines.every((l) => /^(?: {4}|\t)/.test(l))) {
    const code = lines.map((l) => l.replace(/^(?: {4}|\t)/, "")).join(`
`);
    return `<pre><code>${code}</code></pre>`;
  }
  return `<p>${inline(lines.join(" "))}</p>`;
}
function renderList(lines) {
  const raw = [];
  for (const line of lines) {
    const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (m) {
      const indent = m[1].length;
      const level = Math.min(2, Math.floor(indent / 2));
      const content = m[3];
      const tm = /^\[([ xX])\]\s+(.*)$/.exec(content);
      const body = tm ? `<label class="task-item"><input type="checkbox" disabled${tm[1].toLowerCase() === "x" ? " checked" : ""}> ${inline(tm[2])}</label>` : inline(content);
      raw.push({ level, isOl: /^\d/.test(m[2]), body });
    } else if (raw.length) {
      raw[raw.length - 1].body += " " + inline(line.trim());
    }
  }
  if (!raw.length)
    return "";
  const minLevel = Math.min(...raw.map((r) => r.level));
  for (const r of raw)
    r.level -= minLevel;
  const top = [];
  let i = 0;
  while (i < raw.length) {
    const it = raw[i];
    if (it.level === 0) {
      const node = { body: it.body, isOl: it.isOl, children: [] };
      i++;
      while (i < raw.length && raw[i].level === 1) {
        node.children.push({ body: raw[i].body, isOl: raw[i].isOl, children: [] });
        i++;
      }
      top.push(node);
    } else {
      i++;
      if (top.length) {
        top[top.length - 1].children.push({ body: it.body, isOl: it.isOl, children: [] });
      } else {
        top.push({ body: it.body, isOl: it.isOl, children: [] });
      }
    }
  }
  let html = `<${top[0].isOl ? "ol" : "ul"}>`;
  for (const node of top) {
    html += `<li>${node.body}`;
    if (node.children.length) {
      html += `<${node.children[0].isOl ? "ol" : "ul"}>`;
      for (const c of node.children)
        html += `<li>${c.body}</li>`;
      html += `</${node.children[0].isOl ? "ol" : "ul"}>`;
    }
    html += "</li>";
  }
  html += `</${top[0].isOl ? "ol" : "ul"}>`;
  return html;
}
function inline(s) {
  let t = s;
  t = t.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, alt, url, title) => {
    const ttl = title ? ` title="${title}"` : "";
    return `<img src="${url}" alt="${alt}"${ttl}>`;
  });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_m, text, url, title) => {
    const ttl = title ? ` title="${title}"` : "";
    return `<a href="${url}" target="_blank" rel="noopener noreferrer"${ttl}>${text}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return t;
}
window.__KANBAN_RENDER__ = renderMarkdown;
var COLUMNS = [
  { id: "todo", name: "待办", cls: "todo" },
  { id: "doing", name: "进行中", cls: "doing" },
  { id: "done", name: "已完成", cls: "done" }
];
var PRIORITY = {
  high: { label: "高", cls: "high" },
  medium: { label: "中", cls: "medium" },
  low: { label: "低", cls: "low" }
};
var projects = [];
var tasks = [];
var currentProjectId = null;
var countsByProject = new Map;
var draggedId = null;
var editingTaskId = null;
var editingProjectId = null;
function renderHeader() {
  const title = document.getElementById("projectTitle");
  const p = projects.find((x) => x.id === currentProjectId);
  title.textContent = p ? p.name : "—";
}
function renderSidebar() {
  const list = document.getElementById("projectList");
  const empty = document.getElementById("sidebarEmpty");
  list.innerHTML = "";
  empty.style.display = projects.length ? "none" : "block";
  for (const p of projects) {
    const li = document.createElement("li");
    li.className = "project-item" + (p.id === currentProjectId ? " active" : "");
    li.dataset["id"] = String(p.id);
    const count = countsByProject.get(p.id) ?? 0;
    li.innerHTML = `<span class="project-name">${esc(p.name)}</span>` + `<span class="project-count">${count}</span>` + '<button class="project-del" title="删除项目">×</button>';
    li.querySelector(".project-name").addEventListener("click", () => void switchProject(p.id));
    li.querySelector(".project-del").addEventListener("click", (e) => {
      e.stopPropagation();
      deleteProject(p);
    });
    list.appendChild(li);
  }
}
function renderBoard() {
  const board = document.getElementById("board");
  const empty = document.getElementById("boardEmpty");
  board.innerHTML = "";
  if (projects.length === 0 || currentProjectId === null) {
    empty.classList.add("show");
    return;
  }
  empty.classList.remove("show");
  for (const col of COLUMNS) {
    const list = tasks.filter((t) => t.status === col.id).sort((a, b) => a.position - b.position);
    const section = document.createElement("section");
    section.className = "column";
    section.innerHTML = '<div class="col-head">' + `<div class="col-title"><span class="dot ${col.cls}"></span>${col.name} <span class="count">${list.length}</span></div>` + `<button class="add-col" data-col="${col.id}" title="新增到本列">+</button>` + "</div>" + `<div class="col-body" data-status="${col.id}"></div>`;
    const body = section.querySelector(".col-body");
    if (list.length === 0) {
      body.innerHTML = '<div class="empty">暂无任务,拖入或点击 + 添加</div>';
    } else {
      for (const t of list)
        body.appendChild(buildCard(t));
    }
    bindDragBody(body);
    section.querySelector(".add-col").addEventListener("click", () => openTaskModal(null, col.id));
    board.appendChild(section);
  }
}
function buildCard(t) {
  const p = PRIORITY[t.priority] ?? PRIORITY.medium;
  const el = document.createElement("article");
  el.className = "card";
  el.draggable = true;
  el.dataset["id"] = String(t.id);
  const av = `<div class="avatar" style="background:${avatarColor(t.assignee)}">${esc(initial(t.assignee))}</div>`;
  const name = t.assignee ? `<span class="assignee-name">${esc(t.assignee)}</span>` : "";
  const desc = t.description ? `<div class="card-desc">${esc(shortPreview(t.description))}</div>` : "";
  el.innerHTML = '<button class="del" title="删除">×</button>' + `<div class="card-title">${esc(t.title)}</div>` + desc + `<div class="card-foot"><span class="badge ${p.cls}">${p.label}</span><div class="assignee">${av}${name}</div></div>`;
  el.addEventListener("dragstart", (e) => {
    draggedId = String(t.id);
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(t.id));
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    draggedId = null;
  });
  el.addEventListener("click", (e) => {
    if (e.target.classList.contains("del"))
      return;
    openTaskModal(t);
  });
  el.querySelector(".del").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`确认删除任务「${t.title}」？`))
      return;
    await api.deleteTask({ id: t.id });
    await reload();
  });
  return el;
}
function getDragAfterElement(container, y) {
  const els = Array.from(container.querySelectorAll(".card:not(.dragging)"));
  let closest = {
    offset: Number.NEGATIVE_INFINITY,
    element: null
  };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset)
      closest = { offset, element: child };
  }
  return closest.element;
}
function bindDragBody(body) {
  body.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    body.classList.add("drag-over");
  });
  body.addEventListener("dragleave", (e) => {
    if (!body.contains(e.relatedTarget))
      body.classList.remove("drag-over");
  });
  body.addEventListener("drop", async (e) => {
    e.preventDefault();
    body.classList.remove("drag-over");
    const targetCol = body.dataset["status"];
    if (!targetCol)
      return;
    const id = Number(draggedId ?? e.dataTransfer?.getData("text/plain"));
    if (Number.isNaN(id))
      return;
    const after = getDragAfterElement(body, e.clientY);
    const beforeId = after ? Number(after.dataset["id"]) : null;
    await api.moveTask({ id, status: targetCol, beforeId });
    await reload();
  });
}
async function refreshProjects() {
  projects = await api.getProjects();
  const entries = await Promise.all(projects.map(async (p) => [p.id, (await api.getTasks({ projectId: p.id })).length]));
  countsByProject = new Map(entries);
}
async function reload() {
  if (currentProjectId !== null) {
    tasks = await api.getTasks({ projectId: currentProjectId });
    countsByProject.set(currentProjectId, tasks.length);
  }
  renderHeader();
  renderSidebar();
  renderBoard();
}
function applySnapshot(snap) {
  if (draggedId !== null)
    return;
  projects = snap.projects;
  countsByProject = new Map(snap.projects.map((p) => [p.id, p.total]));
  if (currentProjectId !== null && !snap.projects.some((p) => p.id === currentProjectId)) {
    currentProjectId = snap.projects.length > 0 ? snap.projects[0].id : null;
  }
  tasks = currentProjectId !== null ? snap.tasks.filter((t) => t.project_id === currentProjectId) : [];
  renderHeader();
  renderSidebar();
  renderBoard();
}
async function switchProject(id) {
  currentProjectId = id;
  await reload();
}
async function deleteProject(p) {
  const n = countsByProject.get(p.id) ?? 0;
  const msg = n > 0 ? `项目「${p.name}」内有 ${n} 个任务,删除后将一并删除。确定?` : `确定删除项目「${p.name}」?`;
  if (!confirm(msg))
    return;
  await api.deleteProject({ id: p.id });
  countsByProject.delete(p.id);
  if (currentProjectId === p.id) {
    currentProjectId = projects.some((x) => x.id !== p.id) ? projects.find((x) => x.id !== p.id).id : null;
  }
  await refreshProjects();
  await reload();
}
function openModalEl(id) {
  document.getElementById(id).classList.add("open");
}
function closeModalEl(id) {
  document.getElementById(id).classList.remove("open");
}
function openProjectModal(p) {
  editingProjectId = p?.id ?? null;
  document.getElementById("projectModalTitle").textContent = p ? "编辑项目" : "新增项目";
  document.getElementById("f-pname").value = p?.name ?? "";
  document.getElementById("f-pdesc").value = p?.description ?? "";
  document.getElementById("err-pname").classList.remove("show");
  openModalEl("projectModal");
  document.getElementById("f-pname").focus();
}
async function saveProject() {
  const name = document.getElementById("f-pname").value.trim();
  const err = document.getElementById("err-pname");
  if (!name) {
    err.classList.add("show");
    document.getElementById("f-pname").focus();
    return;
  }
  const description = document.getElementById("f-pdesc").value;
  if (editingProjectId !== null) {
    await api.updateProject({ id: editingProjectId, name, description });
  } else {
    const created = await api.createProject({ name, description });
    currentProjectId = created.id;
  }
  closeModalEl("projectModal");
  await refreshProjects();
  await reload();
}
function openTaskModal(task, presetStatus) {
  editingTaskId = task?.id ?? null;
  document.getElementById("taskModalTitle").textContent = task ? "编辑任务" : "新增任务";
  document.getElementById("f-ttitle").value = task?.title ?? "";
  document.getElementById("f-tdesc").value = task?.description ?? "";
  document.getElementById("f-tpriority").value = task?.priority ?? "medium";
  document.getElementById("f-tassignee").value = task?.assignee ?? "";
  document.getElementById("f-tstatus").value = task?.status ?? presetStatus ?? "todo";
  document.getElementById("err-ttitle").classList.remove("show");
  showEditTab();
  openModalEl("taskModal");
  document.getElementById("f-ttitle").focus();
}
async function saveTask() {
  const fTitle = document.getElementById("f-ttitle");
  const title = fTitle.value.trim();
  const err = document.getElementById("err-ttitle");
  if (!title) {
    err.classList.add("show");
    fTitle.focus();
    return;
  }
  const description = document.getElementById("f-tdesc").value;
  const priority = document.getElementById("f-tpriority").value;
  const assignee = document.getElementById("f-tassignee").value.trim();
  const status = document.getElementById("f-tstatus").value;
  if (editingTaskId !== null) {
    await api.updateTask({ id: editingTaskId, title, description, priority, assignee });
    const cur = tasks.find((t) => t.id === editingTaskId);
    if (cur && cur.status !== status)
      await api.setTaskStatus({ id: editingTaskId, status });
  } else {
    if (currentProjectId === null)
      return;
    await api.createTask({ projectId: currentProjectId, title, description, status, priority, assignee });
  }
  closeModalEl("taskModal");
  await reload();
}
function showEditTab() {
  document.getElementById("tabEdit").classList.add("active");
  document.getElementById("tabPreview").classList.remove("active");
  document.getElementById("f-tdesc").classList.remove("hidden");
  document.getElementById("mdPreview").classList.add("hidden");
}
function showPreviewTab() {
  document.getElementById("tabEdit").classList.remove("active");
  document.getElementById("tabPreview").classList.add("active");
  document.getElementById("f-tdesc").classList.add("hidden");
  const preview = document.getElementById("mdPreview");
  preview.classList.remove("hidden");
  preview.innerHTML = renderMarkdown(document.getElementById("f-tdesc").value);
}
document.getElementById("newProjectBtn").addEventListener("click", () => openProjectModal(null));
document.getElementById("addTaskBtn").addEventListener("click", () => {
  if (currentProjectId !== null)
    openTaskModal(null);
});
document.getElementById("saveProjectBtn").addEventListener("click", () => void saveProject());
document.getElementById("cancelProjectBtn").addEventListener("click", () => closeModalEl("projectModal"));
document.getElementById("saveTaskBtn").addEventListener("click", () => void saveTask());
document.getElementById("cancelTaskBtn").addEventListener("click", () => closeModalEl("taskModal"));
document.getElementById("tabEdit").addEventListener("click", showEditTab);
document.getElementById("tabPreview").addEventListener("click", showPreviewTab);
for (const id of ["projectModal", "taskModal"]) {
  document.getElementById(id).addEventListener("click", (e) => {
    if (e.target === e.currentTarget)
      closeModalEl(id);
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeModalEl("projectModal");
    closeModalEl("taskModal");
  }
});
async function init() {
  await refreshProjects();
  renderSidebar();
  if (projects.length === 0) {
    currentProjectId = null;
    renderHeader();
    renderBoard();
  } else {
    currentProjectId = projects[0].id;
    await reload();
  }
}
init().then(() => {
  window.__KANBAN_READY__ = true;
});
