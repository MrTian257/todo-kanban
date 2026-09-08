#!/bin/bash

set -e

SHARED_RELEASE=/c/Users/23136/.cargo/shared-target/release

echo "\n\n[1/3] 打包桌面应用（tauri build）...\n\n"
yarn tauri build

echo "\n\n[2/3] 构建 MCP server（mcp-server，release）...\n\n"
cargo build --release -p mcp-server --manifest-path src-tauri/Cargo.toml

echo "\n\n[3/3] 拷贝产物到 ./release/ ...\n\n"

KANBAN_EXE_PATH=$SHARED_RELEASE/todo-kanban.exe
if [ -f "$KANBAN_EXE_PATH" ]; then
    cp "$KANBAN_EXE_PATH" ./release/todo-kanban.exe
    echo "已拷贝 todo-kanban.exe"
else
    echo "没找到 todo-kanban.exe"
fi

MCP_EXE_PATH=$SHARED_RELEASE/mcp-server.exe
if [ -f "$MCP_EXE_PATH" ]; then
    cp "$MCP_EXE_PATH" ./release/mcp-server.exe
    echo "已拷贝 mcp-server.exe"
else
    echo "没找到 mcp-server.exe"
fi

echo "\n\n打包完成\n\n"
