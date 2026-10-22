# 本地 / 远程大模型接入：HTTP 接口与出网路径的事实调研

> 调研日期 2026-10-22。**纯调研，本仓库源码零改动**（本文件是本次唯一新增文件）。
> 触发场景：GrokBot 的心跳（定时器）与事件（任务完成 / 番茄阶段切换）要调用模型，并把结果反映到宠物表情与气泡，因此需要同时搞清「本地模型怎么调」与「远程模型怎么调」，以及从一个 Rust 桌面进程出网的三条路径各自的代价。
> 取材规则：每条论断回溯到一手来源（官方文档、官方仓库源文件、标准文档、官方 SDK 源码）；抓不到一手来源的显式写「未找到一手来源」，不臆造字段名与端口。

## 一句话结论

本地与远程的「最简调用形状」已经收敛成同一个：**POST {base_url}/v1/chat/completions + Authorization: Bearer + JSON {model, messages, stream, temperature, max_tokens, response_format}**——Ollama、LM Studio、vLLM、llama.cpp 四个本地服务与 DeepSeek、火山方舟、阿里云百炼三个远程服务都有官方文档为这一形状背书，唯一的形状例外是 Anthropic 的 Messages API（`/v1/messages`、`x-api-key` + `anthropic-version`、`system` 是顶层参数、`max_tokens` 必填）。三种出网路径的真实差别不是「能不能连通」，而是三条不同的约束轴：**只有 webview `fetch` 会被浏览器强制的 CORS 拦下**、**只有整块读的 curl 子进程拿不到增量 token**、**引入 reqwest 会把 TLS 与 tokio 依赖推进现在零 HTTP 依赖的 core crate**。

