# magpie-digital-pet

烧 token，养电子宠物 —— 跑在 [magpie](https://github.com/) 网关上的插件，带侧边栏页面。

统计**所有 magpie 记账的请求**（Claude Code、Codex、Pi、OpenCode、Gemini CLI……不管哪个 agent、是否流式），把 token 喂给一只 Digimon 搭档：token 攒满进化槽就进化，650 只图鉴、原版 V-Pet 进化路线、进化对决。失败请求不喂。

引擎移植自 [@jcendal/opencode-digital-pet](https://github.com/jcendal/digital-pet) 0.18.0（Apache-2.0，见 NOTICE）：只换了宿主 —— 原版长在 OpenCode 的 TUI 里，这个版本跑在 magpie 的 Bun 插件宿主上。游戏数值、SQLite 模式、进化逻辑全部是原版代码，未改动。

## 界面

- **侧边栏页面**：magpie 窗口左侧导航里的「宠物」页 —— 当前搭档与进化进度条、喂食统计、一键孵蛋/冻结/钉 ID、喂食记录、历代列表，每 5 秒自刷新，主题跟随 magpie 窗口（page-chat 同款带路页跳本地服务）
- **设置面板**：magpie → Settings → Plugins → Digital Pet（开关、缓存 token、补录、轮询间隔）
- **CLI**：见下

## 工作方式

```
magpie 网关 ──记账──> /v1/magpie/usage/requests
                          │  每 60s 轮询（route_id 幂等去重）
                          ▼
              本插件（magpie 的 Bun 宿主进程内）
                          │  合成 message.updated 事件
                          ▼
              digital-pet 引擎（原版）──> data\pet.db
                          ▲
        侧边栏页面 <── 本地服务 127.0.0.1:3571（读同一库）
```

不走中间件（magpie 的中间件沙箱无 IO），不解析响应体（magpie 已经替你把每个请求的 token 数好了，流式也准）。多个宿主进程同时跑 watcher 也安全：引擎按 route_id 去重，SQLite 走 WAL；页面服务固定端口，谁先绑谁服务，端口被短命宿主占着时后来者定期重试接管。

## 安装

```sh
magpie plugin add E:\LLM_Config\Magpie\plugins\magpie-digital-pet
```

装好即开始记账喂食，首次自动孵蛋，侧边栏「宠物」页即开即用。命令行等效操作：

```sh
cd E:\LLM_Config\Magpie\plugins\magpie-digital-pet
bun cli\pet-cli.mjs status     # 当前进度、进化百分比（与侧边栏页同源）
bun cli\pet-cli.mjs spawn     # 孵新蛋
bun cli\pet-cli.mjs events     # 最近事件
bun cli\pet-cli.mjs partners   # 养过的每一代
bun cli\pet-cli.mjs freeze     # 暂停生长（用量照记，宠物不长）
bun cli\pet-cli.mjs unfreeze
bun cli\pet-cli.mjs set 4-001  # 钉死某只（cheat，钉住时不再生长）
```

## 配置

| 选项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `notifications` | `true` | 进化/孵化提示写进 magpie 插件日志 |
| `includeCacheTokens` | `false` | cache 命中是否计入。默认不计 |
| `backfill` | `false` | 补录 magpie 已记的 30 天用量（蛋立刻孵化）。改后需重载插件 |
| `pollSeconds` | `60` | 轮询间隔（15–3600s）。改后需重载插件 |
| `gatewayUrl` | `http://127.0.0.1:3425` | 网关地址 |
| `dbPath` | `<插件目录>\data\pet.db` | 数据库路径（放插件目录而非 %APPDATA%：宿主进程的用户身份可能与你不同） |
| `port` | `3571` | 侧边栏页面服务的本地端口 |

## 数据

- 数据库：`<插件目录>\data\pet.db`（SQLite，WAL，与 CLI / 页面并发安全）
- 轮询游标：同目录 `watcher-state.json`（删掉它 + 开 `backfill` 可重算历史）

## 红线（与策划书一致）

- 不注入任何 agent 的上下文：不注册 hooks/MCP/skills，不写 agent 配置
- 不消耗 token：引擎零 LLM 调用，全部本地规则
- 不改请求：只读 magpie 的用量账本
- 侧边栏页面只绑 127.0.0.1，只服务 magpie 窗口跳来的页面
- fail-open：本插件任何异常都不影响网关

## 测试

```sh
bun tests/selftest.mjs   # 26 项离线自检（假网关 + 临时库 + 页面服务 + 端口接管）
```

## 卸载

```sh
magpie plugin rm magpie-digital-pet
```

数据留在 `<插件目录>\data\`，想全删手动删目录即可。
