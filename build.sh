#!/bin/bash

yarn tauri build

echo "\n\n打包完成\n\n"

KANBAN_EXE_PATH=/c/Users/23136/.cargo/shared-target/release/todo-kanban.exe

if [ -f $KANBAN_EXE_PATH ]; then
    cp $KANBAN_EXE_PATH ./release/todo-kanban.exe
    echo "\n\n移动完成\n\n"
else
    echo "\n\n没找到安装包\n\n"
fi

echo "\n\n最终完成\n\n"

