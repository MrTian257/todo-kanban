#!/bin/bash
# 一体化打包：本机构建当前平台 + 经 GitHub Actions 远程构建 macOS，产物统一收集。
#
# 用法：
#   ./build.sh                 # Windows 本机：打 Windows + 远程打 macOS；macOS 本机：打 macOS
#   ./build.sh --windows-only  # 只打 Windows（仅在 Windows 本机有效）
#   ./build.sh --mac-only      # 只打 macOS（Windows 上为远程，macOS 上为本机）
#
# 产物布局：
#   artifacts/windows/  exe ×2 + 安装包（nsis setup / msi）
#   artifacts/macos/    dmg + mcp-server 双架构
#   release/            运行目录：Windows 桌面端与 mcp-server 同步更新（数据文件不动）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
ARTIFACTS="$ROOT/artifacts"
RELEASE="$ROOT/release"
MANIFEST="$ROOT/src-tauri/Cargo.toml"
MAC_WORKFLOW="build-macos.yml"
MAC_ARTIFACT="todo-kanban-macos"
CI_TIMEOUT_SEC=3600
CI_POLL_SEC=30

is_macos() { uname -s | grep -qi darwin; }

log()  { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf '\n错误：%s\n' "$*" >&2; exit 1; }

# ── 平台产物目录 ─────────────────────────────────────────
pkg_dir() { local p="$1"; mkdir -p "$ARTIFACTS/$p"; echo "$ARTIFACTS/$p"; }

# ── 版本号（Cargo.toml 第一个 version 字段） ─────────────
version() { sed -n 's/^version = "\([^"]*\)"/\1/p' "$MANIFEST" | head -1; }

# ── cargo target 目录探测（全局 config 可能重定向 shared-target） ──
target_dir() {
  local t
  for t in "$ROOT/src-tauri/target" "$HOME/.cargo/shared-target"; do
    [ -d "$t/release" ] && { echo "$t"; return 0; }
  done
  return 1
}

# ── Windows 本机构建 ─────────────────────────────────────
build_windows_local() {
  log "构建 Windows 桌面端（tauri build）..."
  (cd "$ROOT" && npm run tauri build)

  log "构建 Windows mcp-server..."
  (cd "$ROOT" && cargo build --release -p mcp-server --manifest-path "$MANIFEST")

  local t td out
  t="$(target_dir)" || fail "找不到 cargo 产物目录（src-tauri/target 或 ~/.cargo/shared-target）"
  td="$t/release"
  [ -f "$td/todo-kanban.exe" ] || fail "未找到 todo-kanban.exe（$td）"
  [ -f "$td/mcp-server.exe" ] || fail "未找到 mcp-server.exe（$td）"

  out="$(pkg_dir windows)"
  cp "$td/todo-kanban.exe" "$out/"
  cp "$td/mcp-server.exe" "$out/"
  for b in nsis msi; do
    [ -d "$td/bundle/$b" ] && cp "$td/bundle/$b/"* "$out/" || true
  done

  # 运行目录同步（不触碰数据文件）
  mkdir -p "$RELEASE"
  cp "$td/todo-kanban.exe" "$RELEASE/todo-kanban.exe"
  cp "$td/mcp-server.exe" "$RELEASE/mcp-server.exe"
  log "Windows 产物就绪：$out（release/ 运行目录已同步）"
}

# ── macOS 本机构建（在 macOS 上执行时） ──────────────────
build_macos_local() {
  log "构建 macOS 桌面端（dmg）..."
  (cd "$ROOT" && npm run tauri build -- --bundles dmg --ci)

  for arch in aarch64-apple-darwin x86_64-apple-darwin; do
    log "构建 mcp-server（$arch）..."
    rustup target add "$arch" >/dev/null
    (cd "$ROOT" && cargo build --release -p mcp-server --manifest-path "$MANIFEST" --target "$arch")
  done

  local t out
  t="$(target_dir)" || fail "找不到 cargo 产物目录"
  out="$(pkg_dir macos)"
  cp "$t/release/bundle/dmg/"*.dmg "$out/"
  cp "$t/aarch64-apple-darwin/release/mcp-server" "$out/mcp-server-aarch64-apple-darwin"
  cp "$t/x86_64-apple-darwin/release/mcp-server" "$out/mcp-server-x86_64-apple-darwin"
  log "macOS 产物就绪：$out"
}

# ── GitHub 凭据（GITHUB_TOKEN → gh auth token → git credential，绝不回显） ──
github_token() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then printf '%s' "$GITHUB_TOKEN"; return 0; fi
  if command -v gh >/dev/null 2>&1; then
    local t
    if t="$(gh auth token 2>/dev/null)" && [ -n "$t" ]; then printf '%s' "$t"; return 0; fi
  fi
  local cred pw
  cred="$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill 2>/dev/null)" || return 1
  pw="$(printf '%s\n' "$cred" | sed -n 's/^password=//p')"
  if [ -n "$pw" ]; then printf '%s' "$pw"; return 0; fi
  return 1
}

github_repo() {
  local url
  url="$(git remote get-url origin 2>/dev/null)" || return 1
  url="${url%.git}"
  printf '%s\n' "$url" | sed -E 's#^.*github\.com[:/]([^/]+/[^/]+)$#\1#'
}

