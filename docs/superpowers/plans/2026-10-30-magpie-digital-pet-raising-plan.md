# Magpie Digital Pet 完整养成版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有 token 喂养与 650 只图鉴的前提下，把 Magpie 数字宠物页面升级为可见、可互动、可收集的本地养成小游戏。

**Architecture:** 上游进化引擎继续只通过 `pet.adapter.mjs` 驱动；新增独立养成规则、SQLite 存储、页面 API 与无构建步骤的前端。像素帧从本机 Apache-2.0 上游 bundle 提取为生成物，页面只消费静态 JSON。

**Tech Stack:** Bun 1.4.4、`bun:sqlite`、Node HTTP、原生 HTML/CSS/JavaScript、Playwright Core + 本机 Edge（仅验证）。

**Spec:** `docs/superpowers/specs/2026-10-30-magpie-digital-pet-raising-design.md`

## Global Constraints

- 不修改网关请求、不解析 Agent 上下文、不增加 LLM 调用、不引入云服务。
- 不改变上游 `partners`、`usage_receipts`、进化阈值、图鉴 ID 或进化路线语义。
- 新表统一使用 `magpie_pet_` 前缀；迁移幂等，现有 `data/pet.db` 自动升级。
- 养成状态按 `partner_id` 跟随每只搭档长期保存；同一搭档进化时继承，孵新蛋从初始状态开始。
- 本轮页面优先；CLI 保留原有命令，`status` 只增加只读养成摘要。
- 页面不依赖构建工具、外部图片或运行时网络资源。
- 用户确认的低压力原则：无死亡、无强制打卡，离线衰减最多累计 24 小时。
- 上游像素帧生成物继续受 Apache-2.0 与 NOTICE 约束；不得删除既有许可证文件。

## Review Focus

1. 旧版 `pet.db` 已有活跃伙伴：打开新版后伙伴、token、世代和既有表不能丢失。对应 Task 4、Task 8。
2. shell 有 `HTTP_PROXY` 但没有 `NO_PROXY`：服务关闭测试不能把代理 502 误判成服务仍在线。对应 Task 5。
3. 图鉴有 650 项但本地帧目录只有 646 个 sprite：缺帧宠物必须显示稳定兜底，不能空白。对应 Task 1、Task 6。
4. 用户连点按钮或重复提交：冷却、单探险和重复结算必须在服务端生效。对应 Task 2、Task 3、Task 5。
5. 浅色主题与窄视口：状态、按钮和像素宠物都必须可读且不重叠。对应 Task 6、Task 8。

---

### Task 1: 像素帧提取与加载

**Files:**
- Create: `tools/extract-frames.mjs`
- Create: `lib/pet.frames.mjs`
- Create: `tests/pet-frames.test.mjs`
- Create（由工具生成）: `lib/monster-frames.json`

**Interfaces:**
- Consumes: `.upstream/dist/tui.js` 中 `var MONSTER_FRAME_DATA = ...`。
- Produces:
  - `extractMonsterFrames({ upstreamBundlePath, outputPath }) -> { sprites: number, frames: number }`
  - `loadMonsterFrames(filePath = defaultMonsterFramesPath()) -> Map<string, Record<string, string>>`
  - `getSpriteFrames(frames, sprite) -> Record<string, string> | undefined`
  - `chooseFrame(frames, sprite, preferredNames) -> { name: string, content: string } | undefined`

- [x] **Step 1: Write the failing test**

`tests/pet-frames.test.mjs` 断言：

```js
const result = extractMonsterFrames({ upstreamBundlePath, outputPath: tempJson });
assert.equal(result.sprites, 646);
assert.equal(result.frames, 7227);
const frames = loadMonsterFrames(tempJson);
assert.equal(getSpriteFrames(frames, "egg").walk_1.length > 0, true);
assert.equal(chooseFrame(frames, "missing", ["walk_1", "walk_2"]), undefined);
```

- [x] **Step 2: Run test to verify it fails**

Run: `bun tests/pet-frames.test.mjs`  
Expected: FAIL，模块不存在。

- [x] **Step 3: Implement the extractor and loader**

