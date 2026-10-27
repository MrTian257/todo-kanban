# CLAUDE.md

Claude Code 与其他 AI 工具共用根目录的 [AGENTS.md](AGENTS.md) 作为项目入口，那里记录当前事实、代码地图和协作约定。开始任务时先读 `AGENTS.md`，再阅读与改动相关的源码和文档。

长期产品与架构说明见 [docs/软件设计文档.md](docs/软件设计文档.md)，文档导航见 [docs/README.md](docs/README.md)，决策记录索引见 [docs/adr/README.md](docs/adr/README.md)。所有文档可能随代码变化而过期；实现事实以源码为准。

Claude 专属配置或工作流写在 `.claude/`；跨工具都适用的项目知识必须写在根 `AGENTS.md` 或 `docs/`，不要只放在 Claude 专属文件里。