# ── JSON 提取（python；GitHub API 响应字段解析） ─────────
json_get() { # json_get <json> <python 表达式（d 为解析后对象）>
  local py
  py="$(command -v python || command -v python3)" || fail "需要 python 解析 GitHub API 响应"
  printf '%s' "$1" | "$py" -c "import sys,json;d=json.load(sys.stdin);$2"
}

# ── macOS 远程构建（经 GitHub Actions） ──────────────────
build_macos_remote() {
  local token repo branch
  if ! token="$(github_token)"; then
    log "跳过 macOS 打包：未找到 GitHub 凭据。配置其一即可：安装 gh 并登录 / 设置环境变量 GITHUB_TOKEN / git 凭据助手已存 github.com。"
    return 0
  fi
  repo="$(github_repo)" || fail "无法解析 GitHub 仓库（git remote -v）"
  branch="$(git branch --show-current 2>/dev/null || echo main)"
  [ -n "$branch" ] || branch="main"

  local auth=(-H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json")

  log "触发 macOS 构建（GitHub Actions：$repo @ $branch）..."
  local http
  http="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" \
    "https://api.github.com/repos/$repo/actions/workflows/$MAC_WORKFLOW/dispatches" \
    -d "{\"ref\":\"$branch\"}")" || fail "触发请求失败（网络/凭据）"
  if [ "$http" = "404" ]; then
    fail "远端未找到 .github/workflows/$MAC_WORKFLOW：请先 git push 该文件到 $branch 后重试"
  fi
  [ "$http" = "204" ] || fail "触发 workflow 失败（HTTP $http）"

  # 触发有延迟：轮询取最新 run
  local run_id="" i json
  for i in $(seq 1 10); do
    json="$(curl -sS "${auth[@]}" \
      "https://api.github.com/repos/$repo/actions/workflows/$MAC_WORKFLOW/runs?per_page=1")" || true
    run_id="$(json_get "$json" "print(d['workflow_runs'][0]['id'] if d.get('workflow_runs') else '')")"
    [ -n "$run_id" ] && break
    sleep 3
  done
  [ -n "$run_id" ] || fail "未获取到 workflow run（可到 https://github.com/$repo/actions 查看）"

  log "等待 macOS 构建完成（run #$run_id，超时 ${CI_TIMEOUT_SEC}s）..."
  printf '进度：https://github.com/%s/actions/runs/%s\n' "$repo" "$run_id"
  local start="$SECONDS" status conclusion
  while true; do
    json="$(curl -sS "${auth[@]}" "https://api.github.com/repos/$repo/actions/runs/$run_id")" \
      || fail "查询 run 状态失败"
    read -r status conclusion < <(json_get "$json" "print(d.get('status','') or '', d.get('conclusion','') or '')")
    printf '[%s] status=%s%s\n' "$(date +%H:%M:%S)" "$status" "${conclusion:+ conclusion=$conclusion}"
    if [ "$status" = "completed" ]; then break; fi
    if [ $((SECONDS - start)) -ge "$CI_TIMEOUT_SEC" ]; then
      fail "macOS 构建超时（${CI_TIMEOUT_SEC}s），可到 Actions 页面查看"
    fi
    sleep "$CI_POLL_SEC"
  done
  [ "$conclusion" = "success" ] \
    || fail "macOS 构建失败（conclusion=$conclusion），见 https://github.com/$repo/actions/runs/$run_id"

  log "下载 macOS 产物..."
  local arts url tmp out
  arts="$(curl -sS "${auth[@]}" "https://api.github.com/repos/$repo/actions/runs/$run_id/artifacts")" \
    || fail "查询产物失败"
  url="$(json_get "$arts" "print(next((a['archive_download_url'] for a in d.get('artifacts',[]) if a.get('name')=='$MAC_ARTIFACT'), ''))")"
  [ -n "$url" ] || fail "workflow 未上传 $MAC_ARTIFACT 产物"
  tmp="$(mktemp -d)"
  curl -sSL -H "Authorization: Bearer $token" -o "$tmp/macos.zip" "$url" || fail "产物下载失败"
  out="$(pkg_dir macos)"
  unzip -o -q "$tmp/macos.zip" -d "$out"
  rm -rf "$tmp"
  log "macOS 产物就绪：$out"
}

# ── 入口 ─────────────────────────────────────────────────
MODE="all"
case "${1:-}" in
  "") ;;
  --windows-only|-w) MODE="windows" ;;
  --mac-only|-m)     MODE="mac" ;;
  -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  *) printf '用法：build.sh [--windows-only|--mac-only]\n' >&2; exit 2 ;;
esac

log "todo-kanban v$(version) 打包开始"

if is_macos; then
  case "$MODE" in
    all|mac) build_macos_local ;;
    windows) log "跳过：Windows 产物需在 Windows 上构建（本机为 macOS）" ;;
  esac
else
  case "$MODE" in
    all) build_windows_local; build_macos_remote ;;
    windows) build_windows_local ;;
    mac) build_macos_remote ;;
  esac
fi

log "打包完成。产物清单："
find "$ARTIFACTS" -maxdepth 2 -type f -printf '  %P\n' 2>/dev/null | sort || true