提取器只接受两个精确标记：`var MONSTER_FRAME_DATA = ` 与 `];\n\n// ../digital-pet-core/src/data/monster-frame-catalog.ts`；在空 sandbox 中解析数组字面量，并校验每个条目是 `[sprite, [[frameName, content], ...]]`。输出 JSON 包含 `source: "jcendal/digital-pet 0.18.0 embedded TUI bundle"`、`frameNames` 和 `sprites`。加载器把 `sprites` 对象转成 `Map`，不修改帧字符串。

- [x] **Step 4: Run test to verify it passes**

Run: `bun tests/pet-frames.test.mjs`  
Expected: PASS。

- [x] **Step 5: Generate the checked-in asset**

Run: `bun tools/extract-frames.mjs`  
Expected: 生成 `lib/monster-frames.json`，日志输出 `646 sprites / 7227 frames`。

- [x] **Step 6: Commit**

```bash
git add tools/extract-frames.mjs lib/pet.frames.mjs tests/pet-frames.test.mjs lib/monster-frames.json
git commit -m "Add reusable monster frame catalog"
```

### Task 2: 照顾状态与主动操作规则

**Files:**
- Create: `lib/pet.care-rules.mjs`
- Create: `tests/pet-care-rules.test.mjs`

**Interfaces:**
- Produces:
  - `CARE_LIMITS = { min: 0, max: 100, maxOfflineMs: 24 * 60 * 60 * 1000 }`
  - `CARE_ACTIONS = { snack, play, clean, rest, petEgg }`
  - `createDefaultCareState(partnerId, nowMs) -> CareState`
  - `decayCareState(state, nowMs) -> CareState`
  - `applyCareAction(state, action, nowMs, context = { stage }) -> { ok, state, message, reason? }`
  - `careSummary(state) -> { moodLabel, needsAttention }`

`CareState` 精确字段：

```js
{
  partnerId, satiety, mood, energy, hygiene, bond,
  cooldowns: { snack, play, clean, rest, petEgg },
  lastDecayAt, updatedAt
}
```

- [x] **Step 1: Write the failing tests**

覆盖：

```js
// 初始值
assert.deepEqual(pick(createDefaultCareState("p1", 1000), ["satiety","mood","energy","hygiene","bond"]), [72,70,80,75,0]);
// 离线 48 小时只按 24 小时衰减，bond 不下降
// snack 在冷却中拒绝，且不修改原对象
// play 在 energy < 20 时拒绝
// petEgg 只允许 context.stage === 0
// clean 在 hygiene < 50 时额外 bond +1
```

动作数值固定为设计稿：snack `+10 satiety/+2 mood`、play `+12 mood/+2 bond/-10 energy`、clean `hygiene=100`、rest `+25 energy/-2 satiety`、petEgg `+2 bond`；冷却分别为 10、8、10、15、5 分钟。

- [x] **Step 2: Run tests to verify they fail**

Run: `bun tests/pet-care-rules.test.mjs`  
Expected: FAIL，模块不存在。

- [x] **Step 3: Implement pure rules**

所有函数保持纯计算：不读写数据库、不直接调用 `Date.now()`；返回新对象。衰减率固定为每小时：satiety `-2`、mood `-1.5`、energy `+3`、hygiene `-1`；所有值夹到 0–100，时间最多取 24 小时。

- [x] **Step 4: Run tests to verify they pass**

Run: `bun tests/pet-care-rules.test.mjs`  
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add lib/pet.care-rules.mjs tests/pet-care-rules.test.mjs
git commit -m "Add pet care action rules"
```

### Task 3: 探险、每日目标与成就规则

**Files:**
- Modify: `lib/pet.care-rules.mjs`
- Create: `tests/pet-progression-rules.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `CareState`。
- Produces:
  - `EXPEDITIONS = { patrol: { durationMs: 300000, fragments: 3, bond: 1 }, field: { durationMs: 900000, fragments: 8, bond: 2 }, night: { durationMs: 1800000, fragments: 15, bond: 3 } }`
  - `startExpedition({ careState, activeExpedition, kind, nowMs }) -> { ok, careState, expedition?, reason? }`
  - `claimExpedition({ expedition, nowMs, random }) -> { ok, reward?, reason? }`
  - `evaluateDailyGoals({ careEventsToday, fedRequestsToday, expeditionClaimsToday }) -> DailyGoal[]`
  - `evaluateAchievements({ careEventCount, fragments, evolutionCount }) -> string[]`

