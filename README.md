# minimax-code2api

把 **MiniMax Code 桌面端**的 Coding Plan 订阅，转成 **Anthropic** 和 **OpenAI** 双协议兼容 API 的本地反向代理。让你能在 Claude Code、ZCode、Cherry Studio、LobeChat、OpenWebUI 等任何支持这两种协议的客户端里复用 MiniMax M3 / M2.7 系列模型。

**零依赖** —— 纯 Node.js（≥18.17）标准库实现，无需 `npm install`。

```
Claude Code / ZCode / Cherry Studio / 任意客户端
        │  Anthropic 协议                │  OpenAI 协议
        │  POST /v1/messages             │  POST /v1/chat/completions
        ▼                                ▼
┌───────────────── minimax-code2api (127.0.0.1:8045) ─────────────────┐
│  Anthropic 透传  ·  OpenAI⇄Anthropic 转换  ·  API Key 鉴权  ·  状态页 │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ ① 命名管道租约 token（桌面端负责刷新）
                           ▼
              MiniMax Code 桌面端（必须运行且已登录）
                           │ ② Bearer 转发
                           ▼
        https://agent.minimax.cn/mavis/api/v1/llm/v1/messages
```

## 工作原理（为什么不会影响你桌面端的任务）

MiniMax Code 桌面端内置一个**凭证 broker**：它通过本地命名管道
（`\\.\pipe\mcode-auth-lease-<hash>`）向同机的其他进程"出租"有效的 access token，
官方 CLI 就是这么共享登录态的。本项目实现了同一租约协议（自官方开源仓库
`oauth-lease-protocol` 包移植，MIT）：

- 代理**只租用** token，**从不**读取/写入凭证文件，**从不**主动刷新 token；
- token 刷新完全由桌面端串行管理，代理和官方 CLI 地位相同，属于协议设计的正常多客户端场景；
- 桌面端退出或未登录时，代理返回明确的错误提示，不会碰任何持久化状态。

## 快速开始

前置条件：MiniMax Code 桌面端正在运行且已登录（本机已装即可）。

```bash
# Windows（任意目录）
node src/server.js
# 或者指定配置文件
node src/server.js path/to/config.json
```

启动后：

- 状态面板：<http://127.0.0.1:8045/>
- Anthropic 端点：`POST http://127.0.0.1:8045/v1/messages`
- OpenAI 端点：`POST http://127.0.0.1:8045/v1/chat/completions`
- 模型列表：`GET http://127.0.0.1:8045/v1/models`
- 健康检查：`GET http://127.0.0.1:8045/health`

## 客户端接入示例

**Claude Code**（模型名随意填，会自动映射到 MiniMax-M3）：

```bash
set ANTHROPIC_BASE_URL=http://127.0.0.1:8045
set ANTHROPIC_AUTH_TOKEN=any-string
claude
```

**OpenAI SDK / Codex CLI 等**：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8045/v1", api_key="any-string")
resp = client.chat.completions.create(
    model="MiniMax-M3",           # 或 MiniMax-M3.1-Flash-Preview / MiniMax-M2.7 / MiniMax-M2.7-highspeed
    messages=[{"role": "user", "content": "你好"}],
)
```

**ZCode / 其他 Anthropic 协议客户端**：把 API 地址设为 `http://127.0.0.1:8045`，API Key 随意（未配置 `apiKeys` 时）。

## 配置

复制 `config.example.json` 为 `config.json`（或用环境变量覆盖）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | 监听地址。对外暴露时建议配 `apiKeys` |
| `port` | `8045` | 监听端口（环境变量 `PORT`） |
| `apiKeys` | `[]` | 代理自身的 API Key 列表；为空则不鉴权（环境变量 `API_KEYS`，逗号分隔） |
| `region` | `cn` | `cn`（国内 agent.minimax.cn）或 `io`（国际 agent.minimax.io，配桌面端登录的区域一致） |
| `upstreamBaseUrl` | 空 | 覆盖上游 origin（调试用） |
| `dataDir` | `~/.minimax` | 桌面端数据目录；多 profile 时指向 `~/.minimax-<profile>` |
| `defaultModel` | `MiniMax-M3` | 客户端发送未知模型名（如 `gpt-4o`、`claude-sonnet-*`）时映射到的模型 |
| `modelAlias` | `{}` | 额外的模型名映射，如 `{"gpt-5": "MiniMax-M3.1-Flash-Preview"}` |
| `logLevel` | `info` | `debug` / `info` / `warn` / `error` |

## 已支持的能力

- **Anthropic 协议**：`/v1/messages` 透传（含 SSE 流式）、`/v1/messages/count_tokens`（本地估算）、`/v1/files/upload` 透传
- **OpenAI 协议**：`/v1/chat/completions`（流式/非流式）、`/v1/models`
- **工具调用**：OpenAI tools/function ↔ Anthropic tool_use/tool_result 双向转换（含流式 tool_call 增量）
- **多模态**：图片输入（base64 data URL 与 http URL）
- **思维链**：`thinking` 字段透传；OpenAI 客户端的 `reasoning_effort` 映射为 thinking 开关（仅对支持关闭思维的 M3 生效），思维增量以 `reasoning_content` 下发
- **401 自愈**：上游返回 401 时自动作废缓存 token、重新租约并重试一次
- **用量统计**：流式响应的 `usage`（MiniMax 在 `message_delta` 中回传完整 input/output tokens）正确映射

## 常见问题

**报 "Cannot reach auth broker" / "Cannot read capability file"**
桌面端没在运行或没登录。启动并登录 MiniMax Code 桌面端即可，无需重启代理。

**上游 401 且重试后仍失败**
桌面端的登录态已过期，请在桌面端里重新登录。

**想代理另一个账号 / 区域**
用 `dataDir` 指向对应的 profile 数据目录（如 `~/.minimax-work`），或切 `region`。

**和桌面端同时用会不会抢配额 / 冲突？**
配额是账号级的，代理和桌面端共享同一账号池，用量都会计入 Plan。token 刷新由桌面端 broker 串行管理，协议层面无竞争。

## 免责声明

本项目与 MiniMax 官方无关，仅供个人学习研究。它复用的是你自己已登录账号的订阅额度，上游请求均以该账号身份发起，使用 MiniMax 服务请遵守其服务条款。逆向接口可能随官方版本变动失效。

## 致谢

- [MiniMax-AI/minimax-code](https://github.com/MiniMax-AI/minimax-code) —— 租约协议与模型目录的移植来源（MIT，见 NOTICE）
- [TriDefender/zcode-api](https://github.com/TriDefender/zcode-api)、[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、[Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api) —— 架构设计参考

## License

MIT，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
