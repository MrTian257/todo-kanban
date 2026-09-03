# todo-kanban

Drag-and-drop kanban desktop app built on **Bun + Electrobun** (WebView2/CEF), with SQLite persistence and a bundled **MCP server (stdio)** that shares the same database file, so AI tools and the UI see the same data. UI text is Chinese (zh-CN); code comments are mixed EN/CN. Requires Bun >= 1.1.

## Layout

- `shared/db.ts` — the ONLY business-logic layer: `resolveDbPath()`, `openKanbanDb()`, `createStore(db)` + all types. App main process and MCP server both call this.
- `src/bun/index.ts` — Electrobun main process; `TodoRPC` schema (camelCase handlers) delegating to the store.
- `src/mainview/` — vanilla HTML/CSS/TS view (no framework); `index.ts` uses injectable `__KANBAN_API__` (real RPC in app, mock in harness).
- `mcp/server.ts` — MCP server, 12 snake_case tools (`list_projects`, `update_task_status`, ...) backed by zod schemas; docs in `mcp/README.md`.
- `tests/` — `db.test.ts`, `mcp.test.ts`, `view-harness.html` + generated `tests/.harness/`.
- `electrobun.config.ts` — entrypoints (`src/bun/index.ts`, `src/mainview/index.ts`) and copied assets.
- `opencode.json` — MCP server registration for opencode.

## Dev environment

- `bun install` — deps (electrobun, @modelcontextprotocol/sdk, zod via bun).
- `bun run dev` — dev with watch (`electrobun dev --watch`); `bun start` — dev without watch. Opens a GUI window; **fails headless** (CEF needs a display). DB + MCP are fully testable without it.

## Build & test

- `bun test` — 31 tests / 60 expects (~2s). Never touches the real DB: db tests use `mkdtempSync` temp DBs, mcp tests spawn `mcp/server.ts` with `KANBAN_DB_PATH` pointing at a temp file.
- `bunx tsc --noEmit` — strict typecheck (tsconfig is strict + `noUnusedLocals`/`noUnusedParameters`).
- `bun run mcp` — start MCP server on stdio (for clients/debugging).
- Build: `bun run build:dev` (= `bun install && electrobun build`), or `bun run build:stable` / `bun run build:canary` (`--env` variants). Outputs to `build/` and `artifacts/` (gitignored).
- View harness QA: `python -m http.server 8123` from repo root, then open `http://127.0.0.1:8123/todo-kanban/tests/.harness/index.html`.

## Conventions

- Tabs for indentation. Types live in `shared/db.ts`; `src/mainview/index.ts` mirrors them locally by hand (comment marks it).
- Naming: RPC = camelCase (`getProjects`, `setTaskStatus`), MCP = snake_case (`list_projects`, `update_task_status`) — both hit the same store functions.
- MCP tools: register with zod `inputSchema`; wrap handler in `guard(() => ...)` which returns `ok(data)` or `fail(message)` (JSON with `isError: true`). User-facing errors are Chinese.
- Status `todo|doing|done`, priority `high|medium|low` — string enums enforced by SQLite CHECK constraints; column order within a status is `position` ASC, renumbered by `moveTask`/`move_task`.
- Task descriptions are Markdown stored and returned **verbatim** — never transform or strip them.
- DB location: `KANBAN_DB_PATH` env override, else `%APPDATA%/todo-kanban/kanban.db` (win) / `~/Library/Application Support/...` (mac) / `$XDG_DATA_HOME/...` (linux). WAL mode allows app + MCP concurrent access.

## Pitfalls

- `tests/.harness/index.js` is a **committed build artifact**: after changing `src/mainview/index.ts`, rebuild it or the harness/QA serves stale code: `bun build src/mainview/index.ts --outdir tests/.harness --target browser --format esm --outfile index.js` (and commit the result).
- Always set `KANBAN_DB_PATH` to a temp path for any script/test touching data — otherwise you read/write the real user DB under `%APPDATA%`.
- MCP `update_task_status` takes `id`, not `task_id`. `move_task` takes `id` + optional `status`/`before_id`.
- `bunx tsc --noEmit` is the gate (README: use it when no LSP); unused locals/params are errors.
- The repo root moved at some point (README/mcp docs reference older absolute paths like `C:\workspace\desktop\可拖拽代办`) — trust relative paths.