- [x] **Step 1: Write the failing tests**

覆盖：已有进行中的探险时不能开始；精力低于 15 不能开始；未到 `endsAt` 不能领取；领取奖励按 `EXPEDITIONS` 精确发放；同一个 `random` 得到同一条见闻；每日目标阈值为 `2 次照顾、1 次探险、10 次自动进食`；成就 ID 为 `first-care`、`first-clean`、`first-expedition`、`care-10`、`fragments-100`、`first-evolution`。

- [x] **Step 2: Run tests to verify they fail**

Run: `bun tests/pet-progression-rules.test.mjs`  
Expected: FAIL，导出不存在。

- [x] **Step 3: Implement progression rules**

探险开始时消耗 10 精力并返回 `{ expeditionId, partnerId, kind, status: "running", startedAt, endsAt }`。结算返回 `{ fragments, bond, note }`，`note` 从 6 条固定中文见闻中用传入 `random` 选择；不修改数据库。

- [x] **Step 4: Run tests to verify they pass**

Run: `bun tests/pet-progression-rules.test.mjs`  
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add lib/pet.care-rules.mjs tests/pet-progression-rules.test.mjs
git commit -m "Add expedition and collection rules"
```

### Task 4: 养成 SQLite 存储

**Files:**
- Create: `lib/pet.care-store.mjs`
- Create: `tests/pet-care-store.test.mjs`

**Interfaces:**
- Consumes: Task 2/3 的规则函数与类型。
- Produces:
  - `createCareStore({ databasePath }) -> CareStore`
  - `CareStore.getCareSnapshot(partnerId, nowMs) -> CareSnapshot`
  - `CareStore.performAction(partnerId, action, nowMs, context) -> CareCommandResult`
  - `CareStore.startExpedition(partnerId, kind, nowMs) -> CareCommandResult`
  - `CareStore.claimExpedition(expeditionId, nowMs) -> CareCommandResult`
  - `CareStore.equipDecoration(decorationId) -> CareCommandResult`
  - `CareStore.getCollection() -> { fragments, unlocked, equippedTheme, achievements }`
  - `CareStore.close() -> void`

- [x] **Step 1: Write the failing store tests**

测试使用临时数据库，覆盖：重复打开只迁移一次；`getCareSnapshot("p1")` 自动创建默认状态；连续 snack 第二次被冷却拒绝；切换 `p1/p2` 后各自状态保留；`claimExpedition` 对同一 ID 第二次返回 `already-claimed` 且碎片不翻倍；`care-10` 成就只解锁一次；关闭后不允许继续写。

- [x] **Step 2: Run tests to verify they fail**

Run: `bun tests/pet-care-store.test.mjs`  
Expected: FAIL，模块不存在。

- [x] **Step 3: Implement migrations and transactional writes**

创建设计稿第 9.2 节的 6 张 `magpie_pet_` 表。每个写命令在 Bun SQLite transaction 内完成：读取、规则计算、写状态、写事件、写奖励/成就。事件 ID 用 `randomUUID()`，时间参数由调用方传入。

- [x] **Step 4: Run tests to verify they pass**

Run: `bun tests/pet-care-store.test.mjs`  
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add lib/pet.care-store.mjs tests/pet-care-store.test.mjs
git commit -m "Persist pet care progression"
```

### Task 5: 页面服务 API、安全与关闭测试

**Files:**
- Modify: `lib/pet.server.mjs`
- Modify: `tests/selftest.mjs`
- Create: `tests/pet-server-care.test.mjs`

**Interfaces:**
- Consumes: Task 1 `loadMonsterFrames`，Task 4 `createCareStore`。
- Produces `/api/state` 新字段：

```js
{
  care, expedition, collection, daily,
  frame: { name, content, available: string[] },
  frames: Record<string, string>
}
```