- 本地最简形状：`POST http://127.0.0.1:11434/api/chat`，体 `{model, messages, stream: false, format, options, keep_alive}`（[Ollama API 文档](https://docs.ollama.com/api/chat)）；或 `POST http://127.0.0.1:11434/v1/chat/completions`（[Ollama OpenAI 兼容](https://docs.ollama.com/api/openai-compatibility)）。
- 远程最简形状：`POST {base_url}/v1/chat/completions`，只需改 base_url / api_key / model 三项（[方舟兼容 OpenAI SDK](https://ark.volcengine.com/region:cn-beijing/docs/compatible-with-openai-sdk.md)、[百炼 OpenAI Chat 接口兼容](https://www.alibabacloud.com/help/zh/model-studio/compatibility-of-openai-with-dashscope)、[DeepSeek JSON Output](https://api-docs.deepseek.com/guides/json_mode)）。
- 出网路径的事实轴：CORS 是否拦（只拦 webview）／能否流式（curl 子进程整块读）／依赖落点（core 现无 HTTP crate）。

## 本地服务接口对照（表格）

| 服务 | 默认监听 | 原生对话端点 | OpenAI 兼容端点 | JSON / 结构化输出 | 模型常驻与冷启动 | 就绪探活 | 绑定 / 跨域开关 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Ollama](https://docs.ollama.com/api/chat) | `127.0.0.1:11434`（改绑定用 `OLLAMA_HOST`，[faq](https://docs.ollama.com/faq)） | `POST /api/chat`、`POST /api/generate` | `/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`GET /v1/models`，另有 `POST /v1/messages`（Anthropic 形状），见 [官方仓库 server/routes.go（路由注册）](https://github.com/ollama/ollama/blob/main/server/routes.go) | 请求体 `format: "json"` 或 `format: <JSON schema>`；`options.temperature`（[结构化输出](https://docs.ollama.com/capabilities/structured-outputs)） | 默认 `keep_alive` **5 分钟**；`-1` 常驻、`0` 立即卸载；`OLLAMA_KEEP_ALIVE`（[faq](https://docs.ollama.com/faq)） | `GET /api/tags`（本地模型清单）、`GET /api/ps`（在跑的模型）、`GET /api/version`（[api.md 目录](https://github.com/ollama/ollama/blob/main/docs/api.md)） | 默认只放行来自 `127.0.0.1` 与 `0.0.0.0` 的跨域来源，其余靠 `OLLAMA_ORIGINS`（[faq](https://docs.ollama.com/faq)） |
| [llama.cpp llama-server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) | `--host` 默认 `127.0.0.1`、`--port` 默认 **`9931`**（README L193-194） | `POST /completion`、`/infill`、`/tokenize`、`/embeddings`、`/reranking` | `/v1/chat/completions`、`/v1/completions`、`/v1/models`、`/v1/embeddings`、`/v1/responses`，并实现了 `/v1/messages` | 服务端约束解码 `--json-schema` / `--json-schema-file`（L154-155）；`response_format` 支持 `{"type":"json_object"}` 与 `{"type":"json_schema","json_schema":{"schema":…}}`（L1398） | 模型在进程启动时加载；加载期 `/health` 回 503（L486-487）；`--parallel` 决定槽位数 | `GET /health`（**不受 `--api-key` 保护**，L481）、`GET /slots`、`POST /props`、`GET /metrics`（Prometheus 文本） | `--cors-origins` 默认 `*`；开 `--tools`/`--agent` 时默认降为 `localhost`；官方推荐 webview 类应用填 `tauri://localhost`（L397-408） |
| [LM Studio](https://lmstudio.ai/docs/developer/core/server) | 默认端口 **`1234`**（官方示例统一 `http://localhost:1234/v1`，[openai-compat](https://lmstudio.ai/docs/developer/openai-compat)）；可 Serve on Local Network | 自有 REST `/api/v0/...`（[rest](https://lmstudio.ai/docs/developer/rest)） | `/v1/models`、`/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/responses`、`/v1/decisions`；另有 Anthropic 兼容端点 | `response_format` + JSON schema：官方称「响应会让 LLM 输出符合所给 schema 的合法 JSON」，且「格式与 OpenAI Structured Output 一致，可用 OpenAI 客户端 SDK」（[structured output](https://lmstudio.ai/docs/developer/openai-compat/structured-output)） | JIT 加载默认开启、**空闲 TTL 默认 60 分钟**、Auto-Evict 默认开启（[ttl-and-auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)） | 未找到一手来源（官方未给专门探活端点；`GET /v1/models` 可作事实性检查） | `Server Port` / `Require Authentication` / **`Enable CORS`** 三个开关（[Server Settings](https://lmstudio.ai/docs/developer/core/server/settings)、[源文件](https://github.com/lmstudio-ai/docs/blob/main/1_developer/0_core/0_server/settings.md)） |
| [vLLM](https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/README.md) | `--host`/`--port` 默认值：本次抓到的官方页面未声明（**未找到一手来源**）；官方示例是 `http://localhost:8000/v1` | `/v1/completions` 的 `suffix` 不支持、`user` 被忽略（官方注记） | `/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/decisions`、`/v1/embeddings`、`/v1/audio/transcriptions`、`/v1/chat/completions/batch`，**另实现 Anthropic `/v1/messages`**（README L28-30） | `response_format` 与 `extra_body={"structured_outputs": {...}}`：`choice`/`regex`/`json_schema`/`grammar`/`structural_tag`，后端 xgrammar·guidance·outlines·lm-format-enforcer（[structured_outputs.md](https://github.com/vllm-project/vllm/blob/main/docs/features/structured_outputs.md)） | 模型随 `vllm serve` 进程常驻；官方未给 TTL 类卸载机制 | 未找到一手来源 | `--api-key`/`VLLM_API_KEY` 只保护 `/v1`、`/v2`、`/inference`，**不保护 `/invocations`**（官方警告）；[security.md](https://github.com/vllm-project/vllm/blob/main/docs/usage/security.md) 要求服务只置于可信网络 |
| [LocalAI](https://localai.io/overview/) | 官方 docker 示例 `-p 8080:8080`，Web UI `http://localhost:8080` | — | 官方自我描述「a small core that speaks the OpenAI and Anthropic APIs」「drop-in replacement for OpenAI, Anthropic, and Open Responses APIs」 | 本次未逐条核验（**未找到一手来源**：其 JSON schema 字段名） | 本次未核验 | `GET /v1/models`（属兼容面） | 本次未核验 |
| [Microsoft Foundry Local](https://learn.microsoft.com/en-us/windows/ai/foundry-local/get-started) | 官方入门页给的是**进程内原生 SDK** 形态 | — | 该页示例借用 OpenAI 请求模型库（`Betalgo.Ranul.OpenAI`），但**页面正文未出现 `localhost` / `endpoint` / `port` 字样**（已用关键词核验） | 未找到一手来源 | 未找到一手来源 | 未找到一手来源 | 该页未描述 HTTP 监听形态；是否存在本地 REST 端点：**未找到一手来源** |

### 字段名事实（逐条，按官方文本）

- Ollama `/api/chat` 请求体字段：`model`、`messages`、`tools`、`think`、`format`（`json` 或一个 JSON schema）、`options`（例如 `temperature`）、`stream`、`keep_alive`、`context`、`base_url`、`extra_body`；`stream: false` 时「returns a single response object」（[docs/api.md L493-523](https://github.com/ollama/ollama/blob/main/docs/api.md)）。
- Ollama 响应计时字段：`total_duration`、`load_duration`、`prompt_eval_count`、`prompt_eval_duration`、`eval_count`、`eval_duration`；官方同一次示例值：`load_duration: 6683708`（≈6.7 ms，模型已在内存）、`prompt_eval_count: 17` / `prompt_eval_duration: 201222000`（≈201 ms）、`eval_count: 63` / `eval_duration: 953997000`（≈954 ms）（[api.md L180-195](https://github.com/ollama/ollama/blob/main/docs/api.md)）。`done_reason` 取值含 `stop`/`load`/`unload`/`exit`，其中 `load` 表示本次请求触发了模型加载。
- Ollama 对 `format: "json"` 的告警原文：**「It's important to instruct the model to use JSON in the prompt. Otherwise, the model may generate large amounts whitespace.」**（api.md L69-70）。结构化输出页另给两条实践注记：「最好把 JSON schema 作为字符串也放进 prompt 以 grounding」「降低 temperature（官方示例 `0.5`）以减少幻觉」，并声明 **Ollama 云端目前不支持 structured outputs**（[capabilities/structured-outputs](https://docs.ollama.com/capabilities/structured-outputs)）。
- Ollama 的 OpenAI 兼容层字段清单（官方勾选表）：支持 `model`、`messages`、`frequency_penalty`、`presence_penalty`、`response_format`、`seed`、`stop`、`stream`、`stream_options.include_usage`、`temperature`、`top_p`、`max_tokens`、`tools`、`reasoning_effort`；`logprobs` 与「有状态的 `v1/responses`」列为不支持；`api_key` 传 `'ollama'`——官方原话「required but ignored」（[api/openai-compatibility](https://docs.ollama.com/api/openai-compatibility)）。
- llama.cpp：`/v1/chat/completions` 的 Options 直接指向 OpenAI 文档，另接受 llama.cpp 特有字段（如 `mirostat`）；官方原话「Both synchronous and streaming mode are supported」（L1392）；`/completion` 侧对应字段是 `json_schema`（L580 附近），并 IMPORTANT 注明 `/completion` **不是** OAI 兼容端点（L494-496）。
- LM Studio 的 Server Settings（官方源文件逐条）：`Server Port`（Integer）、「Port number on which the LM Studio API server listens for incoming connections.」、`Require Authentication`（Switch）、**`Enable CORS`**（Switch，描述原文「Enable Cross-Origin Resource Sharing (CORS) to allow applications from different origins to access the API.」）、`Just in Time Model Loading`、`Auto Unload Unused JIT Models`、`Only Keep Last JIT Loaded Model`。**该文档未标注 Enable CORS 的默认开/关状态——未找到一手来源。**（[settings.md](https://github.com/lmstudio-ai/docs/blob/main/1_developer/0_core/0_server/settings.md)）
- LM Studio 的 TTL 机制：请求体带 `ttl` 字段会重置空闲计时；用 `lms load` 显式加载的模型默认**没有** TTL（[ttl-and-auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)）。
- vLLM 的扩展字段入口：官方原文「you can use `extra_body` to pass in additional parameters that are not part of the OpenAI API specification」，示例 `extra_body={"top_k": 50}`、`extra_body={"structured_outputs": {"choice": [...]}}`；另注：服务端默认套用模型仓库的 `generation_config.json`（可用 `--generation-config vllm` 关掉）（[openai_compatible_server.md](https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/openai_compatible_server.md)）。
- 四家本地服务的「不用改代码」表述一致（一手原话）：LM Studio「You can reuse existing OpenAI clients … by switching up the 'base URL'」；方舟「修改 `base url`、`model`、`api_key` 等少量配置」；百炼「您只需调整 API Key、BASE_URL 和模型名称」；Ollama 官方 OpenAI 示例把 `base_url` 设为 `http://localhost:11434/v1/`。

### 无 GPU / 低显存是否可用：可核验的判据

- Ollama 按显存给默认上下文长度分档：**< 24 GiB → 4096**、**24–48 GiB → 32768**、**> 48 GiB → 262144**，可用 `OLLAMA_CONTEXT_LENGTH` 或请求级 `num_ctx` 覆盖；并明示「更大的上下文长度会增加所需内存，请确认显存够用」（[context-length](https://docs.ollama.com/context-length)）。
- Ollama 并发与排队的官方事实：内存不足时「请求会被排队、空闲模型会被卸载」；`OLLAMA_MAX_LOADED_MODELS` 默认单 GPU 为 1、多 GPU 为 3，同尺寸模型分时复用；`OLLAMA_NUM_PARALLEL` 默认 1；`OLLAMA_MAX_QUEUE` 默认 512，队列满回 **503**（[faq](https://docs.ollama.com/faq)）。
- Ollama 对 CPU 推理的官方定位：GPU 不可用时回退 CPU，且**「will be much slower than GPU inference」**（[faq](https://docs.ollama.com/faq)）。
- Windows 门槛（Ollama 官方）：Windows 10 22H2+ 或 Windows Server 2022+，x64 / arm64；桌面版从系统托盘运行，`ollama` 命令行在 PowerShell / CMD 可用；可用 NSSM 作为服务运行（[windows](https://docs.ollama.com/windows)）。
- llama.cpp 侧的「最低显存」官方表：**未找到一手来源**。可核验的一手事实只有：模型在启动时加载、加载期 `/health` 回 503（L486-487），以及 `/metrics`（Prometheus 文本，L1175）与 `/slots`（逐槽位状态，L1027）可作自测依据。
- LM Studio / vLLM / LocalAI / Foundry Local 的显存门槛：本次均未取到官方判据表——**未找到一手来源**。

## 远程服务与兼容层

### OpenAI 兼容层的公共约定（以官方 OpenAPI 规范为准）

- 官方规范 server 块即 `https://api.openai.com/v1`（[openapi.yaml L14-15](https://github.com/openai/openai-openapi/blob/master/openapi.yaml)）——「base_url + Bearer key + model」是规范自带形态。
- `max_tokens` 已弃用：规范原文 **「This value is now deprecated in favor of `max_completion_tokens`」**，且 `max_completion_tokens` 的上限**含推理 token**（L44439-44441、L44667）。→ 事实性差异：OpenAI 新端点用 `max_completion_tokens`，而多数兼容层仍只认 `max_tokens`（Ollama 勾选表里是 `max_tokens`）。
- `response_format` 是三选一：`text` / `json_object` / `json_schema`；原文「Setting to { "type": "json_schema", "json_schema": {...} } enables Structured Outputs which ensures the model will match your supplied JSON schema」，并称 `json_object` 是「older JSON mode」，**「Using `json_schema` is preferred」**（L44522-44537）。
- `json_schema` 形状：`{type: "json_schema", json_schema: {description, name, schema, strict}}`，**`name` 必填**（原文「Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64」）；`strict` 默认 `false`，打开后「the model will always follow the exact schema defined in the `schema` field」但 **「Only a subset of JSON Schema is supported when `strict` is `true`」**（L71162-71213）。
- 流式：`stream_options` 在规范里仍标 beta（L44714-44715）；`stream_options: {"include_usage": true}` 把用量放在**最后一个 chunk**（L44960）。
- 429 的规范定义：`TooManyRequests` 组件——「The request was rejected because a rate limit was exceeded」，响应头 **`Retry-After`**「The minimum number of seconds to wait before retrying. This header is returned when the server has computed a retry delay and may be omitted for 429 responses that require user action」（integer，≥1）（L118352-118361）；另有 `InferenceRateLimited`（slow_down）：「A slow_down error means traffic increased too quickly; reduce your request rate, then increase it gradually.」，其 `Retry-After` 也可能省略（L118366-118377）。
- `https://platform.openai.com/docs/api-reference/*` 对自动抓取返回 **HTTP 403**（本次实测），因此本节 OpenAI 侧接口事实一律取自官方 OpenAPI 规范仓库；针对具体 guide 页正文的引句：**未找到一手来源**。

### DeepSeek

- 官方接入方式是 OpenAI SDK + `base_url = "https://api.deepseek.com"`（[JSON Output](https://api-docs.deepseek.com/guides/json_mode)）。
- JSON 输出只到 `json_object` 一档：`response_format` 设为 `{"type": "json_object"}`；官方三条硬性要求——**提示词（system 或 user）里要出现 "json" 这个词并给出期望的 JSON 示例**、**合理设置 `max_tokens` 以免 JSON 字符串被中途截断**、以及官方自己承认的坑：**「When using the JSON Output feature, the API may occasionally return empty content」**（同上）。
- 错误码事实（[官方错误码页](https://api-docs.deepseek.com/quick_start/error_codes)）：429「Rate Limit Reached」=「You are sending requests too quickly, or have exceeded a concurrency or QPS limit」，建议「pace your requests reasonably」；500 建议稍后重试；503「Server Overloaded」建议稍后重试。**该页未提 `Retry-After`——未找到一手来源。**

### 火山方舟（Ark）

- base_url `https://ark.cn-beijing.volces.com/api/v3`；前提「Python 3.7 及以上、OpenAI SDK 1.0 及以上」；官方定位原文「为方便您集成和使用，火山方舟模型 API 会尽可能兼容 OpenAI API。修改 `base url`、`model`、`api_key` 等少量配置……」（[兼容 OpenAI SDK](https://ark.volcengine.com/region:cn-beijing/docs/compatible-with-openai-sdk.md)）。
- 兼容层的扩展方式：OpenAI SDK 未收录的字段走 **`extra_body`**（官方示例 `{"thinking": {"type": "disabled"}}` 开关深度思考）；自定义请求头走 `extra_headers`（示例 `X-Client-Request-Id`）（同上）。
- 结构化输出为 **beta**：`response_format` 支持 `json_schema` 与 `json_object`；官方对能力的表述原文「输出可靠：输出结构始终符合预期数据类型，包括字段层级、名称、类型、顺序等，避免必要字段缺失或枚举值幻觉等」；同页两条限制事实——**「该能力尚在 beta 阶段，受资源与平台负载影响，服务可用性可能随访问情况产生波动，请谨慎在生产环境使用」**、**使用「在线推理（TPM 保障包）」时不支持结构化输出**（[结构化输出(beta)](https://ark.volcengine.com/region:cn-beijing/docs/structured-output-beta.md)）。
- 限流事实（[错误码](https://ark.volcengine.com/region:cn-beijing/docs/error-codes.md)）：429 一族按维度细分——`TooManyRequests`/`RateLimitExceeded.EndpointRPMExceeded`（接入点 RPM 超限）、「已超过 TPM (Tokens Per Minute) 限制」、`EndpointFlexTPMExceeded` 官方处理建议原文「**请在客户端退避重试**，或调整推理接入点的 Flex TPM 配置」；`RequestTimeout` 建议「可在控制重试次数的前提下重试」。
- 超时与重试的官方默认值（[SDK 常见使用示例](https://ark.volcengine.com/region:cn-beijing/docs/sdk-common-examples.md)）：「超时设置（`timeout`）……这里推荐 30 分钟（1800 秒）」；Python SDK 默认 **60 秒连接超时 + 600 秒 socket 超时**，Java 同，Go 默认 **600 秒端到端总超时**；`max_retries` **默认 2 次**。（这是官方把「长耗时请求」当常态的一手信号。）
- 文档获取方式事实：方舟文档站「在任一文档页面地址后追加 `.md` 即得 Markdown 版」，索引 `https://ark.volcengine.com/llms.txt`（[索引](https://ark.volcengine.com/llms.txt)）。
- 与延迟直接相关的产品事实：「在线推理（低延迟）」用 `service_tier=fast` 换取「更优的输出 token 生成速率（TPOT）」（同上索引条目页）。

### 阿里云百炼 / 通义千问（DashScope 兼容模式）

- 官方定位原文「阿里云百炼的千问模型支持 OpenAI 兼容接口，您只需调整 API Key、BASE_URL 和模型名称，即可将原有 OpenAI 代码迁移至阿里云百炼服务使用」（[OpenAI Chat 接口兼容](https://www.alibabacloud.com/help/zh/model-studio/compatibility-of-openai-with-dashscope)）。
- BASE_URL 按地域不同，形如 `https://{WorkspaceId}.<region>.maas.aliyuncs.com/compatible-mode/v1`（新加坡 `ap-southeast-1`、弗吉尼亚 `us-east-1`、中国香港 `cn-hongkong`、东京 `ap-northeast-1` 等），HTTP 完整端点 `POST .../compatible-mode/v1/chat/completions`；官方说明老域名 `https://dashscope.aliyuncs.com` / `dashscope-intl.aliyuncs.com`「仍可正常使用」但建议迁移到业务空间专属域名（同页）。→ 事实：base_url 不是单一常量，含 `{WorkspaceId}` 模板与地域维度。
- 鉴权与请求头（官方 curl 示例）：`Authorization: Bearer $DASHSCOPE_API_KEY` + `Content-Type: application/json`，体 `{model, messages}`，流式加 `"stream": true`；官方另注「通过以下设置，在流式输出的最后一行展示 token 使用信息」= `stream_options={"include_usage": True}`（同页）。
- 状态码事实（同页「状态码说明」）：**429 有两种不同文案**——「429 - Rate limit reached for requests」（QPS、QPM 等超限）与「429 - You exceeded your current quota, please check your plan and billing details」（额度超限或欠费）；另有 400 / 401「Invalid API-key provided」/ 500 / 503「服务端负载过高，可重试」。**该页未提 `Retry-After`。**
- 排错事实（同页）：「百炼 API Key 按地域绑定。调用某个地域的 base_url 时，必须使用在同一地域创建的 API Key」；404/401/403 先查跨地域与 Key 是否同域。
- 本次抓到的兼容页正文未出现 `response_format` / `json_object` 字样——百炼的 JSON 模式支持情况：**未找到一手来源**（需另查其「文本生成」API 参考页）。

### Anthropic Messages API 的形状差异（一手取官方 SDK 源码）

> 说明：`docs.claude.com` / `platform.claude.com` 的文档页是客户端渲染，抓取到的 HTML 里没有正文文字（本次实测），因此下列字段事实一律取自 **Anthropic 官方 SDK 源码**（同一组织仓库，一手出处）。

- `max_tokens` **必填**：官方 Python SDK 的 `messages.create()` 签名里 `max_tokens: int`、`messages: Iterable[MessageParam]`、`model: ModelParam` 是三个无默认值的关键字参数，其余参数一律 `| Omit = omit`（[官方 SDK 源文件 L122-149](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/resources/messages/messages.py)）。
- `system` 是**顶层参数**、不是 `messages` 里的一条 role：同一签名 `system: Union[str, Iterable[TextBlockParam]]`（同文件 L138）。
- 鉴权头 `x-api-key`（与 `authorization` 二选一）+ 版本头必填：官方 TS SDK `validateHeaders` 检查「`x-api-key` 或 `authorization`」是否存在，并默认注入 `'anthropic-version': '2026-10-21'`；`apiKey` 缺省读环境变量 `ANTHROPIC_API_KEY`（[官方 SDK 源文件](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts) L1233-1249、L2011、L916）。
- 默认 base_url `https://api.anthropic.com`（SDK 用 `this.baseURL !== 'https://api.anthropic.com'` 判断是否被覆盖，L1225-1227）。Anthropic 是否官方提供「OpenAI 兼容端点」：**未找到一手来源**。反向事实：Ollama / llama.cpp / vLLM / LM Studio / LocalAI 各自文档声明实现了 `/v1/messages` 的 Anthropic 兼容形状。
- 官方 SDK 超时与重试默认值：`DEFAULT_TIMEOUT = Timeout(timeout=10 * 60.0, connect=5.0)`（同文件注释原文「# default timeout is 10 minutes」）、`DEFAULT_MAX_RETRIES = 2`、`INITIAL_RETRY_DELAY = 0.5`、`MAX_RETRY_DELAY = 8.0`（[官方 SDK 源文件](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_constants.py)）。
- 重试判定由服务端可控：TS SDK 依次看响应头 `x-should-retry`（显式 true/false 直接决定）→ `retry-after-ms`（官方注释「may not be standard, but is a good idea and we'd like proactive support for it」）→ `retry-after`；退避基数 0.5 s、封顶 8.0 s（`client.ts` L1834-1917）。
- **浏览器侧使用被官方显式拦**：TS SDK 选项 `dangerouslyAllowBrowser` 的注释原文「By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers」，开启后额外注入请求头 `'anthropic-dangerous-direct-browser-access': 'true'`（L916-926、L2008-2011）。→ 事实：「webview 直接调用 + 远程 Key 放前端」与官方安全模型冲突。
- Anthropic 的 JSON / 结构化输出官方手段：**未找到一手来源**（文档页正文取不到，SDK 源码未直接表述该能力）。

### 需要多少个适配器？（只列能决定该问题的事实）

- 「一个 OpenAI 兼容适配器 + 可配 base_url」有 8 个独立一手声明：OpenAI（server `api.openai.com/v1`）、Ollama（`localhost:11434/v1/`，key 必填但忽略）、LM Studio（`localhost:1234/v1`）、vLLM（`localhost:8000/v1`）、llama.cpp（`/v1/chat/completions`）、DeepSeek、方舟、百炼。
- 同一兼容适配器内部仍需处理的分歧点（各有一手出处）：① 参数名 `max_tokens` vs `max_completion_tokens`；② 扩展字段入口（方舟 `extra_body.thinking`、vLLM `extra_body.structured_outputs`）；③ 结构化输出档位不齐（OpenAI / llama.cpp / 方舟 / LM Studio 支持 `json_schema`；Ollama 用 `format` 承载 schema；DeepSeek 只 `json_object`；百炼未核验）；④ 429 语义细分不同（方舟按 RPM/TPM/Flex-TPM 分码，百炼把「QPS 超限」与「欠费」都放 429，OpenAI 规范另有 slow_down 型）；⑤ base_url 形态（百炼含 `{WorkspaceId}` 与地域维度）。
- 必须「另写一套」的唯一一手理由：**Anthropic Messages 形状**（端点、鉴权头、版本头、`system` 位置、`max_tokens` 必填、浏览器侧禁用策略）。

## 三种出网路径的事实对比

> 仓库现状（事实登记，非评价）：唯一的出网实现是系统 curl 子进程——`src-tauri/core/src/svc/http_cache.rs:122-140` 用 `quiet_command("curl")` + `["--disable", "--max-time", "10", "--connect-timeout", "5", "-sS", "--include", "--header", "@-", "--url", url]`，认证头经标准输入管道传入（注释原文 L141「Token 通过管道输入，不出现在命令行参数中。」），响应整块由 `child.wait_with_output()` 取回（L152）；不加 `--fail` 的理由写在 L121：「HTTP 错误码要由我们自己解析（才能给出 401/403/404/429 的精确提示）」；缓存侧常量 `MAX_PAGE_BYTES = 512 * 1024`、`MAX_CACHE_BYTES = 32 * 1024 * 1024`、128 页上限（L65-83）；错误映射 `status_error()`（L39-47）把 401/403/404/429 转中文，429 →「接口配额已用尽（429），请稍后重试」，并从响应头 `X-RateLimit-Remaining: 0` 判定 `rate_limited`（L238，测试 L292）。子进程统一经 `quiet_command()` 构造（`src-tauri/core/src/tool/proc.rs:7,22`：Windows `CREATE_NO_WINDOW = 0x0800_0000`，注释原文「防 release GUI 壳下闪黑框」）；**该封装不改动任何代理环境变量**（一手核验：`src-tauri` 全仓无 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 字样），curl 侧也不走 git 那套隔离参数。传输层失败文案为「…请求失败（curl 退出码 {code}），请检查网络与系统 TLS 证书」（L159-163）→ 事实：证书校验依赖系统信任库。决策记录 `docs/decisions/ADR-002-system-cli-git-curl.md`：L14「外部子进程统一超时：git 30s / curl 10s（防网络挂起卡死写操作）」、L15「GitLab API 走系统 curl：PRIVATE-TOKEN 头 + -k（兼容内网自签证书）」、L24-26「reqwest / hyper 等 HTTP crate——否决：新增 TLS 依赖与配置面；内网自签场景 curl -k 已覆盖；零新增依赖原则优先」、L29「运行环境硬依赖 PATH 中的 git（curl 可选：仅 GitLab 远端增强需要）」、L32「API 失败静默回退本地分支（不打断用户操作）」。

### A. 系统 `curl` 子进程

- Windows 自带 curl 的一手依据（Microsoft 官方）：页面描述原文 **「Use the built-in curl command on Windows to transfer data to and from servers over HTTP, HTTPS, FTP, and other protocols from the command line.」**（[curl on Windows | Microsoft Learn](https://learn.microsoft.com/en-us/windows/curl/)）。
- 同页的一个坑（对「经 shell 起 curl」的形态直接相关）：「**Windows PowerShell 5.1 defines a built-in alias named curl that maps to `Invoke-WebRequest`**, which shadows curl.exe and accepts different parameters……PowerShell 7+ does not define this alias.」→ 事实：必须显式 `curl.exe`。仓库现有实现是 `Command::new("curl")` 直启、不经 shell。
- llama.cpp 官方 README 的同一事实（一手仓库表述）：「**On Windows, `curl.exe` should be available in the base OS.**」（L468）。
- 阻塞性与超时粒度：curl 是同步子进程；本仓库把两个超时都交给 curl 自己（`--max-time 10` 整请求、`--connect-timeout 5` 连接），Rust 侧 `wait_with_output()` 阻塞等待进程结束 → 超时粒度是「整请求 10 秒」，不是首字节 / 逐 token。
- 流式：本仓库路径是 `--include` + 整块读入（`wait_with_output`），没有增量回调；单页驻留上限 `MAX_PAGE_BYTES = 512 KiB`（超过则不缓存但仍返回全文，L188-196）。**未找到一手来源**：curl 在子进程管道下逐行增量消费的官方说明（`--no-buffer` 的行为我只在 curl 帮助文本一侧见到，未取到可用于本场景的官方文档）。
- 错误粒度：curl 只回退出码 + stderr 文本（`-sS`），传输层失败统一文案；现状靠解析响应头拿状态码并映射 4 种中文错误 + `X-RateLimit-Remaining: 0` 判定限流，**不解析 `Retry-After`（一手核验：`http_cache.rs` 无 `Retry` 相关字样）**。
- 认证头形态（现有做法的一手事实）：GitLab 用 `PRIVATE-TOKEN`、GitHub 用 `Authorization: Bearer` + `Accept: application/vnd.github+json` + `X-GitHub-Api-Version: 2022-11-28`（`http_cache.rs:33`），整块 header 以 `--header @-` 经 stdin 传入；请求前还会校验 Token 不含 `\r \n \0`（L113-116）。凭据来源是 OS keyring：`core/src/svc/credentials.rs`（`keyring::Entry::new(SERVICE, &id)`，L31/L63/L129），`keyring = "=3.6.3"` 按平台启用 `windows-native`/`apple-native`/`sync-secret-service`（`src-tauri/core/Cargo.toml:20-27`）。

### B. `reqwest` / hyper（Rust 原生客户端）

- TLS 是「三选一，默认走系统实现」：`reqwest` 官方文档原文「**`default-tls` (enabled by default): Provides TLS support to connect over HTTPS.**」「`rustls`: Enables TLS functionality provided by `rustls`」「`native-tls`: Enables TLS functionality provided by `native-tls`」（[docs.rs/reqwest](https://docs.rs/reqwest/latest/reqwest/)）。
- Windows 侧后端事实：`native-tls` 自我描述「An abstraction over platform-specific TLS implementations」，官方文档原文「**This crate uses SChannel on Windows (via the `schannel` crate)**」，Windows 分支依赖 `schannel ^0.1.28`（[docs.rs/native-tls](https://docs.rs/native-tls/latest/native_tls/)）→ 事实：默认特性在 Windows 上复用系统 schannel；切 `rustls` 才是纯 Rust 栈的依赖增量。
- 依赖面（同页依赖表，一手）：`hyper`、`hyper-tls ^0.6` / `hyper-rustls ^0.27.0`、`native-tls ^0.2.16` / `rustls ^0.23.4`、`tokio-rustls ^0.26`、`rustls-platform-verifier >=0.6.0` 等。
- 运行时需求（官方原文）：「The `reqwest::Client` is asynchronous (requiring Tokio). For applications wishing to only make a few HTTP requests, the `reqwest::blocking` API may be more convenient.」（同上）→ 事实：非阻塞用法必须绑 Tokio 运行时；`blocking` 自带一个运行时。
- 依赖方向事实（本仓库一手）：`tokio`/`axum` 只在壳 crate（`src-tauri/Cargo.toml:33-36`：`axum = "0.8"`、`tokio = { version = "1", features = ["rt", "rt-multi-thread", "macros", "sync", "net", "time"] }`、`futures-util = "0.3"`，另有 `if-addrs`），业务层 `todo-kanban-core` 的依赖清单里**没有任何 HTTP / TLS crate**（`src-tauri/core/Cargo.toml:8-27`：`serde`、`serde_json`、`rusqlite`(bundled,backup)、`log`、`uuid`(v4)、`base64`、`chrono`、`todo-kanban-upgrade` + 按平台的 `keyring`）；workspace 成员与方向 `config ← upgrade ← core ← 壳 / mcp-server`（`src-tauri/Cargo.toml:51-53`、`src-tauri/AGENTS.md`「依赖方向严格单向……core 之外的 crate 不得反向依赖」、`core/src/AGENTS.md` 反模式「在 svc/tool 里 import tauri 相关 crate（core 必须保持纯净）」）。→ 事实：加 reqwest 进 core = 同时把 TLS 栈与运行时假设推进 core；加在壳层则 core 侧需要新的注入点。
- 体积 / 交叉编译：官方文档未给「Windows 上 native-tls vs rustls 的二进制体积或交叉编译差异」的可核验数字——**未找到一手来源**。
- Tauri 生态已提供「不新增顶层 reqwest 依赖」的等价路径：官方 http 插件把 reqwest 重新导出——「you can utilize the `reqwest` crate re-exported by the plugin」，用法 `use tauri_plugin_http::reqwest;`（[Tauri HTTP Client](https://v2.tauri.app/plugin/http-client/)）。

### C. webview 里的 `fetch`

- CSP 现状：`src-tauri/tauri.conf.json` 里 `app.security.csp` 为 **`null`**。Tauri 配置参考原文：「csp — `Csp | null` — The Content Security Policy that will be **injected** on all HTML files on the built application. If devCsp is not specified, this value is also injected on dev.」（[v2.tauri.app/reference/config](https://v2.tauri.app/reference/config/#csp)）→ 事实：`null` 即「没有策略可注入」，不产生 `Content-Security-Policy` 响应头，因此 `connect-src` 不构成对 `http://127.0.0.1:11434` 的限制（文档未展开 `null` 语义，此处按字段定义直读）。
- CORS 由谁执行（MDN 定义原文）：「Cross-Origin Resource Sharing (CORS) is an HTTP-header based mechanism that allows a server to indicate any origins (domain, scheme, or port) other than its own **from which a browser should permit loading resources**. CORS also relies on a mechanism by which **browsers** make a "preflight" request to the server hosting the cross-origin resource」；「the server still must opt-in using `Access-Control-Allow-Origin` to share the response with the script」（[MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS)）。→ 事实：CORS 是 UA（浏览器）侧强制机制；curl / reqwest 不发 `Origin` 也不执行该拦截。
- 预检触发条件（MDN「简单请求」清单原文）：允许的方法只有 `GET`/`HEAD`/`POST`，且「The only type/subtype combinations allowed for the media type specified in the Content-Type header are: `application/x-www-form-urlencoded` `multipart/form-data` `text/plain`」→ 事实：模型接口一律发 `application/json`，**不属简单请求，必然先发 `OPTIONS` 预检**。
- 凭据与通配符（MDN 原文）：请求携带凭据（如 Cookie 头）而响应回 `Access-Control-Allow-Origin: *` 时「the browser will block access to the response, and report a CORS error in the devtools console」。
- 三个本地服务的 CORS 事实：① Ollama「Ollama allows cross-origin requests from `127.0.0.1` and `0.0.0.0` **by default**. Additional origins can be configured with `OLLAMA_ORIGINS`」，浏览器扩展需显式 pattern（[faq](https://docs.ollama.com/faq)）；② llama.cpp `--cors-origins` **默认 `*`**、`--cors-methods` 默认 `GET, POST, DELETE, OPTIONS`、`--cors-headers` 默认 `*`、`--cors-credentials` 默认开启（配 `*` 时回显 Origin），开 `--tools`/`--agent` 后默认降为 `localhost`，官方推荐表里 **webview-based apps 填 `tauri://localhost`**（L197-200、L397-408）；③ LM Studio 需 **`Enable CORS`** 开关（默认态未找到一手来源）。
- Tauri 应用的来源标识（一手示例）：Tauri 官方安全文档的响应头示例出现 `access-control-allow-origin: http://tauri.localhost`（Windows 打包后的应用 origin）与 CSP 示例 `default-src 'self'; connect-src ipc: http://ipc.localhost`（[v2.tauri.app/security/csp](https://v2.tauri.app/security/csp/)）；开发期 origin 由 `devUrl` 决定（本仓库 `http://localhost:1420`）。→ 事实：Ollama 默认放行清单只列 `127.0.0.1`/`0.0.0.0`，它与 `http://tauri.localhost`、`http://localhost:1420` 是否匹配，**没有任何一方的官方文档做过说明**（未找到一手来源）。
- 密钥落点：Anthropic 官方 SDK 明确禁止浏览器侧使用（见上节），是「webview + 远程 Key」路径上的官方反对证据。

### D. Tauri 官方给出的推荐路径（与三者对照）

- 官方 IPC：前端调 Rust 走 `invoke`（[Calling Rust from the Frontend](https://v2.tauri.app/develop/calling-rust/)）；本仓库业务命令即此形态（`src-tauri/src/commands.rs` 薄壳 + `src/lib.rs` 注册；`src-tauri/AGENTS.md` 记「44 命令」，根 `CLAUDE.md` 记 59 个 handler 含 LAN/MCP/native-workflow——两处口径不同，以源码为准）。
- 官方 HTTP 插件（[HTTP Client](https://v2.tauri.app/plugin/http-client/)）文档事实：① 定位「Access the HTTP client written in Rust」，JS 侧 `import { fetch } from '@tauri-apps/plugin-http'`；② 官方页面明写 **「This plugin requires a Rust version of at least 1.90」**，支持平台 windows / linux / macos；本仓库 `src-tauri/Cargo.toml` **未声明 `rust-version`/`compatibility` 字段**（一手核验：全 `src-tauri` 无 `rust-version` 字样），只有 `edition = "2021"`；③「**Forbidden request headers are ignored by default.** To use them you must enable the `unsafe-headers` feature flag」→ `tauri-plugin-http = { version = "2", features = ["unsafe-headers"] }`；④ 权限模型原文「This enables all fetch operations but **does not allow explicitly any origins to be fetched. This needs to be manually configured before usage.**」，capability 形状 `{"identifier": "http:default", "allow": [{"url": "https://*.tauri.app"}], "deny": [...]  }`，「Trying to execute any API with a URL not configured on the scope results in a promise rejection due to denied access」，默认权限清单见 [官方权限清单 default.toml](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/http/permissions/default.toml)；⑤ Rust 侧可直接用插件 re-export 的 reqwest。
- 历史事实（迁移指南原文）：「The Rust `tauri::api::http` JavaScript `@tauri-apps/api/http` APIs have been removed. Use the `@tauri-apps/plugin-http` plugin instead.」（[Tauri 1→2 迁移指南](https://v2.tauri.app/develop/migrate-from-tauri-1/)）→ 事实：内置 HTTP API 在 v2 已不存在，「不加插件的官方 HTTP 通道」不是可选项。
- 本仓库已引入的官方插件清单（事实）：`tauri-plugin-global-shortcut / window-state / clipboard-manager / dialog / notification / opener / log`（`src-tauri/Cargo.toml`），**其中没有 http 插件**。

### 四条路径的事实差异汇总

| 事实轴 | A. curl 子进程 | B. reqwest / hyper | C. webview `fetch` | D. `tauri-plugin-http` |
| --- | --- | --- | --- | --- |
| 本仓库是否已具备 | 已具备（`http_cache.rs` / `proc.rs` / ADR-002） | 未引入（core 无 HTTP crate；壳有 tokio + axum） | 已具备（WebView 原生） | 未引入（插件清单里无 http） |
| 新增依赖 | 无（需系统 curl，Microsoft 官方 built-in 表述） | TLS 后端 3 选 1 + hyper / tokio 依赖面 | 无 | 插件 crate + capability 文件；官方要求 Rust ≥ 1.90（本仓库未声明 rust-version） |
| 是否受 CORS 拦 | 否（非 UA） | 否（非 UA） | **是**（MDN：浏览器发预检，服务端必须 opt-in） | 否（Rust 侧执行；改由 capability scope 拦） |
| 逐 token 增量 | 现状整块读（`-o -` + 1 MiB 上限 + 10 s recv_timeout） | 支持流式响应体（官方：Client 异步、跑在 Tokio） | 支持（ReadableStream；但 `application/json` 需先过预检） | 支持（JS `fetch` 语义） |
| 错误粒度 | 退出码 + stderr 文本 + 头部解析（现状映射 4 种中文文案） | 类型化错误，可读状态码与响应头（含 `Retry-After`） | 跨域被拦时 JS 只拿到 `TypeError`，细节在控制台 | scope 不匹配「results in a promise rejection due to denied access」 |
| 密钥落点 | Rust 侧、stdin 传入（不进命令行） | Rust 侧 | **前端可见**（Anthropic 官方 SDK 禁止该形态） | Rust 侧 |
| 与 core 依赖方向的关系 | 已在 core 内（现行事实） | 放 core 会把 TLS + 运行时推进 core；放壳需新增注入点 | 不经 Rust，绕开该问题 | 落壳 crate（插件注册处） |
| 现有失败策略 | ADR-002：「API 失败静默回退本地分支」 | —（无一手仓库事实） | — | — |

## 成本 / 延迟 / 可靠性事实

### 冷启动与常驻（与心跳间隔直接相关）

- Ollama：模型默认**驻留 5 分钟**，官方原文「By default models are kept in memory for 5 minutes before being unloaded. This allows for quicker response times if you're making numerous requests to the LLM」（[faq](https://docs.ollama.com/faq)）；`keep_alive` 接受时长串（`"10m"`/`"24h"`）、秒数、**负数=常驻**、`0`=响应后立即卸载；`OLLAMA_KEEP_ALIVE` 同格式，且「`keep_alive` API parameter … will override the `OLLAMA_KEEP_ALIVE` setting」（faq L297-318）。
- Ollama 把加载成本变成可观测字段：响应里的 `load_duration`，以及「当本次请求需要先加载此前已卸载的模型时返回 `done_reason: "load"`」（[api.md](https://github.com/ollama/ollama/blob/main/docs/api.md)）→ 事实：心跳是否需要保活，可用这两个字段实测而非猜。
- LM Studio：JIT 加载默认开启（官方原文「you don't need to manually load the model first」），**Idle TTL 默认 60 分钟**，Auto-Evict 默认开启（「unloads previously JIT loaded models before loading new ones」），`lms load` 显式加载的模型默认无 TTL（[ttl-and-auto-evict](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict)）。
- llama.cpp：模型随进程启动加载；加载期 `GET /health` 回 **503 + `{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}`**，就绪回 `200 {"status": "ok"}`；需要排队的请求也回 503（"All handlers are busy" / "No server handlers"）（L478-487）。
- Ollama 的过载面：「If too many requests are sent to the server, it will respond with a 503 error indicating the server is overloaded」（队列上限 `OLLAMA_MAX_QUEUE`）；**流式响应中途出错时服务端仍回 HTTP 200**，错误对象作为最后一行 JSON 送出（[api/errors](https://docs.ollama.com/api/errors)、[troubleshooting](https://docs.ollama.com/troubleshooting)）。→ 事实：流式路径不能用状态码判断失败。

### 典型延迟与吞吐

- **各家官方文档都没有给出「小上下文单次 chat 调用典型端到端耗时 / tokens 每秒」的横向承诺数字——未找到一手来源。**
- 可用于本机实测的一手观测面：Ollama 的 `total_duration`/`load_duration`/`prompt_eval_duration`/`eval_duration`/`eval_count`/`prompt_eval_count`（api.md）；llama.cpp 的 `GET /metrics`（Prometheus 兼容文本，L1175）与 `GET /slots`（逐槽位处理状态，L1027）；LM Studio 未找到一手来源；方舟官方口径是 TPOT（输出 token 生成速率），并有 `service_tier=fast` 一档低延迟产品（[文档索引](https://ark.volcengine.com/llms.txt)）。
- 唯一可从官方示例读出的量级线索（**这是示例值，不是性能承诺**）：Ollama 官方示例中 `eval_count: 63` 对应 `eval_duration: 953997000` ns ≈ 0.954 s，`prompt_eval_count: 17` 对应 ≈201 ms，`load_duration` ≈6.7 ms（模型已在内存时）。

### 流式 vs 一次性（UI 实时性）

- 规范层：OpenAI 流式为 SSE 增量，`stream_options.include_usage` 时用量在最后一个 chunk（openapi.yaml L44960、L44714）。
- 本地服务层：llama.cpp「Both synchronous and streaming mode are supported」（L1392）；Ollama `stream: false` 时「returns a single response object」；百炼官方示例演示 `stream: true` 下逐块 `data: {...}` 输出。
- 与本仓库 UI 时间尺度对齐的一手事实：宠物心情状态机 7 个 `PetMood`，事件气泡 `PET_EVENT_TTL_MS = 8_000`（`src/lib/petState.ts:52`），`src/components/pet/GrokBot.tsx:60-61` 的注释原文「每 2s 推进一次"现在"：事件 TTL 与打盹判定都需要时间前进，但不值得每秒重渲染」→ 事实：现成 UI 粒度是 2 s 重渲染 + 8 s 事件寿命，与逐 token 更新不同尺度。
- 后端向前端推送的仓内先例（一手）：`src-tauri/src/lan_server.rs:161` `ctx.app.emit("lan-state-changed", ())`，前端在 `src/lib/store.ts` 监听同名事件；局域网服务本身是 axum + SSE（壳 crate 有 `futures-util`）。

### 重试与退避（各家一手约定）

- 标准：`Retry-After` 由 **RFC 9110 §10.2.3** 定义——「Servers send the "Retry-After" header field to indicate how long the user agent is expected to wait before making a follow-up request」，与 503 同用表示何时可重试，值可以是 HTTP-date 或 delay-seconds（[RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)）。
- OpenAI：429 带 `Retry-After`（秒，≥1），但「may be omitted for 429 responses that require user action」；slow_down 型要求「reduce your request rate, then increase it gradually」。
- Anthropic SDK：`max_retries` 默认 2，退避 0.5 s → 8.0 s 封顶，优先看 `x-should-retry`，再 `retry-after-ms`、`retry-after`。
- 方舟：`max_retries` 默认 2；超时推荐 1800 s，SDK 默认 60 s 连接 / 600 s socket（Go 600 s 端到端）；429 各码官方建议「请稍后重试」「请在客户端退避重试」。
- DeepSeek：429 建议「pace your requests reasonably」，500/503 稍后重试；未提 `Retry-After`。
- 百炼：429 分「QPS/QPM 超限」与「额度超限或欠费」两类文案（后者重试无意义）；503 可重试；未提 `Retry-After`。
- 本地：Ollama 队列满 503（`OLLAMA_MAX_QUEUE`）、内存不足排队并卸载空闲模型；llama.cpp `/health` 与「需排队」都回 503，可作「是否值得重试」的判据。

### 结构化输出可靠性（官方手段 + 官方自己标注的坑）

| 服务 | 官方手段（一手文本） | 官方标注的坑（一手文本） |
| --- | --- | --- |
| OpenAI | `response_format.json_schema` + `strict`，「ensures the model will match your supplied JSON schema」 | 「**Only a subset of JSON Schema is supported when `strict` is `true`**」；`json_object` 被称 older JSON mode，官方 preferred 是 `json_schema` |
| Ollama | `format: "json"` 或 `format: <JSON schema>`；兼容层走 `response_format` | 「It's important to instruct the model to use JSON in the **prompt**. Otherwise, the model may generate large amounts whitespace」；建议 schema 也进 prompt + 温度 ≤ 0.5；**云端不支持 structured outputs**；用工具时 temperature 不生效 |
| llama.cpp | 服务端约束解码 `-j/--json-schema`、`-jf/--json-schema-file`；`response_format` 的 `json_object`/`json_schema` | 未给「schema 无法满足时」的行为承诺（**未找到一手来源**）；`/completion` 与 `/v1/chat/completions` 字段不通用（README 明写 `/completion` 非 OAI 兼容） |
| LM Studio | `response_format` + JSON schema，「will cause the LLM to respond in valid JSON conforming to the schema provided」，与 OpenAI Structured Output 同格式 | 未声明 `strict` 语义差异（**未找到一手来源**） |
| vLLM | `response_format` / `extra_body.structured_outputs`：`choice`/`regex`/`json_schema`/`grammar`/`structural_tag`，后端 xgrammar·guidance·outlines·lm-format-enforcer | 「The supported regex syntax depends on the structured output backend」（官方原话：正则语法随后端不同） |
| DeepSeek | 仅 `json_object` | 「**the API may occasionally return empty content**」；需 prompt 含 "json" + 示例；需自行设 `max_tokens` 防截断 |
| 火山方舟 | `response_format` 的 `json_schema`/`json_object`；官方称「输出可靠……避免必要字段缺失或枚举值幻觉」 | 「该能力尚在 beta 阶段……**请谨慎在生产环境使用**」；「使用在线推理（TPM 保障包）时不支持结构化输出」 |
| Anthropic | 本次未取到官方文档正文——**未找到一手来源** | — |

- 「只让模型出枚举值 + 本地校验」这条兜底路径的一手支持：vLLM 的 `structured_outputs.choice`（枚举即约束解码）、Ollama 的 JSON schema（可用 `enum`/`required` 等关键字，官方示例含 `"required": ["name", "capital", "languages"]`）与「降低温度减少幻觉」建议、方舟把「枚举值幻觉」列为结构化输出要解决的问题。

## 对本仓库的候选接入项（只列事实性结论与取舍依据，不替人做决策、不写实施计划）

> 每条 = 「一手事实」+「它约束了本仓库的什么」，不含选择与步骤。

1. **本地最简形状不需要新依赖就能问出口**：`POST http://127.0.0.1:11434/api/chat` 的 `{model, messages, stream:false, format, options, keep_alive}` 字段名有官方一手出处（[Ollama API](https://docs.ollama.com/api/chat)）；无 GPU 时官方明示回退 CPU 且「much slower」、默认上下文按显存分档（<24 GiB → 4096）。约束点：本地服务是**用户自装自启的外部进程**（Windows 上 Ollama 是托盘程序，可 NSSM 起服务），本仓库现在不检测任何本地推理服务——「服务在不在、模型在不在内存里」是必须先落地的事实问题，一手可用端点是 `GET /api/version`、`GET /api/tags`、`GET /api/ps`（Ollama）与 `GET /health`（llama.cpp，加载期回 503）。
2. **远程侧一个 OpenAI 兼容适配器 + 可配 `{base_url, api_key, model}` 覆盖 8 个一手来源**；同一适配器内部仍需处理的分歧是参数名（`max_tokens` vs `max_completion_tokens`）、扩展字段入口（`extra_body`）、`response_format` 支持档位（DeepSeek 只 `json_object`、百炼未核验）、429 语义细分、百炼 base_url 含 `{WorkspaceId}` 与地域维度。约束点：兼容层对未知字段的处理是「静默降形」而非报错（`json_schema` 被忽略后照样回 200 + 自由文本），因此「本地校验 + 兜底」不是可选装饰而是该事实链的必然要求。
3. **Anthropic 形状是必须「另写一套」的唯一一手理由**：`/v1/messages`、`x-api-key` + `anthropic-version`、`system` 顶层、`max_tokens` 必填（官方 SDK 源码），且其 SDK 明确禁止浏览器侧使用——这同时否掉「webview 路径 + 远程 Key」的组合。
4. **curl 子进程路径（现状）的取舍依据已有一手记录**：零新增依赖、系统自带（Microsoft 官方 built-in 表述）、Token 不进命令行（`http_cache.rs:141`）、失败静默回退（ADR-002 L32）、证书依赖系统信任库（L159-163 文案）。代价同样有一手出处：整块 `wait_with_output`（无增量）、超时粒度是 `--max-time 10` 整请求（不是首 token）、状态码自己解析（L121 注释）、不读 `Retry-After`。对宠物气泡，是否需要逐 token = 与本仓库现成时间尺度（2 s `nowTick` + 8 s 事件寿命，`GrokBot.tsx:60-61` / `petState.ts:52`）对齐的问题。
5. **`tauri-plugin-http` 是「既绕开 webview CORS、又不新增顶层 reqwest 依赖」的那条路，但带三个官方一手前置**：官方页明写「This plugin requires a Rust version of at least **1.90**」（本仓库 `src-tauri/Cargo.toml` 未声明 `rust-version`）；「Forbidden request headers are ignored by default. To use them you must enable the `unsafe-headers` feature flag」（远程 API 必带的 `Authorization` 属被禁头清单）；权限面「This enables all fetch operations but **does not allow explicitly any origins to be fetched. This needs to be manually configured before usage.**」，且 scope 不匹配时「results in a promise rejection due to denied access」（以上均出自 [HTTP Client 插件页](https://v2.tauri.app/plugin/http-client/)）。约束点：它落在壳 crate；core 若要用得走插件 re-export 的 reqwest 或另设注入点——依赖方向是既有硬约束（`src-tauri/AGENTS.md`、`core/src/AGENTS.md`）。
6. **webview `fetch` 的真实拦阻是 CORS，不是 CSP**：`csp: null`（`tauri.conf.json:24`）→ 无 `connect-src` 限制；但 `application/json` 的 POST 必触发预检（MDN 简单请求清单），而三个本地服务的默认策略互不相同——Ollama 只放行 `127.0.0.1`/`0.0.0.0 来源、需 `OLLAMA_ORIGINS` 扩列；llama.cpp `--cors-origins` 默认 `*`（且官方推荐表把 webview 场景明写为 `tauri://localhost`）；LM Studio 需 `Enable CORS` 开关（默认态未找到一手来源）。约束点：该路径把「配置第三方服务的来源白名单」变成用户或应用的前置动作，而打包后 origin（Tauri 文档示例 `http://tauri.localhost`）与 Ollama 默认清单的匹配关系没有任何官方说明。
7. **常驻策略是心跳成本的最大单点**（一手事实并列，不做推荐）：Ollama 默认 5 分钟、可 `keep_alive=-1` 常驻、`OLLAMA_KEEP_ALIVE` 全局、API 参数覆盖 env；LM Studio 空闲 TTL 默认 60 分钟、请求体 `ttl` 可续期、`lms load` 加载的模型无 TTL；llama.cpp 常驻由进程决定、加载期 `/health` 回 503。约束点：心跳间隔若大于驻留时长，每次心跳都要付一次加载；这次加载在 Ollama 上可观测（`load_duration` + `done_reason: "load"`）。
8. **事件驱动侧本仓库已有现成落点，且形状与「枚举式输出」对得上**：心情状态机 7 个 `PetMood`、优先级「事件（8 s TTL）> 阻塞 > 番茄阶段 > 打盹 > idle」（`src/lib/petState.ts:16` 的 `PetMood`、`:52` 的 `PET_EVENT_TTL_MS`、`:88-96` 的 `moodOf`）；渲染包对外是 `setState`/`setExpression`/`playAction`/`say` + `registerState`/`registerAction`/`registerExpression` 的注册式扩展 API（`src/grokbot/README.md`），包边界明写「包内不 import 应用代码、不依赖 React、不碰 zustand 与 Tauri」（ADR-017 D6.1）；偏好存 localStorage 而非 SQLite（ADR-017 D3）；后端向前端推事件已有先例 `ctx.app.emit("lan-state-changed", ())`（`src-tauri/src/lan_server.rs:161`）。约束点：模型输出的落地面已经是**枚举式接口**，而「枚举即约束解码」正是各家最可靠的一档（vLLM `structured_outputs.choice`、Ollama schema `enum` + 低温、方舟把「枚举值幻觉」列为该能力要解决的问题）。
9. **成本可测但没有官方基线**：横向延迟/吞吐的官方承诺数字一律**未找到一手来源**；可自测的一手观测面是 Ollama 六个计时字段、llama.cpp `/metrics`（Prometheus）+ `/slots`、方舟 TPOT 口径（`service_tier=fast`）。约束点：任何「心跳频率 × token 数」的预算必须来自本机实测。
10. **本机资源竞争是既有事实**：Ollama `OLLAMA_NUM_PARALLEL` 默认 1、`OLLAMA_MAX_LOADED_MODELS` 默认 1（多 GPU 3）、队列 `OLLAMA_MAX_QUEUE` 默认 512 溢出回 503；llama.cpp `--parallel` 决定槽位、忙时 503；本仓库已在同一进程内跑两个 axum 服务（局域网共享 ADR-019、MCP HTTP ADR-023）。约束点：模型请求与它们共用同一台机器的 CPU/GPU，这是资源事实而非设计假设。
11. **「429-限流」与「429-额度」不是一回事**（一手事实）：百炼同一状态码两种文案（后者为「额度超限或者欠费」，重试无意义）；OpenAI 规范的 429 带 `Retry-After` 但「may be omitted」；方舟 Flex-TPM 官方建议「请在客户端退避重试」；Anthropic SDK 的退避区间 0.5 s → 8.0 s、默认 2 次；RFC 9110 定义该头可为 HTTP-date 或秒数。约束点：ADR-002 现在的「失败静默回退」策略与「退避重试」是两个层面，接入前需先明确区分这两类 429。
12. **凭据落点已有既有机制**：本仓库 Token 走 OS keyring（`core/src/svc/credentials.rs` + 按平台的 `keyring` 依赖），curl 侧经 stdin 传入不进命令行。约束点：这是远程 API Key 的现成一手机制；webview 路径与之冲突（Anthropic SDK 的浏览器禁令即官方表态）。
13. **文档可机读性的一手事实**（影响后续「能力清单」类同步的成本）：方舟「任一文档页 URL 追加 `.md` 即得 Markdown」+ `llms.txt` 索引；Ollama `docs.ollama.com/<页>.md` + `llms.txt`；llama.cpp / vLLM / Ollama 的文档正文就在官方仓库里（可锚定行号）；LM Studio 文档正文在 GitHub `lmstudio-ai/docs`；而 `platform.openai.com` 对自动抓取回 403、`docs.claude.com` 是纯客户端渲染（本次实测）。

## 来源

> 每条都是本文件正文实际引用过的一手出处；括号内标注本次的核验方式。带行号者指该仓库当时默认分支的行号（本机下载副本核对）。

### 本地推理服务

- Ollama API（`/api/chat` 与 `/api/generate` 字段、计时字段、`format`、`keep_alive`、`/api/tags`、`/api/ps`、`/api/version`）：https://docs.ollama.com/api/chat （200）；仓库源文件 https://github.com/ollama/ollama/blob/main/docs/api.md （raw 下载，正文 L67-71、L180-195、L493-523）
- Ollama FAQ（`127.0.0.1:11434` 默认绑定 + `OLLAMA_HOST`；跨域默认放行 `127.0.0.1`/`0.0.0.0` + `OLLAMA_ORIGINS`；`keep_alive` 默认 5 分钟与 `OLLAMA_KEEP_ALIVE`；`OLLAMA_MAX_LOADED_MODELS`/`OLLAMA_NUM_PARALLEL`/`OLLAMA_MAX_QUEUE` 与 503；CPU 回退「much slower」）：https://docs.ollama.com/faq （200）；源文件 https://github.com/ollama/ollama/blob/main/docs/faq.mdx （L185、L222-224、L291-322）
- Ollama 结构化输出（`format` 承载 schema、schema 进 prompt、温度 ≤ 0.5、云端不支持）：https://docs.ollama.com/capabilities/structured-outputs （200）
- Ollama OpenAI 兼容（`base_url = http://localhost:11434/v1/`、`api_key='ollama'`「required but ignored」、支持字段勾选表）：https://docs.ollama.com/api/openai-compatibility （200）
- Ollama 错误与状态码（400/401/403/404/429/500/502；流式中途错误回 200 + 末行 JSON 错误）：https://docs.ollama.com/api/errors （200）；队列满 503：https://docs.ollama.com/troubleshooting
- Ollama 上下文长度按显存分档（4096 / 32768 / 262144，`OLLAMA_CONTEXT_LENGTH`、`num_ctx`）：https://docs.ollama.com/context-length （200）
- Ollama Windows（版本门槛、托盘、命令行、NSSM 服务化）：https://docs.ollama.com/windows （200）
- Ollama 路由注册源码（`/v1/chat/completions`、`/v1/models`、`/v1/responses`、`/v1/messages` 等）：https://github.com/ollama/ollama/blob/main/server/routes.go （raw 下载，L2409-2425）
- llama.cpp `llama-server` README（`--host` 默认 `127.0.0.1`、`--port` 默认 `9931`、`--cors-*` 四项默认值与按部署场景的推荐值表、`--api-key`、`-j/--json-schema`、`/health` 503「Loading model」与「不受 api-key 保护」、`/slots`、`/props`、`/metrics`、`/v1/chat/completions` 同步+流式与 `response_format` 两种形态、`/v1/messages`、「On Windows, curl.exe should be available in the base OS」）：https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md （raw 下载 1 245 538 字节；正文 L154-155、L193-200、L397-408、L468-496、L1027、L1175、L1298、L1390-1398、L1564）
- LM Studio 本地服务器（Developer 面板 / `lms server start`、localhost 或局域网）：https://lmstudio.ai/docs/developer/core/server （200）
- LM Studio Server Settings（`Server Port`、`Require Authentication`、`Enable CORS`、JIT 三开关）：https://lmstudio.ai/docs/developer/core/server/settings （200）；源文件 https://github.com/lmstudio-ai/docs/blob/main/1_developer/0_core/0_server/settings.md （raw 下载，逐条开关描述）
- LM Studio OpenAI 兼容端点清单与端口 `1234`：https://lmstudio.ai/docs/developer/openai-compat （200）
- LM Studio 结构化输出（`response_format` + JSON schema、「与 OpenAI Structured Output 同格式」）：https://lmstudio.ai/docs/developer/openai-compat/structured-output
- LM Studio JIT / Idle TTL / Auto-Evict（默认 60 分钟、`ttl` 字段、`lms load` 无 TTL）：https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict
- LM Studio 自有 REST：https://lmstudio.ai/docs/developer/rest
- vLLM 在线服务总览（OpenAI 各端点 + **Anthropic `/v1/messages`** + `suffix` 不支持 / `user` 忽略注记）：https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/README.md （raw 下载，L7-30）
- vLLM OpenAI 兼容服务（`base_url="http://localhost:8000/v1"`、`--api-key` 保护范围警告、`extra_body`、`generation_config.json`）：https://github.com/vllm-project/vllm/blob/main/docs/serving/online_serving/openai_compatible_server.md （raw 下载）
- vLLM 结构化输出（`response_format` / `structured_outputs` 的 choice/regex/json_schema/grammar/structural_tag；后端 xgrammar·guidance·outlines·lm-format-enforcer；「supported regex syntax depends on the structured output backend」）：https://github.com/vllm-project/vllm/blob/main/docs/features/structured_outputs.md （raw 下载，L5、L17、L30、L64、L88、L251）
- vLLM 安全文档（服务不宜置于不可信网络、内部端口不外露、gRPC 默认不安全）：https://github.com/vllm-project/vllm/blob/main/docs/usage/security.md （raw 下载，L39、L111-123、L396）
- LocalAI 概览（「speaks the OpenAI and Anthropic APIs」、drop-in replacement、`-p 8080:8080`）：https://localai.io/overview/ （200）；源文件 https://github.com/mudler/LocalAI/blob/master/docs/content/overview.md
- Microsoft Foundry Local 入门（进程内原生 SDK：`FoundryLocalManager.CreateAsync`、`GetCatalogAsync`、`IsCachedAsync`；页面无 `localhost`/`endpoint`/`port` 字样）：https://learn.microsoft.com/en-us/windows/ai/foundry-local/get-started （正文抽取核验）
- Windows 自带 curl（「Use the built-in curl command on Windows…」；PowerShell 5.1 的 `curl` 别名会遮蔽 `curl.exe`）：https://learn.microsoft.com/en-us/windows/curl/

### 远程服务与 API 形状

- OpenAI 官方 OpenAPI 规范（server、`response_format` 三选一、`json_schema.name`/`strict`、`max_tokens` 弃用、`stream_options`、`TooManyRequests` 与 `Retry-After`、`InferenceRateLimited`）：https://github.com/openai/openai-openapi/blob/master/openapi.yaml （raw 下载 4 123 157 字节；L14-15、L44439-44441、L44522-44537、L44667、L44714-44715、L44960、L71162-71213、L118352-118377）
- OpenAI 文档站对自动抓取返回 HTTP 403（本次实测），故未引用其 guide 正文。
- DeepSeek JSON Output（`base_url`、`json_object`、prompt 需含 "json"、`max_tokens` 防截断、「may occasionally return empty content」）：https://api-docs.deepseek.com/guides/json_mode
- DeepSeek 错误码（429 / 500 / 503；无 `Retry-After` 表述）：https://api-docs.deepseek.com/quick_start/error_codes
- 火山方舟 兼容 OpenAI SDK（`https://ark.cn-beijing.volces.com/api/v3`、Python ≥3.7 / OpenAI SDK ≥1.0、`extra_body` 与 `extra_headers`）：https://ark.volcengine.com/region:cn-beijing/docs/compatible-with-openai-sdk.md （raw 下载）
- 火山方舟 结构化输出(beta)：https://ark.volcengine.com/region:cn-beijing/docs/structured-output-beta.md （raw 下载）
- 火山方舟 错误码（429 的 RPM/TPM/Flex-TPM 细分、`RequestTimeout`）：https://ark.volcengine.com/region:cn-beijing/docs/error-codes.md （raw 下载）
- 火山方舟 SDK 常见使用示例（超时与 `max_retries` 默认值、推荐 1800 s）：https://ark.volcengine.com/region:cn-beijing/docs/sdk-common-examples.md （raw 下载）
- 火山方舟 文档索引与 `.md` 取法：https://ark.volcengine.com/llms.txt （raw 下载）
- 阿里云百炼 OpenAI Chat 接口兼容（各地域 `compatible-mode/v1`、老域名仍可用、`Authorization: Bearer` 的 curl 示例、`stream` + `stream_options.include_usage`、状态码表含两种 429、API Key 与地域绑定）：https://www.alibabacloud.com/help/zh/model-studio/compatibility-of-openai-with-dashscope
- Anthropic 官方 Python SDK `messages.create()` 签名（`max_tokens`/`messages`/`model` 必填、`system` 顶层可选）：https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/resources/messages/messages.py （L122-149）
- Anthropic 官方 Python SDK 常量（10 分钟默认超时、`DEFAULT_MAX_RETRIES = 2`、`INITIAL_RETRY_DELAY = 0.5`、`MAX_RETRY_DELAY = 8.0`）：https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_constants.py
- Anthropic 官方 TypeScript SDK（`x-api-key`/`authorization` 校验、默认 `anthropic-version: '2026-10-21'`、默认 base URL、`x-should-retry`/`retry-after-ms`/`retry-after`、`dangerouslyAllowBrowser` + `anthropic-dangerous-direct-browser-access`）：https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts （L916-926、L1225-1249、L1834-1917、L2008-2011）
- `docs.claude.com` / `platform.claude.com` 为客户端渲染、本次未取到正文（实测），故 Anthropic 接口事实一律取官方 SDK 源码。
- HTTP `Retry-After` 标准定义（RFC 9110 §10.2.3）：https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3 （txt 版 L4799-4821）

### 出网路径

- MDN CORS（浏览器执行、预检、`Access-Control-Allow-Origin` 需 opt-in、简单请求的 `Content-Type` 白名单、凭据 + 通配符被阻断）：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
- Tauri 配置参考 `app.security.csp`（`Csp | null`、「injected on all HTML files」、`devCsp` 关系）：https://v2.tauri.app/reference/config/#csp
- Tauri 安全文档（CSP 与响应头示例：`access-control-allow-origin: http://tauri.localhost`、`connect-src ipc: http://ipc.localhost`）：https://v2.tauri.app/security/csp/ （200）；官方机器可读全文 https://v2.tauri.app/_llms-txt/guides.txt
- Tauri HTTP Client 插件（插件定位、Rust ≥ 1.90、`unsafe-headers`、Rust 侧可复用插件 re-export 的 reqwest、`http:default`「does not allow explicitly any origins to be fetched」、scope 不匹配即 promise rejection）：https://v2.tauri.app/plugin/http-client/ （200，正文在 guides.txt L13780-13924 逐条核验）
- Tauri「Calling Rust from the Frontend」：https://v2.tauri.app/develop/calling-rust/ （200）
- Tauri 1→2 迁移指南（`tauri::api::http` / `@tauri-apps/api/http` 已移除）：guides.txt L1092，页面 https://v2.tauri.app/develop/migrate-from-tauri-1/
- `reqwest` crate 文档（`default-tls` 默认、`rustls`/`native-tls` 特性、依赖表、异步需 Tokio 与 `blocking` 备选）：https://docs.rs/reqwest/latest/reqwest/
- `native-tls` crate 文档（「abstraction over platform-specific TLS」、「uses SChannel on Windows (via the `schannel` crate)」、依赖 `schannel ^0.1.28`）：https://docs.rs/native-tls/latest/native_tls/

### 本仓库现状（一手仓库内文件）

- `src-tauri/core/src/svc/http_cache.rs`：curl 参数（`--disable --max-time 10 --connect-timeout 5 -sS --include --header @- --url`，L122-140）、Token 走 stdin（L141）、整块 `wait_with_output`（L152）、传输层失败文案含「系统 TLS 证书」（L159-163）、`status_error` 的 401/403/404/429 中文映射（L39-47）、`X-RateLimit-Remaining: 0` → `rate_limited`（L238）、`MAX_PAGE_BYTES = 512 KiB` / `MAX_CACHE_BYTES = 32 MiB` / 128 页（L65-83）、GitHub 头块（L33）、Token 控制字符校验（L113-116）。
- `src-tauri/core/src/tool/proc.rs:7,22`：`CREATE_NO_WINDOW = 0x0800_0000` 与注释「防 release GUI 壳下闪黑框」；全 `src-tauri` 无 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 字样（一手 grep 核验）。
- `src-tauri/core/src/svc/credentials.rs`：OS keyring 存取（`keyring::Entry::new`，L31/L63/L129）。
- `src-tauri/Cargo.toml:33-36,51-53`：`axum = "0.8"`、`tokio = "1"`（`rt`/`rt-multi-thread`/`macros`/`sync`/`net`/`time`）、`futures-util = "0.3"`；workspace 成员 `["config", "core", "upgrade", "mcp-server"]`、`resolver = "2"`；插件清单（opener / dialog / window-state / log / clipboard-manager / single-instance / global-shortcut / notification）——**无 http 插件**；**无 `rust-version` 声明**。
- `src-tauri/core/Cargo.toml:8-27`：core 依赖 `serde`/`serde_json`/`rusqlite`/`log`/`uuid`/`base64`/`chrono`/`todo-kanban-upgrade` + 按平台 `keyring`——**无 HTTP / TLS crate**。
- `src-tauri/tauri.conf.json:8,20,24`：`devUrl: http://localhost:1420`、`decorations: false`、`app.security.csp: null`。
- `docs/decisions/ADR-002-system-cli-git-curl.md:10-32`：Windows 10+ 自带 curl、git 30s / curl 10s、`-k` 覆盖内网自签、被否方案「reqwest / hyper 等 HTTP crate」、`CREATE_NO_WINDOW` 必须全路径覆盖、「API 失败静默回退本地分支」。
- `docs/decisions/ADR-017-pomodoro-and-pet.md`：D3 宠物偏好走 localStorage、D6 心情优先级、D6.1 `src/grokbot/` 包边界（不 import 应用代码、不依赖 React、不碰 zustand 与 Tauri）、D7 MCP 只读资源。
- `src/lib/petState.ts:16,52,88-96`：7 个 `PetMood`、`PET_EVENT_TTL_MS = 8_000`、`PET_SLEEPY_IDLE_MS = 10 * 60_000`（L54）、`moodOf` 优先级。
- `src/components/pet/GrokBot.tsx:60-61`：每 2 秒 `nowTick`，注释原文「事件 TTL 与打盹判定都需要时间前进，但不值得每秒重渲染」。
- `src-tauri/src/lan_server.rs:161`：`ctx.app.emit("lan-state-changed", ())`。
- `src/grokbot/README.md`：`setState`/`setExpression`/`playAction`/`say`/`registerState`/`registerAction`/`registerExpression`。
- `src-tauri/AGENTS.md`、`src-tauri/core/src/AGENTS.md`：依赖方向严格单向、core 保持纯净（不 import tauri 相关 crate）。

### 未找到一手来源（明示留白）

- 任何官方给出的「小上下文一次 chat 调用典型端到端延迟 / tokens 每秒」横向数字（Ollama、llama.cpp、LM Studio、vLLM、DeepSeek、方舟、百炼均未提供）。
- LM Studio `Enable CORS` 开关的默认状态、其探活端点；LocalAI 的 JSON schema 字段名与 CORS 默认值；Microsoft Foundry Local 是否存在本地 HTTP 监听形态。
- vLLM `--host`/`--port` 的官方默认值声明（本次抓到的页面只给 `localhost:8000` 示例与 YAML 配置样例）。
- DeepSeek / 百炼是否返回 `Retry-After`；Ollama 对 `http://tauri.localhost` 这类 origin 的处理说明；Tauri 文档对 `csp: null` 语义的展开表述；LM Studio / vLLM / LocalAI 的显存门槛表。
- `reqwest` 的 native-tls vs rustls 在 Windows 上的二进制体积 / 交叉编译差异官方数字。
- Anthropic Messages API 的 JSON / 结构化输出官方文档正文（文档页客户端渲染，本次只有 SDK 源码）。
- 百炼兼容层的 `response_format` 支持档位（兼容页正文未出现该字段）。
- curl 在子进程管道下逐行增量消费的官方说明（本仓库场景无对应文档）。

---

> 本文件只登记事实与出处，不含实施计划。若要据此做选择，请另开决策文档（`docs/decisions/ADR-*.md`）。