`frame` 是按当前状态选出的首帧；`frames` 是当前 sprite 的全部可用帧，供页面在进食、开心、睡觉、行走等反馈之间切换。缺帧 sprite 返回空对象，由页面使用稳定兜底。

新增命令白名单精确为：`pet-feed-snack`、`pet-play`、`pet-clean`、`pet-rest`、`pet-pet-egg`、`pet-expedition-start`、`pet-expedition-claim`、`pet-decoration-equip`。

- [x] **Step 1: Write the failing server tests**

`tests/pet-server-care.test.mjs` 用临时库启动服务，断言：state 包含默认 care；每个新命令成功改变对应状态；非法探险类型、非法装饰 ID、重复 claim 返回 HTTP 400；静态路径 `/%2e%2e/package.json` 不返回文件；响应中的动态字段经 JSON 输出而不是拼 HTML。

修改 `tests/selftest.mjs` 的关闭断言：使用 Node `node:http` 请求 127.0.0.1，关闭后必须连接失败；不要把代理 HTTP 502 当作服务在线。

- [x] **Step 2: Run tests to verify they fail**

Run: `bun tests/pet-server-care.test.mjs && bun tests/selftest.mjs`  
Expected: 新测试因 API 不存在而失败。

- [x] **Step 3: Implement server integration**

在 `createPetServer` 内持有一个 `CareStore` 和帧目录；`readState` 合并上游快照与养成快照。所有新命令先校验参数，再调用 store，并把 `state: readState(...)` 返回。静态文件用 `resolve` 后判断 `relative(UI_ROOT, file)` 不以 `..` 开头。`close()` 跟踪并销毁活动 socket，确保重复 close 幂等。

- [x] **Step 4: Run tests to verify they pass**

Run: `bun tests/pet-server-care.test.mjs && bun tests/selftest.mjs`  
Expected: 新测试 PASS，自检 26/26 PASS。

- [x] **Step 5: Commit**

```bash
git add lib/pet.server.mjs tests/pet-server-care.test.mjs tests/selftest.mjs
git commit -m "Expose care gameplay through local page API"
```

### Task 6: 宠物主页视觉与交互

**Files:**
- Modify: `page/app.html`
- Create: `page/app.css`
- Create: `page/app.js`
- Create: `tests/page-contract.test.mjs`

**Interfaces:**
- Consumes: Task 5 的 `/api/state` 与 `/api/command`。
- Produces DOM 区域：`#habitat`、`#pet-canvas`、`#care-bars`、`#actions`、`#daily-goals`、`#collection`、`#events`、`#gens`。

- [x] **Step 1: Write the failing page contract test**

测试读取三个页面文件，断言：`app.html` 不再包含内联 `<script>` 逻辑；动态文本经 `textContent` 渲染；存在 `pet-canvas`、`care-bars`、`actions`、`daily-goals`、`collection`；CSS 同时包含 `.theme-light` 和 `.theme-dark` 选择器；所有新增命令按钮有 `data-command`。

- [x] **Step 2: Run test to verify it fails**

Run: `bun tests/page-contract.test.mjs`  
Expected: FAIL，文件/结构不存在。

- [x] **Step 3: Implement the page**

首屏按设计稿第 8.1 节布局。Canvas 把 `frame.content` 中的非空字符画成像素；`█/▀/▄` 使用不同亮度，缺帧时按 `node.id + stage` 生成稳定的对称像素兜底。宠物按状态选择帧：饱食低用 `angry/refuse`，精力低用 `sleep_1/sleep_2`，操作后短暂播放对应帧。主题继续读取 query 参数，同时加 `prefers-color-scheme` 兜底。

- [x] **Step 4: Run contract test to verify it passes**

Run: `bun tests/page-contract.test.mjs`  
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add page/app.html page/app.css page/app.js tests/page-contract.test.mjs
git commit -m "Build interactive pixel pet habitat"
```

### Task 7: CLI 摘要与用户文档

**Files:**
- Modify: `cli/pet-cli.mjs`
- Modify: `ui/panel.html`
- Modify: `README.md`
- Modify: `package.json`
- Create: `tests/docs-contract.test.mjs`

**Interfaces:**
- Consumes: Task 4 `CareStore.getCareSnapshot` 与 `getCollection`。
- Produces: `bun cli/pet-cli.mjs status` 输出 `care`、`bond`、`fragments`、`expedition` 四行只读摘要；版本升级到 `0.4.0`。

- [x] **Step 1: Write the failing documentation/CLI contract test**

断言 README 与设置页都写 `<插件目录>\data\pet.db` 或等价的「插件目录下的 `data/pet.db`」；README 包含新页面操作说明；`package.json` version 为 `0.4.0`；CLI status 在没有新养成表时仍能输出原有状态。

- [x] **Step 2: Run test to verify it fails**

Run: `bun tests/docs-contract.test.mjs`  
Expected: FAIL。

- [x] **Step 3: Implement CLI summary and docs**

CLI 只读接入 care store，不改变现有命令语义。设置页修正数据库路径并说明新操作在侧边栏「宠物」页。README 更新界面、玩法、测试命令和卸载数据说明。

- [x] **Step 4: Run tests to verify they pass**

Run: `bun tests/docs-contract.test.mjs`  
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add cli/pet-cli.mjs ui/panel.html README.md package.json tests/docs-contract.test.mjs
git commit -m "Document and summarize pet care progression"
```

### Task 8: 端到端回归与真实页面验收

**Files:**
- Modify: `tests/selftest.mjs`（只在发现集成缺口时）
- Create: `tests/e2e-page.test.mjs`（用 node:http 做核心端到端；Playwright Core + 本机 Edge 的真实浏览器段在显式提供本机路径时运行，否则明确跳过）
- Modify: `README.md`（把 e2e 命令列入测试说明）
- Modify: `tests/docs-contract.test.mjs`（把 e2e 测试纳入文档契约）

**Interfaces:**
- Consumes: 前 7 个任务的全部接口。
- Produces: 可重复的端到端验证命令和真实截图。

- [x] **Step 1: Write the failing end-to-end test**

使用当前真实 `data/pet.db` 的临时副本启动服务，执行一次 snack、一次 clean、开始并领取一个将时长缩短到测试用毫秒的探险（通过测试端口/注入参数，不改生产数值），断言 `/api/state` 读回状态、事件、碎片与现役 Digiegg。

- [x] **Step 2: Run test to verify it fails**

Run: `bun tests/e2e-page.test.mjs`  
Expected: 如果服务未暴露可测试的时间注入，则 FAIL；不得为了通过测试改掉生产时长常量。

- [x] **Step 3: Implement minimal test hook**

只允许测试显式传入 `expeditionScale` 或 `nowMs`；生产默认不改变设计稿的 5/15/30 分钟。

- [x] **Step 4: Run all tests**

Run: `bun tests/pet-frames.test.mjs && bun tests/pet-care-rules.test.mjs && bun tests/pet-progression-rules.test.mjs && bun tests/pet-care-store.test.mjs && bun tests/pet-server-care.test.mjs && bun tests/page-contract.test.mjs && bun tests/docs-contract.test.mjs && bun tests/e2e-page.test.mjs && bun tests/selftest.mjs`  
Expected: 全部 PASS，自检 26/26。

- [x] **Step 5: Verify the real rendered page**

用 Playwright Core + `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 打开本地服务，分别截取浅色 1440px 与浅色窄视口；确认标题、像素宠物、五项状态、行动按钮可见，页面 console error 为 0。

- [x] **Step 6: Commit**

```bash
git add tests/e2e-page.test.mjs tests/selftest.mjs
git commit -m "Verify digital pet care end to end"
```

## Self-Review

- Spec coverage：像素帧、照顾、探险、每日目标、成就、图鉴/世代展示、服务关闭测试、HTML 输出安全、静态路径、CLI 摘要、设置页与 README 均有对应任务。
- Type consistency：`CareState`、`CareStore`、命令名和 API 字段在任务 2–8 中使用同一命名。
- Proportion：实现者可按接口与验收值施工；具体样式、文案和函数体留给实施者。
